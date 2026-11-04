//! Local desktop backup snapshots.
//!
//! The desktop shell writes portable JSON snapshots into a folder that the user
//! selects with the native folder dialog. Each snapshot uses an atomic write.
//! Retention removes only files that match the snapshot name pattern.

use serde::Serialize;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const SNAPSHOT_PREFIX: &str = "deckmark-backup-";
const SNAPSHOT_SUFFIX: &str = ".json";
const SNAPSHOT_STAMP_BYTES: usize = 16;
const MAX_PAYLOAD_BYTES: usize = 256 * 1024 * 1024;
const MIN_KEEP: u32 = 1;
const MAX_KEEP: u32 = 50;
const MAX_NAME_ATTEMPTS: u32 = 120;

/// Approved backup folders for this session.
///
/// A folder enters this set after `desktop_backup_write` or
/// `desktop_backup_list`. `desktop_backup_read` accepts only a direct child of
/// one of these folders.
#[derive(Default)]
pub struct BackupRoots(Mutex<HashSet<PathBuf>>);

impl BackupRoots {
    fn allow(&self, root: &Path) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "backup root store unavailable")?
            .insert(root.to_path_buf());
        Ok(())
    }

    fn contains(&self, root: &Path) -> bool {
        self.0
            .lock()
            .map(|roots| roots.contains(root))
            .unwrap_or(false)
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
pub struct BackupWrite {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    pub created_at_ms: f64,
    pub removed: usize,
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

fn next_timestamp(root: &Path, now: u64) -> Result<u64, String> {
    let newest = snapshot_entries(root)?
        .iter()
        .filter_map(|entry| parse_snapshot_seconds(&entry.file_name))
        .max();
    Ok(newest.map_or(now, |value| now.max(value.saturating_add(1))))
}

fn metadata_ms(metadata: &fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn write_atomic_snapshot(
    root: &Path,
    name: &str,
    payload: &[u8],
) -> Result<PathBuf, AtomicWriteError> {
    let target = root.join(name);
    let temp = root.join(format!(".{name}.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(payload)?;
        file.sync_all()?;
        drop(file);
        // A hard link creates the target only when the name is free.
        fs::hard_link(&temp, &target)?;
        let _ = fs::remove_file(&temp);
        #[cfg(unix)]
        {
            if let Ok(directory) = File::open(root) {
                let _ = directory.sync_all();
            }
        }
        Ok::<(), std::io::Error>(())
    })();
    match result {
        Ok(()) => Ok(target),
        Err(error) => {
            let _ = fs::remove_file(&temp);
            if error.kind() == ErrorKind::AlreadyExists {
                Err(AtomicWriteError::Exists)
            } else {
                Err(AtomicWriteError::Failed(error.to_string()))
            }
        }
    }
}

fn snapshot_entries(root: &Path) -> Result<Vec<BackupEntry>, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
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
            path: entry.path().to_string_lossy().into_owned(),
            file_name: name,
            size: metadata.len(),
            modified_ms: metadata_ms(&metadata),
        });
    }
    entries.sort_by(|left, right| right.file_name.cmp(&left.file_name));
    Ok(entries)
}

fn apply_retention(root: &Path, keep: u32) -> Result<usize, String> {
    let keep = keep.clamp(MIN_KEEP, MAX_KEEP) as usize;
    let entries = snapshot_entries(root)?;
    let mut removed = 0;
    for entry in entries.into_iter().skip(keep) {
        match fs::remove_file(&entry.path) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(removed)
}

fn write_snapshot(root: &Path, payload: &[u8], keep: u32) -> Result<BackupWrite, String> {
    ensure_payload_size(payload.len())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let mut seconds = next_timestamp(root, now)?;
    for _ in 0..MAX_NAME_ATTEMPTS {
        let name = snapshot_name(seconds);
        let target = root.join(&name);
        if target.exists() {
            seconds = seconds.saturating_add(1);
            continue;
        }
        match write_atomic_snapshot(root, &name, payload) {
            Ok(path) => {
                let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
                let removed = apply_retention(root, keep)?;
                return Ok(BackupWrite {
                    path: path.to_string_lossy().into_owned(),
                    file_name: name,
                    size: metadata.len(),
                    created_at_ms: metadata_ms(&metadata),
                    removed,
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

fn validate_snapshot_path(path: &Path, root: Option<&Path>) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("backup path must be an absolute path".to_string());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("backup path must not contain '..'".to_string());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "backup path has no file name".to_string())?;
    if !is_snapshot_name(name) {
        return Err("backup path is not a DeckMark snapshot".to_string());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "backup file is missing or not accessible".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("symbolic-link snapshots are not accepted".to_string());
    }
    if !metadata.is_file() {
        return Err("backup path is not a regular file".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "backup path has no parent".to_string())?;
    let canonical_parent = parent.canonicalize().map_err(|error| error.to_string())?;
    if let Some(root) = root {
        if canonical_parent != root {
            return Err("backup path is outside the approved folder".to_string());
        }
    }
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    if canonical.parent() != Some(canonical_parent.as_path()) {
        return Err("backup path is outside the approved folder".to_string());
    }
    Ok(())
}

fn read_snapshot(path: &Path, root: Option<&Path>) -> Result<String, String> {
    validate_snapshot_path(path, root)?;
    let file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
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
pub fn desktop_backup_write(
    roots: tauri::State<'_, BackupRoots>,
    root: String,
    payload: String,
    keep: u32,
) -> Result<BackupWrite, String> {
    let root = resolve_root(&root)?;
    roots.allow(&root)?;
    write_snapshot(&root, payload.as_bytes(), keep)
}

#[tauri::command]
pub fn desktop_backup_list(
    roots: tauri::State<'_, BackupRoots>,
    root: String,
) -> Result<Vec<BackupEntry>, String> {
    let root = resolve_root(&root)?;
    roots.allow(&root)?;
    snapshot_entries(&root)
}

#[tauri::command]
pub fn desktop_backup_read(
    roots: tauri::State<'_, BackupRoots>,
    path: String,
) -> Result<String, String> {
    let path = PathBuf::from(path);
    let parent = path
        .parent()
        .ok_or_else(|| "backup path has no parent".to_string())?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !roots.contains(&parent) {
        return Err("backup path is outside the approved folder".to_string());
    }
    read_snapshot(&path, Some(&parent))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_directory() -> PathBuf {
        let directory = std::env::temp_dir().join(format!("mdsh-backup-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("fixture directory");
        directory
    }

    fn write_fixture(root: &Path, name: &str, contents: &str) {
        fs::write(root.join(name), contents).expect("fixture file");
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
        assert_eq!(
            read_snapshot(Path::new(&snapshot.path), Some(&first)).unwrap(),
            "first"
        );
        assert!(read_snapshot(Path::new(&outside.path), Some(&first)).is_err());
        assert!(read_snapshot(Path::new(&outside.path), None).is_ok());
        let traversal = first.join("..").join(
            Path::new(&outside.path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .as_ref(),
        );
        assert!(read_snapshot(&traversal, Some(&first)).is_err());
        let unrelated = first.join("notes.json");
        fs::write(&unrelated, "keep").unwrap();
        assert!(read_snapshot(&unrelated, Some(&first)).is_err());
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
