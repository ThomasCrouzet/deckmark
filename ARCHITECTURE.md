# Architecture

This document explains the main design decisions in DeckMark. For a module reference,
see the map in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Two editions share one client

DeckMark has two editions. **Web Light** is a static PWA that GitHub Pages
publishes. **Desktop Complete (Beta)** packages the same client in Tauri and adds
native operating-system capabilities. Both editions use the same note and
presentation formats, IndexedDB model, project ZIP format, and backup format.
There is no forked document logic.

Web Light runs in the browser sandbox. A disk link uses the browser File System
Access API when the browser provides it. Firefox and Safari use a download
fallback. Web Light has no native path capability, native print panel, native
menu, or native file association. A PWA can use browser file handlers where the
browser supports them.

Desktop Complete keeps native authority in Rust. The WebView receives an opaque
session token for an approved path, not a general filesystem handle. The native
access registry is separate from IndexedDB. The Desktop build serves assets from
the package and does not register the service worker.

The edition is a compile-time input. `scripts/build-edition.mjs` sets
`VITE_EDITION` and writes `build/edition.json`. `vite.config.ts` replaces native
bridges with Web stubs. `scripts/check-edition-boundaries.mjs` checks the output
and precache for native bridge strings. Lazy imports keep optional features out
of the startup graph. See [edition builds](docs/EDITIONS.md#build-each-edition).

GitHub Pages is the only production Web publisher. The deployment workflow reads
the Pages base path before the build. A custom domain uses the root and a project
site uses `/deckmark/`. The service worker scope and navigation fallback follow
that base path. The workflow does not configure DNS or a custom domain.

Both editions have an optional OpenAI-compatible AI connection, disabled by
default. Neither has a secure browser API key vault or unrestricted filesystem
access. See [docs/EDITIONS.md](docs/EDITIONS.md) for the feature matrix.

## Offline-first without a backend

DeckMark requires no application server. Dexie stores drafts in IndexedDB. The
File System Access API edits selected disk files in supported browsers. Exports
are plain files. The PWA needs an initial online installation. After **Ready
offline**, it must start without relying on a previous document visit.

The pre-1.0 hardening pass broke this guarantee. The post-build step in
`scripts/generate-service-worker.mjs` converts Workbox URLs to requested browser URLs.
The SPA fallback used `/mdsh` instead of the served `/mdsh/` path. A new install
could not match its navigation request to the precache key. `navigateFallback`
then returned a blank offline shell. With an empty base path, the same transform
produced an empty precache.

A previous online visit hid the defect because the browser already had the page.
`e2e/pwa.spec.ts` found it by loading a new installation after network access was
disabled. The fix aligned the fallback key with the served URL. An offline-first
claim requires a test that disables the network after installation and before
the first offline navigation.

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
receives `onSaved` and `onError` callbacks. An IndexedDB failure reaches `onError`
instead of a silent store `console.error`. Browser workflows verify observable
save and recovery results. Retained isolated tests cover the failure risks in
[docs/TESTING.md](docs/TESTING.md).

## An in-house bilingual layer instead of a library

DeckMark uses a small runes-based layer in `src/lib/i18n/`. It supports English and
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

## Optional tools share local documents

Dexie schema 7 adds comments and snippets. Schema 8 adds the optional local
search index. `snippets.ts` searches snippet metadata and resolves placeholders
for copy. The stored snippet keeps its source text. `linked-blocks.ts` stores
source markers and readable include snapshots in Markdown. Updates, freezing,
and detachment are explicit actions.

`docs-check.ts` checks a project without file writes or network requests.
`services/docs-site-export.ts` creates a static site ZIP from local documents
and assets. It reports missing resources and does not fetch remote images.
`semantic-search.ts` uses feature hashing or local term co-occurrence. The
user builds the index explicitly. These search models need no downloaded model
and are separate from the provider-based AI assistant.

Desktop loads Git, scheduled backup, and global capture modules through its
edition boundary. Git acts on disk files under an approved project root.
`desktop-backup.ts` collects a portable backup after pending draft writes finish.
Its timer runs in the application, not an operating-system service. Quick capture
uses a separate native window and an opt-in global shortcut.

The Node CLI and MCP server are separate processes from a source checkout.
The MCP server uses standard input and output, with explicit filesystem roots.
Its tools read files or propose patches without applying them. See
[docs/CLI.md](docs/CLI.md) and [docs/MCP.md](docs/MCP.md).

## AI has an explicit network boundary

AI is disabled by default. `ai/store.svelte.ts` keeps provider settings separate
from document storage. Web Light keeps its key in memory and `sessionStorage`
after browser-key consent. This is session storage, not a secure vault.
`ai/openai-compatible.ts` makes direct provider requests subject to browser CORS
and the application's connection policy.

Desktop uses `ai/native.ts` and the Rust request boundary. The key entry field
passes a key to the operating-system credential store. Stored keys are not read
back into the WebView. Rust obtains the key for each request.

`AiPanel.svelte` builds a context manifest from the user's selected scope.
A send action transmits the prompt and included context. Proposed edits require
review and an explicit apply action. No bundled inference engine, required
backend, telemetry, or automatic document upload is part of this flow.

<a id="notes-and-markdown-presentations"></a>

## Document types and Markdown presentations

`document-kind.ts` defines note, presentation, code, image, and PDF types.
`documentKindForFile()` checks an explicit kind, then the filename extension,
then Markdown presentation metadata. Draft rows can store `kind`, `mime`, and
binary `data`. Code uses a separate CodeMirror editor. Images use an annotation
canvas with flattened PNG export. PDF viewing uses a browser viewer, with
open and download actions. The production Web CSP permits local blob frames
and blocks network frames. Inline PDF support depends on the browser viewer.

For Markdown, a recognized marker with valid or malformed metadata makes the
file a presentation. Markers inside code fences,
front matter, or framed element content do not change a note's type.
Presentations keep format version 1.

The New dialog offers Note and Presentation. Presentation creation serializes an
empty deck with one slide before the first save. The app does not convert notes
to presentations or rewrite existing files when it opens them.

`EditorPane.svelte` selects the view for each document type. The active
file ID keys the slide editor so a file switch cannot reuse another deck's state.
The editor and exports use the lazy module `presentation/entry.ts`. The small
static type detector keeps the presentation graph outside the startup bundle.
Note modes, split view, outline, tags, backlinks, and the link graph remain note
features. Search includes slide text and identifies document types.

Presentation metadata stores layout and presenter notes in the same Markdown
file as the slide content. Source markers connect content to stable object IDs.
The parser rejects invalid metadata before visual edits can replace the source.
Malformed presentations stay in the slide editor with an error and source access.
**Advanced > Markdown source** edits a draft. Apply rejects a missing metadata
marker and keeps both the draft and stored content. Cancel discards the draft.
Malformed metadata keeps the presentation type and shows a parse error for repair.
An external source change blocks a stale Apply.

The inline editor owns Present, Export, Advanced, and Presenter notes controls.
The notes panel is visible by default. Only Present uses a full-screen overlay;
Escape returns to the inline editor. Desktop actions use the
`mdsh:presentation-action` event for the active presentation.

Pointer gestures update reactive geometry once per animation frame.
They serialize the completed operation once and use the existing 400 ms save queue.
The editor keeps bounded undo history and reports storage failures in the document area.
Visible thumbnails share the slide renderer and load through an intersection observer.

HTML, browser printing, and native printing use the same slide geometry.
Each slide occupies one fixed-size page. Native macOS printing receives optional page dimensions.
Notes retain the existing A4 print settings. HTML and PDF omit presenter notes;
Markdown export retains them in the metadata.
The browser suite and native PDF inspector retain exported files and page evidence.

## Source preview and change comparisons

Source preview keeps one CodeMirror editor and a delayed reading view.
The divider has pointer and keyboard controls. Its saved ratio also applies when the panes stack vertically.

History, disk conflicts, and replacement previews share a bounded line-diff renderer.
It displays text without HTML execution. Work limits prevent large comparisons from blocking the interface.
Replacement confirms its inputs and writes checkpoints with replacements in one database transaction.

## Source fidelity in visual edits

The visual editor keeps the imported source and its initial serialized Markdown.
`source-fidelity.ts` compares Markdown trees and applies changes to source spans.
Unchanged nodes keep their original bytes. Text changes retain surrounding
markers, reference definitions, blank lines, escapes, and line endings.
A second parse checks the meaning of each candidate. If a text patch changes
syntax, the editor tries the changed block before the full serializer fallback.
An external revision resets the source map. Undo can return the exact initial
source, and synchronous flushes use the same source restoration as edit events.

`milkdown-table-breaks.ts` keeps visual line breaks inside table cells. It reads
safe `<br>` tags before Milkdown removes empty-line placeholders. Both cell
serializers retain trailing and consecutive breaks as `<br>` tags. A blank cell
stays empty. The Enter handler runs after ProseMirror's input-method guards.
`milkdown-table-selection.ts` sends cell pointer events to ProseMirror instead of
selecting the whole paragraph after a click. It retains the Crepe table node view.
The same node view labels the icon-only table controls and removes hidden ones
from the tab order.
`milkdown-table-clipboard.ts` keeps table structure when a copied row or rectangle
is pasted into a table. It converts copied cell types to the destination row type,
skips the whole-table header repair inside a table, and keeps an author break at
the end of a cell. Paste outside a table keeps the default clipboard path.

The Source editor applies CodeMirror change ranges to its stored source. This
keeps unchanged CRLF and mixed line endings through Source and Split edits.
The source fidelity browser report compares actual exported source with an
explicit expected file and retains both Git diffs.

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

Desktop Complete does not accept JavaScript paths for file commands. A Rust-owned picker or operating-system open event canonicalizes the path and returns an opaque session token. Rust stores approved Markdown paths in `disk-access.json` in the application data directory. It issues new tokens after restart. IndexedDB records cannot add paths to this registry. Removing a disk link revokes its native permission.

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
