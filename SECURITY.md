# Security policy

DeckMark is a local-first static PWA with an optional Tauri Desktop Beta shell.
It requires no application backend, account, or cloud storage. It sends no
telemetry or crash reports. Browser drafts live in IndexedDB. Optional AI sends
user-selected context to a configured provider after an explicit action.

## Supported versions

| Version                         | Support     |
| ------------------------------- | ----------- |
| Latest `2.x` release and `main` | Supported   |
| Older tags                      | Best effort |

## Report a vulnerability privately

Do not open a public issue for a security-sensitive finding. Use [GitHub Private Vulnerability Reporting](https://github.com/ThomasCrouzet/deckmark/security/advisories/new). This is the private enforcement and conduct contact for this repository as well as the preferred security channel.

Include the version or commit, browser or operating system, reproduction steps, impact, and any planned disclosure. The solo maintainer aims to acknowledge a report within seven days on a best-effort basis. Disclosure timing is coordinated after a fix or an explicit risk decision.

## Browser threat model

In scope:

- script or markup injection through imported Markdown, reading mode, presentations, or exports;
- CSS or image requests that disclose network metadata without consent;
- a CSP or offline-shell bypass;
- silent IndexedDB loss, stale backups, or a false durability status;
- weaknesses in encrypted backup handling;
- provider-key exposure or transmission of AI context without a user action.

Rendering uses DOMPurify as the final sanitizer. CSS `url()` values in user content accept only validated local SVG fragments. The sanitizer removes SVG `feImage` filters to close that network request path. The app blocks remote images by default. It fetches them only after an explicit action for the document. An HTTPS fetch reveals the client IP address to the remote server. It sends no cookies or referrer and does not follow redirects. The app then embeds the validated bytes in the document. The project does not provide an image proxy.

The production CSP blocks unauthorized scripts, objects, forms, and external framing. It permits HTTPS connections for approved image fetches and optional AI requests. It blocks direct image loading from an external origin. The media preparation layer still enforces consent. The editor, KaTeX, and Mermaid require inline styles. Before rendering, Mermaid diagrams reject images and network styles. They use native SVG labels and keep only drawing styles limited to the SVG. Note HTML exports contain no scripts or remote font dependencies. Documentation site exports include local scripts for navigation controls and optional search.

Imported PDFs use the browser PDF viewer. The production Web CSP permits local
blob frames and blocks network frames. Open or download the PDF when inline viewing is unavailable. DeckMark
does not extract PDF text or provide a PDF editor.

## Optional AI and local MCP

AI is disabled by default. The assistant sends a prompt and context from the
selected document scope only after a send action. A connection test sends a test
prompt without document content. Provider configuration and context selection
remain the user's responsibility. A response does not execute commands or apply
document edits automatically.

Web Light requires browser-key consent. The key is held in memory and tab
`sessionStorage`, where page scripts can access it. This is not a protected
secret store. **Forget key** removes the browser key. Browser provider requests
are subject to CORS and the production connection policy.

Desktop stores the entered key in the operating-system credential store.
Stored keys are not returned to the WebView. Rust reads them for provider
requests and binds them to the full canonical endpoint. Old host-only entries
require key re-entry. **Delete key** removes the endpoint's stored key. The native request boundary
restricts endpoints and redirects. See [AI privacy](docs/EDITIONS.md#ai-and-network-privacy).

The optional [MCP server](docs/MCP.md) is a separate local process with explicit
roots and read-only tools. It binds no port and cannot apply its patch proposals.
An external MCP client can send returned content elsewhere. Its data handling
is outside DeckMark's network boundary.

## Desktop threat model

The Desktop Beta treats the WebView as potentially compromised. JavaScript cannot grant itself an arbitrary path. A native file picker or an operating-system file-open event canonicalizes an allowed path and creates an opaque, random, session-only capability token in Rust. Read, stat, write, and rename commands accept that token rather than a path. Rust keeps approved Markdown paths in a local access registry and issues new tokens after restart. Browser records cannot add entries to this registry. Removing a disk link also removes its native access. Exports do not restore access to non-Markdown targets.

A rename accepts a filename in the same approved directory. It rejects traversal, unsupported extensions, and existing targets. Native writes and renames share a lock. The local access registry uses the same atomic write mechanism as documents and owner-only permissions on Unix when first created.

Native file operations reject relative paths, parent traversal, unsupported extensions, and symlink substitutions. Writes use a same-directory temporary file, file synchronization, permission preservation, a final content-revision conflict check, atomic replacement, and directory synchronization where supported. An external edit requires an explicit user decision. Windows uses the native replace API for an existing target.

These boundaries reduce the impact of a WebView compromise but do not make an already compromised local operating-system account safe. Desktop installers remain unsigned beta artifacts until platform signing and notarization are available. Update delivery is on standby. The app does not check for or install updates. Install new releases manually.

Path and revision checks do not lock out external processes. A noncooperating
writer can change an entry after the final check. See the remaining race window
and native evidence in [Architecture](ARCHITECTURE.md#native-file-access-uses-session-capabilities)
and [Testing](docs/TESTING.md).

## Durability and backup limits

IndexedDB writes are debounced by 400 ms and flushed when the page becomes hidden, on page hide, and before relevant navigation. A rejected write makes the durability barrier fail closed and blocks backup, restore, and workspace replacement. A browser or device kill can still lose edits within the debounce window, and IndexedDB can be removed with browser profile data.

External backups include drafts, projects, assets, workspaces, custom templates,
snippets, and comments. They exclude trash, version history, the local search
index, API keys, File System Access handles, and Desktop capability tokens.
Encrypted backups are unrecoverable without their passphrase. Desktop scheduled
snapshots are unencrypted JSON files in a selected folder.

## Supply chain

CI audits the complete npm tree and Cargo lockfile. It reviews dependency
changes, runs CodeQL, scans Git history for secrets, and verifies third-party
notices. Tests and bundle budgets are blocking. Release builds have no write
credentials. A separate final job publishes Desktop Beta artifacts. It includes
SHA-256 checksums and GitHub build provenance.

The Linux Tauri GTK3 toolchain still requires `glib 0.18.5`. The project applies the official fix for `GHSA-wrw7-89jp-8q8g` and `RUSTSEC-2024-0429` in a local copy. It does not change the version or licenses. The repository contains the [provenance and patch](patches/glib/README.md). CI and Desktop publishing verify the official archive with SHA256. They apply the canonical patch, then compare each byte with the local copy. Six optimized Linux tests cover the affected iterators. The unpatched version causes SIGSEGV failures on nonempty paths. The `scripts/annotate-cargo-sbom.mjs` tool can add the backport and its origin to a Cargo SBOM without changing the recorded version.

`cargo audit --deny unsound` also blocks undefined-behavior advisories. Cargo Audit does not check local dependencies as registry packages. Thus, no alert does not prove that the backport is correct. Provenance verification and optimized tests are separate blocking controls. Maintenance advisories remain visible. The project will remove the backport when the GTK toolchain accepts an officially fixed version.

Security controls and scanners reduce risk; they are not a guarantee that every vulnerability has been found.
