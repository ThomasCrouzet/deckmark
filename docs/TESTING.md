# Test policy and evidence

Use E2E tests as the preferred verification method. Test observable results through
the application. For a complex change, write the workflow and its failure cases
before implementation. Never write unit tests after implementation.

If isolated tests are necessary, first record all identified failure risks. Explain
which risk each test detects and why the browser suite cannot detect it. Do not add
tests only to increase coverage. Do not test dependency internals, type contracts,
constant values, or mocked call sequences alone.

## Release review regressions

`e2e/review-regressions.spec.ts` checks these failures through the application:

- A rename can replace a code or image extension with `.md`. Compare downloaded
  bytes and the filename after reload.
- A note rename can rewrite wiki-like text inside a code file. Compare its export.
- A delayed editor mount can take focus from the filename input. Continue typing
  after the editor loads and check the complete name.
- A new document in another window can remain absent from the library. Check its
  content without a reload and keep the current document selected until the user
  opens the new one.

Run `npx playwright test e2e/review-regressions.spec.ts --project=chromium --workers=1`.
The standard report records the source revision, working diff, environment, and
command. The cases attach exports and screenshots as repeatable evidence.

`cli/mcp.test.ts` starts the real Node server with temporary filesystem roots.
It checks sensitive symlink targets, ambiguous paths across roots, malformed
JSON-RPC recovery, and notifications. A browser cannot exercise this process or
its filesystem boundary. Run `npx vitest run cli/mcp.test.ts --maxWorkers=1`.
The review evidence in `/tmp/opencode/mcp-review-evidence.json` records the command,
revision, environment, fixture source, hashes, and before-and-after results.

`e2e/binary-review.spec.ts` compares image and PDF bytes after disk copy actions,
library ZIP export, and project ZIP export. Binary copies must stay unlinked.
An oversized restored PDF must produce an export error. `e2e/pdf-viewer.spec.ts`
checks the native browser viewer under the production CSP. Retain fixture PDFs,
downloads, ZIP files, screenshots, and JSON reports. Run both specs with
`npx playwright test e2e/binary-review.spec.ts e2e/pdf-viewer.spec.ts --project=chromium --workers=1`.

The native Git tests use real repositories. They check executable filters,
included configuration, parent-repository confinement, literal diff paths, and
unstage before the first commit. Check unchanged index and working-tree bytes.
A browser cannot inspect native subprocesses or the Git index. Run
`cargo test --manifest-path src-tauri/Cargo.toml git::tests`. The shell marker case
runs on Unix. Keep the command, source hash, environment, fixtures, and Cargo output.
Unused global and system LFS settings must permit ordinary Git workflows.
Each child command disables executable drivers and requires conversion success.
Git must reject a conversion that needs a disabled driver. Log and cached diff
can read stored objects without conversion. Check conditional includes, attribute
macros, index fallback, info attributes, global attributes, and directory paths.
Compare index and disk bytes after rejected staging. Use separate child
environments for global and system LFS settings. Do not change environment
variables inside parallel tests. Evidence is in `/tmp/opencode/git-ci-fix/`.

Native AI tests bind keys to canonical endpoints, reject caller-selected key IDs,
and check that pending HTTP requests yield. They use an in-memory secret store
and loopback servers with synthetic keys. Browser tests cannot execute this Rust
boundary. Run `cargo test --manifest-path src-tauri/Cargo.toml ai::tests` and
`cargo test --manifest-path src-tauri/Cargo.toml vault::tests`. Keep the report in
`/tmp/opencode/ai-review-cargo-final-evidence.json`. The operating-system keyring
still needs a desktop session. Old host-only entries require key re-entry.

Backup boundary tests check forged grants, persisted grants, replaced roots,
symlink confinement, and retention. Browser tests cannot inspect native directory
handles. Run `cargo test --manifest-path src-tauri/Cargo.toml backup::tests --lib`.
Run `node scripts/verify-desktop-backup-scheduler.mjs` for remaining delays,
overdue startup, opt-in, concurrent disable, and retry behavior. Its JSON report
records the command, revision, source diff, environment, fixtures, and results in
`test-results/backup-scheduler.json`. The native smoke checks picker grants
and denied renderer paths through real IPC.
Close fixture directory handles before cleanup. Windows refuses to remove a
directory while these handles remain open.
An enabled schedule without a previous successful snapshot must run at startup.
Otherwise, repeated sessions shorter than the interval can prevent its first backup.

`e2e/capture-snippets-review.spec.ts` checks snippet updates across windows.
Desktop-edition cases also check first-mount templates, duplicate and concurrent
saves, and failed writes that retain capture input. Set `CAPTURE_REVIEW_DESKTOP=1`
with a Desktop server for those cases. The native-command fixture does not prove
the operating-system shortcut or native window lifecycle. Native smoke covers
those paths. Each browser case retains source metadata, fixtures, and screenshots.
The PDF viewer case uses full Chromium headless mode because the headless shell
does not include the PDF viewer.

The PDF case checks the native viewer, page count, rendered thumbnail pixels, and
exact fixture text before and after reload. It also compares the downloaded bytes.
Keep `frame-src blob:` and `object-src 'none'` in the production CSP.
A blob URL alone does not prove that the PDF rendered. If Chromium changes its
viewer API, inspect a rendered PDF before changing the assertions.

`e2e/cross-window-review.spec.ts` checks two overlapping draft changes. A later
write must replace an earlier read that waits for disk-link lookup. A removal must
invalidate that read, even when the draft is not yet in the receiving window.
The fixture holds a real transaction on `mdsh-fs.handles`. A second window commits
the changes in `mdsh` and sends BroadcastChannel notifications. The cases compare
visible content, the active document, and the persisted row after transaction release.
Run `npx playwright test e2e/cross-window-review.spec.ts --project=chromium --workers=1`.
Keep `sync-evidence.json`, the screenshot, trace, and source metadata with the report.
Both cases failed before the correction and passed in the development check.
The reports are in `/tmp/opencode/cross-window-review-red/` and
`/tmp/opencode/cross-window-review-green/`. The production suite checks them again.

## Edition and hosting checks

GitHub Pages is the only production Web publisher. Check Web Light and Desktop
Complete as different editions. A browser result does not replace a native
Desktop check, and a native result does not replace a browser result.

The deployment workflow builds two base paths. The production path comes from the
current Pages configuration. The other path is a check. Both must produce a usable
PWA with the correct service worker scope.

Build and serve the project-site path:

```sh
npm run preview:pages
```

Build and serve the root path:

```sh
BASE_PATH='' npm run build
npm run preview -- --host 127.0.0.1 --port 4893 --strictPort
```

Run these checks in a fresh browser profile for each base path:

1. Open the served URL and wait for **Ready offline**.
2. Disable the network, reload a deep link, and create a note from the cached shell.
3. Reload the note and confirm that its content remains in IndexedDB.
4. Deploy a new build, save a draft, and apply the update. Confirm that the draft
   reaches IndexedDB before the page reloads.
5. Confirm that application assets and the service worker use the same base path.
6. Confirm that no Desktop-only native module appears in the Web build or precache.

For a custom domain, also confirm HTTPS and the redirect from the project URL.
Do not test DNS changes in CI. Record the domain state as a manual result. A
project-site service worker keeps its old origin after a domain change. Install
the PWA again from the custom domain and repeat the offline checks.

Keep the command, source revision, browser version, base path, domain state, and
results in the run artifact. The browser suite still produces the standard
`playwright-report/index.html` and `test-results/results.json` files.

The retained failure risks are:

- A wrong base path can produce a blank offline shell or an empty precache.
- A service worker with the wrong scope can lose deep-link refresh and offline
  first use.
- A stale project-site worker can keep an old origin after a domain change.
- An absolute asset URL can work on one host and fail on the other.
- A Desktop-only module can enter the Web bundle or precache.
- An update can reload before a draft reaches IndexedDB.

See [EDITIONS.md](EDITIONS.md#hosting-and-downloads) for the hosting contract and
[DEVELOPMENT.md](DEVELOPMENT.md#web-publishing) for the maintainer steps.

## Version 2.0 project risks

At native 200% browser zoom in a 320 by 844 viewport, save-status text can wrap
and reduce the slide editor height. A button that had keyboard focus before the
save can then be covered by the application status bar. Check English and French.
Hold the browser clock before notes input, reach Properties with Tab, then advance
the existing 400 ms save timer. Record the control and editor bounds before and
after the saved-state indicator changes. Keep native zoom, clipping, hit-test,
keyboard, source, and export checks. Retain the runner trace and screenshots.

Run the focused workflow with `npx playwright test e2e/slide-zoom-review.spec.ts
--project=chromium --workers=1 --retries=0`. Record source revision, environment,
build hashes, command, fixtures, and results with each report.

Write browser scenarios before implementation. Test the following failures through visible results and downloaded artifacts where possible.

- Old drafts or backups can lose documents during the schema upgrade. Keep a version 1.9 fixture and compare its complete content.
- Duplicate basenames can overwrite each other. Import separate directories with identical filenames and compare both exported files.
- Archive paths can escape the project root through absolute paths, traversal, encoding, or symlinks. Reject unsafe archives before storage changes.
- Large archives can exhaust memory or storage. Apply entry, depth, compressed, expanded, and image limits before atomic import.
- Missing assets, malformed images, and unsupported links can appear complete. Show a link report with precise document paths and destinations.
- Rendering can replace source image paths or contact a remote host. Compare source text and record requests during offline rendering.
- Visual editing can request a private relative image path before local asset resolution. Record requests for block and inline images.
- Renames can break incoming links, fragments, aliases, code samples, or documents with duplicate basenames. Check each destination after export.
- A storage failure can leave partial projects. Keep existing data and make failed writes visible.
- Backup merge can collide with project identifiers or paths. Keep a complete project copy and make repeated merges idempotent.
- Native directory access can escape through symlinks or stale grants. Check confinement, revocation, restart, and actual file contents.
- External edits can occur during comparison. Recheck the exact revision before overwrite or reload and retain the local version.
- Source preview can reset undo, lose the caret, or block typing. Check navigation, resizing, small screens, and a large document.
- A large comparison can block the interface. Bound comparison work and show any omitted context explicitly.
- A replacement preview can become stale. Refuse changed inputs and rebuild the preview before applying changes.

Feature scenarios cover [split view](testing/split-view.md), [comparisons](testing/diff-workflows.md), [project backups](testing/project-backup.md), [native projects](testing/native-projects.md), and [presentations](testing/presentations.md).

## Code snippets

`e2e/snippets.spec.ts` checks the snippet library in Chromium. The cases are:

- A selection becomes a snippet. A second save with the same code and language
  shows the duplicate message and does not add a row.
- A snippet copies from the keyboard. `${PROJECT_NAME}` and `${FILE_NAME}`
  resolve. An escaped `\${PROJECT_NAME}` stays literal. The favorite state
  survives a reload.
- Search returns 100 of 3000 metadata rows in less than three seconds. The
  panel mounts one code editor, not one editor per result. A query that only
  matches code text returns no result.
- The JSON export and import keep exact code bytes, language, tags, folder, and
  favorite state.
- A backup export and restore keeps the snippet collection and the exact code.
- A 375 by 812 viewport fits the panel. The dialog, search box, list, and close
  button have accessible names.

The spec attaches JSON reports and screenshots with the run. Run it with:

```sh
E2E_PORT=4177 npx playwright test e2e/snippets.spec.ts --project=chromium --workers=1
```

The checks use browser storage and the Chromium clipboard permission. A native
Desktop clipboard and a physical screen reader need a manual smoke test.
The retained failure risks are a lost code byte during a backup round trip, a
search path that reads code instead of metadata, a stale snippet list after a
restore, and a panel that loads every code editor.

The outline and editor keyboard scenarios in `e2e/toc-modes.spec.ts` and
`e2e/editor-tab.spec.ts` check two failure modes. A render can replace heading
nodes before the outline refresh. Tab can move focus and scroll the page instead
of inserting indentation. The Tab scenario runs in Chromium, WebKit, and Firefox.
The outline scenarios run in Chromium. The outline check replaces the heading
nodes in the same frame as the click, so a detached node cannot hide the failure.

The browser filesystem workflow uses an OPFS file selected by its fixture.
It verifies cancellation, stale comparison rejection, reload, and a retained local checkpoint.
Browser file APIs cannot make the final revision check and write atomic against another application.

## Local file and copy workflows

`disk-workflows.spec.ts` checks the visible disk and copy behavior. The cases are:

- A browser without the File System Access API downloads a copy. The status stays
  `draft`, and the original source is not touched.
- A linked file saves in place through the granted handle. An external change
  shows the conflict dialog. Cancel keeps the disk bytes and the local draft.
- Save As writes a new file and leaves the linked source unchanged. A target that
  is the linked source is refused.
- A denied permission shows an error and does not write. The status stays
  `pending`.
- A cancelled save dialog keeps the original and the draft.

The spec attaches a JSON report and a screenshot for each case. Run it with:

```sh
npx playwright test e2e/disk-workflows.spec.ts --project=chromium --workers=1
```

The test replaces the native pickers with OPFS handles. This checks the browser
code path only. A native Tauri save, permission revocation, and conflict flow
needs a manual smoke test on Windows, Linux, and macOS.

The portable project scenario verifies cached rendering after network loss.
Wait for the saved-state indicator before reloading a reopened document.
Service worker readiness does not confirm that the open tab state reached IndexedDB.
Chromium and Firefox use browser offline emulation.
WebKit uses a stopped origin server because [Playwright offline emulation can reject service worker responses](https://github.com/microsoft/playwright/issues/42775).
The report records the disruption and confirms service worker control.
This server outage check does not reproduce every operating system network condition.

## Visual table risks

`table-editing.spec.ts` checks Enter and Shift+Enter in header and body cells.
The first-click case waits for two animation frames, then types without End.
The cell must keep a collapsed caret and retain its existing text.
Line breaks must remain in the selected cell, including consecutive breaks.
Trailing breaks and breaks in empty cells must survive reload and undo.
Imported `<br>` tags must appear as line breaks. Other HTML must remain inert.
HTML paste must keep line breaks and the content of adjacent cells.
The WebKit case sends composition events to check the Safari Enter guard.
This case does not reproduce a physical input method or phone keyboard.
Mode changes, reload, and Markdown export must keep the edited content and other
cells. A copied row pasted into a table must keep one table, the row content, and
the surrounding paragraphs. The rectangle-paste, insert, delete, move, and
alignment matrix lives in the retained clipboard audit, not in this spec.
Hidden table controls must leave the tab order, and tabbable controls need
accessible names. The HTML-paste case runs in Chromium only because it uses the
browser clipboard permission.
Retain the input Markdown, stored and exported bytes, screenshots, and browser
traces with the command and source identity.

```sh
CI=1 xvfb-run -a npm run test:e2e -- table-editing.spec.ts --workers=1 --retries=0
```

## Retained isolated risks

The test review removed duplicate creation, selection, rendering, export, and
preference tests. Browser workflows verify those results. The remaining isolated
tests cover these additional risks:

| Area | Failure risks absent from the browser suite |
| --- | --- |
| Saves, trash, history, and workspaces | Write ordering, concurrent variants, rollback, history retention, invalid records, and failed durability barriers. |
| Native and browser disk access | Revoked permissions, stale capabilities, changed revisions, interrupted reads, rename rollback, and restart recovery. |
| Backup, crypto, and export | Malformed backups, linked ID remapping, authentication failure, invalid crypto parameters, name collisions, and cancellation cleanup. |
| Markdown, search, and media | Hostile CSS and SVG, parser time limits, code and YAML boundaries, Unicode matching, unsafe regexes, invalid images, and resource limits. |
| UI coordination | Competing prompts, rejected lazy imports, stale search results, worker timeouts, failed preference writes, and keyboard composition. |
| Release scripts and budgets | Incorrect checksums, missing installers, source identity, SBOM patch provenance, changelog boundaries, and shared-chunk accounting. |
| Native Rust code | Symlink substitution, persisted grants, file replacement, close ordering, the GLib iterator security regression, vault lifecycle, endpoint validation, and error redaction. |

The native AI boundary tests use an in-memory secret store. A headless Linux
machine can lack a Secret Service. Use a desktop session to test the operating
system credential store. The tests cover endpoint rejection, a missing key that
stops the request, stable error codes, redaction, request body building, and
command return types.

The presentation round-trip test keeps one byte-identity case that a browser workflow
cannot observe directly. The browser suite checks the visible import, edit, and save
path. The isolated test compares the exact parse and serialize result for an ordinary
document and confirms that a model edit adds the metadata block. This is a
low-level format check, not an application conversion path. The application
opens notes only in the note editor.

Remove an isolated case when a reliable E2E test covers the same risk. Keep the
reason for each remaining case clear in its test name. `npm run test:coverage`
still reports coverage for diagnosis. No percentage target requires extra tests.

## Performance benchmarks and native WebView coverage

Use `scripts/benchmark-local.mjs` for repeatable performance evidence. It is one
command with two separate targets. A web run and a native run never share a
result, because a browser process and a native WebView have different renderers,
process models and startup paths.

```sh
npm run build
npm run benchmark:local
node scripts/benchmark-local.mjs --output /tmp/benchmark/web-chromium.json
node scripts/benchmark-local.mjs --browser firefox --runs 5 --output /tmp/benchmark/web-firefox.json
node scripts/benchmark-local.mjs --browser webkit --runs 5 --output /tmp/benchmark/web-webkit.json
```

A native run needs the isolated test binary first:

```sh
npm run tauri -- build --debug --features native-smoke --no-bundle --config src-tauri/tauri.smoke.conf.json
node scripts/benchmark-local.mjs --target native --build-mode debug --output /tmp/benchmark/native.json
```

The command reads local files and writes one raw JSON report. It sends no
telemetry. Its only network request is to the local static server that serves
`build/`.

The report holds the schema version, target, build mode, source revision,
runtime identity, fixture identity, method text, p50 and p95 summaries, raw
samples, a budget comparison and explicit limits. Runtime identity includes the
Node version, OS name and version, CPU model and count, total memory, browser
name and version or WebDriver WebView capabilities, and the CI runner name.
Each fixture records its description, byte count and SHA-256. Generated fixtures
record their generator name and arguments.

### Measured stages

| Metric | Web target | Native target |
| --- | --- | --- |
| Startup | Cold navigation to the ready shell, service worker restart, first contentful paint, DOM content loaded. | Process spawn to the WebDriver ready endpoint, shell ready, close, then warm restart. |
| Typing | In-page insert to the next animation frame, synchronous insert cost, and WebDriver text insertion. Source and visual editor. | The same probes through the embedded WebDriver. |
| Document work | Library reload, document switch, large note open, read mode and visual mode switch. | The same stages in the native editor. |
| Scroll | Scroll to position plus two animation frames in read mode. | The same probe in the native WebView. |
| Project tree | Projects panel open to the expected row count. | The same probe with the native project panel. |
| Presentation | Editor load, slide switch and present mode toggle. | The same stages with native slide rendering. |
| Export | HTML export from the command palette to the browser download event. | Export preparation to the print document. macOS writes the real PDF. Linux and Windows stop before the OS print dialog. |
| Memory | Chromium JS heap from CDP; other engines report `performance.memory` when present. | Resident bytes or working set for the application process tree, including WebView helper processes when the platform reports them. |

The input probe dispatches one `execCommand` insert, then waits one animation
frame. It excludes driver round trip. The sample includes any product work that
the input triggers, such as save scheduling and index updates. WebDriver text
insertion is recorded separately because it includes driver IPC. Do not compare
an engine that handles one insert with an engine that processes each key.

### Fixture corpus and budgets

`scripts/benchmark-fixtures/manifest.json` describes the corpus. The repository
keeps `note-small.md`, `presentation.md`, and deterministic generators in
`scripts/benchmark-fixtures/corpus.mjs`:

- `note-large` creates about 240 KB of Markdown.
- `library` creates 300 notes of about 16 KB each.
- `project-tree` creates one project with 600 documents in 30 nested folders.

`scripts/benchmark-budgets.json` holds one baseline set for each platform key:
`web-chromium`, `web-firefox`, `web-webkit`,
`native-linux-webkitgtk`, `native-windows-webview2` and
`native-macos-wkwebview`. A baseline is a recorded p95 for one platform. It is
not a claim that two platforms have equal timings. The default tolerance is
1.0, so a measurement can be twice the recorded baseline before it reports
`over-budget`. The report always includes the comparison. Pass
`--enforce-budgets` only for a dedicated regression run with a stable machine.

The recorded Chromium baseline near 2.5 s for a document switch uses the
900-document fixture library. This value reproduces the reported desktop
responsiveness problem and is not an acceptance target. Diagnose the stage
before you tighten or raise the value. Keep the matching artifact with any
budget change.

Do not compare these results across platforms, build modes, machines or corpus
counts. A debug native build is slower than a release build. A hosted CI runner
has unequal hardware and a shared CPU.

### Retained benchmark and native risks

- A headless browser does not prove a native WebView result. Keep web and native
  artifacts separate.
- Headless animation frames can be throttled. A large frame delay can include
  engine scheduling and is not always editor work.
- The native benchmark uses a test binary with the embedded WebDriver feature.
  Packaged installers have no test driver. Native timing evidence does not prove
  release performance. Record `buildMode` and compare equal modes only.
- The native matrix uses hosted runners with unequal hardware. A failed platform
  job must keep `results.json`, screenshots, `application.log` and the source
  snapshots.
  The configured output path must receive a report on failure. Record partial
  samples, the read-mode iteration, process state, and diagnostic errors.
  A failed screenshot must not replace the first benchmark error.
- Read mode must not allocate a full-document annotation canvas before the user
  enables annotations. `read-annotations.spec.ts` switches the full native
  benchmark note between Source and Read five times. Keep the canvas dimensions,
  fixture hash, screenshot, and source snapshot. Existing ink must remain visible
  when the user closes the tools. Reload and Clear must remove the ink.
- Linux native tests use WebKitGTK under Xvfb with the DMA-BUF renderer disabled.
  This does not prove compositor behavior on a physical display.
- The benchmark seeds IndexedDB directly. It does not cover the import dialog,
  file picker, disk latency or network conditions.
- A change to a fixture count or generator invalidates a comparison. Compare the
  recorded fixture hashes and corpus counts first.
- A document switch sample includes the pending save flush. A switch on a small
  library is not comparable.
- Small sample counts are explicit in the report. An expensive stage uses five
  samples by default. Treat its p95 as an indication, not a precise percentile.
- Native export evidence stops before the OS print dialog on Linux and Windows.
  Only the macOS run writes the product PDF.
- The native capture workflow uses the command API. A successful browser or
  command result does not prove that an operating-system hotkey is available.
  Hotkey registration on macOS and Windows is recorded only by the CI runners,
  and the system can refuse a shortcut that another application owns.

### Native WebView workflow coverage

`scripts/native-smoke.mjs` runs against the built Tauri binary on its real
WebView. The suite now also records:

- Source and visual note editing, undo, redo and save.
- The project tree row count after a native project import.
- Linked disk save, rename, restart, revocation and stale-write races.
- Focus mode and theme toggles.
- Built-in template creation and the return to the linked note.
- Presentation editing and separate menu and shortcut PDF exports.
- The opt-in quick capture window: command-based opening, a library note, a
  project note, a code snippet, a built-in template, a durable IndexedDB row, a
  reused window, and a cancel path with no new row. The session switches
  windows instead of opening a second WebDriver session. The artifact is
  `native-capture.json`.
- The update standby state: the settings dialog has no update panel, and the
  native install command stays rejected.
- Process memory for the application process tree, startup, reload, save, close
  and template timings, and platform identity from the driver capabilities.
- A failure screenshot, the page state and the last driver response.

The suite does not claim coverage for features that do not exist. The
`features` block in `results.json` records edition capabilities. Do not add a
check for an absent feature. Add one only when the product provides an
observable workflow and the browser suite has a matching case. Desktop AI and
Git have Rust coverage but no interactive WebView capture, because they depend
on credentials or on a repository. Backup snapshots and signed update checks
have native command coverage in `native-desktop-tools.mjs`.

The repository keeps browser E2E on Chromium, Firefox and WebKit. A Chromium
browser pass is not a native desktop pass, and a headless WebKit pass is not a
WebKitGTK pass.

### Benchmark and native CI artifacts

`.github/workflows/desktop.yml` runs these jobs for a Desktop change:

- `web-benchmark` on Ubuntu for Chromium, Firefox and WebKit. Artifact:
  `web-benchmark-<browser>`.
- `native-smoke` on Ubuntu, Windows and macOS with the built test binary.
  Artifact: `native-smoke-<platform>`.
- `native-benchmark` on Ubuntu, Windows and macOS with the same built test
  binary. Artifact: `native-benchmark-<platform>`, which contains the raw JSON,
  screenshots and the application log. The macOS jobs assert an ARM64 runner
  before they run.
- `desktop-validation` requires every job above to succeed. A reused validation
  run must contain one successful job for each browser and each platform.

The performance jobs record budgets but do not fail on a budget difference. A
shared runner is too noisy for that gate. A harness failure, a missing result or
a functional native check failure does fail the job.

## Command-line interface checks

The CLI is a Node process. A browser suite cannot start it and cannot inspect its
exit codes or filesystem refusals. Keep the isolated CLI suite for these failure
risks:

- An output path can escape the working directory through `..`.
- An unsupported format or output extension can create a misleading file.
- A failed check can return a success code in a pipeline.
- Non-deterministic archive dates or path order can break golden files.
- A renderer change can alter the standalone HTML contract.
- A CLI import can enter the Web bundle or the PWA precache.

Run the suite:

```sh
npx vitest run cli/cli.test.ts
```

The suite uses temporary project directories, golden JSON and HTML files in
`cli/test/golden`, and a fixed project archive digest. It records these results:

- The check report and exit code `5`.
- The filtered check exit code `0`.
- Search order and the `deckmark-search/1` schema.
- The inspect report for a note and a presentation.
- The golden render HTML.
- HTML, Markdown, and reproducible ZIP export results.
- Path traversal exit code `4`, usage exit code `2`, and input exit code `3`.

Keep the command, source revision, Node version, fixture paths, and results with
the run. The CLI does not start the GUI, the Tauri shell, or a network service.

## Repeat the browser suite

Browser profiles, downloads, and traces need free temporary storage. If `/tmp`
uses a small memory filesystem, set `TMPDIR` to an empty directory on disk before
the run. Keep any `ENOSPC` failure report and repeat the affected cases after the
storage problem is corrected. Do not treat a failed trace write as an application result.

### Command palette load order

`e2e/palette-load-review.spec.ts` holds a real IndexedDB transaction on
`workspaces` and `templates`. The user types an export query and selects HTML
with ArrowDown. After the transaction completes, saved commands must appear
without changes to the query, focus, or selection. Enter must download the
expected HTML. A second opening must start with an empty query.

Run `npx playwright test e2e/palette-load-review.spec.ts --workers=1`.
Keep the report, source revision, diff, fixtures, screenshots, and exported HTML.
The test runs in Chromium, Firefox, and WebKit.

The export benchmark confirms the named, enabled HTML option directly. Its
measured interval ends at the download event. Completion and byte checks follow
that interval. `exportDownloads` records the filename, byte count, and SHA-256.
On failure, the JSON report retains browser state and errors, then the command
fails. An incomplete run has no budget result.

Run `node scripts/benchmark-local.mjs --browser webkit --runs 5 --build-mode production-static --output /tmp/opencode/web-benchmark-webkit.json`
against a recorded production build. Keep its build hashes with the report.

### Compact toolbars

`e2e/toolbar-density.spec.ts` checks English and French at widths from 320 to
1600 pixels. The app toolbar must fit one row on desktop and two rows on narrow
screens. Check visible mode labels, control bounds, document rename, and menu
focus return. Retain the measured geometry and screenshots.

`ux-review.spec.ts` also checks 44-pixel touch targets and real 200 percent
browser zoom. Use a short `TMPDIR` path on disk for Chromium persistent profiles.
Long paths can exceed the operating system limit for the browser socket.
Desktop backup controls must keep the same touch target size as Settings.

`e2e/presentation-toolbar-density.spec.ts` checks compact presentation controls
with keyboard and touch input, in both languages. It checks source changes,
exact Markdown export bytes, Present, and focus return. It retains geometry,
screenshots, browser errors, fixture content, and source hashes.
The resize case checks browser error events while the viewport changes from
320 to 1280 pixels. Canvas scale updates must run after resize delivery to
prevent a ResizeObserver notification loop.
At widths below 260 CSS pixels, presentation controls can wrap. The native
200 percent zoom checks verify keyboard access before and after a draft save.
Native PDF checks use the command palette because the direct toolbar action
can be hidden at the default window width. The native export benchmark opens
the palette before it starts the export timer.
The offline status keeps a fixed width. `e2e/toolbar-stability.spec.ts` holds
service worker registration, then checks that the mode button stays under the
pointer when offline preparation completes. Long status text uses an ellipsis.
The 400-section source fidelity case has a 60-second timeout. It types each
character through the browser, exports the file, and compares the exact bytes.
Firefox can use most of the default 30-second limit for typing alone. This
timeout permits the export check to finish; it is not a performance budget.

### Blank lines in Markdown downloads

`e2e/markdown-blank-lines.spec.ts` types two paragraphs with an empty paragraph
between them. The downloaded file must contain blank Markdown lines, without an
HTML placeholder. Check the exact bytes after a mode change, a second edit, and
a reload. Wait for the committed draft before reload.

Shift+Enter must use a Markdown hard break. Preserve HTML that the source
already contains, including a separate `<br />`, code, and table cell breaks.
Markdown parsers do not retain empty paragraph nodes. Source fidelity must keep
the blank lines when the editor mounts again and changes nearby text.
The existing-note cases cover LF, CRLF, reference definitions, and blockquotes.
A visual insertion must change the saved gap even when the parsed block content
stays equal.
After export, click the document to place a caret at its start. ProseMirror can
restore the previous selection after programmatic focus. Check the collapsed
selection before the next key.

Run `npx playwright test markdown-blank-lines.spec.ts table-editing.spec.ts source-fidelity.spec.ts --workers=2 --retries=0`.
Keep the report, traces, downloaded bytes, source revision, command, browser,
environment, and fixture text. The blank-line spec attaches each download.

### Code editor focus after delayed loading

`e2e/code-focus-review.spec.ts` delays the code editor while the user types a
snippet title. The title must retain the complete input and focus. Code must
remain unchanged. The test checks saved bytes, keyboard copy, favorites, and
reload. A second case checks initial focus when no control has focus.

Run `npx playwright test e2e/code-focus-review.spec.ts e2e/snippets.spec.ts e2e/code-editor.spec.ts --project=chromium --workers=1 --retries=0`.
Keep the JSON values, screenshots, source revision, environment, and fixtures.

### Whole-application review

The presentation-file review found failures in shared workflows. These retained
browser cases check their observable results:

| Spec | Failure risk and retained result |
| --- | --- |
| `durability-review.spec.ts` | Single delete and a delayed cross-tab read can lose the final visual edit. Check restored content, rollback, conflict copies, and history. Record the event intervals. |
| `note-type-guard.spec.ts` | A rejected note edit can remain visible with a saved status. Check source and visual input, the caret before and after rejection, undo, export, and reopened bytes. |
| `read-preview-isolation.spec.ts` | A delayed render can show interactive content from another file. Check the visible preview and link targets during the delay. |
| `editor-state.spec.ts` | Removing the read article can reset its scroll position before storage. A language change can replace a focused search control and send Undo to another control. Check restored positions, search focus, and exact saved content. |
| `presentation-review.spec.ts` | Delayed image insertion can replace newer edits. Check edits made during decoding, file drops, and text shortcuts. |
| `backup-review.spec.ts` | Replace restore can remove trash resources. Repeated merge can duplicate projects or break ID fragments. Check recovery, binary assets, rollback, and downloaded bytes. |
| `project-link-performance.spec.ts` | Unmatched brackets can block Check links and project export. Record heartbeat gaps and verify nested links and exported Markdown. |
| `modal-isolation-review.spec.ts` | File drops can change the document behind a dialog. Error notices can become inaccessible. Check unchanged content after reload and one accessible alert. |
| `save-recovery-review.spec.ts` | A recovered draft can keep a failure warning, or one recovery can clear another draft's warning. Check per-file retry, partial recovery, and durable content after reload. |
| `toast-overlap.spec.ts` | Save warnings can cover actions, leave recovery controls outside the focus trap, or collapse the document list. Check row selection, direct deletion, Retry, and dismiss in Library and its confirmation dialog at 320 and 1280 px, in English and French. |
| `mixed-document-review.spec.ts` | Search, replacement, backup merge, and project export can use the wrong document type. Compare complete deck bytes, literal ID links, relative links, and presenter notes. |
| `ux-review.spec.ts` | Creation cards and titles can clip at native browser zoom. Check English and French, card-child bounds, Cancel visibility, filename editing, and 44 px controls. |
| `slide-guidance-review.spec.ts` | Disabled source and selection actions can have no visible reason. Check contextual guidance and accessible descriptions at narrow and desktop widths. |
| `slide-zoom-review.spec.ts` | The slide header, inspector, and source actions can become unreachable at 200 percent browser zoom. Complete the English and French keyboard workflows and compare exported source. |
| `presentation-responsive-tasks.spec.ts` | Landscape footers can cover Apply, and a smaller visible viewport can hide the focused field. Check the full task matrix, pointer hit targets, reduced motion, and keyboard-height simulation. |

Run these cases against a production build:

```sh
npm run test:e2e -- durability-review.spec.ts note-type-guard.spec.ts read-preview-isolation.spec.ts presentation-review.spec.ts backup-review.spec.ts project-link-performance.spec.ts modal-isolation-review.spec.ts --project=chromium --workers=1
```

Keep the HTML and JSON reports, fixtures, downloads, screenshots, and failure
traces with the command and source identity. Development-server results establish
the correction only. Run the complete production suite before release.

## Documentation check risks

The documentation check must not change files or start requests. A broad scan can
also block the editor or report a malformed example as a real link. The browser
workflow imports a project archive, runs the check twice, opens one issue, and
compares two downloaded JSON reports. It records the stored documents before and
after the check and rejects every external request. Keep the archive, both JSON
reports, the summary artifact, and the browser trace with the command and source
revision.

The focused source fixtures cover code fences, anchors, duplicate headings,
missing images and alt text, traversal, invalid front matter, ambiguous wiki
targets, and presentation image resources. These cases compare exact issue codes
and source positions. The browser suite cannot show every parser boundary without
a large fixture. The E2E case confirms the report order, navigation, and stable
bytes. A remote image is a warning because the checker never downloads it.
Presentation overflow stays under "Not checked" because text layout needs a
renderer and the model clamps element bounds.

```sh
npx playwright test e2e/docs-check.spec.ts --project=chromium --workers=1 --reporter=line
```

Project link reports follow database traversal order. Random document IDs can
change the order between documents. The project link performance test sorts a
copy by document path before comparison. It checks complete issue objects, their
counts, and their order within each document. Keep the original report and ZIP
downloads in the artifacts. To check repeated imports without retries, run:

```sh
npm run test:e2e -- project-link-performance.spec.ts --project=chromium --workers=1 --retries=0 --repeat-each=8
```

## Documentation site export risks

The site export must not change source Markdown, start requests, or write a
partial ZIP. The browser workflow imports a nested project, exports the site,
reads the ZIP in Node, and resolves every local link and asset from each HTML
page. It compares the stored documents before and after the export. It also opens
the extracted site from a `file://` URL with the network disabled, follows one
navigation link, and rejects every external request.

Keep the source archive, the site ZIP, the report JSON, the summary artifact, and
the browser trace with the command and source revision. Run:

```sh
E2E_PORT=4178 npx playwright test e2e/docs-site-export.spec.ts --project=chromium --workers=1 --reporter=line
```

The isolated fixtures cover nested links, anchors, missing local images, external
images, generated HTML escaping, wiki targets, and deterministic file order. The
browser suite cannot inspect every path boundary without a large archive. A remote
image is a warning and the export removes its source. A missing local image is an
error and the export stops before ZIP creation. The exporter and the Markdown
renderer stay in lazy chunks. Run `npm run size` after a change to the export
entry points.

The visual note guard sets a collapsed DOM range at the paragraph end and waits
for browser selection events before paste. This fixture does not test native End-key
navigation. Keep `before-paste-caret.json`, `after-rejection-caret.json`, and
`after-insertion-caret.json` with the exact source and export comparisons. The
post-rejection check must not move the caret.

For source search, open Settings from the search control with the keyboard.
Change the language and close Settings. Check focus before Escape and Undo.
The replacement input and Replace button share a name. Check that each control
keeps its own focus target. Retain the search values, selection, scroll position,
and exact saved bytes before and after reload.

For responsive presentation checks, wait for the creation dialog to close before
using the editor. The previous presentation can remain visible during creation.
Select motion targets and read their styles in one browser task. Require the
filename input and Present button in both samples. Reject non-finite durations
and keep the 0.001-second reduced-motion limit. Retain every viewport cell and
its exact Markdown export comparison.
On a failed pointer hit test, report the covering element, editor bounds, scroll
position, and focused control. A boolean result alone cannot identify a covered
button in a CI-only failure.

Repeat the editor, modal, and responsive workflows with one worker:

```sh
CI=1 xvfb-run -a npm run test:e2e -- editor-state.spec.ts modal-isolation-review.spec.ts presentation-responsive-tasks.spec.ts --workers=1
```

Keep the JSON and HTML reports, focus traces, motion samples, and exported files.

The native zoom fixture uses a local Chromium extension to set browser zoom to
200 percent. It records the viewport width and device pixel ratio and confirms
that CSS zoom remains unchanged. This differs from the CSS zoom scenario in
`presentation-files.spec.ts`. Neither fixture establishes physical phone keyboard
behavior.

The slide zoom fixture lets Playwright own the trace for its persistent context.
Starting a second trace fails before the workflow. Wait for service worker
installation and the normal offline-ready notice to finish before geometry checks.
A zero-notice count before installation does not establish this barrier. Keep the
successful traces as well as the screenshots, focus checks, and exported bytes.

Save-warning checks include a failed Retry from the warning itself, a later
failure after manual dismissal, and recovery of only one failed draft. Trash
rollback must restore an open tab's active ID when no other tab is active. It must
not replace a tab that the user selected while the operation was pending.

For imported document reload checks, wait for the saved indicator and the
exact committed fixture before reload. Record the same draft ID and content after
reload. An import report confirms parsing, not completion of the 400 ms save.
Use the same barrier before a second tab loads an imported malformed presentation.
Check its exact initial source before the remote repair. Keep the local correction
and revision-conflict checks after that repair.

`e2e/offline-review.spec.ts` checks first-use presentation creation, reload, and
source editing after network loss. It also compares Mermaid diagram geometry
online and offline when the document requests another layout. The application
uses Dagre in both cases to keep its offline resource budget. Chromium and
Firefox use offline emulation. WebKit stops the origin server. Each case confirms
service worker control and retains build hashes, requests, and source bytes.

To repeat these cases against the current production build without rebuilding:

```sh
OFFLINE_REVIEW_PHASE=final npx playwright test --config e2e/offline-review.config.ts
```

### Desktop release checks

The Desktop reuse validator must reject missing, repeated, failed, skipped, or
incomplete platform jobs. It must reject a different source SHA, workflow, or run
event. A valid run has one validation job, one native smoke job and one native
benchmark job for each of Ubuntu, Windows, and macOS, one web benchmark job for
each of Chromium, Firefox, and WebKit, plus one successful aggregate gate. The
workflow trigger must reach the same path classifier for frontend and native
changes.

Browser tests cannot observe GitHub job records. The release-review artifact
retains a 75-case runner that executes the workflow's JavaScript with recorded job
fixtures. It includes the pre-fix and corrected results, commands, and hashes.

The native smoke workflow checks presentation creation, editing, source Apply and
Cancel, file restoration, note editing, the project tree, disk access, focus and
theme, built-in templates, and separate menu and shortcut exports on each platform.
Keep both exports under `native-test-results/presentation-pdf/menu/` and
`native-test-results/presentation-pdf/shortcut/`. Inspect the menu result before
the shortcut export starts. macOS checks the native print operation and its PDF
pixels. Linux and Windows use driver capture of the prepared print document; this
does not prove an operating system print dialog. The CI artifacts are named
`native-smoke-<platform>`.

The native presentation color gate must reject white slide backgrounds and white
shape interiors even when borders remain visible. It must also reject missing
borders and missing arrows when slide backgrounds are present. The PDF inspector
uses sRGB pixels, four background patches per page, and a patch inside each filled
shape. Each patch must match the retained Markdown fixture within eight channel
units for at least 99 percent of its pixels. The rectangle fill must differ from
its slide background so a transparent rectangle cannot pass. Keep all page PNGs
and the inspection JSON even when a color check fails.

Repeat the macOS inspection without rebuilding the app:

```sh
swiftc -O scripts/inspect-native-presentation-pdf.swift -o /tmp/presentation-pdf-inspector
/tmp/presentation-pdf-inspector native-test-results/presentation-pdf/menu/native-presentation.pdf native-test-results/presentation-pdf/menu native-test-results/presentation-pdf/native-presentation.md
/tmp/presentation-pdf-inspector native-test-results/presentation-pdf/shortcut/native-presentation.pdf native-test-results/presentation-pdf/shortcut native-test-results/presentation-pdf/native-presentation.md
```

Linux PDF rendering can demonstrate the retained macOS color defect. Only a new
macOS native run can verify the corrected WKWebView and AppKit print operation.

Native build tools can change tracked configuration files. A working diff hash
alone cannot identify those changes. Keep `source-before-build/`,
`source-after-build/`, and `source-runtime/` under `native-test-results/`. Each
snapshot contains the binary Git diff, full porcelain status, source tree ID,
metadata, and any untracked source bytes. Compare these snapshots with the runtime
binary hash before assigning results to a revision.

### Media consent and export

The legacy HTML background case checks that table, header, and cell background
attributes are removed before preview and HTML export. Visible text must remain.
Passive `cite`, `href`, and `usemap` controls check for automatic requests.
The red-first development proof and downloaded HTML are in
`/tmp/opencode/media-background/`. Repeat the seven scoped cases with:

```sh
MEDIA_REVIEW_PHASE=green npx playwright test --config test-results/expert-review/media-consent/background.config.ts
```

The `srcset` case repeats HTML export after the first error is dismissed. Both
attempts must report the same error without a request or download. The existing
isolated media test compares the complete issue arrays and HTML across repeated
preparation, including the expired-blob marker. Its old count of three omitted
two retained `srcset` diagnostics. Evidence is in `/tmp/opencode/media-diagnostics/`.

`e2e/media-consent-review.spec.ts` records requests from HTML media and escaped
SVG paint URLs. It also checks that unsupported `srcset` causes an export error,
local images and fragment paints survive HTML export, and an ordinary remote
image is fetched only after consent. Each test retains its fixture, intercepted
requests, export outcome, screenshot, and any downloaded HTML.

Run `npx playwright test e2e/media-consent-review.spec.ts --project chromium`
for the production workflow. The scoped development proof uses port 4303:

```sh
MEDIA_REVIEW_PHASE=green-final npx playwright test --config test-results/expert-review/media-consent/playwright.config.ts
```

The scoped configuration, source hashes, pre-fix failures, and corrected results
are in `test-results/expert-review/media-consent/`. This development proof does
not verify the production CSP, service worker, native printing, or audio playback.

### Heading navigation and editing controls

- The table of contents must remain available in Source, Edit, and Read modes.
  Check H1 through H6, duplicate headings, source line navigation, and live edits.
  Code examples and front matter must not create entries.
  Empty documents, narrow windows, and focus mode must not reserve a column.
- A delayed table of contents update can shift a link during pointer activation.
  Record the link geometry from its first visible frame until the column appears.
  Require stable geometry, deliver one normal click, and keep the target heading in the viewport.
  Retain the geometry JSON, final screenshot, HTML report, and failure trace.
- Heading level indicators must follow the pointer and caret without changing document content or exported files.
- The link editor must keep a text contrast ratio of at least 4.5 in the light theme.
  Wait for offline readiness before the fixture reload. An unfinished first installation can show a persistent update notice after reload.
- Delayed search results can move option buttons between pointer movement and activation.
  Record replacement-button geometry before and after results. Require one click at the original point to open replacement controls.
- Visual editor mark boundaries can consume an arrow key without moving the selection.
  Select the wiki alias text explicitly. Check the visible selection before replacement, then verify saved Markdown and navigation.
- A Markdown image without a title must open in Edit mode after a reload.
  Normalize absent parser titles before Milkdown validates image attributes.
  Preserve the source image, caption, and export bytes.
- Shortcut help must distinguish editing commands from configurable application commands.
  A changed binding must survive reload and execute its action once.

Run the heading, outline, link, and shortcut workflows with:

```sh
npm run test:e2e -- toc-modes.spec.ts heading-level.spec.ts link-theme.spec.ts keyboard-settings.spec.ts
```

Repeat the project anchor check with:

```sh
npm run test:e2e -- portable-projects.spec.ts --grep "same-document project links"
```

The browser report retains screenshots, fixtures, and measured link contrast.
Its source metadata identifies the commit and working diff.

### Durability and resource pressure risks

- A restored draft can appear unsaved after reload although its content is durable.
  Check the saved label after content restoration. Keep pending writes and write failures visible.
  Do not use an imported modification date as the local save time.
- A process kill before the 400 ms timer can lose the in-memory revision. An
  unload event is not a durability barrier. Record the last committed revision
  separately from the text that existed only in the editor.
- A kill during an IndexedDB transaction must retain the previous committed
  data. A completed backup or workspace barrier must survive a process restart.
- Concurrent saves must retain both branches, including the closed conflict
  copy. A failed conflict write must not replace the original draft.
- Large libraries can fill storage through drafts, history, and trash. Record
  both logical bytes and the browser storage estimate. A quota error must keep
  the save status in error and roll back the whole backup replacement.
- An export can stop at consent, media fetch, image decoding, stylesheet loading,
  or the native dialog. Cancellation must remove progress UI and print DOM,
  preserve edits and the dirty indicator, and permit the next export.
- An external process can replace, rename, or substitute a selected disk path
  while a save is staged. Native permission revocation must serialize with file
  writes. Check actual filesystem contents and retain each result.
- PDF inspection can exceed its deadline through per-pixel AppKit allocations.
  Keep all page images and pixel assertions, with a measured inspection budget.

These workflows use real browser processes, IndexedDB, and the native WebView.
Test-only gates select interruption points. They do not report simulated
filesystem or quota errors as native evidence.

### Durability and resource pressure evidence

Run the focused browser workflows with one worker:

```sh
npm run test:e2e -- abrupt-exit.spec.ts storage-pressure.spec.ts export-cancellation.spec.ts --project=chromium --workers=1
```

| Workflow | Observable result and artifact |
| --- | --- |
| `abrupt-exit.spec.ts` | SIGKILL before debounce, during a live transaction, and after backup, workspace, and conflict writes. The same profile reopens. `abrupt-exit.json` records process IDs, signals, before/after rows, lost memory-only text, and recoverable history. The backup case also retains its downloaded JSON. |
| `storage-pressure.spec.ts` | A seeded xorshift32 corpus has 300 drafts of 32 KiB, 9,000 history rows of about 2 KiB, and 100 trash entries. `storage-pressure.json` records timestamps, table counts, logical bytes, SHA-256 values, and Chromium usage/quota measurements. A real quota override rejects a save and replacement restore. Retry succeeds when quota returns. |
| `export-cancellation.spec.ts` | Cancel consent, a held image response, image decoding, CSS, fonts, and browser print preparation. Each case keeps the draft and dirty marker, removes progress within two seconds, and downloads a subsequent HTML export. |

The crash workflow delays only the save timer or holds a real IndexedDB
transaction at a known point. The transaction and conflict cases request a
flush first. SIGKILL itself does not run an unload handler.
On Unix, it kills the owned process group, including Chromium's storage and
rendering processes. Temporary-profile cleanup has bounded filesystem retries.
It tests browser-process loss, not device power loss or deletion of a profile.
The quota workflow waits 32 seconds for Chromium's bucket-space cache before
each constrained write. This avoids filling the host disk. The decoder workflow
holds the real bitmap operation until cancellation, then releases it to check
that a late result cannot trigger a download.

For native evidence, build and run in sequence:

```sh
CARGO_BUILD_JOBS=2 BASE_PATH='' npm run tauri -- build --debug --features native-smoke --no-bundle --config src-tauri/tauri.smoke.conf.json
node scripts/native-smoke.mjs
```

`disk-races.json` records actual file replacement, external rename, native rename,
symlink substitution on Unix, and permission revocation before a pending write.
Test-only gates wait at most 15 seconds and are absent from normal builds.
On macOS, the runner cancels the actual Markdown, ZIP, HTML, and print panels
through AppKit. The result includes editor content and dirty state. A later
native print operation must produce a complete PDF.

The macOS runner compiles the PDF inspector once with `swiftc -O` (60 second
compile limit). It inspects two separate product exports. Each inspection has
a 20 second internal budget and a 30 second process deadline on both Apple
Apple Silicon CI runner. The inspector renders every page to a 595 by 842
RGBA bitmap, counts both colored image bands, and checks A4 dimensions and the
final paragraph. It retains both PDFs, all PNG pages, extracted text, per-page
timings, and `native-pdf-inspection.json`, including under `repeated-pdf/`.
The parent `results.json` records source, environment, binary hash, and command.

Browser consent checks replace two isolated tests that asserted mocked export
calls. Native panel checks replace the old assumption that a frontend abort can
remove print content while an AppKit panel remains open. Isolated printer-error
and invalid-stylesheet checks remain because these workflows do not cause those
failures through the operating system.

### Image layout and native export risks

- Milkdown can mount an image node before its asynchronous proxy resolves. Never assign the relative Markdown source to the DOM image.
- Test existing and missing project images. Include block images, inline images, queries, and cross-tab document updates.
- Embedded image data can fill the source editor. Hide the payload with a keyboard-accessible
  control. Editing, undo, mode changes, reload, and Markdown export must preserve the bytes.
- A fixed image height can crop pixels when the PDF width guide or window becomes narrower.
  Check wide and tall images, image resize handles, and the saved scale.
- An image taller than the printable A4 area can cross a page boundary. Check its aspect ratio
  and the actual PDF, including the first and last rows of pixels.
- WebKit can display SVG while `createImageBitmap` rejects it. Use the native image decoder
  as a fallback and retain the image limits and sanitization.
- JavaScript `window.print()` can do nothing in WKWebView. The macOS test must use the product's
  native print operation and save a real PDF. A WebDriver screen capture is not equivalent.
- Native print cancellation, asset failure, repeated export, and a long-running dialog must
  restore the editor without deleting the print content before the operation completes.
- Replacing the macOS application menu can remove Hide, Services, Minimize, and Full Screen.
  Native edit commands must reach the active editor, including Undo and Redo. Application
  shortcuts must execute once and respect user overrides.
- Installer renaming can cause collisions or incorrect checksums. Keep architecture checks
  before collection and calculate checksums from the final published names.
- Presentation separators must stay inside code fences until a matching closing fence.
- An initial horizontal rule without a closing YAML marker must not hide source headings.
- An hourly service worker update can fail offline. Editing must remain usable without an
  unhandled rejection.
- Selection ZIP export must keep the content snapshot taken when the command starts.
- System theme changes must refresh diagram colors without replacing editor history.
- Reading mode must restore list markers removed by the global CSS reset. Check nested
  bullets, ordered-list start values, and task lists without duplicate markers.
- A Safari-compatible user agent can report a Linux keyboard platform. Prefer the platform
  for shortcut labels and keep native Control-only handling inside Desktop.
- The offline status label can change between pointer movement and a click.
  Keep the mode buttons at the same position through service worker activation.
  `toolbar-stability.spec.ts` holds real registration, then checks geometry and
  one pointer click in Chromium and Firefox.

Run the focused browser media workflows with:

```sh
npm run test:e2e -- project-media.spec.ts image-layout.spec.ts media-export.spec.ts source-fidelity.spec.ts portable-projects.spec.ts
```

The project media workflow records all requests for private relative paths.
It covers the initial mount and a cross-tab update of the same visual editor.
The attached ZIP contains existing and missing block and inline image fixtures.
The request artifact must contain an empty JSON array.

Run the native build command from `.github/workflows/desktop.yml`, then
`node scripts/native-smoke.mjs`. On macOS, `native-test-results/native.pdf` comes from
the same native print operation as the application. The test supplies a save destination
instead of a print panel. PDFKit checks A4 pages, the final paragraph, and both colored
image borders on one page. It writes page images and `native-pdf-inspection.json`.
Native menu checks inspect shortcut bindings and execute the associated AppKit actions.
Reports include the command, source SHA, working diff identity, binary hash, environment,
fixture, and results.

Use the Node version from `.node-version` and the committed lockfile:

```sh
npm ci --legacy-peer-deps
npx playwright install --with-deps chromium firefox webkit
npx playwright test --ignore-snapshots --grep-invert "Snapshots visuels"
```

Playwright builds the application and starts a new preview server. Each workflow
uses a fresh browser context. Test helpers reset local data. Visual snapshots are
local-only, as specified in [CONTRIBUTING.md](../CONTRIBUTING.md#visual-tests-snapshots).

On a Linux host without a display, prefix the browser command with `xvfb-run -a`.
The scrollbar tests use headed Firefox because its headless mode hides native
scrollbars. CI supplies a virtual display for the same checks.

For the bulk deletion, PDF width, scrollbar, and heading-command workflows:

```sh
npm run test:e2e -- bulk-delete.spec.ts editor-width.spec.ts slash-commands.spec.ts
```

The deletion fixtures stop the browser context clock before the pending edit.
Separate clock installation and pause calls can race with real time and reject the pause timestamp.
Keep the edit, deletion, storage, and reload assertions active when correcting clock setup.
The cross-tab cases use real IndexedDB transactions and BroadcastChannel messages while editor and save timers remain stopped.

## Verify the artifacts

Every browser run produces:

- `playwright-report/index.html`: test results, steps, attachments, and Git metadata.
- `test-results/results.json`: machine-readable results, project settings, source metadata, and timing.
- `test-results/`: failed-test screenshots and traces, plus workflow attachments.
  The PDF width test attaches the actual A4 PDF that it measures.
  Cross-tab tests attach saved document and active-view evidence. Scrollbar tests
  attach screenshots and measured drag positions.

Open the HTML report with `npx playwright show-report playwright-report`. Inspect a
failed trace with `npx playwright show-trace <trace.zip>`. Use the report's file,
test title, and browser project to repeat one case with `--project` and `--grep`.

CI runs two browser shards with one worker each. The protected `e2e` check requires both shards to succeed.
Chromium runs all scenarios. Firefox and WebKit run engine-sensitive persistence, editing, layout, and source checks.
Append `--shard=1/2` or `--shard=2/2` to repeat one shard.
CI runs the browser and native tests without uploading reports to GitHub.
Keep repeatable evidence in local storage. Compare its source commit with the release tag before using it.

Source fidelity and library export limits use [source-fidelity.md](testing/source-fidelity.md).
The source comparison algorithm also needs isolated checks. Browser exports cannot
identify which span or semantic check selected a fallback. The retained risks are
word offsets, edits across marks, repeated occurrences, block insertion and removal,
delimiter changes, CRLF, the BOM prefix, final newlines, empty input, and rejection
of a patch that changes meaning. Write these checks before changes to the algorithm.
Use the real Markdown parser and exact strings. Run
`npm run test -- src/lib/source-fidelity.test.ts`. The BOM check uses the same
prefix removal as the visual editor. Browser cases still verify the complete save.
Add `--reporter=default --reporter=json --outputFile=test-results/fidelity-unit.json`
to retain exact test results and path counts in each result's `meta.pathCounts`.

Run `E2E_PORT=4287 npm run test:fidelity -- --workers=3` for sentence edits,
source syntax, line endings, undo, mode changes, reload, and export. Inspect
`test-results/source-fidelity.json`. Every comparison must be exact, with zero
unexpected changed lines. Check test statuses as well as comparison totals.
The BOM import, disk save, and external-conflict browser cases replace the
isolated disk test that expected BOM removal and checked mocked revision calls.
The browser case retains actual disk bytes and confirms that an external
revision cannot be replaced without consent.
Repeat it with `npm run test:fidelity -- --project=chromium --grep "a linked disk file"`.
Its `bom-disk-save-disk-bytes.md` and `bom-disk-conflict-disk-bytes.md` attachments
come from fresh file snapshots. The case compares complete UTF-8 buffers before
it decodes them for the source report. This checks the browser linked-file path
with a real origin-private file handle. It cannot run Tauri native file writes.

## Presentation workflows

Document type comes from content. Notes open in the note editor; valid and
malformed presentation markers select the inline slide editor. The format stays
at version 1 with no database migration.

Retain these failure risks for `e2e/presentation-files.spec.ts` and the existing
presentation workflows:

- New can create the wrong type, create a file after Cancel, or lose keyboard focus.
- Opening, switching, or reloading files can rewrite source or show the previous deck.
- A note action can add presentation data, or a note-only shortcut can edit a deck.
- A fenced or front matter marker can misclassify a note. Invalid metadata can
  incorrectly open the note editor and hide the source error.
- Advanced source can save before Apply, discard a rejected draft, remove the
  presentation marker, or overwrite an external change. Verify Apply and Cancel.
- The inline editor can block global navigation as if it were a modal. Only
  Present must confine focus; Escape must restore the inline editor.
- Presenter notes can be hidden on first open, lost after reload, or included in
  HTML or PDF. Markdown must retain them.
- Creation cards, Export, Advanced, and presenter notes controls can become
  unavailable at narrow widths, with French labels, or at 200 percent zoom.

Run the browser workflows with:

```sh
npm run test:e2e -- presentation-files.spec.ts presentation-editor.spec.ts presentation-format.spec.ts presentation-export.spec.ts presentation-offline.spec.ts presentation-performance.spec.ts --project=chromium --workers=1
npm run test:e2e -- presentation-mobile.spec.ts --project=mobile-chromium --workers=1
```

The editor workflow checks fenced separators, front matter bytes, object editing,
save failures, keyboard playback, selection announcements, focus restoration, and axe results.
The format workflow checks an unknown version, malformed JSON, duplicate identifiers,
an element outside the slide, a marker inside a fence, and a separator inside a fence.
Each failure case must keep the source bytes visible and unchanged.
The export workflow retains the HTML file and the PDF. It checks one PDF page for each slide.
The offline workflow opens the lazy editor after the first installation loses its network.
The performance workflow drags a 20-slide deck and records the interaction budget.

Each run keeps the HTML report, `test-results/results.json`, traces, screenshots,
and the attachments written by the workflow. Keep these files local.
The source metadata in the JSON report identifies the commit, working diff, Node
version, and browser projects. Do not upload reports to GitHub.

At the end of each presentation-file run, record a summary in
`test-results/presentation-files-<revision>.json`. Use the tested source revision
in the name. Include the exact command, source revision and working diff
identity, platform, Node and browser versions, fixtures, pass/fail/skipped
results, and the path to `playwright-report/index.html`. Include paths to the
retained Markdown, HTML, PDF, and screenshot evidence as applicable.

Record the responsive and first-use review with that artifact. Test widths 320,
360, 390, 768, 1024, 1280, and 1440 in portrait and landscape, English and French,
200 percent zoom, and reduced motion. Review creation, editing, presenter notes,
Present, and Export. Record keyboard-only and human screen reader checks
separately from axe and accessibility-tree assertions. Mark a check that was not
run as **not run**. This test plan does not report a passing run or manual review.

See [presentation scenarios](testing/presentations.md) and the
[presentation file review](testing/presentation-files.md). The release gate also
requires `npm run check`, `npm run lint`, `npm run test`, `npm run build`, and the
full E2E suite because document types affect navigation, storage, export, and PWA
paths. A focused run does not replace that gate.

## Version 2 accessibility

The project tree, split view, history comparison, and disk comparison must support keyboard operation.
Check initial focus, focus confinement, focus restoration, scroll access, and text contrast.

Run `npm run test:e2e -- v2-accessibility.spec.ts --project=chromium`.
The Playwright report retains screenshots and axe results.
Wait for interface animations before the contrast check. Keep all serious and critical violations as failures.

## DeckMark Relay design

The Relay checks retain these failure risks: a first visit can follow a light OS
instead of the dark default; a saved theme can be lost; touch targets can be too
small; the toolbar can overflow; list semantics and keyboard focus can be lost.
A library with more than 80 documents can hide rows if virtual offsets do not
include the height of touch controls or a second line for project paths.

Build the app, start a preview, then run the design check in another terminal:

```sh
npm run build
npm run preview -- --host 127.0.0.1 --port 4893 --strictPort
RELAY_URL=http://127.0.0.1:4893 node scripts/relay-review.mjs
```

The check uses the Night survey document. It captures dark and light views at
1440 by 900, 820 by 1180, and 390 by 844 pixels. It asserts tagged axe results,
44 px touch toolbar targets, theme persistence, system theme changes, drawer
focus, and reflow at 320, 600, 768, and 1024 pixels. It keeps screenshots and
`test-results/relay/validation/browser.json`, including the command, source
revision, working diff hash, environment, fixture, and results. These checks do
not replace review with assistive technology on physical devices.

Filled danger buttons must keep readable text in both themes. Check the disk
conflict and replacement dialogs with axe. The System theme fixtures must select
System explicitly because the first visit starts dark. Reading and slide views
must show one checkbox per task without an additional list marker.

Run the full browser suite on Linux with a virtual display:

```sh
xvfb-run -a npm run test:e2e -- --ignore-snapshots --grep-invert "Snapshots visuels" --workers=4 --output=test-results/final-e2e
```

The final browser output is in `test-results/final-e2e/`. The HTML report and
JSON result use the standard paths above. Use a separate output directory to
keep capture evidence from an earlier run.

### Native text export source bytes

The browser cannot run the Tauri export bridge. A UTF-8 decode in that bridge can
remove a Markdown byte order mark before the native write. Keep one isolated
integration case for this failure. It supplies the native picker grant and writes
the bridge output to a real temporary file. Compare the saved bytes with the
export Blob. Do not replace this check with a mocked call-count assertion.
Run `npm run test -- src/lib/disk-tauri.test.ts` to repeat this case.

The drag performance fixture waits for a stable object after it closes Source
view. A pending canvas resize can move the screen baseline without a drag error.
Keep the movement and frame-time limits. Retain measurements before assertions.
The disk source fixture retries a fresh File snapshot while a write completes.
A browser can reject an older snapshot with `NotReadableError` during that write.
The fixture must still compare the committed file bytes and the rejected branch.

## Project explorer and project drops

The project explorer keeps its expansion state in `mdsh:project-expanded`.
`e2e/project-explorer.spec.ts` checks these failure risks through the browser:

- A document switch or reload can lose the expanded folder state.
- A project document can appear twice or receive a new identity when it opens.
- A drop can place a file in the wrong folder or steal an operating system drop.
- A name conflict can overwrite an existing document.
- A folder move can break Markdown links, wiki links, or image paths.
- A cancelled conflict can leave a partial move.
- A path traversal or unsupported file can change the project before it fails.
- A large folder can block the interface without bounded rendering.

The spec records the stored drafts, the rewritten Markdown, a screenshot, and a
JSON report with the expansion keys or the drop result. It also records a
heartbeat for the 320 document fixture.

Run the focused workflow with:

```sh
npx playwright test e2e/project-explorer.spec.ts --project=chromium --workers=1 --retries=0
```

The operating system directory case uses `webkitRelativePath` on a synthetic
`DataTransfer`. Chromium does not give `webkitGetAsEntry` entries to a synthetic
drag, so the test checks the relative path fallback. A manual desktop drag of a
real directory is still necessary for the entry traversal branch. The test does
not reproduce a denied operating system permission or a real storage quota
failure. The move transaction is the rollback boundary for those failures.
