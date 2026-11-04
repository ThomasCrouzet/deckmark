//! Lightweight Git integration for authorized native project roots.
//!
//! Every command resolves a persistent grant identifier through
//! `ProjectStore::authorize`. JavaScript never supplies an absolute path.
//! Git runs without a shell, with explicit arguments, a bounded run time,
//! and a bounded output size.

use crate::projects::ProjectStore;
use serde::Serialize;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_COMMIT_MESSAGE_CHARS: usize = 2000;
const MAX_PATHS: usize = 500;
const MAX_PATH_BYTES: usize = 4096;
const MAX_LOG_LIMIT: usize = 100;
const MAX_NESTED_DEPTH: usize = 4;
const MAX_NESTED_SCAN: usize = 2000;

/// Variables that Git needs to find itself and the user configuration.
/// The child process gets no other inherited variable, so credentials in the
/// parent environment cannot reach Git.
const SAFE_ENVIRONMENT: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
    "TZ",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    repository: &'static str,
    repository_name: Option<String>,
    branch: Option<String>,
    head: Option<String>,
    detached: bool,
    initial: bool,
    clean: bool,
    dirty: bool,
    conflicts: Vec<String>,
    nested_repositories: Vec<String>,
    nested_scan_truncated: bool,
    outside_changes: usize,
    files: Vec<GitFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    path: String,
    original_path: Option<String>,
    index: char,
    worktree: char,
    untracked: bool,
    conflicted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    hash: String,
    short_hash: String,
    author: String,
    timestamp: i64,
    subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    hash: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RepositoryKind {
    SelfRepository,
    ParentRepository,
}

struct Repository {
    kind: RepositoryKind,
    name: Option<String>,
}

struct GitRun {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn safe_environment() -> Vec<(String, std::ffi::OsString)> {
    SAFE_ENVIRONMENT
        .iter()
        .filter_map(|name| std::env::var_os(name).map(|value| ((*name).to_string(), value)))
        .collect()
}

fn git_command(cwd: &Path) -> Command {
    let mut command = Command::new("git");
    command.env_clear();
    for (name, value) in safe_environment() {
        command.env(name, value);
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let disabled_hooks = std::env::temp_dir().join(format!("mdsh-git-hooks-{}", Uuid::new_v4()));
    command
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(cwd)
        .arg("-c")
        .arg("core.quotepath=false")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg(format!(
            "core.hooksPath={}",
            disabled_hooks.to_string_lossy()
        ))
        .arg("-c")
        .arg("commit.gpgSign=false");
    command
}

fn read_bounded<R: Read>(mut reader: R) -> Result<(Vec<u8>, bool), String> {
    let mut buffer = Vec::new();
    {
        let mut limited = (&mut reader).take((MAX_OUTPUT_BYTES + 1) as u64);
        limited
            .read_to_end(&mut buffer)
            .map_err(|error| error.to_string())?;
    }
    let exceeded = buffer.len() > MAX_OUTPUT_BYTES;
    if exceeded {
        buffer.truncate(MAX_OUTPUT_BYTES);
        io::copy(&mut reader, &mut io::sink()).map_err(|error| error.to_string())?;
    }
    Ok((buffer, exceeded))
}

fn wait_with_timeout(child: &mut Child) -> Result<ExitStatus, String> {
    let deadline = Instant::now() + GIT_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Git command timed out after 10 seconds".to_string());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn run_git(cwd: &Path, args: &[String]) -> Result<GitRun, String> {
    let mut child = git_command(cwd)
        .args(args)
        .spawn()
        .map_err(|error| format!("Cannot start Git: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Git standard output is unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Git standard error is unavailable")?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout));
    let stderr_reader = thread::spawn(move || read_bounded(stderr));
    let status = wait_with_timeout(&mut child)?;
    let (stdout, stdout_exceeded) = stdout_reader
        .join()
        .map_err(|_| "Git output reader failed".to_string())??;
    let (stderr, stderr_exceeded) = stderr_reader
        .join()
        .map_err(|_| "Git error reader failed".to_string())??;
    if stdout_exceeded || stderr_exceeded {
        return Err("Git output exceeds the 1 MiB limit".to_string());
    }
    Ok(GitRun {
        status,
        stdout,
        stderr,
    })
}

fn git_error(run: &GitRun) -> String {
    let text = String::from_utf8_lossy(&run.stderr);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        format!("Git command failed with status {}", run.status)
    } else {
        trimmed.chars().take(MAX_COMMIT_MESSAGE_CHARS).collect()
    }
}

fn run_checked(cwd: &Path, args: &[String]) -> Result<Vec<u8>, String> {
    let run = run_git(cwd, args)?;
    if run.status.success() {
        Ok(run.stdout)
    } else {
        Err(git_error(&run))
    }
}

fn utf8_output(output: Vec<u8>) -> Result<String, String> {
    String::from_utf8(output).map_err(|_| "Git output is not UTF-8".to_string())
}

fn validate_git_relative_path(raw: &str) -> Result<(), String> {
    if raw.is_empty()
        || raw.len() > MAX_PATH_BYTES
        || raw.starts_with('/')
        || raw.ends_with('/')
        || raw.contains('\\')
        || raw.contains('\0')
    {
        return Err("Invalid project-relative Git path".to_string());
    }
    if Path::new(raw).is_absolute() {
        return Err("Invalid project-relative Git path".to_string());
    }
    for component in raw.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err("Invalid project-relative Git path".to_string());
        }
        if component.eq_ignore_ascii_case(".git") {
            return Err("Git metadata paths are not accepted".to_string());
        }
        if component.chars().any(char::is_control) {
            return Err("Invalid project-relative Git path".to_string());
        }
        #[cfg(windows)]
        if component.contains(':') {
            return Err("Invalid project-relative Git path".to_string());
        }
    }
    Ok(())
}

fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() || paths.len() > MAX_PATHS {
        return Err("Select between 1 and 500 files".to_string());
    }
    for path in paths {
        validate_git_relative_path(path)?;
    }
    Ok(())
}

fn git_toplevel(root: &Path) -> Result<PathBuf, String> {
    let output = run_checked(
        root,
        &["rev-parse".to_string(), "--show-toplevel".to_string()],
    )?;
    let text = utf8_output(output)?;
    let value = text.trim();
    if value.is_empty() {
        return Err("The project root is not a Git repository".to_string());
    }
    let path = PathBuf::from(value);
    path.canonicalize()
        .map_err(|_| "The Git repository root is unavailable".to_string())
}

fn inspect_repository(root: &Path) -> Result<Repository, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "The project root is unavailable".to_string())?;
    let metadata = match fs::symlink_metadata(root.join(".git")) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    if let Some(metadata) = metadata {
        if metadata.file_type().is_symlink() {
            return Err("Git metadata is a symbolic link and is not accepted".to_string());
        }
        if !metadata.is_dir() && !metadata.is_file() {
            return Err("Git metadata is not a directory or a file".to_string());
        }
        let toplevel = git_toplevel(root)?;
        if toplevel != canonical_root {
            return Err("The Git repository root does not match the project root".to_string());
        }
        return Ok(Repository {
            kind: RepositoryKind::SelfRepository,
            name: None,
        });
    }
    let toplevel = git_toplevel(root)?;
    if toplevel == canonical_root {
        return Ok(Repository {
            kind: RepositoryKind::SelfRepository,
            name: None,
        });
    }
    let name = toplevel
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string);
    Ok(Repository {
        kind: RepositoryKind::ParentRepository,
        name,
    })
}

fn require_self_repository(root: &Path) -> Result<Repository, String> {
    let repository = inspect_repository(root)?;
    if repository.kind == RepositoryKind::ParentRepository {
        return Err(
            "The Git repository is a parent of the project root. Stage and commit need a repository at the project root."
                .to_string(),
        );
    }
    Ok(repository)
}

fn is_inside_root(path: &str) -> bool {
    !path.starts_with('/')
        && path
            .split('/')
            .all(|component| !component.is_empty() && component != "." && component != "..")
}

fn status_path(path: &str, confined: bool, outside_changes: &mut usize) -> Option<String> {
    if confined && !is_inside_root(path) {
        *outside_changes += 1;
        return None;
    }
    Some(path.to_string())
}

#[derive(Default)]
struct StatusHeader {
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
    initial: bool,
}

fn parse_status_header(line: &str, header: &mut StatusHeader) {
    if let Some(value) = line.strip_prefix("branch.oid ") {
        if value == "(initial)" {
            header.initial = true;
        } else {
            header.head = Some(value.to_string());
        }
    } else if let Some(value) = line.strip_prefix("branch.head ") {
        if value == "(detached)" {
            header.detached = true;
        } else {
            header.branch = Some(value.to_string());
        }
    }
}

fn status_flags(value: &str) -> Result<(char, char), String> {
    let mut characters = value.chars();
    let index = characters
        .next()
        .ok_or("Git status has no index flag".to_string())?;
    let worktree = characters
        .next()
        .ok_or("Git status has no worktree flag".to_string())?;
    Ok((index, worktree))
}

fn parse_status(
    output: &[u8],
    confined: bool,
) -> Result<(StatusHeader, Vec<GitFile>, Vec<String>, usize), String> {
    let text = std::str::from_utf8(output)
        .map_err(|_| "Git status contains a path that is not UTF-8".to_string())?;
    let mut tokens = text.split('\0');
    let mut header = StatusHeader::default();
    let mut files = Vec::new();
    let mut conflicts = Vec::new();
    let mut outside_changes = 0;
    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        if let Some(line) = token.strip_prefix("# ") {
            parse_status_header(line, &mut header);
            continue;
        }
        match token.as_bytes().first().copied() {
            Some(b'1') => {
                let fields: Vec<&str> = token.splitn(9, ' ').collect();
                if fields.len() != 9 {
                    continue;
                }
                let Some(path) = status_path(fields[8], confined, &mut outside_changes) else {
                    continue;
                };
                let (index, worktree) = status_flags(fields[1])?;
                files.push(GitFile {
                    path,
                    original_path: None,
                    index,
                    worktree,
                    untracked: false,
                    conflicted: false,
                });
            }
            Some(b'2') => {
                let fields: Vec<&str> = token.splitn(10, ' ').collect();
                if fields.len() != 10 {
                    continue;
                }
                let Some(original_path) = tokens.next() else {
                    continue;
                };
                let Some(path) = status_path(fields[9], confined, &mut outside_changes) else {
                    continue;
                };
                let Some(original_path) =
                    status_path(original_path, confined, &mut outside_changes)
                else {
                    continue;
                };
                let (index, worktree) = status_flags(fields[1])?;
                files.push(GitFile {
                    path,
                    original_path: Some(original_path),
                    index,
                    worktree,
                    untracked: false,
                    conflicted: false,
                });
            }
            Some(b'u') => {
                let fields: Vec<&str> = token.splitn(11, ' ').collect();
                if fields.len() != 11 {
                    continue;
                }
                let Some(path) = status_path(fields[10], confined, &mut outside_changes) else {
                    continue;
                };
                let (index, worktree) = status_flags(fields[1])?;
                conflicts.push(path.clone());
                files.push(GitFile {
                    path,
                    original_path: None,
                    index,
                    worktree,
                    untracked: false,
                    conflicted: true,
                });
            }
            Some(b'?') => {
                let path = token.get(2..).unwrap_or_default();
                let Some(path) = status_path(path, confined, &mut outside_changes) else {
                    continue;
                };
                files.push(GitFile {
                    path,
                    original_path: None,
                    index: '?',
                    worktree: '?',
                    untracked: true,
                    conflicted: false,
                });
            }
            Some(b'!') => {}
            _ => {}
        }
    }
    Ok((header, files, conflicts, outside_changes))
}

fn scan_nested_repositories(root: &Path) -> (Vec<String>, bool) {
    let mut repositories = Vec::new();
    let mut scanned = 0;
    let mut truncated = false;
    scan_nested_directory(
        root,
        Path::new(""),
        0,
        &mut repositories,
        &mut scanned,
        &mut truncated,
    );
    repositories.sort();
    (repositories, truncated)
}

fn scan_nested_directory(
    directory: &Path,
    prefix: &Path,
    depth: usize,
    repositories: &mut Vec<String>,
    scanned: &mut usize,
    truncated: &mut bool,
) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if *scanned >= MAX_NESTED_SCAN {
            *truncated = true;
            return;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.eq_ignore_ascii_case(".git") {
            continue;
        }
        *scanned += 1;
        let child = entry.path();
        let relative = prefix.join(name);
        if fs::symlink_metadata(child.join(".git")).is_ok() {
            repositories.push(relative.to_string_lossy().replace('\\', "/"));
            continue;
        }
        if depth < MAX_NESTED_DEPTH {
            scan_nested_directory(
                &child,
                &relative,
                depth + 1,
                repositories,
                scanned,
                truncated,
            );
        }
    }
}

fn status_for_root(root: &Path) -> Result<GitStatus, String> {
    let repository = inspect_repository(root)?;
    let args = [
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=all",
        "-z",
    ]
    .map(str::to_string);
    let output = run_checked(root, &args)?;
    let confined = repository.kind == RepositoryKind::ParentRepository;
    let (header, files, conflicts, outside_changes) = parse_status(&output, confined)?;
    let dirty = files
        .iter()
        .any(|file| file.untracked || file.conflicted || file.worktree != '.');
    let (nested_repositories, nested_scan_truncated) = scan_nested_repositories(root);
    Ok(GitStatus {
        repository: if repository.kind == RepositoryKind::SelfRepository {
            "self"
        } else {
            "parent"
        },
        repository_name: repository.name,
        branch: header.branch,
        head: header.head,
        detached: header.detached,
        initial: header.initial,
        clean: files.is_empty() && conflicts.is_empty(),
        dirty,
        conflicts,
        nested_repositories,
        nested_scan_truncated,
        outside_changes,
        files,
    })
}

fn diff_for_root(root: &Path, path: Option<&str>, staged: bool) -> Result<String, String> {
    if let Some(path) = path {
        validate_git_relative_path(path)?;
    }
    inspect_repository(root)?;
    let mut args = vec!["diff".to_string()];
    if staged {
        args.push("--cached".to_string());
    }
    for flag in [
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--unified=3",
    ] {
        args.push(flag.to_string());
    }
    args.push("--".to_string());
    match path {
        Some(path) => args.push(format!(":(literal){path}")),
        None => args.push(".".to_string()),
    }
    utf8_output(run_checked(root, &args)?)
}

fn parse_commits(output: &[u8]) -> Result<Vec<GitCommit>, String> {
    let text = std::str::from_utf8(output)
        .map_err(|_| "Git log contains text that is not UTF-8".to_string())?;
    let mut fields = text.split('\0');
    let mut commits = Vec::new();
    while let Some(hash) = fields.next() {
        let hash = hash.trim_start_matches(['\n', '\r']);
        if hash.is_empty() {
            break;
        }
        let short_hash = fields.next().unwrap_or_default().to_string();
        let author = fields.next().unwrap_or_default().to_string();
        let timestamp = fields.next().unwrap_or_default().parse().unwrap_or(0);
        let subject = fields.next().unwrap_or_default().to_string();
        commits.push(GitCommit {
            hash: hash.to_string(),
            short_hash,
            author,
            timestamp,
            subject,
        });
    }
    Ok(commits)
}

fn log_for_root(root: &Path, limit: usize) -> Result<Vec<GitCommit>, String> {
    inspect_repository(root)?;
    let head = run_git(
        root,
        &[
            "rev-parse".to_string(),
            "--verify".to_string(),
            "--quiet".to_string(),
            "HEAD".to_string(),
        ],
    )?;
    if !head.status.success() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, MAX_LOG_LIMIT);
    let args = vec![
        "log".to_string(),
        format!("-n{limit}"),
        "--no-color".to_string(),
        "--no-decorate".to_string(),
        "--no-show-signature".to_string(),
        "--format=%H%x00%h%x00%an%x00%at%x00%s%x00".to_string(),
        "--".to_string(),
        ".".to_string(),
    ];
    parse_commits(&run_checked(root, &args)?)
}

fn stage_for_root(root: &Path, paths: &[String]) -> Result<(), String> {
    require_self_repository(root)?;
    validate_paths(paths)?;
    let mut args = vec!["add".to_string(), "-A".to_string(), "--".to_string()];
    args.extend(paths.iter().map(|path| format!(":(literal){path}")));
    run_checked(root, &args).map(|_| ())
}

fn unstage_for_root(root: &Path, paths: &[String]) -> Result<(), String> {
    require_self_repository(root)?;
    validate_paths(paths)?;
    let mut args = vec![
        "restore".to_string(),
        "--staged".to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().map(|path| format!(":(literal){path}")));
    run_checked(root, &args).map(|_| ())
}

fn validate_commit_message(message: &str) -> Result<String, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("The commit message is empty".to_string());
    }
    if trimmed.chars().count() > MAX_COMMIT_MESSAGE_CHARS {
        return Err("The commit message exceeds 2000 characters".to_string());
    }
    if trimmed.contains('\0') {
        return Err("The commit message contains a NUL character".to_string());
    }
    Ok(trimmed.to_string())
}

fn commit_for_root(root: &Path, message: &str) -> Result<GitCommitResult, String> {
    require_self_repository(root)?;
    let message = validate_commit_message(message)?;
    let staged = run_git(
        root,
        &[
            "diff".to_string(),
            "--cached".to_string(),
            "--quiet".to_string(),
            "--no-ext-diff".to_string(),
            "--no-textconv".to_string(),
            "--".to_string(),
            ".".to_string(),
        ],
    )?;
    match staged.status.code() {
        Some(0) => return Err("There are no staged changes to commit".to_string()),
        Some(1) => {}
        _ => return Err(git_error(&staged)),
    }
    run_checked(
        root,
        &[
            "commit".to_string(),
            "--no-verify".to_string(),
            "--quiet".to_string(),
            "-m".to_string(),
            message,
        ],
    )?;
    let hash = utf8_output(run_checked(
        root,
        &["rev-parse".to_string(), "HEAD".to_string()],
    )?)?;
    Ok(GitCommitResult {
        hash: hash.trim().to_string(),
    })
}

#[tauri::command]
pub async fn git_status(
    projects: tauri::State<'_, ProjectStore>,
    root_id: String,
) -> Result<GitStatus, String> {
    let session = projects.authorize(&root_id)?;
    status_for_root(&session.path)
}

#[tauri::command]
pub async fn git_diff(
    projects: tauri::State<'_, ProjectStore>,
    root_id: String,
    path: Option<String>,
    staged: bool,
) -> Result<String, String> {
    let session = projects.authorize(&root_id)?;
    diff_for_root(&session.path, path.as_deref(), staged)
}

#[tauri::command]
pub async fn git_log(
    projects: tauri::State<'_, ProjectStore>,
    root_id: String,
    limit: usize,
) -> Result<Vec<GitCommit>, String> {
    let session = projects.authorize(&root_id)?;
    log_for_root(&session.path, limit)
}

#[tauri::command]
pub async fn git_stage(
    projects: tauri::State<'_, ProjectStore>,
    root_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let session = projects.authorize(&root_id)?;
    stage_for_root(&session.path, &paths)
}

#[tauri::command]
pub async fn git_unstage(
    projects: tauri::State<'_, ProjectStore>,
    root_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let session = projects.authorize(&root_id)?;
    unstage_for_root(&session.path, &paths)
}

#[tauri::command]
pub async fn git_commit(
    projects: tauri::State<'_, ProjectStore>,
    root_id: String,
    message: String,
) -> Result<GitCommitResult, String> {
    let session = projects.authorize(&root_id)?;
    commit_for_root(&session.path, &message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::ProjectStore;

    struct TemporaryRepository {
        path: PathBuf,
    }

    impl Drop for TemporaryRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn temporary_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mdsh-git-{label}-{}", Uuid::new_v4()))
    }

    fn git(path: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .expect("git must be installed");
        assert!(status.success(), "git command failed: {args:?}");
    }

    fn init_repository() -> TemporaryRepository {
        let path = temporary_path("repo");
        fs::create_dir_all(&path).expect("create temporary repository");
        git(&path, &["init", "-q", "-b", "main"]);
        git(&path, &["config", "user.email", "test@example.invalid"]);
        git(&path, &["config", "user.name", "Test Author"]);
        TemporaryRepository { path }
    }

    fn write(path: &Path, name: &str, content: &str) {
        let target = path.join(name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(target, content).expect("write test file");
    }

    fn commit_all(path: &Path, message: &str) {
        git(path, &["add", "-A"]);
        git(path, &["commit", "-q", "-m", message]);
    }

    fn file<'a>(status: &'a GitStatus, path: &str) -> &'a GitFile {
        status
            .files
            .iter()
            .find(|file| file.path == path)
            .unwrap_or_else(|| panic!("missing Git status entry for {path}"))
    }

    #[test]
    fn status_reports_modified_staged_untracked_and_deleted_files() {
        let repository = init_repository();
        write(&repository.path, "modified.md", "old\n");
        write(&repository.path, "staged.md", "old\n");
        write(&repository.path, "deleted.md", "old\n");
        commit_all(&repository.path, "Initial commit");
        write(&repository.path, "modified.md", "new\n");
        write(&repository.path, "staged.md", "new\n");
        git(&repository.path, &["add", "staged.md"]);
        fs::remove_file(repository.path.join("deleted.md")).expect("delete tracked file");
        write(&repository.path, "untracked.md", "new\n");

        let status = status_for_root(&repository.path).expect("read status");
        assert_eq!(status.repository, "self");
        assert!(!status.clean);
        assert!(status.dirty);
        assert!(status.branch.is_some());
        assert!(status.head.is_some());
        assert_eq!(file(&status, "modified.md").worktree, 'M');
        assert_eq!(file(&status, "staged.md").index, 'M');
        assert_eq!(file(&status, "deleted.md").worktree, 'D');
        assert!(file(&status, "untracked.md").untracked);
    }

    #[test]
    fn diff_contains_change_content_for_worktree_and_index() {
        let repository = init_repository();
        write(&repository.path, "note.md", "before\n");
        commit_all(&repository.path, "Initial commit");
        write(&repository.path, "note.md", "after\n");

        let worktree =
            diff_for_root(&repository.path, Some("note.md"), false).expect("worktree diff");
        assert!(worktree.contains("-before"));
        assert!(worktree.contains("+after"));

        git(&repository.path, &["add", "note.md"]);
        let staged = diff_for_root(&repository.path, Some("note.md"), true).expect("staged diff");
        assert!(staged.contains("-before"));
        assert!(staged.contains("+after"));
        let empty = diff_for_root(&repository.path, Some("note.md"), false).expect("empty diff");
        assert!(empty.is_empty());
    }

    #[test]
    fn log_lists_recent_commits_in_order() {
        let repository = init_repository();
        write(&repository.path, "note.md", "one\n");
        commit_all(&repository.path, "First commit");
        write(&repository.path, "note.md", "two\n");
        commit_all(&repository.path, "Second commit");

        let log = log_for_root(&repository.path, 10).expect("read log");
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, "Second commit");
        assert_eq!(log[1].subject, "First commit");
        assert_eq!(log[0].author, "Test Author");
        assert!(!log[0].hash.is_empty());
    }

    #[test]
    fn stage_and_commit_create_a_clean_repository() {
        let repository = init_repository();
        write(&repository.path, "note.md", "content\n");
        stage_for_root(&repository.path, &["note.md".to_string()]).expect("stage file");
        let status = status_for_root(&repository.path).expect("read status");
        assert_eq!(file(&status, "note.md").index, 'A');

        let result = commit_for_root(&repository.path, "Add note").expect("create commit");
        assert_eq!(result.hash.len(), 40);
        let status = status_for_root(&repository.path).expect("read status");
        assert!(status.clean);
        assert!(!status.dirty);
        let log = log_for_root(&repository.path, 5).expect("read log");
        assert_eq!(log[0].subject, "Add note");
    }

    #[test]
    fn unstage_restores_the_index_entry() {
        let repository = init_repository();
        write(&repository.path, "note.md", "one\n");
        commit_all(&repository.path, "Initial commit");
        write(&repository.path, "note.md", "two\n");
        stage_for_root(&repository.path, &["note.md".to_string()]).expect("stage file");
        unstage_for_root(&repository.path, &["note.md".to_string()]).expect("unstage file");
        let status = status_for_root(&repository.path).expect("read status");
        assert_eq!(file(&status, "note.md").index, '.');
        assert_eq!(file(&status, "note.md").worktree, 'M');
    }

    #[test]
    fn commit_message_validation_rejects_empty_and_oversized_values() {
        assert!(validate_commit_message("").is_err());
        assert!(validate_commit_message("   \n\t").is_err());
        assert!(validate_commit_message(&"x".repeat(2001)).is_err());
        assert_eq!(
            validate_commit_message(&"x".repeat(2000)).expect("valid message"),
            "x".repeat(2000)
        );
        assert_eq!(
            validate_commit_message("  Fix the note  ").expect("trimmed message"),
            "Fix the note"
        );
    }

    #[test]
    fn path_validation_rejects_traversal_absolute_and_metadata_paths() {
        assert!(validate_git_relative_path("../outside.md").is_err());
        assert!(validate_git_relative_path("folder/../../outside.md").is_err());
        assert!(validate_git_relative_path("/etc/passwd").is_err());
        assert!(validate_git_relative_path(".git/config").is_err());
        assert!(validate_git_relative_path("folder\\note.md").is_err());
        assert!(validate_git_relative_path("").is_err());
        assert!(validate_git_relative_path("folder/note.md").is_ok());

        let repository = init_repository();
        write(&repository.path, "note.md", "content\n");
        assert!(diff_for_root(&repository.path, Some("../outside.md"), false).is_err());
        assert!(stage_for_root(&repository.path, &["../outside.md".to_string()]).is_err());
    }

    #[test]
    fn unknown_root_is_rejected() {
        let directory = temporary_path("registry");
        fs::create_dir_all(&directory).expect("create registry directory");
        let store = ProjectStore::default();
        store
            .set_registry(directory.join("registry.json"))
            .expect("set registry");
        assert!(store.authorize(&Uuid::new_v4().to_string()).is_err());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn detached_head_is_reported() {
        let repository = init_repository();
        write(&repository.path, "note.md", "content\n");
        commit_all(&repository.path, "Initial commit");
        git(&repository.path, &["checkout", "-q", "--detach", "HEAD"]);

        let status = status_for_root(&repository.path).expect("read status");
        assert!(status.detached);
        assert!(status.branch.is_none());
        assert!(status.head.is_some());
    }

    #[test]
    fn nested_repositories_are_reported() {
        let repository = init_repository();
        write(&repository.path, "note.md", "content\n");
        commit_all(&repository.path, "Initial commit");
        let nested = repository.path.join("packages").join("nested");
        fs::create_dir_all(&nested).expect("create nested repository");
        git(&nested, &["init", "-q"]);

        let status = status_for_root(&repository.path).expect("read status");
        assert_eq!(status.nested_repositories, vec!["packages/nested"]);
    }

    #[test]
    fn parent_repository_is_read_only() {
        let repository = init_repository();
        write(&repository.path, "note.md", "content\n");
        commit_all(&repository.path, "Initial commit");
        let child = repository.path.join("docs");
        fs::create_dir_all(&child).expect("create child directory");
        write(&child, "page.md", "content\n");

        let status = status_for_root(&child).expect("read parent status");
        assert_eq!(status.repository, "parent");
        assert_eq!(
            status.repository_name.as_deref(),
            repository.path.file_name().and_then(|name| name.to_str())
        );
        assert!(status.outside_changes == 0);
        assert!(stage_for_root(&child, &["page.md".to_string()]).is_err());
        assert!(commit_for_root(&child, "Message").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_git_metadata_is_rejected() {
        use std::os::unix::fs::symlink;

        let repository = init_repository();
        let real_metadata = repository.path.join("real-git-metadata");
        fs::rename(repository.path.join(".git"), &real_metadata).expect("move Git metadata");
        symlink("real-git-metadata", repository.path.join(".git")).expect("create symlink");
        assert!(status_for_root(&repository.path).is_err());
    }

    #[test]
    fn index_conflicts_are_reported() {
        let repository = init_repository();
        write(&repository.path, "note.md", "base\n");
        commit_all(&repository.path, "Initial commit");
        git(&repository.path, &["checkout", "-q", "-b", "other"]);
        write(&repository.path, "note.md", "other\n");
        commit_all(&repository.path, "Other change");
        git(&repository.path, &["checkout", "-q", "main"]);
        write(&repository.path, "note.md", "main\n");
        commit_all(&repository.path, "Main change");
        let run = run_git(
            &repository.path,
            &["merge".to_string(), "other".to_string()],
        )
        .expect("run merge");
        assert!(!run.status.success());

        let status = status_for_root(&repository.path).expect("read status");
        assert_eq!(status.conflicts, vec!["note.md"]);
        let entry = file(&status, "note.md");
        assert!(entry.conflicted);
        assert!(commit_for_root(&repository.path, "Merge").is_err());
    }
}
