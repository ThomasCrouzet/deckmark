# Development guide

Use [CONTRIBUTING.md](../CONTRIBUTING.md) for setup and code rules.
Use [ARCHITECTURE.md](../ARCHITECTURE.md) for design decisions and [TESTING.md](TESTING.md) for verification.

## Daily commands

Use Node 22 or later and the committed npm lockfile.

```sh
npm ci --legacy-peer-deps
npm run dev
npm run check
npm run lint
npm test
npm run build
npm run size
npm run preview
npm run preview:pages
```

`make dev` binds Vite to `127.0.0.1`.
`make dev-tailnet` exposes the development server on a private network address and prints the URL.
`npm run preview:pages` checks the `/mdsh/` base path.
Run the browser and native commands from [TESTING.md](TESTING.md) for changed workflows.
Do not run two builds in the same working directory at the same time.
On a shared machine, use `npm test -- --maxWorkers=1`, Playwright `--workers=1`,
and `CARGO_BUILD_JOBS=2`. Run the heavy checks in sequence.

## Desktop development

Tauri wraps the same static application. Use the Rust version from `rust-toolchain.toml`.
Platform libraries are listed in [CONTRIBUTING.md](../CONTRIBUTING.md#setup).

```sh
npm run desktop:dev
BASE_PATH='' npm run desktop:build
```

| Concern | Implementation |
| --- | --- |
| Disk access | Native pickers and opaque Rust tokens. IndexedDB keeps links, not authority. |
| Menus | macOS application, File, Edit, and Window menus. Custom accelerators follow the Desktop shortcut profile. |
| Editing | Native Undo and Redo use the active editor history. Standard clipboard commands use the system responder. |
| PDF | macOS uses an asynchronous WKWebView print operation. Its completion callback releases the prepared DOM. |
| Window state | `tauri-plugin-window-state` restores size and position. |
| File associations | `.md`, `.markdown`, `.mdx`, and `.txt`; argv and operating-system open events. |
| Service worker | Disabled in Desktop. Assets come from the package. |
| Version | `package.json`; Tauri reads this file directly. |

Generate brand assets with [BRANDING.md](BRANDING.md). Do not use a separate icon source.

## Module map

### Application and editors

| Path | Purpose |
| --- | --- |
| `src/routes/+page.svelte` | Coordinates modes, commands, file intents, and panels. |
| `src/lib/components/EditorPane.svelte` | Selects the editor and controls document width. |
| `src/lib/components/Editor.svelte` | Milkdown lifecycle, image scaling, native history, and diagram previews. |
| `src/lib/components/SourceEditor.svelte` | Lazy CodeMirror loading, search, history, and caret restoration. |
| `src/lib/source-extensions.ts` | Markdown parsing and reversible image-data concealment. |
| `src/lib/components/ReadView.svelte` | Rendered content, wiki navigation, and explicit image embedding. |
| `src/lib/components/DocumentNavigator.svelte` | In-mode search and outline navigation. |
| `src/lib/editor-state.ts` | Per-document source history and session positions, limited to 32 documents. |
| `src/lib/milkdown-mermaid-preview.ts` | Lazy Mermaid previews and stale-result protection. |

### State and local data

| Path | Purpose |
| --- | --- |
| `src/lib/files.svelte.ts` | Reactive library, open tabs, selection, and operation coordination. |
| `src/lib/db.ts` | Dexie schema for drafts, trash, workspaces, versions, templates, and metadata. |
| `src/lib/save-queue.ts` | Serialized draft writes, 400 ms debounce, conflict copies, and durability barriers. |
| `src/lib/trash.ts` | Atomic deletion and restoration; purge keeps live history and disk ownership. |
| `src/lib/cross-tab*.ts` | Broadcast delivery and conflict policy. |
| `src/lib/disk-sync.ts`, `fsa.ts`, `disk-tauri.ts` | Browser and native disk links, revision checks, rename, and permission renewal. |
| `src/lib/services/backup.ts`, `crypto.ts` | Validated backup, merge, replacement, and optional encryption. |
| `src/lib/meta-index.ts`, `wiki-links.ts` | Cached metadata, link resolution, backlinks, and target rewriting. |
| `src/lib/workspaces.svelte.ts`, `templates.svelte.ts` | Saved tab sessions and document templates. |
| `src/lib/version-history.ts` | Checkpoints, retention, and version comparisons. |

### Rendering and export

| Path | Purpose |
| --- | --- |
| `src/lib/render/markdown.ts` | Lazy Markdown, math, code, and diagram rendering. |
| `src/lib/render/sanitize-html.ts` | Shared HTML, CSS, SVG, and remote-image controls. |
| `src/lib/render/image-media.ts` | Image validation, size limits, and portable bytes. |
| `src/lib/render/document-media.ts` | Rewrites image destinations after explicit file selection or consent. |
| `src/lib/render/image-markdown.ts` | Preserves image alternatives, captions, and scale metadata. |
| `src/lib/services/export.ts`, `export-ops.ts` | Export snapshots, downloads, native saves, and feedback. |
| `src/lib/render/print.ts`, `print-desktop.ts` | Print documents, asset preparation, and platform dispatch. |
| `src-tauri/src/printing.rs` | Native macOS print panel, pagination, and completion callback. |
| `src/lib/services/clipboard.ts` | Markdown and rich HTML clipboard formats. |
| `static/print/print.css`, `static/katex/` | Local print styles and math fonts. |

### Shared interface and workers

| Path | Purpose |
| --- | --- |
| `src/lib/i18n/messages/{en,fr}.ts` | Interface catalogs. English defines the message keys. |
| `src/lib/ui/commands.ts`, `keyboard.svelte.ts`, `shortcuts.svelte.ts` | Command metadata, profile overrides, and keyboard dispatch. |
| `src/lib/desktop-shell.ts` | Native menus, file delivery, external links, and close guard. |
| `src/lib/ui/modals.svelte.ts` | Lazy panels and retry after an unavailable chunk. |
| `src/lib/ui/theme.svelte.ts`, `theme.ts` | System, light, and dark themes, including diagram updates. |
| `src/lib/ui/pwa-update.ts`, `offline.svelte.ts` | Offline readiness and save-before-update behavior. |
| `src/lib/search-core.ts`, `replace.ts`, `workers/` | Bounded search and replacement. |
| `src/lib/report.ts`, `notify.svelte.ts`, `storage.ts` | Error reporting, notifications, and storage status. |
| `src/app.css`, `src/lib/styles/`, `milkdown.css` | Theme tokens and editor typography. |

## Bundle and offline limits

Rendering libraries and editor engines must stay outside the startup graph.
Use dynamic imports for Markdown, KaTeX, Mermaid, highlighting, ZIP, and YAML.
Keep Tauri API imports behind the Desktop boundary.

Keep the KaTeX override linked to the direct dependency through `$katex`.
This shares one parser version across Milkdown, Mermaid, and Markdown rendering.
Regenerate the bundled CSS and fonts after a KaTeX update.
The visual editor loads its Milkdown plugin imports through one deferred module.

### Milkdown image proxy patch

Milkdown 7.22.2 initializes each image view with the raw Markdown source.
The view mounts before an asynchronous image proxy resolves.
A relative project path can therefore cause a request to the application origin.

`patches/milkdown/image-proxy-race.patch` initializes block and inline image views with an empty source.
The existing proxy then supplies a data URI or the blocked-image placeholder.
The patch changes the published JavaScript files that Vite imports.
It also changes their TypeScript source files for inspection.

`npm run patch:milkdown` applies the patch and verifies the installed package version.
`npm run patch:milkdown:check` fails if the package version or required patch state differs.
The prepare, development, check, and build commands apply the patch idempotently.
This also repairs a cached `node_modules` directory before a production build.
The patch script requires Git, which is already required for repository development.

Remove the patch after Milkdown ships the same fix and the browser media workflow passes.

### Bundle budgets

`npm run size` checks public chunks, transitive mode graphs, and the PWA precache.
Its graph artifact is `.svelte-kit/output/client/.vite/bundle-graph.json`.
Do not add all mode totals: the graphs share modules.
The large Mermaid ELK chunk is excluded because the application uses the Dagre layout.

After a chunk-layout change, check startup imports and a fresh offline browser context.
Do not raise a budget to hide an unintended eager import.

## Release procedure

1. Complete the checks in [TESTING.md](TESTING.md).
2. Push reviewed Conventional Commits and wait for the applicable CI checks.
3. Review and merge the release-please version and changelog pull request.
4. Verify the stable `v*` source release and its exact Pages deployment.
5. Verify the separate `desktop-v*` prerelease, installers, checksums, SBOMs, and provenance.

Desktop publishing reuses successful validation only when the source SHA matches exactly.
A manual Desktop run requires `release_tag` and must run from that source tag.
Pushing a tag alone does not start the Desktop workflow.
See [GITHUB_SETTINGS.md](GITHUB_SETTINGS.md) for repository controls.
