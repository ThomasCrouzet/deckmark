# Native project protocol

The native project boundary gives one selected directory to one desktop project.
Rust keeps the approved root in its private registry. The webview receives an
opaque root identifier and an opaque session token. A database import cannot add
or renew a root grant.

## Retained failure risks

Browser tests cannot observe these native filesystem and registry failures:

- An unknown root identifier can renew access after a database import.
- A revoked root can renew a token after restart.
- A session token can select a different root or survive a process restart.
- An absolute path, parent component, or platform prefix can escape the root.
- A symbolic link in any existing path component can escape the root.
- Root replacement can redirect a valid session to a different directory.
- File replacement between validation and access can disclose or modify another file.
- A same-content file replacement can bypass a revision-only identity check.
- An in-place change can return mixed bytes from one file read.
- Parent replacement during staging can write temporary contents outside the root.
- A Windows device name or alternate data stream can bypass path confinement.
- A stale revision can overwrite an external change.
- A create request can replace an existing file.
- A rename can replace an existing destination or use a stale source revision.
- A failed atomic write can leave a partial file or temporary file.
- A successful replacement can change the existing file permissions.
- A refresh can omit a supported nested file or return an absolute path.
- A snapshot can include an unsupported file or exceed a resource limit.
- A malformed registry can create authority that did not come from the native picker.
- A failed registry update can leave an unreachable persistent grant after disconnect.
- A local asset can change while its disk conflict dialog is open.
- Two disk paths can collide after case folding in the frontend database.

The native smoke workflow uses real directories and files. It checks command
results and final filesystem contents. It uses a native-smoke build to select its
temporary fixture without an interactive dialog. Production builds do not accept
a webview path for root selection.

## Limits

| Resource              |  Limit |
| --------------------- | -----: |
| Markdown documents    |    300 |
| All returned entries  |  1,300 |
| Directory depth       |      8 |
| One Markdown document | 16 MiB |
| One image asset       |  2 MiB |
| One snapshot          | 64 MiB |

Supported text extensions are `.md`, `.markdown`, `.mdx`, and `.txt`. Supported
image extensions are `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, and `.svg`.
All relative paths use Windows-compatible component rules on each platform.

File creation and rename use an exclusive hard-link installation. The operation
fails without changing the target when the filesystem does not support hard links.
Directory handles confine traversal and reject symbolic links. The commands reopen
each parent from the approved root before installation.

One entry read verifies the opened file identity and hashes the reopened contents.
It rejects a detected concurrent change. A full project snapshot is not globally atomic.

## Commands

The protocol exposes these commands:

```text
project_pick_root() -> ProjectSnapshot | null
project_open_root(rootId) -> ProjectSnapshot
project_refresh(token) -> ProjectSnapshot
project_read(token, relativePath) -> ProjectEntry
project_write_text(token, relativePath, content, expectedRevision) -> ProjectEntry
project_write_asset(token, relativePath, contents, expectedRevision) -> ProjectEntry
project_rename(token, fromPath, toPath, expectedRevision) -> ProjectEntry
project_revoke(token) -> void
```

`expectedRevision` is null only for file creation. It never means unconditional
overwrite. An overwrite must supply the current revision. The command checks that
revision again immediately before replacement.

## Native smoke evidence

Build the native-smoke binary before this workflow. The runner that starts the
binary must set `MDSH_NATIVE_PROJECT_ROOT` to a temporary fixture directory. Call
the exported `nativeProjects` function from the native WebDriver workflow.
Set `MDSH_NATIVE_PROJECT_REGISTRY` to a temporary file for registry failure tests.
Production builds ignore both variables.

The workflow writes `native-projects.json` in the native evidence directory. The
artifact records the command names, fixture paths, source metadata from the parent
runner, command results, and final file revisions. The fixture stays outside the
repository and contains no user data.

The workflow also uses the Projects panel. It imports the approved root twice and
verifies that the second import reuses the project. It edits a document locally,
changes the same file on disk, and reviews both conflict snapshots. It then writes
the reviewed local revision, renames the document, and restarts the application.
After restart, an explicit refresh must load changed image bytes. Disconnect must
keep the local documents and assets. It must also revoke the registry identifier.
The workflow replaces a staged file with the same bytes and replaces a staged
parent with a symbolic link. Both operations must fail without an escaped write.
It also changes an asset during conflict review. The reviewed stale bytes must
not reach the disk. A registry failure must keep the project connection.
The workflow changes a file in place during a read. The command must reject the snapshot.
It also rejects reserved Windows paths and case-folded frontend path collisions.

A repeated import can display existing documents while its disk refresh still runs.
Wait for the Projects panel to become available before changing the next fixture.
Reject an import failure even when documents from an earlier import remain visible.
Apply the same wait after the refresh that follows duplicate-path cleanup.
Otherwise, that earlier operation can open the next conflict before its intended refresh.

## Frontend scenarios

Run these scenarios through the desktop WebView with a real temporary directory:

1. Pick a root with nested Markdown and image files. Verify the imported paths,
   content, assets, persistent root identifier, and baseline revisions.
2. Pick the same root again. Verify that DeckMark selects the existing project and
   does not create duplicate database rows.
3. Restart the native process. Open the project through its registry identifier
   and verify that the new session token can refresh and save the project.
4. Edit one local document, change a different disk document, and save. Verify
   both successful paths and their new baseline revisions.
5. Change the same document locally and on disk. Verify that the conflict dialog
   shows the exact reviewed snapshots before reload or overwrite.
6. Choose reload, then change the disk file again before apply. Verify that DeckMark
   keeps the local draft and reports the changed revision.
7. Choose overwrite. Verify the external checkpoint and the expected-revision
   write. A second external change must reject the write.
8. Delete a disk document and refresh. Verify that the local draft remains in the
   library and that a later save does not silently recreate it.
9. Add local documents and assets, then save. Verify exclusive creation and exact
   bytes. A concurrent disk creation must reject the operation.
10. Cause one write to fail during a multi-file save. Verify the successful
    baseline updates, the failed dirty item, and the path-specific error report.
11. Rename a native document, then fail the database transaction. Verify that the
    receipt restores the original disk path and leaves the baseline unchanged.
12. Disconnect or revoke the root. Verify that all local documents and assets
    remain available and that the old root identifier cannot renew access.
