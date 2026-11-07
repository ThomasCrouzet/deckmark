# Installed CLI and MCP package

This document defines the installed-user package for the existing DeckMark CLI
and local MCP server. It does not change a CLI command or an MCP tool
permission, the Desktop application, or the release workflow. It adds one usage
error path to the installed MCP entry point.

## Decision

Use a version-matched bundled Node runtime in one relocatable directory. The
package contains one runtime copy and two small launchers. The installed user
does not install Node, Rust, or a source checkout.

Rejected alternatives:

- A separate npm package needs an external Node runtime. It does not meet the
  installed-user requirement.
- A Node single executable application (SEA) works on Linux. It duplicates the
  runtime in each command, about 290 MB for both commands. It also needs an
  ad-hoc code signature on macOS ARM64. The project defers OS signing. This
  task does not authorize a signing step.
- A mandatory background service or a public listener is not necessary. The
  MCP server uses standard input and standard output.

The bundled runtime is the smallest supported model for all three targets. It
uses the existing CLI bundle and the existing MCP source. It needs no rewrite
and no new runtime dependency.

## Package layout

Linux and macOS:

```text
deckmark-cli-<version>-<os>-<arch>/
  bin/deckmark
  bin/deckmark-mcp
  lib/deckmark.mjs
  lib/deckmark-mcp.mjs
  runtime/node
  runtime/LICENSE-node.txt
  deckmark-build.json
  SHA256SUMS
```

Windows:

```text
deckmark-cli-<version>-windows-<arch>/
  bin/deckmark.cmd
  bin/deckmark-mcp.cmd
  lib/deckmark.mjs
  lib/deckmark-mcp.mjs
  runtime/node.exe
  runtime/LICENSE-node.txt
  deckmark-build.json
  SHA256SUMS
```

The directory name in the archive is the release name
`deckmark-cli-<version>-<os>-<arch>`. Extraction therefore produces the paths
that the install and MCP examples below use.

The launchers resolve their own directory with shell built-ins. They do not use
the current working directory and they do not call an external `node`,
`dirname`, or `readlink` command. Invoke a launcher by path, or add its `bin`
directory to PATH. Do not replace a launcher with a symbolic link. The bundle
is not signed, and a symbolic link changes the directory that the launcher
resolves.

`deckmark-build.json` records the package version, the source commit, the source
dirty state, the Node runtime version, the target platform and architecture,
and the SHA-256 hash of each payload file. `SHA256SUMS` uses the standard
`sha256sum -c` format.

## Build

Build on the target operating system and architecture. The build host needs
Node 22 or later and the repository dependencies. The build does not need
network access after dependency installation.

```sh
npm ci --legacy-peer-deps
node scripts/pack-cli.mjs --out build/cli-pack --archive
```

`--archive` writes the package directory and the archive with the release name
under the `--out` parent. On this host the command writes
`build/deckmark-cli-2.4.0-linux-x64/` and
`build/deckmark-cli-2.4.0-linux-x64.tar.gz`. It writes a `.zip` file on Windows.
On Windows, the packer uses `%SystemRoot%\System32\tar.exe` and ignores `tar`
on `PATH`: Git for Windows puts GNU tar first, and GNU tar cannot write a ZIP
archive.
The archive root directory and the package directory have the same name, so the
extracted paths match the documented layout and the install examples.

Use `--name <dir>` to select another package directory name. Use
`--runtime-node <path>` to bundle a specific official Node binary. The default
is the Node binary that runs the pack script. Use `--allow-dirty` only for a
local test build. A release build rejects a dirty source tree.

The packer deletes the output directory before it installs the new build.
It therefore refuses an output that is a file system root, a path with fewer
than two segments, the repository root, the user home directory, or the working
directory, or an ancestor of one of them. It also refuses an existing output
that is not a directory, a symbolic link, or a non-empty directory without a
`deckmark-build.json` marker with the expected schema. The check resolves
symbolic links in the existing part of the path. No flag bypasses it. Remove an
unowned directory yourself when you are sure that it holds no user data.

The command builds `lib/deckmark.mjs` with the existing
`scripts/build-cli.mjs` bundle function. It copies `bin/deckmark-mcp.mjs` to
`lib/deckmark-mcp.mjs`. It copies the Node binary and its adjacent `LICENSE`
file. It runs `--version` and one MCP `initialize` request on the new package
before it reports success.

Verify a package later:

```sh
node scripts/pack-cli.mjs verify --dir build/deckmark-cli-<version>-<os>-<arch>
```

The verify mode rejects a wrong schema, a missing file, a changed hash, a
package version that differs from `package.json`, and a platform or
architecture that differs from the expected value. It walks `bin/`, `lib/`, and
`runtime/` and rejects an extra file, an extra directory, a symbolic link, and
an unlisted top-level entry. On a POSIX target it also requires an executable,
non-writable mode for `bin/deckmark`, `bin/deckmark-mcp`, and `runtime/node`.

The manifest and `SHA256SUMS` are self-referential and unsigned. They detect
corruption and an accidental file change. They do not prove that a deliberate
attacker did not replace the payload and the hashes together. Compare the
archive hash with the value that the build record gives.

## Install and uninstall

Extract the archive in a directory that the user owns. The examples use
`~/.local/opt`, which is a convention, not a system requirement.

Linux and macOS:

```sh
mkdir -p ~/.local/opt
tar -xzf deckmark-cli-<version>-<os>-<arch>.tar.gz -C ~/.local/opt
export PATH="$HOME/.local/opt/deckmark-cli-<version>-<os>-<arch>/bin:$PATH"
```

Windows PowerShell:

```powershell
Expand-Archive .\deckmark-cli-<version>-windows-x64.zip -DestinationPath $env:LOCALAPPDATA\DeckMark
$env:Path = "$env:LOCALAPPDATA\DeckMark\deckmark-cli-<version>-windows-x64\bin;$env:Path"
```

The PATH change is optional, explicit, and session-scoped. To make it durable,
add the same directory in the user shell profile or in the Windows user
environment. The package does not edit a profile, the registry, or a system
PATH.

Uninstall:

1. Remove the MCP client entry that names this package.
2. Delete the extracted package directory.
3. Remove the PATH entry if you added one.

Uninstall does not delete documents, project archives, or backups. The package
writes no state outside its own directory.

## CLI

```sh
deckmark --version
deckmark --help
deckmark check /path/to/project --json
deckmark search "release" /path/to/project
deckmark render note.md --out note.html
deckmark export project --format zip --out project.zip
deckmark inspect note.md --json
```

The commands, options, schemas, exit codes, limits, and cancellation behavior
are the existing behavior in `docs/CLI.md`. The package does not add a command.
The executable prints the package version. The installed command runs the same
compiled CLI bundle as the repository command.

## MCP client

The MCP server is opt-in. It starts one process for each client. It binds no
port and needs no account.

Linux and macOS client entry:

```json
{
  "mcpServers": {
    "deckmark": {
      "command": "/home/user/.local/opt/deckmark-cli-<version>-linux-x64/bin/deckmark-mcp",
      "args": ["--root", "/home/user/notes"]
    }
  }
}
```

Windows client entry:

```json
{
  "mcpServers": {
    "deckmark": {
      "command": "C:\\Users\\user\\AppData\\Local\\DeckMark\\deckmark-cli-<version>-windows-x64\\runtime\\node.exe",
      "args": [
        "C:\\Users\\user\\AppData\\Local\\DeckMark\\deckmark-cli-<version>-windows-x64\\lib\\deckmark-mcp.mjs",
        "--root",
        "C:\\Users\\user\\notes"
      ]
    }
  }
}
```

The Windows form starts the bundled runtime directly. Some clients cannot start
a `.cmd` file without a shell. The direct form avoids that limit. The
`bin\deckmark-mcp.cmd` launcher remains available for a terminal.

A missing root, an unknown argument, or a root directory that does not exist
writes one `deckmark-mcp: <message>` line on standard error and exits with code
2. The server does not print a stack trace.

Use absolute paths. Repeat `--root` for each approved directory. The server
rejects a path outside all roots with `outside-root`, a sensitive path with
`sensitive`, and an ambiguous path with `ambiguous-path`. A client that requests
an unsupported MCP protocol version receives the server version
`2024-11-05`. The client must accept that version or disconnect.

## Lifecycle

- Start: the client starts one MCP process with explicit roots.
- Stop: close standard input or terminate the process. The process exits.
- Crash cleanup: the process holds no lock and writes no state. A new process
  can start immediately.
- Concurrent access: each process reads files independently. `propose_patch`
  returns a proposal and a base hash. It does not write. The client or the user
  must apply the change through the existing reviewed path.
- Cancellation: the CLI uses the existing timeout and `SIGINT` behavior.
- Revocation: remove the root from the client arguments and restart the
  process. A running process keeps its approved roots until it exits.

The package does not add a service, an autostart entry, a listener, or a shell
tool. It does not bypass the editor revision and permission checks.

## Security

- The package contains no credential and reads no credential file.
- Help text, errors, process arguments, and diagnostics contain no secret.
- The MCP server has no write, shell, process, or network tool.
- The server reads standard input and writes standard output only.
- The existing 1 MiB file limit, 500 file listing limit, excluded path rules,
  and root confinement apply.
- The runtime version is fixed by the package. A version mismatch is visible in
  `deckmark-build.json` and in the `--version` output.
- Unsigned release policy remains in force. The package is not signed, not
  notarized, and does not enable updates.

## Available commands and limits

The package provides these existing CLI commands:

- `check`
- `search`
- `render`
- `export`
- `inspect`
- `--help` and `--version`

The package provides these existing MCP tools:

- `list_files`
- `read_file`
- `search`
- `check`
- `project_metadata`
- `propose_patch`

The package does not provide a write tool, a shell tool, a public listener, a
background service, a Desktop auto-start entry, or an update mechanism.

Runtime limits:

- The Linux package uses the official glibc Node build. It does not support
  Alpine Linux or another musl distribution.
- The macOS package uses the official arm64 Node build. The package itself is
  not signed or notarized. A downloaded archive can receive a quarantine flag.
  Record the macOS decision before release. Do not add a certificate in this
  task.
- The Windows package is not signed. Windows SmartScreen can warn about an
  unsigned download.
- The package contains the current CLI and MCP behavior. It does not include the
  GUI rendering features that `docs/CLI.md` lists as different from the GUI.

The following items are future proposals, not part of this package:

- A Node SEA single-file executable. It removes the launcher files but
  duplicates the runtime for each command and needs an ad-hoc macOS signature.
- In-installer Desktop resources and an automatic PATH entry.
- OS code signing and notarization.
- Automatic update of the companion package.

## Web boundary

The package output goes to `build/`, which is ignored by Git. The Web build does
not import `scripts/pack-cli.mjs`, `bin/`, or `lib/`. The PWA precache does not
include the package. No CLI or MCP code enters Web assets.

## Test design, recorded before implementation

Failure risks:

1. A launcher can depend on the caller working directory or on an external
   `node` command.
2. The copied CLI bundle can be stale, or it can need a repository file.
3. The MCP process can start in the repository only because of a relative path.
4. The package can read a root that the user did not approve.
5. The package can write outside its own directory, or uninstall can remove a
   document.
6. The manifest can name a different version, platform, architecture, or hash
   than the payload.
7. Help or error output can expose an environment secret.
8. Two processes can corrupt a document or block each other.
9. The packer can delete an unrelated directory through `--out`.
10. Verify can accept an unlisted file, a symbolic link, or a wrong mode.
11. The MCP usage error can print a stack trace, and the test can accept it.

Planned checks, in `scripts/pack-cli.test.mjs`, using a real package and real
processes:

1. Run the packer with six unsafe `--out` values in an isolated fake checkout:
   the repository root, its parent, the home directory, a non-empty unowned
   directory, an existing file, and a directory with a foreign marker. Confirm
   a non-zero exit and that each directory and file is unchanged.
2. Build a package with `--allow-dirty` and `--archive` into `test-results/`.
   Confirm the release directory name and the archive root. Run the verify
   mode. Change the manifest version and confirm that verify fails. Restore it.
3. Add an unlisted file, an extra top-level entry, a nested directory, a
   symbolic link, and a launcher without an executable mode. Confirm that
   verify rejects each one and passes again after the restore.
4. Extract the archive to an isolated temporary directory outside the
   repository. Run it with an empty PATH, an isolated HOME, and a canary
   environment variable. Check `--version`, `--help`, exit codes, and absence
   of the canary.
5. Run `check` on a temporary project with one good note and one missing link.
   Expect exit 5 and the documented issue code. Run `export` to HTML and ZIP and
   compare the output bytes.
6. Start the POSIX `bin/deckmark-mcp` launcher with one approved root. Check
   `initialize`, `tools/list`, and `read_file` for an approved file. Request
   `../outside/secret.md` and an absolute path outside the root on every
   platform and expect `unsafe-path`. Request a symlink that resolves outside
   the root on POSIX and expect `outside-root`. Start with no `--root`, a
   missing value, an unknown argument, and a root that does not exist; expect
   exit 2 and one line on standard error.
7. Start two CLI checks and one MCP read at the same time. Compare the project
   hash before and after.
8. Remove the installed directory. Confirm that the temporary documents remain
   unchanged and that the isolated HOME is empty.

A browser test cannot start an installed native process or inspect its file
descriptor and root boundary. This is the isolated test exception recorded in
`docs/TESTING.md` policy.

## Current evidence

Linux x64 evidence was recorded on 2026-11-06 on the Lenovo host. The source
tree was clean at the recorded commit. The evidence file records the commit
SHA, the archive SHA-256, the archive size, each command, and each exit code.

```text
Command: node --test scripts/pack-cli.test.mjs
Exit: 0
Tests: 9 passed, 0 failed
Package version: 2.4.0
Runtime: Node 26.13.0 linux-x64
```

Absolute artifact paths:

```text
Package:  /srv/dev/projects/.deckmark-worktrees/cli-packaging/test-results/deckmark-cli-2.4.0-linux-x64
Archive:  /srv/dev/projects/.deckmark-worktrees/cli-packaging/test-results/deckmark-cli-2.4.0-linux-x64.tar.gz
Manifest: /srv/dev/projects/.deckmark-worktrees/cli-packaging/test-results/deckmark-cli-2.4.0-linux-x64/deckmark-build.json
Evidence: /srv/dev/projects/.deckmark-worktrees/cli-packaging/test-results/272-cli-pack-evidence.json
```

The archive SHA-256 is `packageArchiveSha256` in that evidence file. A rebuild
gives a different archive hash because the archive records file modification
times. Verify a package with the verify mode and compare the payload hashes,
not only the archive hash.

The package tree contains `runtime/node` at 150319296 bytes. The compressed
archive is about 48 MiB. The manifest records the source SHA, clean state, runtime
version, target `linux-x64`, and one SHA-256 for each payload file.

Run the installed proof with:

```sh
node --test scripts/pack-cli.test.mjs
```

The test writes `test-results/272-cli-pack-evidence.json`. It uses the ignored
`test-results/` directory and does not change the repository source.

Observed installed-like results, with `PATH` containing no `node` and `HOME`
set to an isolated directory outside the repository:

```text
bin/deckmark --version          exit 0  deckmark 2.4.0
bin/deckmark --help             exit 0  DeckMark CLI, five commands listed
bin/deckmark check . --json     exit 5  mdsh-docs-check/1, one link-missing
bin/deckmark export ... --json  exit 0  HTML, schema deckmark-export/1
bin/deckmark export ... --json  exit 0  ZIP, 2 documents, 1 asset
bin/deckmark-mcp --root ...     exit 0  initialize, tools/list, read_file (POSIX launcher)
bin/deckmark-mcp --root ...     result  unsafe-path for ../outside and an absolute path
bin/deckmark-mcp --root ...     result  outside-root for the symbolic link (POSIX)
bin/deckmark-mcp (no root)      exit 2  one deckmark-mcp line, no stack trace
```

The recorded run also proves these refusals: six unsafe `--out` values exit 1
and leave their files intact; five payload mutations make verify exit 1; and
four MCP usage cases exit 2 with one line. The evidence file records each
command and exit code in `negativeChecks`.

The test extracted the tar archive into an isolated temporary directory. It
started two CLI checks and one MCP read at the same time. The project hash was
equal before and after. It removed the installed directory and confirmed that
the temporary project stayed unchanged. A canary environment value did not
appear in help, error, or protocol output.

Hosted isolated artifact verification covers Linux x64, macOS ARM64 and Windows
x64. Run `42306710039` tested merge commit `d29d4f3`. Its tree `65799b42`
matches the tree of PR head `a2610bc`. Each target ran 11 installed-package
tests with Node 22.23.4: 11 passed, 0 failed and 0 skipped. This is CI artifact
verification on hosted runners, not a manual clean-OS audit. It does not replace
the procedures below.

The hosted validation does not publish a CLI package. No current workflow
creates, uploads or signs a CLI archive; `CLI package` runs the installed
checks only. Adding a CLI archive needs the unapplied integration below and a
separate decision by the release owner. Signing remains deferred.

## Release integration request, not applied

This task does not change a workflow. The release owner must add one pack step
to the existing `build-desktop` job in `.github/workflows/desktop.yml`, after
`npm ci --legacy-peer-deps` and before `tauri-action`:

```yaml
- name: Pack installed CLI and MCP
  run: node scripts/pack-cli.mjs --out build/cli-pack --archive

- name: Upload installed CLI and MCP
  uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9
  with:
    name: deckmark-cli-${{ runner.os }}-${{ runner.arch }}
    path: build/deckmark-cli-*
    if-no-files-found: error
    retention-days: 14
```

The glob matches one archive on each runner: `deckmark-cli-<version>-linux-x64.tar.gz`,
`...-windows-x64.zip`, or `...-darwin-arm64.tar.gz`. Attach the archive of the
run operating system only. Do not upload both suffixes.

The existing Node 22 setup is sufficient. The matrix already uses
`ubuntu-24.04` x64, `windows-2022` x64, and `macos-15` arm64. The pack step
does not need Node 26 and does not change the Tauri configuration. Add the
archive to the release asset set and keep the source SHA in
`deckmark-build.json`. Do not add a signing step in this task.

## Windows and macOS clean-install validation

Do not claim completion until each procedure passes on a clean target.

Windows 11 x64 clean virtual machine or GitHub `windows-2022` runner:

1. Confirm `where node` returns no path. Confirm the machine has no DeckMark
   source checkout.
2. Extract `deckmark-cli-<version>-windows-x64.zip`.
3. Run `bin\deckmark.cmd --version` and compare the output with the release tag.
   The batch launcher passes arguments through `cmd.exe`. Quote an argument that
   contains a space or a shell metacharacter. Use the direct `runtime\node.exe`
   form for a path that contains a double quote or a percent sign.
4. Run `bin\deckmark.cmd --help` and the `check` and `export` cases from a
   temporary project.
5. Start the MCP server with the `runtime\node.exe` and `lib\deckmark-mcp.mjs`
   form. Send `initialize`, `tools/list`, `read_file`, and a path outside the
   approved root. Check the `outside-root` result.
6. Close standard input. Confirm that the process exits.
7. Delete the extracted directory. Confirm that the temporary project and its
   files are unchanged.
8. Record the package SHA-256, the source SHA, the OS build, the commands, the
   exit codes, and the output files.

macOS 15 Apple Silicon clean machine or GitHub `macos-15` runner:

1. Confirm `command -v node` returns no path. Confirm the machine has no
   DeckMark source checkout.
2. Extract the `darwin-arm64` archive. Run `file runtime/node` and confirm an
   arm64 Mach-O executable.
3. Run `codesign --verify --strict runtime/node`. The copied official Node
   binary must keep its upstream signature. The launchers are scripts and have
   no project signature.
4. Run `bin/deckmark --version`, `--help`, `check`, and `export` from a
   temporary project.
5. Start `bin/deckmark-mcp --root <project>`. Repeat the MCP protocol and
   unapproved-root checks.
6. Remove the directory. Confirm that the documents are unchanged.
7. Record the package SHA-256, the source SHA, the macOS build, the commands,
   the exit codes, and the output files.

If macOS blocks the downloaded archive, record the exact `spctl` and
`xattr` output. Do not add a signature or a notarization step in this task.
