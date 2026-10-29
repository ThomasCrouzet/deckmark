# Architecture

This document explains the main design decisions in mdsh. For a module reference,
see the map in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Offline-first without a backend

mdsh has no server. Dexie stores drafts in IndexedDB. The File System Access API
edits disk files in place. Exports are plain files. The PWA must work offline on
its first use, before a previous online visit can fill browser caches.

The pre-1.0 hardening pass broke this guarantee. The post-build step in
`scripts/generate-service-worker.mjs` converts Workbox URLs to requested browser URLs.
The SPA fallback used `/mdsh` instead of the served `/mdsh/` path. A new install
could not match its navigation request to the precache key. `navigateFallback`
then returned a blank offline shell. With an empty base path, the same transform
produced an empty precache.

A previous online visit hid the defect because the browser already had the page.
`e2e/pwa.spec.ts` found it by loading a new installation after network access was
disabled. The fix aligned the fallback key with the served URL. An offline-first
claim requires a CI test that disables the network before first use.

## The bundle budget as a design constraint

`.size-limit.json` limits the gzip JavaScript entry to 12 KB, the startup page
chunk to 60 KB, and CSS to 120 KB. CI blocks a change that exceeds a limit.
The application uses `marked` to render Markdown and KaTeX to render math.
It uses `highlight.js` for syntax highlighting and Mermaid for diagrams.
It uses `jszip` for exports and `js-yaml` to parse YAML front matter.
The startup graph cannot include these engines and remain within the limits.

Each engine stays behind a dynamic `import()` from `render/markdown.ts`,
`services/export.ts`, or `frontmatter.ts`. The PWA cache still contains all
revisioned chunks. Offline startup can load the requested engine without a
network and keep the initial graph small. A static import from `+page.svelte`, a
store, or a component mounted at startup would increase the initial cost. ESLint
blocks this leak. `scripts/bundle-graph.mjs` measures the transitive closures of
the startup, reading, source, and WYSIWYG graphs. Thus, the budget checks what
each path loads without counting a shared chunk more than once.

## A facade store over pure, testable modules

`files.svelte.ts` is the primary file store. Svelte 5 requires its `$state` to
stay in one class. Runes cannot move to a plain module and then be imported.
This restriction can put all file logic in one class. Such a class does not
scale across exports, disk sync, tags, search, saves, and trash. Unit tests would
need to start the full class and mock `$state`.

The store is a thin facade. It owns reactive state and connects pure logic
modules. `export-ops` controls Markdown, HTML, PDF, and ZIP exports. `disk-sync`
controls the File System Access API. `meta-index` controls tags, backlinks, and
titles. `save-queue` controls debounced Dexie writes. `trash` controls the trash.

Each module is a plain class or function set. Callbacks connect it to the store.
For example, `meta-index` receives a `() => FileItem[]` accessor. `save-queue`
receives `onSaved` and `onError` callbacks. Thus, `save-queue.test.ts` and
`meta-index.test.ts` test logic without the store, DOM, or Svelte runtime. An
IndexedDB failure reaches `onError` instead of a silent store `console.error`.

## An in-house bilingual layer instead of a library

mdsh uses a small runes-based layer in `src/lib/i18n/`. It supports English and
French without a general i18n library. English is the default. The app detects
French in the browser, and Settings can change the locale.

`src/lib/i18n/messages/en.ts` satisfies `Record<string, string>` and defines the `MessageKey` type.
The adjacent `fr.ts` uses the same type. A missing key is thus a TypeScript error instead
of a runtime fallback. `i18n.test.ts` checks nonempty values, locale precedence,
and invalid preferences. Browser tests check the English and French interfaces.
For two locales, this layer uses less code and gives strict guarantees.

## Document identity is independent of tabs

`filesStore.library` includes open and closed drafts. Search, metadata, graph links,
and full-library ZIP export use this collection. Opening a closed result calls
`openDocument()` and preserves the document ID and history. Open-tab operations
use an explicit scope.

Renames rewrite incoming wiki targets after a history checkpoint. The rewrite
preserves aliases, front matter, escaped examples, and code. Backup merge maps
imported identifiers in both workspace references and Markdown links. It checks
existing variants against the mapped references before reusing them, including
cycles. Repeating the same merge does not duplicate an unchanged linked notebook.

## Projects keep paths separate from document identity

Dexie schema 6 adds projects and binary assets. A project document keeps its existing draft ID plus a project ID and relative path.
Closed tabs, history, and workspaces continue to refer to draft IDs.
Paths use normalized slash separators. Validation rejects traversal, platform-reserved names, and case-insensitive collisions.

Project ZIP import validates the central directory before decompression. Each entry also has an enforced decompression limit.
Import writes documents, assets, and project metadata in one transaction.
Rendering resolves local images through the project asset table without changing the Markdown source.
Project export writes relative paths, separate assets, and a link report.

The native directory registry owns access independently of IndexedDB.
Session tokens authorize relative operations under one selected root. Backups exclude registry identifiers and revision baselines.
Native refresh is explicit. Local and external changes require comparison before either branch replaces the other.

## Source preview and change comparisons

Source preview keeps one CodeMirror editor and a delayed reading view.
The divider has pointer and keyboard controls. Its saved ratio also applies when the panes stack vertically.

History, disk conflicts, and replacement previews share a bounded line-diff renderer.
It displays text without HTML execution. Work limits prevent large comparisons from blocking the interface.
Replacement confirms its inputs and writes checkpoints with replacements in one database transaction.

## Durability is a state transition, not a timer

The 400 ms save debounce is an optimization, not proof that content is durable. `SaveQueue` serializes writes per document and records a rejected IndexedDB revision as a durability failure. `flushAwait()` retries failed rows and rejects while any in-memory revision is not represented in IndexedDB. Backup export, restore, and workspace replacement stop at that barrier. The UI reports the error without converting it into a successful save.

Workspace creation and update also wait for pending drafts before writing their
tab references. A workspace must not report a successful save while its current
text exists only in memory.

Visibility, page-hide, and before-unload events trigger an immediate flush to reduce the residual recovery point. They cannot guarantee execution after a browser or operating-system kill. External backup remains the recovery mechanism for loss of the browser profile.
The abrupt-exit workflow kills Chromium with SIGKILL and reopens the same profile
at the debounce, transaction, backup, workspace, and conflict stages. Its artifact
lists committed content, conflict copies, and revisions available in history.

## Native file access uses session capabilities

The Desktop Beta does not accept JavaScript paths for file commands. A Rust-owned picker or operating-system open event canonicalizes the path and returns an opaque session token. Rust stores approved Markdown paths in `disk-access.json` in the application data directory. It issues new tokens after restart. IndexedDB records cannot add paths to this registry. Removing a disk link revokes its native permission.

The disk-link record keeps the last written content revision across restarts. A restored draft can save through a renewed native token without another picker. External edits still require an overwrite decision. A rename accepts only a filename in the approved directory. It refuses an existing target and keeps file content and permissions. The store serializes rename, save, and unlink operations for each document.

Native writes stage data in the target directory and synchronize it. They then compare a SHA-256 revision immediately before replacement. The operation preserves permissions and uses the platform replacement function. It detects external edits with unchanged size and timestamp. A staging failure keeps the original file.

The final check also validates the canonical path, including for a forced save.
Write, rename, and permission revocation share the Rust capability lock. An
operation that acquires this lock before revocation can complete; subsequent
operations with the revoked token fail.

External writers do not share this lock. A noncooperating process can still
change the file or a parent directory after the final path and revision check
and before the filesystem operation. The same limit applies between the hard
link and unlink steps of rename. These operations are not a filesystem-wide
compare-and-swap. The native race artifact records the tested interruption points.

## Native macOS printing

The frontend prepares sanitized content in a separate shadow tree and waits for images and fonts.
On macOS, it applies print styles before WKWebView calculates page boundaries.
Rust starts a WKWebView print operation as an asynchronous native sheet.
Its completion callback releases the prepared content after printing or cancellation.
There is no cleanup deadline while the macOS print panel remains open.

HTML and PDF preparation accept a cancellation signal through rendering, media,
styles, fonts, and print preparation. The progress action stops that work. Once
the native panel opens, it owns cancellation and its callback owns DOM cleanup.

The native smoke build saves through this same print operation.
PDFKit checks pagination, content, and image border pixels in the resulting file.
WebDriver screen capture alone cannot establish that native PDF export works.

## Measured corpus budget

Logic tests build a corpus of 300 documents. They then measure the
metadata index and search. A separate browser test uses a Mac mini M4, Chromium,
and a 50,000-character document. Search takes 183 to 205 ms for 200 and 300
notes. The first WYSIWYG pass takes 119 ms, then 85 to 88 ms. Typing takes a
median of 25 ms and 34 ms at the 95th percentile. These values are references
for this machine. The wider CI budgets are regression alarms. They are not a
performance guarantee for all devices.

Optional editor views load when the selected mode needs them.
The startup state module shares its static dependencies in one resource.
Bundle graph checks cover startup, rendering, Source, and visual editing.
The precache budget includes every offline editor view and project operation.
