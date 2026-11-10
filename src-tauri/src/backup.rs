//! Local desktop backup snapshots.
//!
//! The desktop shell writes portable JSON snapshots into a folder that the user
//! selects with the native folder dialog. Each snapshot uses an atomic write.
//! Retention removes only files that match the snapshot name pattern.

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions as CapOpenOptions};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const SNAPSHOT_PREFIX: &str = "deckmark-backup-";
const SNAPSHOT_SUFFIX: &str = ".json";
const SNAPSHOT_STAMP_BYTES: usize = 16;
const MAX_PAYLOAD_BYTES: usize = 256 * 1024 * 1024;
const MIN_KEEP: u32 = 1;
const MAX_KEEP: u32 = 50;
const MAX_NAME_ATTEMPTS: u32 = 120;
const MAX_REGISTRY_BYTES: u64 = 64 * 1024;

/// Only the native picker can replace the persistent backup grant.
#[derive(Default)]
pub struct BackupRoots(Mutex<Option<PathBuf>>);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RootGrant {
    root_id: String,
    path: PathBuf,
    identity: [u64; 2],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRoot {
    root_id: String,
    path: String,
}

struct BackupDirectory {
    path: PathBuf,
    handle: Dir,
}

impl BackupDirectory {
    fn open(path: &Path) -> Result<Self, String> {
        let path = resolve_root(&path.to_string_lossy())?;
        let handle =
            Dir::open_ambient_dir(&path, ambient_authority()).map_err(|error| error.to_string())?;
        Ok(Self { path, handle })
    }

    fn identity(&self) -> Result<[u64; 2], String> {
        let file = self
            .handle
            .try_clone()
            .map_err(|error| error.to_string())?
            .into_std_file();
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = file.metadata().map_err(|error| error.to_string())?;
            Ok([metadata.dev(), metadata.ino()])
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            };
            let mut information = BY_HANDLE_FILE_INFORMATION::default();
            if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) }
                == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok([
                u64::from(information.dwVolumeSerialNumber),
                (u64::from(information.nFileIndexHigh) << 32)
                    | u64::from(information.nFileIndexLow),
            ])
        }
    }
}

impl BackupRoots {
    pub fn set_registry(&self, path: PathBuf) -> Result<(), String> {
        *self.0.lock().map_err(|_| "backup root store unavailable")? = Some(path);
        Ok(())
    }

    fn selected_root(&self, path: PathBuf) -> Result<BackupRoot, String> {
        let root = BackupDirectory::open(&path)?;
        let grant = RootGrant {
            root_id: Uuid::new_v4().to_string(),
            path: root.path.clone(),
            identity: root.identity()?,
        };
        let state = self.0.lock().map_err(|_| "backup root store unavailable")?;
        let registry = state.as_ref().ok_or("backup registry is not configured")?;
        let parent = registry.parent().ok_or("backup registry has no parent")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temp = parent.join(format!(".backup-root-{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp).map_err(|error| error.to_string())?;
            let bytes = serde_json::to_vec(&grant).map_err(|error| error.to_string())?;
            file.write_all(&bytes).map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            drop(file);
            fs::rename(&temp, registry).map_err(|error| error.to_string())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result?;
        Ok(BackupRoot {
            root_id: grant.root_id,
            path: grant.path.to_string_lossy().into_owned(),
        })
    }

    fn resolve(&self, root_id: &str) -> Result<BackupDirectory, String> {
        if Uuid::parse_str(root_id).is_err() {
            return Err("unknown or revoked backup root".to_string());
        }
        let state = self.0.lock().map_err(|_| "backup root store unavailable")?;
        let registry = state.as_ref().ok_or("backup registry is not configured")?;
        let parent = registry.parent().ok_or("backup registry has no parent")?;
        let directory = Dir::open_ambient_dir(parent, ambient_authority())
            .map_err(|error| error.to_string())?;
        let mut options = CapOpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let file = directory
            .open_with(
                registry
                    .file_name()
                    .ok_or("backup registry has no file name")?,
                &options,
            )
            .map_err(|error| error.to_string())?;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_REGISTRY_BYTES {
            return Err("backup registry is invalid".to_string());
        }
        let grant: RootGrant = serde_json::from_reader(file.take(MAX_REGISTRY_BYTES + 1))
            .map_err(|_| "backup registry is invalid".to_string())?;
        if grant.root_id != root_id {
            return Err("unknown or revoked backup root".to_string());
        }
        let root = BackupDirectory::open(&grant.path)?;
        if root.path != grant.path || root.identity()? != grant.identity {
            return Err("backup folder changed; select it again".to_string());
        }
        Ok(root)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    pub modified_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionResult {
    pub removed: usize,
    pub failed: usize,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupWrite {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    pub created_at_ms: f64,
    pub removed: usize,
    pub retention: RetentionResult,
}

enum AtomicWriteError {
    Exists,
    Failed(String),
}

fn resolve_root(root: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(root);
    if !path.is_absolute() {
        return Err("backup folder must be an absolute path".to_string());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("backup folder must not contain '..'".to_string());
    }
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "backup folder is missing or not accessible".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("symbolic-link folders are not accepted".to_string());
    }
    if !metadata.is_dir() {
        return Err("backup folder is not a directory".to_string());
    }
    path.canonicalize().map_err(|error| error.to_string())
}

fn ensure_payload_size(len: usize) -> Result<(), String> {
    if len > MAX_PAYLOAD_BYTES {
        return Err("backup payload exceeds the 256 MiB limit".to_string());
    }
    Ok(())
}

fn is_snapshot_name(name: &str) -> bool {
    let Some(stamp) = name
        .strip_prefix(SNAPSHOT_PREFIX)
        .and_then(|rest| rest.strip_suffix(SNAPSHOT_SUFFIX))
    else {
        return false;
    };
    let bytes = stamp.as_bytes();
    if bytes.len() != SNAPSHOT_STAMP_BYTES {
        return false;
    }
    bytes[..8].iter().all(u8::is_ascii_digit)
        && bytes[8] == b'T'
        && bytes[9..15].iter().all(u8::is_ascii_digit)
        && bytes[15] == b'Z'
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    (year + i64::from(month <= 2), month as u32, day as u32)
}

fn utc_timestamp(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let time = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        time / 3_600,
        (time % 3_600) / 60,
        time % 60
    )
}

fn snapshot_name(seconds: u64) -> String {
    format!(
        "{SNAPSHOT_PREFIX}{}{SNAPSHOT_SUFFIX}",
        utc_timestamp(seconds)
    )
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = if month > 2 { month - 3 } else { month + 9 } as i64;
    let day_of_year = (153 * month_prime + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn parse_snapshot_seconds(name: &str) -> Option<u64> {
    if !is_snapshot_name(name) {
        return None;
    }
    let stamp = name
        .strip_prefix(SNAPSHOT_PREFIX)?
        .strip_suffix(SNAPSHOT_SUFFIX)?;
    let number = |range: std::ops::Range<usize>| stamp[range].parse::<u32>().ok();
    let year = i64::from(number(0..4)?);
    let month = number(4..6)?;
    let day = number(6..8)?;
    let hour = number(9..11)?;
    let minute = number(11..13)?;
    let second = number(13..15)?;
    let days = days_from_civil(year, month, day);
    if days < 0 {
        return None;
    }
    Some(
        days as u64 * 86_400 + u64::from(hour) * 3_600 + u64::from(minute) * 60 + u64::from(second),
    )
}

fn next_timestamp(root: &BackupDirectory, now: u64) -> Result<u64, String> {
    let newest = snapshot_entries(root)?
        .iter()
        .filter_map(|entry| parse_snapshot_seconds(&entry.file_name))
        .max();
    Ok(newest.map_or(now, |value| now.max(value.saturating_add(1))))
}

fn metadata_ms(metadata: &cap_std::fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.into_std().duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn write_atomic_snapshot(
    root: &BackupDirectory,
    name: &str,
    payload: &[u8],
) -> Result<PathBuf, AtomicWriteError> {
    let temp = format!(".{name}.{}.tmp", Uuid::new_v4());
    let result = (|| {
        let mut options = CapOpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = root.handle.open_with(&temp, &options)?;
        file.write_all(payload)?;
        file.sync_all()?;
        drop(file);
        // A hard link creates the target only when the name is free.
        root.handle.hard_link(&temp, &root.handle, name)?;
        let _ = root.handle.remove_file(&temp);
        #[cfg(unix)]
        {
            if let Ok(directory) = root.handle.try_clone() {
                let _ = directory.into_std_file().sync_all();
            }
        }
        Ok::<(), std::io::Error>(())
    })();
    match result {
        Ok(()) => Ok(root.path.join(name)),
        Err(error) => {
            let _ = root.handle.remove_file(&temp);
            if error.kind() == ErrorKind::AlreadyExists {
                Err(AtomicWriteError::Exists)
            } else {
                Err(AtomicWriteError::Failed(error.to_string()))
            }
        }
    }
}

fn snapshot_entries(root: &BackupDirectory) -> Result<Vec<BackupEntry>, String> {
    let mut entries = Vec::new();
    for entry in root.handle.entries().map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_snapshot_name(&name) {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if !file_type.is_file() {
            continue;
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        entries.push(BackupEntry {
            path: root.path.join(&name).to_string_lossy().into_owned(),
            file_name: name,
            size: metadata.len(),
            modified_ms: metadata_ms(&metadata),
        });
    }
    entries.sort_by(|left, right| right.file_name.cmp(&left.file_name));
    Ok(entries)
}

fn apply_retention_with(
    root: &BackupDirectory,
    keep: u32,
    mut remove: impl FnMut(&Dir, &str) -> std::io::Result<()>,
) -> Result<RetentionResult, String> {
    let keep = keep.clamp(MIN_KEEP, MAX_KEEP) as usize;
    let entries = snapshot_entries(root)?;
    let mut removed = 0;
    let mut failures = Vec::new();
    for entry in entries.into_iter().skip(keep) {
        match remove(&root.handle, &entry.file_name) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => failures.push(format!("{}: {error}", entry.file_name)),
        }
    }
    let failed = failures.len();
    Ok(RetentionResult {
        removed,
        failed,
        error: if failures.is_empty() {
            None
        } else {
            Some(failures.join("; "))
        },
    })
}

fn apply_retention(root: &BackupDirectory, keep: u32) -> Result<RetentionResult, String> {
    apply_retention_with(root, keep, |directory, name| directory.remove_file(name))
}

fn write_snapshot_impl(
    root: &BackupDirectory,
    payload: &[u8],
    keep: u32,
    retention: impl FnOnce(&BackupDirectory, u32) -> Result<RetentionResult, String>,
) -> Result<BackupWrite, String> {
    ensure_payload_size(payload.len())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let mut seconds = next_timestamp(root, now)?;
    for _ in 0..MAX_NAME_ATTEMPTS {
        let name = snapshot_name(seconds);
        match write_atomic_snapshot(root, &name, payload) {
            Ok(path) => {
                let metadata = root
                    .handle
                    .symlink_metadata(&name)
                    .map_err(|error| error.to_string())?;
                // A committed snapshot stays successful even when a later
                // retention cleanup fails. The caller receives both outcomes.
                let retention = retention(root, keep).unwrap_or_else(|error| RetentionResult {
                    removed: 0,
                    failed: 1,
                    error: Some(error),
                });
                return Ok(BackupWrite {
                    path: path.to_string_lossy().into_owned(),
                    file_name: name,
                    size: metadata.len(),
                    created_at_ms: metadata_ms(&metadata),
                    removed: retention.removed,
                    retention,
                });
            }
            Err(AtomicWriteError::Exists) => {
                seconds = seconds.saturating_add(1);
            }
            Err(AtomicWriteError::Failed(error)) => return Err(error),
        }
    }
    Err("could not allocate a unique backup file name".to_string())
}

fn write_snapshot(
    root: &BackupDirectory,
    payload: &[u8],
    keep: u32,
) -> Result<BackupWrite, String> {
    write_snapshot_impl(root, payload, keep, apply_retention)
}

fn read_snapshot(root: &BackupDirectory, name: &str) -> Result<String, String> {
    if !is_snapshot_name(name) {
        return Err("backup name is not a DeckMark snapshot".to_string());
    }
    let metadata = root
        .handle
        .symlink_metadata(name)
        .map_err(|_| "backup file is missing or not accessible".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("symbolic-link snapshots are not accepted".to_string());
    }
    if !metadata.is_file() {
        return Err("backup path is not a regular file".to_string());
    }
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = root
        .handle
        .open_with(name, &options)
        .map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("backup path is not a regular file".to_string());
    }
    if metadata.len() > MAX_PAYLOAD_BYTES as u64 {
        return Err("backup file exceeds the 256 MiB limit".to_string());
    }
    let mut contents = Vec::with_capacity(metadata.len().try_into().unwrap_or(0));
    file.take(MAX_PAYLOAD_BYTES as u64 + 1)
        .read_to_end(&mut contents)
        .map_err(|error| error.to_string())?;
    if contents.len() > MAX_PAYLOAD_BYTES {
        return Err("backup file exceeds the 256 MiB limit".to_string());
    }
    String::from_utf8(contents).map_err(|_| "backup file is not UTF-8".to_string())
}

#[tauri::command]
pub async fn desktop_backup_pick_root(
    app: tauri::AppHandle,
    roots: tauri::State<'_, BackupRoots>,
    title: String,
) -> Result<Option<BackupRoot>, String> {
    #[cfg(feature = "native-smoke")]
    if let Some(path) =
        std::env::var_os("MDSH_NATIVE_BACKUP_ROOT").filter(|value| !value.is_empty())
    {
        return roots.selected_root(PathBuf::from(path)).map(Some);
    }
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title(title).blocking_pick_folder()
    })
    .await
    .map_err(|error| error.to_string())?;
    selected
        .map(|path| roots.selected_root(path.into_path().map_err(|error| error.to_string())?))
        .transpose()
}

#[tauri::command]
pub async fn desktop_backup_write(
    roots: tauri::State<'_, BackupRoots>,
    root_id: String,
    payload: String,
    keep: u32,
) -> Result<BackupWrite, String> {
    let root = roots.resolve(&root_id)?;
    tauri::async_runtime::spawn_blocking(move || write_snapshot(&root, payload.as_bytes(), keep))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_backup_cleanup(
    roots: tauri::State<'_, BackupRoots>,
    root_id: String,
    keep: u32,
) -> Result<RetentionResult, String> {
    let root = roots.resolve(&root_id)?;
    tauri::async_runtime::spawn_blocking(move || apply_retention(&root, keep))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_backup_list(
    roots: tauri::State<'_, BackupRoots>,
    root_id: String,
) -> Result<Vec<BackupEntry>, String> {
    let root = roots.resolve(&root_id)?;
    tauri::async_runtime::spawn_blocking(move || snapshot_entries(&root))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn desktop_backup_read(
    roots: tauri::State<'_, BackupRoots>,
    root_id: String,
    file_name: String,
) -> Result<String, String> {
    let root = roots.resolve(&root_id)?;
    tauri::async_runtime::spawn_blocking(move || read_snapshot(&root, &file_name))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_snapshot(root: &Path, payload: &[u8], keep: u32) -> Result<BackupWrite, String> {
        super::write_snapshot(&BackupDirectory::open(root)?, payload, keep)
    }

    fn snapshot_entries(root: &Path) -> Result<Vec<BackupEntry>, String> {
        super::snapshot_entries(&BackupDirectory::open(root)?)
    }

    fn temp_directory() -> PathBuf {
        let directory = std::env::temp_dir().join(format!("mdsh-backup-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("fixture directory");
        // macOS resolves /var to /private/var, so the root must match the
        // canonical parent compared by the read confinement.
        directory
            .canonicalize()
            .expect("canonical fixture directory")
    }

    fn write_fixture(root: &Path, name: &str, contents: &str) {
        fs::write(root.join(name), contents).expect("fixture file");
    }

    #[test]
    fn only_picker_grants_authorize_roots_and_survive_restart() {
        let root = temp_directory();
        let private = temp_directory();
        let registry = private.join("backup-root.json");
        let roots = BackupRoots::default();
        roots.set_registry(registry.clone()).unwrap();
        assert!(roots.resolve(&root.to_string_lossy()).is_err());
        assert!(roots.resolve(&Uuid::new_v4().to_string()).is_err());
        assert!(!registry.exists());
        let grant = roots.selected_root(root.clone()).unwrap();
        assert_ne!(grant.root_id, root.to_string_lossy());
        let restarted = BackupRoots::default();
        restarted.set_registry(registry.clone()).unwrap();
        let authorized = restarted.resolve(&grant.root_id).unwrap();
        let written = super::write_snapshot(&authorized, b"approved", 1).unwrap();
        assert_eq!(
            super::read_snapshot(&authorized, &written.file_name).unwrap(),
            "approved"
        );
        assert!(super::read_snapshot(&authorized, &written.path).is_err());
        assert!(super::read_snapshot(&authorized, &format!("../{}", written.file_name)).is_err());
        fs::write(&registry, "invalid registry").unwrap();
        assert!(restarted.resolve(&grant.root_id).is_err());
        drop(authorized);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(private).unwrap();
    }

    #[test]
    fn selecting_another_folder_revokes_the_previous_identity() {
        let first = temp_directory();
        let second = temp_directory();
        let private = temp_directory();
        let roots = BackupRoots::default();
        roots
            .set_registry(private.join("backup-root.json"))
            .unwrap();
        let old = roots.selected_root(first.clone()).unwrap();
        let new = roots.selected_root(second.clone()).unwrap();
        assert!(roots.resolve(&old.root_id).is_err());
        assert!(roots.resolve(&new.root_id).is_ok());
        let moved = second.with_extension("moved");
        fs::rename(&second, &moved).unwrap();
        fs::create_dir(&second).unwrap();
        assert!(roots.resolve(&new.root_id).is_err());
        fs::remove_dir_all(first).unwrap();
        fs::remove_dir_all(second).unwrap();
        fs::remove_dir_all(moved).unwrap();
        fs::remove_dir_all(private).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn granted_handles_reject_symlinks_and_stay_in_the_selected_directory() {
        use std::os::unix::fs::symlink;
        let root = temp_directory();
        let outside = temp_directory();
        let private = temp_directory();
        let roots = BackupRoots::default();
        roots
            .set_registry(private.join("backup-root.json"))
            .unwrap();
        let grant = roots.selected_root(root.clone()).unwrap();
        let authorized = roots.resolve(&grant.root_id).unwrap();
        let name = "deckmark-backup-20260101T000000Z.json";
        write_fixture(&outside, name, "outside");
        symlink(outside.join(name), root.join(name)).unwrap();
        assert!(super::read_snapshot(&authorized, name).is_err());
        assert!(super::snapshot_entries(&authorized).unwrap().is_empty());
        let moved = root.with_extension("moved");
        fs::rename(&root, &moved).unwrap();
        symlink(&outside, &root).unwrap();
        assert!(roots.resolve(&grant.root_id).is_err());
        super::write_snapshot(&authorized, b"inside", 1).unwrap();
        assert_eq!(fs::read_to_string(outside.join(name)).unwrap(), "outside");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
        fs::remove_file(root).unwrap();
        fs::remove_dir_all(moved).unwrap();
        fs::remove_dir_all(outside).unwrap();
        fs::remove_dir_all(private).unwrap();
    }

    #[test]
    fn atomic_write_creates_one_snapshot_without_temporary_files() {
        let root = temp_directory();
        let result = write_snapshot(&root, b"payload", 5).expect("snapshot write");
        assert!(is_snapshot_name(&result.file_name));
        assert_eq!(fs::read_to_string(&result.path).unwrap(), "payload");
        let entries = snapshot_entries(&root).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, result.path);
        let leftovers = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retention_keeps_the_newest_snapshots() {
        let root = temp_directory();
        let mut names = Vec::new();
        for index in 0..5 {
            let payload = format!("snapshot-{index}");
            names.push(
                write_snapshot(&root, payload.as_bytes(), 2)
                    .unwrap()
                    .file_name,
            );
        }
        let mut remaining: Vec<String> = snapshot_entries(&root)
            .unwrap()
            .into_iter()
            .map(|entry| entry.file_name)
            .collect();
        remaining.sort();
        let mut expected = names[3..].to_vec();
        expected.sort();
        assert_eq!(remaining, expected);
        assert_eq!(remaining.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn committed_snapshot_stays_successful_when_retention_fails() {
        let root = temp_directory();
        let directory = BackupDirectory::open(&root).unwrap();
        let committed = super::write_snapshot_impl(&directory, b"committed", 1, |_, _| {
            Ok(RetentionResult {
                removed: 0,
                failed: 1,
                error: Some("permission denied".to_string()),
            })
        })
        .expect("committed snapshot");
        assert!(is_snapshot_name(&committed.file_name));
        assert_eq!(committed.retention.removed, committed.removed);
        assert_eq!(committed.retention.failed, 1);
        assert!(committed.retention.error.is_some());
        assert_eq!(
            super::read_snapshot(&directory, &committed.file_name).unwrap(),
            "committed"
        );
        drop(directory);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retention_failure_can_be_retried_without_touching_the_new_snapshot() {
        let root = temp_directory();
        let directory = BackupDirectory::open(&root).unwrap();
        let mut names = Vec::new();
        for index in 0..3 {
            names.push(
                super::write_snapshot(&directory, format!("payload-{index}").as_bytes(), 5)
                    .unwrap()
                    .file_name,
            );
        }
        let oldest = names[0].clone();
        let failed = super::apply_retention_with(&directory, 1, |handle, name| {
            if name == oldest {
                Err(std::io::Error::new(
                    ErrorKind::PermissionDenied,
                    "injected removal failure",
                ))
            } else {
                handle.remove_file(name)
            }
        })
        .unwrap();
        assert_eq!(failed.removed, 1);
        assert_eq!(failed.failed, 1);
        assert!(failed
            .error
            .as_deref()
            .unwrap_or_default()
            .contains(&oldest));
        assert!(root.join(&oldest).exists());
        assert!(root.join(&names[2]).exists());
        let retry = super::apply_retention(&directory, 1).unwrap();
        assert_eq!(retry.removed, 1);
        assert_eq!(retry.failed, 0);
        assert!(!root.join(&oldest).exists());
        assert!(root.join(&names[2]).exists());
        drop(directory);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retention_preserves_unrelated_files() {
        let root = temp_directory();
        write_fixture(&root, "notes.txt", "keep");
        write_fixture(&root, "other.json", "keep");
        write_fixture(&root, "deckmark-backup-not-a-date.json", "keep");
        write_fixture(&root, "deckmark-backup-20260101T000000Z.json.bak", "keep");
        write_fixture(&root, "deckmark-backup-20260101T000000Z.txt", "keep");
        fs::create_dir(root.join("deckmark-backup-20260101T000000Z.json-dir")).unwrap();
        let mut names = Vec::new();
        for index in 0..3 {
            names.push(
                write_snapshot(&root, format!("payload-{index}").as_bytes(), 1)
                    .unwrap()
                    .file_name,
            );
        }
        assert_eq!(snapshot_entries(&root).unwrap().len(), 1);
        assert_eq!(fs::read_to_string(root.join("notes.txt")).unwrap(), "keep");
        assert_eq!(fs::read_to_string(root.join("other.json")).unwrap(), "keep");
        assert_eq!(
            fs::read_to_string(root.join("deckmark-backup-not-a-date.json")).unwrap(),
            "keep"
        );
        assert_eq!(
            fs::read_to_string(root.join("deckmark-backup-20260101T000000Z.json.bak")).unwrap(),
            "keep"
        );
        assert!(root.join("deckmark-backup-20260101T000000Z.txt").exists());
        assert!(root
            .join("deckmark-backup-20260101T000000Z.json-dir")
            .is_dir());
        let remaining = snapshot_entries(&root).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].file_name, names[2]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_roots_are_rejected() {
        assert!(resolve_root("relative-folder").is_err());
        assert!(resolve_root(&format!(
            "{}/../escape",
            std::env::temp_dir().to_string_lossy()
        ))
        .is_err());
        let missing = std::env::temp_dir().join(format!("mdsh-missing-{}", Uuid::new_v4()));
        assert!(resolve_root(&missing.to_string_lossy()).is_err());
        let file = std::env::temp_dir().join(format!("mdsh-backup-file-{}.json", Uuid::new_v4()));
        fs::write(&file, "not a directory").unwrap();
        assert!(resolve_root(&file.to_string_lossy()).is_err());
        fs::remove_file(file).unwrap();
    }

    #[test]
    fn read_rejects_paths_outside_the_approved_root() {
        let first = temp_directory();
        let second = temp_directory();
        let snapshot = write_snapshot(&first, b"first", 1).unwrap();
        let outside = write_snapshot(&second, b"second", 1).unwrap();
        let approved = BackupDirectory::open(&first).unwrap();
        assert_eq!(
            read_snapshot(&approved, &snapshot.file_name).unwrap(),
            "first"
        );
        assert!(read_snapshot(&approved, &outside.path).is_err());
        assert!(read_snapshot(&approved, &format!("../{}", outside.file_name)).is_err());
        let unrelated = first.join("notes.json");
        fs::write(&unrelated, "keep").unwrap();
        assert!(read_snapshot(&approved, "notes.json").is_err());
        drop(approved);
        fs::remove_dir_all(first).unwrap();
        fs::remove_dir_all(second).unwrap();
    }

    #[test]
    fn payload_limit_and_timestamp_format_are_exact() {
        assert!(ensure_payload_size(MAX_PAYLOAD_BYTES).is_ok());
        assert!(ensure_payload_size(MAX_PAYLOAD_BYTES + 1).is_err());
        assert_eq!(utc_timestamp(0), "19700101T000000Z");
        assert_eq!(utc_timestamp(1_700_000_000), "20231114T221320Z");
        assert_eq!(
            parse_snapshot_seconds("deckmark-backup-20231114T221320Z.json"),
            Some(1_700_000_000)
        );
        assert_eq!(
            snapshot_name(1_700_000_000),
            "deckmark-backup-20231114T221320Z.json"
        );
    }

    #[test]
    fn snapshot_names_are_strict() {
        assert!(is_snapshot_name("deckmark-backup-20261104T101500Z.json"));
        assert!(!is_snapshot_name("deckmark-backup-20261104T101500.json"));
        assert!(!is_snapshot_name("deckmark-backup-20261104T101500Z.JSON"));
        assert!(!is_snapshot_name("deckmark-backup-2026110AT101500Z.json"));
        assert!(!is_snapshot_name("deckmark-backup-20261104t101500Z.json"));
        assert!(!is_snapshot_name("deckmark-backup-20261104T10150Z.json"));
        assert!(!is_snapshot_name("other-20261104T101500Z.json"));
    }
}
