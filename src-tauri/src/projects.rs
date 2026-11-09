//! Native directory project boundary for the desktop shell.
//!
//! A native picker creates each persistent root grant. Rust stores the grant in
//! its private registry. The webview uses opaque identifiers and session tokens.

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, File as CapFile, OpenOptions as CapOpenOptions};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions as StdOpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdx", "txt"];
const ASSET_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"];
const MAX_MARKDOWN_FILES: usize = 3_000;
const MAX_ENTRIES: usize = 6_500;
const MAX_DEPTH: usize = 16;
const MAX_MARKDOWN_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileIdentity {
    first: u64,
    second: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RootGrant {
    root_id: String,
    path: PathBuf,
    identity: FileIdentity,
}

#[derive(Clone)]
pub(crate) struct ProjectSession {
    root_id: String,
    pub(crate) path: PathBuf,
    identity: FileIdentity,
}

#[derive(Default)]
struct ProjectState {
    sessions: HashMap<String, ProjectSession>,
    registry: Option<PathBuf>,
}

#[derive(Default)]
pub struct ProjectStore(Mutex<ProjectState>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    kind: &'static str,
    relative_path: String,
    mime: &'static str,
    content: Option<String>,
    bytes: Option<Vec<u8>>,
    mtime_ms: f64,
    size: u64,
    revision: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    root_id: String,
    token: String,
    name: String,
    entries: Vec<ProjectEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifestEntry {
    kind: &'static str,
    relative_path: String,
    mtime_ms: f64,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    root_id: String,
    token: String,
    entries: Vec<ProjectManifestEntry>,
}

#[derive(Clone, Copy, PartialEq)]
enum EntryKind {
    Markdown,
    Asset,
}

struct ProjectChild {
    parent: Dir,
    parent_relative: PathBuf,
    name: OsString,
    absolute: PathBuf,
}

impl ProjectStore {
    pub fn set_registry(&self, path: PathBuf) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "project store unavailable")?;
        state.registry = Some(path);
        Ok(())
    }

    fn selected_root(&self, path: PathBuf) -> Result<(String, ProjectSession), String> {
        let canonical = validate_selected_root(&path)?;
        let identity = directory_identity(&canonical)?;
        let mut state = self.0.lock().map_err(|_| "project store unavailable")?;
        let mut grants = load_registry(&state)?;
        let existing = grants
            .iter()
            .find(|grant| grant.path == canonical && grant.identity == identity)
            .cloned();
        let grant = existing.unwrap_or_else(|| RootGrant {
            root_id: Uuid::new_v4().to_string(),
            path: canonical.clone(),
            identity: identity.clone(),
        });
        grants.retain(|known| known.path != canonical && known.root_id != grant.root_id);
        grants.push(grant.clone());
        store_registry(&state, &grants)?;
        let session = ProjectSession {
            root_id: grant.root_id,
            path: grant.path,
            identity: grant.identity,
        };
        let token = Uuid::new_v4().to_string();
        state.sessions.insert(token.clone(), session.clone());
        Ok((token, session))
    }

    fn open(&self, root_id: &str) -> Result<(String, ProjectSession), String> {
        let mut state = self.0.lock().map_err(|_| "project store unavailable")?;
        let grants = load_registry(&state)?;
        let grant = grants
            .into_iter()
            .find(|grant| grant.root_id == root_id)
            .ok_or("unknown or revoked native project root")?;
        validate_root(&grant.path, &grant.identity)?;
        let session = ProjectSession {
            root_id: grant.root_id,
            path: grant.path,
            identity: grant.identity,
        };
        let token = Uuid::new_v4().to_string();
        state.sessions.insert(token.clone(), session.clone());
        Ok((token, session))
    }

    fn resolve(&self, token: &str) -> Result<ProjectSession, String> {
        let state = self.0.lock().map_err(|_| "project store unavailable")?;
        let session = state
            .sessions
            .get(token)
            .cloned()
            .ok_or("invalid or expired native project token")?;
        validate_root(&session.path, &session.identity)?;
        Ok(session)
    }

    /// Resolve a persistent grant identifier without creating a session token.
    /// Every Git call uses this path so each call revalidates the root.
    pub(crate) fn authorize(&self, root_id: &str) -> Result<ProjectSession, String> {
        let state = self.0.lock().map_err(|_| "project store unavailable")?;
        let grants = load_registry(&state)?;
        let grant = grants
            .into_iter()
            .find(|grant| grant.root_id == root_id)
            .ok_or("unknown or revoked native project root")?;
        validate_root(&grant.path, &grant.identity)?;
        Ok(ProjectSession {
            root_id: grant.root_id,
            path: grant.path,
            identity: grant.identity,
        })
    }

    fn revoke(&self, token: &str) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "project store unavailable")?;
        let root_id = state
            .sessions
            .get(token)
            .ok_or("invalid or expired native project token")?
            .root_id
            .clone();
        let mut grants = load_registry(&state)?;
        if !grants.iter().any(|grant| grant.root_id == root_id) {
            return Err("unknown or revoked native project root".to_string());
        }
        grants.retain(|grant| grant.root_id != root_id);
        store_registry(&state, &grants)?;
        state
            .sessions
            .retain(|_, session| session.root_id != root_id);
        Ok(())
    }
}

fn load_registry(state: &ProjectState) -> Result<Vec<RootGrant>, String> {
    let Some(path) = &state.registry else {
        return Err("project registry is not configured".to_string());
    };
    reject_symlink(path)?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    if file.metadata().map_err(|error| error.to_string())?.len() > MAX_REGISTRY_BYTES {
        return Err("project registry is too large".to_string());
    }
    let opened_identity = std_file_identity(&file)?;
    let grants: Vec<RootGrant> = serde_json::from_reader(file.take(MAX_REGISTRY_BYTES))
        .map_err(|_| "project registry is invalid".to_string())?;
    reject_symlink(path)?;
    if file_identity(path)? != opened_identity {
        return Err("project registry changed during read".to_string());
    }
    let mut root_ids = HashSet::new();
    let mut paths = HashSet::new();
    for grant in &grants {
        if Uuid::parse_str(&grant.root_id).is_err()
            || !grant.path.is_absolute()
            || !root_ids.insert(grant.root_id.clone())
            || !paths.insert(grant.path.clone())
        {
            return Err("project registry is invalid".to_string());
        }
    }
    Ok(grants)
}

fn store_registry(state: &ProjectState, grants: &[RootGrant]) -> Result<(), String> {
    let path = state
        .registry
        .as_ref()
        .ok_or("project registry is not configured")?;
    let parent = path.parent().ok_or("project registry has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    reject_symlink(path)?;
    let bytes = serde_json::to_vec(grants).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err("project registry is too large".to_string());
    }
    let expected_revision = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Some(current_revision(path)?),
        Ok(_) => return Err("project registry is not a regular file".to_string()),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    atomic_registry_replace(path, &bytes, expected_revision.as_deref()).map(|_| ())
}

fn validate_selected_root(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("selected project root is not absolute".to_string());
    }
    reject_symlink(path)?;
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    reject_symlink(&canonical)?;
    if !fs::metadata(&canonical)
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err("selected project root is not a directory".to_string());
    }
    Ok(canonical)
}

fn validate_root(path: &Path, expected: &FileIdentity) -> Result<(), String> {
    reject_symlink(path)?;
    let canonical = path
        .canonicalize()
        .map_err(|_| "native project root is unavailable".to_string())?;
    if canonical != path || directory_identity(path)? != *expected {
        return Err("native project root changed since approval".to_string());
    }
    Ok(())
}

#[cfg(unix)]
fn metadata_identity(metadata: &fs::Metadata) -> Result<FileIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    Ok(FileIdentity {
        first: metadata.dev(),
        second: metadata.ino(),
    })
}

#[cfg(unix)]
fn std_file_identity(file: &File) -> Result<FileIdentity, String> {
    metadata_identity(&file.metadata().map_err(|error| error.to_string())?)
}

#[cfg(windows)]
fn std_file_identity(file: &File) -> Result<FileIdentity, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let result =
        unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) };
    if result == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(FileIdentity {
        first: u64::from(information.dwVolumeSerialNumber),
        second: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
}

fn directory_identity(path: &Path) -> Result<FileIdentity, String> {
    let directory =
        Dir::open_ambient_dir(path, ambient_authority()).map_err(|error| error.to_string())?;
    cap_dir_identity(&directory)
}

fn file_identity(path: &Path) -> Result<FileIdentity, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("native project entry is not a regular file".to_string());
    }
    std_file_identity(&file)
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("symbolic links are not accepted in native projects".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn relative_components(relative_path: &str) -> Result<Vec<&str>, String> {
    if relative_path.is_empty()
        || relative_path.len() > 1024
        || relative_path.contains('\\')
        || relative_path.starts_with('/')
        || relative_path.ends_with('/')
    {
        return Err("invalid native project relative path".to_string());
    }
    let components = relative_path.split('/').collect::<Vec<_>>();
    if components.is_empty() || components.len() > MAX_DEPTH + 1 {
        return Err("native project path exceeds the depth limit".to_string());
    }
    for component in &components {
        if component.is_empty()
            || *component == "."
            || *component == ".."
            || component.ends_with(['.', ' '])
            || component
                .chars()
                .any(|character| character.is_control() || r#"<>:\"|?*"#.contains(character))
            || is_windows_reserved_name(component)
        {
            return Err("invalid native project relative path".to_string());
        }
    }
    if components[0].eq_ignore_ascii_case(".mdsh") {
        return Err("reserved native project path".to_string());
    }
    Ok(components)
}

fn is_windows_reserved_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or(component);
    let uppercase = stem.to_ascii_uppercase();
    matches!(uppercase.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || uppercase
            .strip_prefix("COM")
            .or_else(|| uppercase.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

fn cap_dir_identity(directory: &Dir) -> Result<FileIdentity, String> {
    let file = directory
        .try_clone()
        .map_err(|error| error.to_string())?
        .into_std_file();
    std_file_identity(&file)
}

fn cap_file_identity(file: &CapFile) -> Result<FileIdentity, String> {
    let file = file
        .try_clone()
        .map_err(|error| error.to_string())?
        .into_std();
    std_file_identity(&file)
}

fn cap_file_metadata(file: &CapFile) -> Result<fs::Metadata, String> {
    let file = file
        .try_clone()
        .map_err(|error| error.to_string())?
        .into_std();
    file.metadata().map_err(|error| error.to_string())
}

fn open_project_root(session: &ProjectSession) -> Result<Dir, String> {
    validate_root(&session.path, &session.identity)?;
    let root = Dir::open_ambient_dir(&session.path, ambient_authority())
        .map_err(|error| error.to_string())?;
    if cap_dir_identity(&root)? != session.identity {
        return Err("native project root changed since approval".to_string());
    }
    Ok(root)
}

fn open_child_parent(
    session: &ProjectSession,
    relative_path: &str,
    create_parents: bool,
) -> Result<ProjectChild, String> {
    let components = relative_components(relative_path)?;
    let mut parent = open_project_root(session)?;
    let mut parent_relative = PathBuf::new();
    for component in &components[..components.len() - 1] {
        let next = match parent.open_dir_nofollow(component) {
            Ok(directory) => directory,
            Err(error) if error.kind() == ErrorKind::NotFound && create_parents => {
                match parent.create_dir(component) {
                    Ok(()) => {}
                    Err(create_error) if create_error.kind() == ErrorKind::AlreadyExists => {}
                    Err(create_error) => return Err(create_error.to_string()),
                }
                parent
                    .open_dir_nofollow(component)
                    .map_err(|error| error.to_string())?
            }
            Err(error) => return Err(error.to_string()),
        };
        parent = next;
        parent_relative.push(component);
    }
    let name = OsString::from(components[components.len() - 1]);
    Ok(ProjectChild {
        parent,
        parent_relative,
        name,
        absolute: session.path.join(relative_path),
    })
}

fn reopen_child_parent(session: &ProjectSession, child: &ProjectChild) -> Result<Dir, String> {
    let mut parent = open_project_root(session)?;
    for component in child.parent_relative.components() {
        let Component::Normal(component) = component else {
            return Err("invalid native project parent path".to_string());
        };
        parent = parent
            .open_dir_nofollow(component)
            .map_err(|error| error.to_string())?;
    }
    if cap_dir_identity(&parent)? != cap_dir_identity(&child.parent)? {
        return Err("native project parent changed during access".to_string());
    }
    Ok(parent)
}

fn open_child_file(child: &ProjectChild) -> std::io::Result<CapFile> {
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    child.parent.open_with(&child.name, &options)
}

fn child_state(child: &ProjectChild) -> Result<Option<(FileIdentity, String)>, String> {
    let file = match open_child_file(child) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let identity = cap_file_identity(&file)?;
    let revision = revision_for_cap_file(file)?;
    Ok(Some((identity, revision)))
}

fn extension(path: &Path) -> Result<String, String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "native project entry has no extension".to_string())
}

fn entry_kind(path: &Path) -> Result<EntryKind, String> {
    let extension = extension(path)?;
    if MARKDOWN_EXTENSIONS.contains(&extension.as_str()) {
        Ok(EntryKind::Markdown)
    } else if ASSET_EXTENSIONS.contains(&extension.as_str()) {
        Ok(EntryKind::Asset)
    } else {
        Err(format!(
            "native project extension is not supported: .{extension}"
        ))
    }
}

fn mime_for(path: &Path, kind: EntryKind) -> Result<&'static str, String> {
    if kind == EntryKind::Markdown {
        return if extension(path)? == "txt" {
            Ok("text/plain")
        } else {
            Ok("text/markdown")
        };
    }
    match extension(path)?.as_str() {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        "avif" => Ok("image/avif"),
        "svg" => Ok("image/svg+xml"),
        _ => Err("native project asset type is not supported".to_string()),
    }
}

fn revision_for_bytes(contents: &[u8]) -> String {
    let digest = Sha256::digest(contents);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut revision = String::with_capacity(7 + digest.len() * 2);
    revision.push_str("sha256:");
    for byte in digest {
        revision.push(char::from(HEX[usize::from(byte >> 4)]));
        revision.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    revision
}

fn revision_for_cap_file(mut file: CapFile) -> Result<String, String> {
    let metadata = cap_file_metadata(&file)?;
    if !metadata.is_file() || metadata.len() > MAX_MARKDOWN_BYTES {
        return Err("native project revision target is invalid or too large".to_string());
    }
    let mut contents = Vec::with_capacity(metadata.len().try_into().unwrap_or(0));
    Read::by_ref(&mut file)
        .take(MAX_MARKDOWN_BYTES + 1)
        .read_to_end(&mut contents)
        .map_err(|error| error.to_string())?;
    if contents.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err("native project revision target is too large".to_string());
    }
    Ok(revision_for_bytes(&contents))
}

fn read_entry(session: &ProjectSession, relative_path: &str) -> Result<ProjectEntry, String> {
    let child = open_child_parent(session, relative_path, false)?;
    let kind = entry_kind(&child.absolute)?;
    let mut file = open_child_file(&child).map_err(|error| error.to_string())?;
    let metadata = cap_file_metadata(&file)?;
    let expected_identity = cap_file_identity(&file)?;
    if !metadata.is_file() {
        return Err("native project entry changed during read".to_string());
    }
    let limit = if kind == EntryKind::Markdown {
        MAX_MARKDOWN_BYTES
    } else {
        MAX_ASSET_BYTES
    };
    if metadata.len() > limit {
        return Err("native project entry exceeds its size limit".to_string());
    }
    let mut contents = Vec::with_capacity(metadata.len().try_into().unwrap_or(0));
    Read::by_ref(&mut file)
        .take(limit + 1)
        .read_to_end(&mut contents)
        .map_err(|error| error.to_string())?;
    if contents.len() as u64 > limit {
        return Err("native project entry exceeds its size limit".to_string());
    }
    #[cfg(feature = "native-smoke")]
    crate::disk_gate::wait(&child.absolute, "project-read")?;
    reopen_child_parent(session, &child)?;
    let current = open_child_file(&child).map_err(|error| error.to_string())?;
    if cap_file_identity(&current)? != expected_identity {
        return Err("native project entry changed during read".to_string());
    }
    if revision_for_cap_file(current)? != revision_for_bytes(&contents) {
        return Err("native project entry changed during read".to_string());
    }
    let content = if kind == EntryKind::Markdown {
        let content = String::from_utf8(contents.clone())
            .map_err(|_| "native Markdown entry is not UTF-8".to_string())?;
        if content
            .chars()
            .any(|character| (character as u32) < 32 && !matches!(character, '\t' | '\n' | '\r'))
        {
            return Err("native Markdown entry contains binary controls".to_string());
        }
        Some(content)
    } else {
        None
    };
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    let size = contents.len() as u64;
    let revision = revision_for_bytes(&contents);
    Ok(ProjectEntry {
        kind: if kind == EntryKind::Markdown {
            "markdown"
        } else {
            "asset"
        },
        relative_path: relative_path.to_string(),
        mime: mime_for(&child.absolute, kind)?,
        content,
        bytes: (kind == EntryKind::Asset).then_some(contents),
        mtime_ms,
        size,
        revision,
    })
}

fn collect_relative_paths(
    directory: &Dir,
    prefix: &Path,
    depth: usize,
    paths: &mut Vec<String>,
) -> Result<(), String> {
    let mut children = directory
        .entries()
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let name = child.file_name();
        let name_utf8 = name.to_str().ok_or("native project path is not UTF-8")?;
        let file_type = child.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let relative = prefix.join(name_utf8);
        if file_type.is_dir() {
            if depth == 0 && name_utf8.eq_ignore_ascii_case(".mdsh") {
                continue;
            }
            if depth >= MAX_DEPTH {
                return Err(format!(
                    "native project exceeds the depth limit of {MAX_DEPTH}"
                ));
            }
            let nested = directory
                .open_dir_nofollow(&name)
                .map_err(|error| error.to_string())?;
            collect_relative_paths(&nested, &relative, depth + 1, paths)?;
            continue;
        }
        if file_type.is_file() && entry_kind(&relative).is_ok() {
            if paths.len() >= MAX_ENTRIES {
                return Err(format!(
                    "native project contains more than {MAX_ENTRIES} supported entries"
                ));
            }
            paths.push(
                relative
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/"),
            );
        }
    }
    Ok(())
}

fn collect_snapshot(session: &ProjectSession) -> Result<Vec<ProjectEntry>, String> {
    let root = open_project_root(session)?;
    let mut paths = Vec::new();
    collect_relative_paths(&root, Path::new(""), 0, &mut paths)?;
    paths.sort();
    let markdown_count = paths
        .iter()
        .filter(|path| entry_kind(Path::new(path)).ok() == Some(EntryKind::Markdown))
        .count();
    if markdown_count > MAX_MARKDOWN_FILES {
        return Err(format!(
            "native project contains more than {MAX_MARKDOWN_FILES} Markdown documents"
        ));
    }
    let mut total_bytes = 0_u64;
    let mut entries = Vec::with_capacity(paths.len());
    for relative in paths {
        let entry = read_entry(session, &relative)?;
        total_bytes = total_bytes
            .checked_add(entry.size)
            .ok_or("native project snapshot size overflow")?;
        if total_bytes > MAX_SNAPSHOT_BYTES {
            return Err("native project snapshot exceeds the 64 MiB limit".to_string());
        }
        entries.push(entry);
    }
    validate_root(&session.path, &session.identity)?;
    Ok(entries)
}

fn collect_manifest(session: &ProjectSession) -> Result<Vec<ProjectManifestEntry>, String> {
    let root = open_project_root(session)?;
    let mut paths = Vec::new();
    collect_relative_paths(&root, Path::new(""), 0, &mut paths)?;
    paths.sort();
    let markdown_count = paths
        .iter()
        .filter(|path| entry_kind(Path::new(path)).ok() == Some(EntryKind::Markdown))
        .count();
    if markdown_count > MAX_MARKDOWN_FILES {
        return Err(format!(
            "native project contains more than {MAX_MARKDOWN_FILES} Markdown documents"
        ));
    }
    let mut entries = Vec::with_capacity(paths.len());
    for relative in paths {
        let child = open_child_parent(session, &relative, false)?;
        let kind = entry_kind(&child.absolute)?;
        let file = open_child_file(&child).map_err(|error| error.to_string())?;
        let metadata = cap_file_metadata(&file)?;
        if !metadata.is_file() {
            return Err("native project entry changed during manifest read".to_string());
        }
        let limit = if kind == EntryKind::Markdown {
            MAX_MARKDOWN_BYTES
        } else {
            MAX_ASSET_BYTES
        };
        if metadata.len() > limit {
            return Err("native project entry exceeds its size limit".to_string());
        }
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        entries.push(ProjectManifestEntry {
            kind: if kind == EntryKind::Markdown {
                "markdown"
            } else {
                "asset"
            },
            relative_path: relative,
            mtime_ms,
            size: metadata.len(),
        });
    }
    validate_root(&session.path, &session.identity)?;
    Ok(entries)
}

fn manifest(token: String, session: ProjectSession) -> Result<ProjectManifest, String> {
    let entries = collect_manifest(&session)?;
    Ok(ProjectManifest {
        root_id: session.root_id,
        token,
        entries,
    })
}

fn snapshot(token: String, session: ProjectSession) -> Result<ProjectSnapshot, String> {
    let name = session
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Project")
        .to_string();
    let entries = collect_snapshot(&session)?;
    Ok(ProjectSnapshot {
        root_id: session.root_id,
        token,
        name,
        entries,
    })
}

fn current_revision(path: &Path) -> Result<String, String> {
    reject_symlink(path)?;
    let expected_identity = file_identity(path)?;
    let file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file()
        || std_file_identity(&file)? != expected_identity
        || metadata.len() > MAX_MARKDOWN_BYTES
    {
        return Err("native project revision target is invalid or too large".to_string());
    }
    let mut contents = Vec::new();
    file.take(MAX_MARKDOWN_BYTES + 1)
        .read_to_end(&mut contents)
        .map_err(|error| error.to_string())?;
    if contents.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err("native project revision target is too large".to_string());
    }
    reject_symlink(path)?;
    if file_identity(path)? != expected_identity {
        return Err("native project revision target changed during read".to_string());
    }
    Ok(revision_for_bytes(&contents))
}

fn verify_expected_revision(path: &Path, expected: Option<&str>) -> Result<(), String> {
    match (expected, fs::symlink_metadata(path)) {
        (None, Err(error)) if error.kind() == ErrorKind::NotFound => Ok(()),
        (None, _) => Err("native project create target already exists".to_string()),
        (Some(_), Err(error)) if error.kind() == ErrorKind::NotFound => {
            Err("native project write target is missing".to_string())
        }
        (Some(_), Ok(metadata)) if metadata.file_type().is_symlink() => {
            Err("symbolic links are not accepted in native projects".to_string())
        }
        (Some(expected), Ok(metadata)) if metadata.is_file() => {
            if current_revision(path)? == expected {
                Ok(())
            } else {
                Err("native project conflict: entry changed since refresh".to_string())
            }
        }
        (Some(_), Ok(_)) => Err("native project entry is not a regular file".to_string()),
        (_, Err(error)) => Err(error.to_string()),
    }
}

fn temporary_path(path: &Path) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or("native project entry has no parent")?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("native project filename is invalid")?;
    Ok(parent.join(format!(".{name}.{}.tmp", Uuid::new_v4())))
}

fn sync_parent(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        if let Some(parent) = _path.parent() {
            File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn replace_existing(temp: &Path, target: &Path) -> Result<(), String> {
    fs::rename(temp, target).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn replace_existing(temp: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let temp_wide: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temp_wide.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

fn install_new_file(temp: &Path, target: &Path) -> Result<(), String> {
    fs::hard_link(temp, target).map_err(|error| error.to_string())?;
    fs::remove_file(temp).map_err(|error| error.to_string())
}

fn atomic_registry_replace(
    target: &Path,
    contents: &[u8],
    expected_revision: Option<&str>,
) -> Result<(), String> {
    reject_symlink(target)?;
    verify_expected_revision(target, expected_revision)?;
    let parent = target
        .parent()
        .ok_or("native project entry has no parent")?;
    let parent_identity = directory_identity(parent)?;
    let temp = temporary_path(target)?;
    let result = (|| {
        let mut options = StdOpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|error| error.to_string())?;
        if let Ok(metadata) = fs::metadata(target) {
            fs::set_permissions(&temp, metadata.permissions())
                .map_err(|error| error.to_string())?;
        }
        file.write_all(contents)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        if directory_identity(parent)? != parent_identity {
            return Err("native project parent changed during write".to_string());
        }
        reject_symlink(target)?;
        verify_expected_revision(target, expected_revision)?;
        if expected_revision.is_some() {
            replace_existing(&temp, target)?;
        } else {
            install_new_file(&temp, target)?;
        }
        sync_parent(target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn sync_cap_directory(_directory: &Dir) -> Result<(), String> {
    #[cfg(unix)]
    {
        _directory
            .open(".")
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn project_temp_name(name: &OsStr) -> Result<OsString, String> {
    let name = name.to_str().ok_or("native project filename is invalid")?;
    Ok(OsString::from(format!(".{name}.{}.tmp", Uuid::new_v4())))
}

fn expected_child_identity(
    child: &ProjectChild,
    expected_revision: Option<&str>,
) -> Result<Option<FileIdentity>, String> {
    open_expected_child(child, expected_revision).map(|(identity, _file)| identity)
}

fn open_expected_child(
    child: &ProjectChild,
    expected_revision: Option<&str>,
) -> Result<(Option<FileIdentity>, Option<CapFile>), String> {
    let file = match open_child_file(child) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return if expected_revision.is_none() {
                Ok((None, None))
            } else {
                Err("native project write target is missing".to_string())
            };
        }
        Err(error) => return Err(error.to_string()),
    };
    let Some(expected_revision) = expected_revision else {
        return Err("native project create target already exists".to_string());
    };
    let identity = cap_file_identity(&file)?;
    let revision = revision_for_cap_file(file.try_clone().map_err(|error| error.to_string())?)?;
    if revision != expected_revision {
        return Err("native project conflict: entry changed since refresh".to_string());
    }
    Ok((Some(identity), Some(file)))
}

fn atomic_project_replace(
    session: &ProjectSession,
    relative_path: &str,
    contents: &[u8],
    expected_revision: Option<&str>,
) -> Result<(), String> {
    let child = open_child_parent(session, relative_path, expected_revision.is_none())?;
    let parent_identity = cap_dir_identity(&child.parent)?;
    let (expected_identity, expected_file) = open_expected_child(&child, expected_revision)?;
    let existing_permissions = expected_file
        .as_ref()
        .map(|file| {
            file.metadata()
                .map_err(|error| error.to_string())
                .map(|metadata| metadata.permissions())
        })
        .transpose()?;
    let temp_name = project_temp_name(&child.name)?;
    let result = (|| {
        let mut options = CapOpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = child
            .parent
            .open_with(&temp_name, &options)
            .map_err(|error| error.to_string())?;
        if let Some(permissions) = existing_permissions {
            file.set_permissions(permissions)
                .map_err(|error| error.to_string())?;
        }
        file.write_all(contents)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        #[cfg(feature = "native-smoke")]
        crate::disk_gate::wait(&child.absolute, "project-staged")?;
        reopen_child_parent(session, &child)?;
        if cap_dir_identity(&child.parent)? != parent_identity {
            return Err("native project parent changed during write".to_string());
        }
        let current_identity = expected_child_identity(&child, expected_revision)?;
        if current_identity != expected_identity {
            return Err("native project entry was replaced during write".to_string());
        }
        if expected_identity.is_some() {
            child
                .parent
                .rename(&temp_name, &child.parent, &child.name)
                .map_err(|error| error.to_string())?;
        } else {
            child
                .parent
                .hard_link(&temp_name, &child.parent, &child.name)
                .map_err(|error| {
                    format!(
                        "native project filesystem cannot install a new file without replacement: {error}"
                    )
                })?;
            child
                .parent
                .remove_file(&temp_name)
                .map_err(|error| error.to_string())?;
        }
        sync_cap_directory(&child.parent)
    })();
    drop(expected_file);
    if result.is_err() {
        let _ = child.parent.remove_file(&temp_name);
    }
    result
}

fn write_entry(
    session: &ProjectSession,
    relative_path: &str,
    contents: &[u8],
    expected_revision: Option<&str>,
    expected_kind: EntryKind,
) -> Result<ProjectEntry, String> {
    relative_components(relative_path)?;
    if entry_kind(Path::new(relative_path))? != expected_kind {
        return Err("native project entry type does not match the write command".to_string());
    }
    let limit = if expected_kind == EntryKind::Markdown {
        MAX_MARKDOWN_BYTES
    } else {
        MAX_ASSET_BYTES
    };
    if contents.len() as u64 > limit {
        return Err("native project entry exceeds its size limit".to_string());
    }
    if expected_kind == EntryKind::Markdown {
        let content = std::str::from_utf8(contents)
            .map_err(|_| "native Markdown entry is not UTF-8".to_string())?;
        if content
            .chars()
            .any(|character| (character as u32) < 32 && !matches!(character, '\t' | '\n' | '\r'))
        {
            return Err("native Markdown entry contains binary controls".to_string());
        }
    }
    let entries = collect_snapshot(session)?;
    let old_size = entries
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .map(|entry| entry.size)
        .unwrap_or(0);
    if expected_revision.is_none() {
        if entries.len() >= MAX_ENTRIES {
            return Err("native project has reached its entry limit".to_string());
        }
        if expected_kind == EntryKind::Markdown
            && entries
                .iter()
                .filter(|entry| entry.kind == "markdown")
                .count()
                >= MAX_MARKDOWN_FILES
        {
            return Err("native project has reached its Markdown document limit".to_string());
        }
    }
    let new_total = entries
        .iter()
        .map(|entry| entry.size)
        .sum::<u64>()
        .saturating_sub(old_size)
        .checked_add(contents.len() as u64)
        .ok_or("native project snapshot size overflow")?;
    if new_total > MAX_SNAPSHOT_BYTES {
        return Err("native project snapshot exceeds the 64 MiB limit".to_string());
    }
    atomic_project_replace(session, relative_path, contents, expected_revision)?;
    read_entry(session, relative_path)
}

fn rename_entry(
    session: &ProjectSession,
    from_path: &str,
    to_path: &str,
    expected_revision: &str,
) -> Result<ProjectEntry, String> {
    relative_components(from_path)?;
    relative_components(to_path)?;
    let kind = entry_kind(Path::new(from_path))?;
    if entry_kind(Path::new(to_path))? != kind {
        return Err("native project rename must keep the entry type".to_string());
    }
    if from_path == to_path {
        return read_entry(session, from_path);
    }
    let source = open_child_parent(session, from_path, false)?;
    let target = open_child_parent(session, to_path, true)?;
    let (source_identity, source_file) = open_expected_child(&source, Some(expected_revision))?;
    let source_identity = source_identity.ok_or("native project rename source is missing")?;
    let source_file = source_file.ok_or("native project rename source is missing")?;
    let source_parent_identity = cap_dir_identity(&source.parent)?;
    let target_parent_identity = cap_dir_identity(&target.parent)?;
    if let Some((target_identity, _)) = child_state(&target)? {
        if target_identity == source_identity && source_parent_identity == target_parent_identity {
            reopen_child_parent(session, &source)?;
            reopen_child_parent(session, &target)?;
            source
                .parent
                .rename(&source.name, &target.parent, &target.name)
                .map_err(|error| error.to_string())?;
            sync_cap_directory(&source.parent)?;
            drop(source_file);
            return read_entry(session, to_path);
        }
        return Err("native project create target already exists".to_string());
    }
    reopen_child_parent(session, &source)?;
    reopen_child_parent(session, &target)?;
    if cap_dir_identity(&source.parent)? != source_parent_identity
        || cap_dir_identity(&target.parent)? != target_parent_identity
        || expected_child_identity(&source, Some(expected_revision))?
            != Some(source_identity.clone())
        || child_state(&target)?.is_some()
    {
        return Err("native project path changed during rename".to_string());
    }
    source
        .parent
        .hard_link(&source.name, &target.parent, &target.name)
        .map_err(|error| {
            format!("native project filesystem cannot rename without replacement: {error}")
        })?;
    let result = (|| {
        reopen_child_parent(session, &source)?;
        reopen_child_parent(session, &target)?;
        if expected_child_identity(&source, Some(expected_revision))?
            != Some(source_identity.clone())
            || child_state(&target)?.map(|state| state.0) != Some(source_identity.clone())
        {
            return Err("native project source changed during rename".to_string());
        }
        if cap_dir_identity(&source.parent)? != source_parent_identity
            || cap_dir_identity(&target.parent)? != target_parent_identity
        {
            return Err("native project parent changed during rename".to_string());
        }
        source
            .parent
            .remove_file(&source.name)
            .map_err(|error| error.to_string())?;
        sync_cap_directory(&source.parent)?;
        if source_parent_identity != target_parent_identity {
            sync_cap_directory(&target.parent)?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = target.parent.remove_file(&target.name);
    }
    drop(source_file);
    result?;
    read_entry(session, to_path)
}

#[cfg(feature = "native-smoke")]
fn smoke_project_root() -> Option<PathBuf> {
    std::env::var_os("MDSH_NATIVE_PROJECT_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn pick_project_root(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    #[cfg(feature = "native-smoke")]
    if let Some(path) = smoke_project_root() {
        return Ok(Some(path));
    }
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| path.into_path().map_err(|error| error.to_string()))
        .transpose()
}

#[tauri::command]
pub async fn project_pick_root(
    app: tauri::AppHandle,
    projects: tauri::State<'_, ProjectStore>,
) -> Result<Option<ProjectSnapshot>, String> {
    let Some(path) = pick_project_root(&app)? else {
        return Ok(None);
    };
    let (token, session) = projects.selected_root(path)?;
    snapshot(token, session).map(Some)
}

#[tauri::command]
pub async fn project_open_root(
    projects: tauri::State<'_, ProjectStore>,
    root_id: String,
) -> Result<ProjectSnapshot, String> {
    let (token, session) = projects.open(&root_id)?;
    tauri::async_runtime::spawn_blocking(move || snapshot(token, session))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_refresh(
    projects: tauri::State<'_, ProjectStore>,
    token: String,
) -> Result<ProjectSnapshot, String> {
    let session = projects.resolve(&token)?;
    tauri::async_runtime::spawn_blocking(move || snapshot(token, session))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_manifest(
    projects: tauri::State<'_, ProjectStore>,
    token: String,
) -> Result<ProjectManifest, String> {
    let session = projects.resolve(&token)?;
    tauri::async_runtime::spawn_blocking(move || manifest(token, session))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_read(
    projects: tauri::State<'_, ProjectStore>,
    token: String,
    relative_path: String,
) -> Result<ProjectEntry, String> {
    let session = projects.resolve(&token)?;
    tauri::async_runtime::spawn_blocking(move || read_entry(&session, &relative_path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_write_text(
    projects: tauri::State<'_, ProjectStore>,
    token: String,
    relative_path: String,
    content: String,
    expected_revision: Option<String>,
) -> Result<ProjectEntry, String> {
    let session = projects.resolve(&token)?;
    tauri::async_runtime::spawn_blocking(move || {
        write_entry(
            &session,
            &relative_path,
            content.as_bytes(),
            expected_revision.as_deref(),
            EntryKind::Markdown,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_write_asset(
    projects: tauri::State<'_, ProjectStore>,
    token: String,
    relative_path: String,
    contents: Vec<u8>,
    expected_revision: Option<String>,
) -> Result<ProjectEntry, String> {
    let session = projects.resolve(&token)?;
    tauri::async_runtime::spawn_blocking(move || {
        write_entry(
            &session,
            &relative_path,
            &contents,
            expected_revision.as_deref(),
            EntryKind::Asset,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_rename(
    projects: tauri::State<'_, ProjectStore>,
    token: String,
    from_path: String,
    to_path: String,
    expected_revision: String,
) -> Result<ProjectEntry, String> {
    let session = projects.resolve(&token)?;
    tauri::async_runtime::spawn_blocking(move || {
        rename_entry(&session, &from_path, &to_path, &expected_revision)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_revoke(
    projects: tauri::State<'_, ProjectStore>,
    token: String,
) -> Result<(), String> {
    projects.revoke(&token)
}
