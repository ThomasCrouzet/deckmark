# Installed CLI and MCP package

This document defines the installed-user package for the existing DeckMark CLI
and local MCP server. It does not change the CLI, the MCP server, the Desktop
application, or the release workflow.

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

The launchers resolve their own directory with shell built-ins. They do not use
the current working directory and they do not call an external `node`,
`dirname`, or `readlink` command. Invoke a launcher by path, or add its `bin`
directory to PATH. Do not replace a launcher with a symbolic link.

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

The `--archive` option writes `build/cli-pack.tar.gz` on Linux and macOS, or
`build/cli-pack.zip` on Windows. Rename the archive to the release asset name
that contains the version, operating system, and architecture. Use
`--runtime-node <path>` to bundle a specific official Node binary. The default
is the Node binary that runs the pack script. Use `--allow-dirty` only for a
local test build. A release build rejects a dirty source tree.

The command builds `lib/deckmark.mjs` with the existing
`scripts/build-cli.mjs` bundle function. It copies `bin/deckmark-mcp.mjs` to
`lib/deckmark-mcp.mjs`. It copies the Node binary and its adjacent `LICENSE`
file. It runs `--version` and one MCP `initialize` request on the new package
before it reports success.

Verify a package later:

```sh
node scripts/pack-cli.mjs verify --dir build/cli-pack
```

The verify mode rejects a wrong schema, a missing file, a changed hash, a
package version that differs from `package.json`, and a platform or
architecture that differs from the current host.

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

Planned checks, in `scripts/pack-cli.test.mjs`, using a real package and real
processes:

1. Build a package with `--allow-dirty` and `--archive` into `test-results/`.
   Run the verify mode. Change the manifest version and confirm that verify
   fails. Restore it.
2. Extract the archive to an isolated temporary directory outside the
   repository. Run it with an empty PATH, an isolated HOME, and a canary
   environment variable. Check `--version`, `--help`, exit codes, and absence
   of the canary.
3. Run `check` on a temporary project with one good note and one missing link.
   Expect exit 5 and the documented issue code. Run `export` to HTML and ZIP and
   compare the output bytes.
4. Start the MCP launcher with one approved root. Check `initialize`,
   `tools/list`, and `read_file` for an approved file. Request a symlink that
   resolves outside the root and expect `outside-root`. Start with no `--root`
   and expect a clear failure.
5. Start two CLI checks and one MCP read at the same time. Compare the project
   hash before and after.
6. Remove the installed directory. Confirm that the temporary documents remain
   unchanged and that the isolated HOME is empty.

A browser test cannot start an installed native process or inspect its file
descriptor and root boundary. This is the isolated test exception recorded in
`docs/TESTING.md` policy.

## Current evidence

Linux x64 evidence was recorded on 2026-11-06 on the Lenovo host. The source
tree was clean at commit `f6d6a45660e152db6abbd51f8c9d216baaeba98a`.

```text
Command: node --test scripts/pack-cli.test.mjs
Exit: 0
Tests: 6 passed, 0 failed
Package version: 2.4.0
Runtime: Node 26.13.0 linux-x64
```

Absolute artifact paths:

```text
Package:  /srv/dev/projects/.deckmark-worktrees/cli-packaging/test-results/272-clean-pack
Archive:  /srv/dev/projects/.deckmark-worktrees/cli-packaging/test-results/272-clean-pack.tar.gz
Manifest: /srv/dev/projects/.deckmark-worktrees/cli-packaging/test-results/272-clean-pack/deckmark-build.json
Evidence: /srv/dev/projects/.deckmark-worktrees/cli-packaging/test-results/272-cli-pack-evidence.json
```

Release-candidate archive SHA-256:
`85778b0b961e14dc38a5bc5f870267c39f7b6d39dccea649cfe78d62cc8d2f30`.

The package tree contains `runtime/node` at 150319296 bytes. The compressed
archive is 48 MiB. The manifest records the source SHA, clean state, runtime
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
bin/deckmark export ... --json  exit 0  HTML 2378 bytes
bin/deckmark export ... --json  exit 0  ZIP, 2 documents, 1 asset, 2003 bytes
bin/deckmark-mcp --root ...     exit 0  initialize, tools/list, read_file
bin/deckmark-mcp --root ...     result  outside-root for the escape path
bin/deckmark-mcp (no root)      exit 1  clear usage error
```

The test extracted the tar archive into an isolated temporary directory. It
started two CLI checks and one MCP read at the same time. The project hash was
equal before and after. It removed the installed directory and confirmed that
the temporary project stayed unchanged. A canary environment value did not
appear in help, error, or protocol output.

Windows x64 and macOS arm64 clean-install evidence is not available. Do not
mark issue 272 complete until the procedure below passes on those targets.

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
    path: |
      build/cli-pack.tar.gz
      build/cli-pack.zip
    if-no-files-found: error
    retention-days: 14
```

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
