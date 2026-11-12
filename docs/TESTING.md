# Test policy and evidence

## Large rendered input risks

Retain local input latency at both ends of a 5 MB note. Keep each raw
beforeinput-to-second-frame sample, not only the last position. This measures
browser frame scheduling, not physical display latency. Record warmup input
and navigation tasks separately from steady input and its final save. Keep the
100 ms p95 input budget and the 250 ms long-task budget. Disable Playwright DOM
tracing for timing runs. Retain JSON samples and screenshots instead.
The 1 MB slow-input case includes publication and the 400 ms draft save between
keys. Compare saved source bytes after edits and immediate mode changes.

Incremental serialization must preserve block separators, lists, empty blocks,
inline marks, images, tables, undo and structural edits. Source fidelity and
document revision workflows check exact exports and outgoing snapshots. Offscreen
layout must still permit selection, find and outline navigation.

The mounted editor must remain read-only until source reconciliation is ready.
Heading ID updates must keep duplicate IDs consistent after edits and undo.
The ID timer must stop when the editor is destroyed. Large notes use the native
caret. Retain inline mark editing and keyboard selection through browser checks.
Plain headings and paragraphs use scoped source reconciliation. Structural edits
retain the conservative whole-document path.

Run `npx playwright test e2e/editor-input-latency.spec.ts --grep 'large rendered'
--project=chromium --workers=1 --retries=0 --trace=off`. Retain the JSON and HTML reports,
fixture hash, browser version, source revision, working diff, command and raw
measurements. Run source-fidelity, document-revisions, toc-modes and navigation
workflows for correctness. Chromium timings do not establish native WebView or
other browser performance.

The retained `markdown-incremental.test.ts` checks the serializer work bound:
an unchanged top-level block must not be serialized after a local edit. Browser
export checks establish source bytes but do not identify that internal work.
Use the browser source-fidelity corpus for actual Milkdown serialization.

### WebKit large-note paragraph paint

Issue #553 covers the WebKit gap left after #431. The retained risks are a new
paragraph that stays in the DOM while the next frame paints nothing, text that
is transparent, clipped or covered, a scroll that hides the paragraph, a mode
change or reload that loses inserted bytes, and an undo that removes a
different range.

`e2e/editor-large-note-visibility.spec.ts` seeds a 240 KB note with several
headings, inline images and several hundred lines. It opens the visual editor
and inserts three consecutive paragraphs through real Enter and text input.
It then checks each paragraph before any pointer event:

- A screenshot of the viewport is decoded in the page. The modal background
  color is the local reference. Glyph pixels more than 90 color-distance units
  from that background must number more than 20 in each paragraph rectangle.
  A test paragraph with hidden, transparent, clipped or covered text keeps
  this count near zero.
- The rectangle must have a positive size and stay inside the viewport. The
  computed display, visibility, opacity, color alpha and `user-select` must
  permit visible, selectable text.
- `document.elementFromPoint` at the paragraph center must resolve to that
  paragraph or a descendant.
- A Range over the paragraph text must select the exact text and produce at
  least one client rectangle.

The case repeats the paint check after scroll out and back, after a Source and
WYSIWYG round trip, and after reload. It compares the downloaded Markdown with
the exact prior source plus the three paragraphs after every durable state. It
checks undo and redo before the mode change. The spec is selected by the
`webkit` project. It uses no Chromium-only API. The mobile WebKit project does
not select it: on the 240 KB fixture, one Enter can be lost in the mobile
emulation and the paragraphs merge. A mobile paint case needs a smaller
fixture and a separate review.

Run:

```sh
npx playwright test e2e/editor-large-note-visibility.spec.ts \
  --project=webkit --workers=1 --retries=0
```

Keep the attached `visibility-evidence.json` and `visible-paragraphs.png` with
the fixture hash, browser version, source identity and command. The screenshot
proves compositor output for the test viewport. It does not prove a physical
display, a native WKWebView paint, or a different engine.

## Image-rich rendered input risks

Keep the image-heavy typing attribution independent from the text-only latency
cases. The measured risks are a decoded bitmap that grows without a bound, a
project image that is read and hashed again for an unchanged source, a NodeView
update that resolves the proxy again, a resize callback loop, a late fetch
policy write that restarts a load, and layout work that moves scroll anchors.
Compare a text-only control with 1, 4 and 12 images at equal text size, a
near-limit pixel image with small encoded bytes, and project-linked assets.
Record p50 and p95 input-to-second-frame time, engine long tasks, image proxy
calls, project media reads, decodes and the saved Markdown bytes.

Run:

```sh
E2E_PORT=4395 npx playwright test e2e/image-input-latency.spec.ts --project=chromium --workers=1 --retries=0
```

The spec attaches `image-input-latency.json` with the fixture hash, image sizes,
raw samples, counters and the browser version, plus `saved-note.md`. The WebKit
project runs the same scenarios. A Chromium and WebKit result does not cover a
native WebView, a physical display or a thermal state.

The visual preview budget is separate from the upload limit. Keep the original
Markdown, the original image bytes and the Read and export sources exact. The
WYSIWYG node may use a bounded object URL. Retain the preflight rejection case:
an image with a small encoded size and a huge declared pixel count must fail
before a bitmap decode. Run
`npx playwright test e2e/image-preview-budget.spec.ts --project=chromium --workers=1 --retries=0`
and the WebKit project. The reports record the decoded size, generated previews,
revoked object URLs, import counters and available heap values.

## Project media cache epochs

A repeated resolve of an unchanged project image must return the resolved data
URI before an IndexedDB read or a byte fingerprint. Retain the counters
`assetReads`, `fingerprintCalls`, `decodeCalls` and `resolvedHits` in the
`__MDSH_PROJECT_MEDIA__` probe. A draft content save in another tab must not
increment the global media epoch or cancel another document's image work. An
asset write, a project asset broadcast and a backup restore must still invalidate
the resolved path. The same ID, MIME and byte length with different bytes must
return the new image.

Run:

```sh
npx playwright test e2e/project-media-cache.spec.ts --project=chromium --workers=1 --retries=0
```

The WebKit project runs the same cases. The spec attaches the raw counters, the
replacement byte length and the observed image pixels. A cached string and DOM
result do not prove GPU texture release or native WebView memory.

## Image block geometry risks

Keep the image sizing work bounded. The risks are a ResizeObserver feedback
loop, a synchronous layout read for every image on every frame, a fetch policy
write during a sizing pass and an offscreen image with a 2.4em intrinsic height.
The editor stores the observed block width once per delivery, reads all sizes
before writes and writes a style only when the value changes. An image block
uses the measured display width and aspect height for its intrinsic box.

Run:

```sh
npx playwright test e2e/image-resize-budget.spec.ts --project=chromium --workers=1 --retries=0
```

The Chromium, Firefox and WebKit projects run the case. It attaches the block
metrics, the attribute mutations from a viewport resize and a typing burst, and
a screenshot. A DOM attribute count is not a compositor or layout count.

## Image NodeView proxy risks

Keep the NodeView proxy work tied to a changed image source. The risks are a
resolution for an unchanged source, a late promise that writes an older image
into a newer node, and a write after the NodeView is destroyed. The patched
Milkdown 7.23.0 view stores the bound source, checks it before the proxy call
and fences each promise with a monotonic token. A self-contained `data:` image
returns a synchronous visual source and never imports the project media module.

Run:

```sh
npx playwright test e2e/image-nodeview-proxy.spec.ts --project=chromium --workers=1 --retries=0
```

The Chromium, Firefox and WebKit projects run the two cases. The spec uses the
instrumented editor view handle, which a normal build does not expose. It
attaches proxy and project media counters. The stale case fails on the earlier
view with the 1500 px project image after a newer 80 px inline source. A
counter is not a native WebView result.

## Image fetch policy ordering

Set `crossorigin` and `referrerpolicy` before the first `src` value. A relevant
image-data update restarts resource selection when those attributes change
after a load starts. Retain a probe that records each image when it enters the
DOM and every later change to those two attributes. The image-node and inline
views in the pinned Milkdown patch carry the attributes when the element is
created. The editor sizing path writes them only when a value differs.

Run:

```sh
npx playwright test e2e/image-fetch-policy.spec.ts --project=chromium --workers=1 --retries=0
```

The Chromium, Firefox and WebKit projects run the case. It attaches each
inserted image record, the policy mutations, a per-element load count and the
saved Markdown. The earlier view fails the insertion assertion. The load count
is local evidence for a data URI and does not prove a network request count.

## Split heading index risks

Retain the complete navigation index separately from the legacy 300-heading
helper contract. Check headings after 300 in Source and Read. Split caret movement
must not parse unchanged source or query heading nodes. Warm preview scrolling
must not measure every heading. Retain 240 KB and 1 MB fixtures with 1,000 headings,
raw two-frame samples, heading query and rectangle counts, fixture hashes, and
engine-supported CPU/layout counters. A rectangle call is not proof of forced
layout. A two-frame sample is not proof of compositor paint. Mark unsupported
WebKit counters as unavailable, not zero.

Large heading fixtures use a real IndexedDB draft followed by reload. This setup
does not measure bulk typing. Keep insertion-timeout attempts separately from
navigation failures. Use real input for the subsequent structural edits.

Check inserted and deleted headings, pane width, theme, fonts, image load, file
replacement, detached nodes, teardown, focus, undo, and alternating scroll sources.
Keep the 400 ms scroll suppression and draft save delay. Run
`npx playwright test e2e/split-view.spec.ts e2e/toc-modes.spec.ts e2e/navigation-stats-scroll.spec.ts --project=chromium --workers=1 --retries=0`.
Keep the command, source/diff identity, raw measurements and screenshots locally.

Use E2E tests as the preferred verification method. Test observable results through
the application. For a complex change, write the workflow and its failure cases
before implementation. Never write unit tests after implementation.

If isolated tests are necessary, first record all identified failure risks. Explain
which risk each test detects and why the browser suite cannot detect it. Do not add
tests only to increase coverage. Do not test dependency internals, type contracts,
constant values, or mocked call sequences alone.

## Presentation thumbnail retention

An intersection callback can mount a thumbnail once and retain its rich subtree
after it leaves the filmstrip. Visiting a long deck then retains every preview.
The retention case in `e2e/presentation-performance.spec.ts` applies a deterministic
300-slide source fixture through the application. It scrolls the complete strip
forward and backward twice. At each step, it records visible slides, 160 CSS px
overscan, selected/focused pins, mounted rich previews and DOM node counts.
Visible sentinels must render. Rich previews must stay within the current range
plus pins. Lightweight keyed buttons must remain available for all 300 slides.
This case does not establish drag, touch, native parity or a heap budget.

Run the targeted case before application changes:

```sh
npm run test:e2e -- e2e/presentation-performance.spec.ts --project=chromium --workers=1 --retries=0 --grep 'releases offscreen thumbnail previews'
```

Retain `thumbnail-retention-fixture.md`, `thumbnail-retention.json`, the screenshot,
failure trace and standard source metadata with the actual command and exit code.
The JSON records the exact fixture hash, browser, method and every scroll sample.
Keep unavailable tools and failed runs. A DOM count is not a heap measurement.

The content cache bound case applies 300 unique large text slides and visits every
preview. It reads the local `window.__MDSH_PRESENTATION_CACHE__` counters from the
instrumented build. Entries must stay at or below 512, estimated bytes at or below
8 MiB, evictions must occur and no render may remain in flight. The estimate counts
key, source and HTML characters. It is not a heap measurement.

Run the targeted presentation performance file before and after application changes:

```sh
npm run test:e2e -- e2e/presentation-performance.spec.ts --project=chromium --workers=1 --retries=0
```

Retain `presentation-cache-bounds.json` with the fixture hash, browser, command and
cache counters.

## Presentation connector endpoint lookup

A dense slide with linked connectors must not scan every element for each
connector endpoint. The browser suite checks visible connector geometry. It
cannot count the element reads behind one render pass, so it cannot detect a
return to a full slide scan per connector. `render-connectors.test.ts` keeps that
bound. It checks one endpoint index per render pass, a linear id-read count, the
connected and missing endpoint fallback, duplicate ids, and a geometry change
after the index is built. The same file records a 4,000-element,
2,000-connector render benchmark.

Run `npx vitest run src/lib/presentation/render-connectors.test.ts --maxWorkers=1`.
The read count and timings are local diagnostics, not a CI latency budget.

## Large presentation source risks

Decks above 512 KiB open their Advanced source in a lazily loaded CodeMirror
document. The plain textarea remains for small decks and for existing exact-value
checks. The large path must keep the document editable, apply one validated
snapshot, and leave the deck untouched on Cancel. Draft state remains keyed by
file, and source conflicts still compare the original base.

`e2e/presentation-format.spec.ts` checks the CodeMirror path on a 600 KiB deck,
the applied tail edit and the durable row. It does not establish native IME,
physical paint or a 5 MB deck profile; those remain benchmark and native work.

## Release review regressions

`e2e/external-editor-patches.spec.ts` checks a tiny external update in Source and
Code. The failure risks are lost selection direction, a viewport jump, and an
editor feedback write that replaces accepted external bytes. The workflow imports
a real file, selects text backward below the edit, then commits an IndexedDB row
and sends the existing BroadcastChannel notification. It records selection,
scroll, exact fixture bytes and hashes, the durable row and the browser version.
Run `npx playwright test e2e/external-editor-patches.spec.ts --project=chromium --workers=1 --retries=0 --trace=on`.
Keep the HTML and JSON reports, trace and attached observation with the exact
command, source revision, working diff and environment. This small workflow does
not prove native coverage, stale-conflict handling or large-file performance.

`src/lib/code/external-changes.test.ts` covers the native patch helper. The
isolated risks are a change boundary that splits a UTF-16 surrogate pair and
native line-ending normalization for CRLF or bare CR input, plus the large-region
replacement threshold. A browser workflow cannot force those byte boundaries
cheaply. Run
`npx vitest run src/lib/code/external-changes.test.ts --maxWorkers=1`.
The browser workflow still proves selection mapping, scroll position, durable
bytes and the feedback loop through the application.

### Incremental Read rendering risks

Before a renderer change, retain these failure cases: cancelled work can replace a
new file or theme; a section edit can replace all diagram and code nodes; cached
SVG identifiers can collide or lose fragment references; cached output can retain
old media consent or project membership; a width change can leave stale geometry;
and a preview optimization can omit the end of an HTML or print export. Markdown
reference definitions and duplicate headings need document-global parsing.

`rendering.spec.ts` retains DOM handles across a Split edit and checks a complete
101-diagram, 1000-heading HTML download. `read-preview-isolation.spec.ts` checks
delayed file and theme work and layout identity after a width change. Existing
rendering and media-consent cases check offline HTML, PDF and blocked requests.
Run the focused Chromium specs with one worker and retain the standard JSON/HTML
reports, trace, fixture source, downloaded HTML and source identity. Performance
diagnostics must keep raw samples and explicit engine support limits. A diagnostic
without enforced budgets is not a strict gate result.

The Read preview mounts its parsed HTML before the Mermaid lane finishes. A file
or theme switch must cancel the obsolete lane, and the final render must replace
the placeholders without losing headings, anchors or the article identity.
`rendering.spec.ts` covers this with a 30-diagram note that switches to a
one-diagram note after the first non-diagram content. It checks the new document,
the exact diagram count and `mermaid.cancel` counters.

Run `npx playwright test e2e/rendering.spec.ts --project=chromium --workers=1
--retries=0 --grep 'cancels the obsolete Mermaid lane'`. Keep the attached JSON
counters, fixture hashes, browser version and command. The counters are local
diagnostics, not a latency budget.

`src/lib/milkdown-mermaid-preview.test.ts` checks that a second WYSIWYG preview
request aborts the first signal before SVG work starts. The browser workflow shows
only the final preview, so it cannot prove that abandoned queued work was
cancelled. Run `npx vitest run src/lib/milkdown-mermaid-preview.test.ts
--maxWorkers=1`. This does not establish Mermaid CPU cost or native WebView
behavior.

### Incremental visual source reconciliation

Retain these failure risks for issue 310: a scoped patch can target a repeated
paragraph, change decoded escapes or mixed line endings, or use a rejected edit
as its accepted cache. References, block changes, large paragraphs and uncertain
offset mappings need the conservative whole-document check. Multiple changed
blocks must not be treated as a single safe text leaf.
An unresolved reference can become a link to a definition outside the scoped
paragraph. Keep reference-like text on the whole-document semantic route.

`src/lib/source-fidelity.test.ts` checks exact source and parser input sizes.
Exact export checks cannot detect repeated whole-note parsing, so this isolated
resource regression retains real parser and normalizer calls. It uses the full
rich corpus, not a repeated plain-text substitute. Run
`npx vitest run src/lib/source-fidelity.test.ts --maxWorkers=1`.
`e2e/source-fidelity.spec.ts` checks the actual visual editor and exported bytes.
Run `npx playwright test e2e/source-fidelity.spec.ts --project=chromium --workers=1`.
Keep source, expected and exported files, hashes, path decisions, command, source
identity and raw timings with each report. Core parser timings do not establish
browser edit, save, switch or native performance.

### Versioned JSON worker risks

The JSON browser workflows retain these risks: a full parse on the input thread,
unbounded snapshots, stale diagnostics after edits or file changes, a cancelled
action that changes source, lost number or escape tokens, grouped undo, deep input,
invalid large input, and duplicate-key loss. Run the JSON and code editor specs with
one Chromium worker. The JSON profile attaches raw paint samples, fixture hashes,
request and response times, and main-thread long tasks. Chromium attempts a CDP
worker heap measurement. Other engines report an unavailable counter. This profile
does not replace the benchmark gate or native checks.

Run `npx playwright test e2e/json-tools.spec.ts e2e/code-editor.spec.ts --project=chromium --workers=1 --retries=0`.
The standard report retains fixtures, traces on failure, source metadata, and the
`json-worker-profile.json` attachment. Firefox and WebKit include these specs in
their remote project lists. No existing performance budget changes.

The optional schema callback is not exposed by a browser workflow. Isolated JSON
tests retain callback output and exception semantics and check parsed-value reuse.
This bridge cannot move an arbitrary caller closure into a Worker.

The JSON workflow also holds revalidation while an unchanged minify action or an
injected action transport failure replaces it. Both paths must clear Checking,
preserve saved bytes and permit Validate to retry. The formatting workflow checks
a reversed noncollapsed selection and single undo. The JSON offline case uses a
private production-asset server. WebKit stops that origin and proves access fails;
Chromium and Firefox use browser offline emulation. Each case confirms service
worker control, reload, exact formatted bytes and undo, and attaches request and
response evidence. The fixture changes only its test root precache revision and
release marker. This is not native or production-CSP acceptance.

The duplicate/CRLF workflow must not require an unused OPFS file. WebKit rejected
that setup before the required CRLF checks. Keep duplicate keys, saved CRLF bytes,
the download filename and actual exported bytes as exact assertions. A local
rejecting OPFS trap received no calls after removal. A corrupt export kept saved
CRLF text but downloaded LF text and failed the unchanged byte assertion.
Retained local evidence: `/home/thomas/.hermes/tasks/deckmark-issues-20261107/issue-314/ci-repro-20261108/result.md`
and its JSON receipts. Three byte-identical archived recovery cases executed;
three duplicate cases did not run. This is mechanism evidence, not CI acceptance.

### Source typewriter centering

Retain these risks for issue 328: a key burst can queue obsolete scroll targets;
an already centered caret can cause a redundant scroll transaction; a disabled or
destroyed extension can dispatch against the old view; wrapped text can change
caret geometry; selection, composition, undo, accessible input and saved bytes
can change while the mode is active.

Run `npx playwright test navigation-stats-scroll.spec.ts editor-input-latency.spec.ts
--grep typewriter --project=chromium --workers=1 --retries=0 --trace=on`.
Keep the standard source metadata, trace, screenshots and attached JSON files.
The performance cases record raw frame intervals, p50, p95, pending frame counts,
center scroll targets and fixture hashes for small, 1 MB and 5 MB notes. Counts
include the CodeMirror measure frame. The probe uses real editor key handlers.
It does not prove physical key repeat, a native IME or screen-reader output.
The existing strict performance budgets stay unchanged.
Run `npx playwright test keyboard-platform.spec.ts --grep typewriter --workers=1`
for the accessible input, synthetic composition, selection, undo and save case.
This spec is in the Chromium, Firefox and WebKit project lists. The navigation
cases also check repeated disable and re-enable, mode exit and a file switch.
Construct `InputEvent` explicitly for a synthetic `beforeinput` history action.
Playwright's generic event driver does not retain `inputType`. The keyboard case
checks the constructor, target, input type and cancellation before it checks redo.
Use `CompositionEvent` for the synthetic composition boundaries. These events do
not reproduce an operating-system input method.

### Inactive editor history risks

History pressure must not remove cursor, selection direction or scroll metadata.
A restored Code editor must use saved selection even without history. Byte totals
must release replaced and deleted entries. Oversized histories must not remove
unsaved text or alter the 400 ms draft save queue. Native history must not retain
old view callbacks, cross file boundaries or survive a different raw source.
Raw BOM and mixed line endings must remain separate from native coordinates.

`e2e/editor-state.spec.ts` drives navigation after 35 file switches and resident
undo/redo with an immediate unsaved switch in Source and Code. It attaches final
text and navigation evidence. Run `npx playwright test e2e/editor-state.spec.ts
--project=chromium --workers=1 --retries=0`. Keep the standard report, source/diff
identity, environment, command and attachments for each run.

The 35-file navigation and 40-file pressure cases are Chromium-only. Firefox and
WebKit keep the retained coordinates in the cache but do not expose the restored
DOM selection after a deferred body mount. The cache unit tests still check the
exact coordinates, and the Chromium workflow checks selection, scroll and bytes.
Do not read a skipped engine as a passing cross-engine result.

`e2e/project-backup.spec.ts` ignores the derived `manifest` index key when it
compares migrated rows. The key is rebuilt on every write and on the version 9
upgrade; document bytes and identifiers remain the compared data.

`src/lib/editor-state.test.ts` retains deterministic byte accounting, independent
LRU and invalid-charge cases. Browser workflows cannot precisely attribute a
replacement or malformed numeric charge to an internal budget. Run
`npx vitest run src/lib/editor-state.test.ts --maxWorkers=1`. These cases do not
replace browser content, selection or history evidence.

`src/lib/editor-history.test.ts` detects undercharged removed text, selection
events, recache resets and unknown retained history effects. A cache estimate is
not browser heap measurement. Unsupported effect providers must refuse inactive
history without scanning or serializing it. Run this file with the cache cases.

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

### CLI filesystem boundary risks

`cli/cli-security.test.ts` keeps the access-time identity checks for CLI input
reads and output writes. A browser cannot run the Node CLI. A spawned process
also cannot be paused between the directory walk, a metadata check, an open, a
write, and a rename without a test-only hook. The cases therefore call the
shared helpers with real temporary directories and real symbolic links.

The retained input risks are a leaf file replaced by a symlink, an ancestor
directory replaced by a symlink after the walk, the same swap for a binary
asset, a file that grows past the byte budget, and a relative path that leaves
the approved root. The explicit user-selected symlink case stays supported.
The retained output risks are an absent or existing parent directory replaced
by an outside symlink after approval, a leaf target replaced by a symlink, a
write failure, and an outside sentinel that must stay unchanged.

Node does not expose directory-relative creation (`openat`) to JavaScript. The
writer pins the approved parent identity, checks it before the directory
create, after the create, after the temporary open and before the rename, and
writes bytes only after the post-open check. A swap that moves the temporary
file leaves the outside sentinel intact, and the rename cannot find the random
temporary name.

Directory links run on Unix. Windows file links need an extra privilege, so the
selected-symlink case skips there. Run
`npx vitest run cli/cli-security.test.ts --maxWorkers=1`.
The browser suite cannot detect these races. The installed-package workflow
still checks the normal command workflows.

`cli/text-only.test.ts` keeps the text-only input policy for `inspect`, HTML
export, and Markdown export. A browser cannot run the Node CLI or its real
filesystem boundary. The cases use an ASCII PDF whose bytes are valid UTF-8 and
a PDF with invalid UTF-8 bytes. A PDF extension is a binary document in both
cases. The checks require the same error code, no standard output, and no output
file. They also keep note, text, code, presentation, and ZIP asset behavior.
Run `npx vitest run cli/text-only.test.ts --maxWorkers=1`. The installed-package
suite `scripts/pack-cli.test.mjs` repeats the PDF rejection with the installed
CLI in the CLI package workflow on Linux, Windows, and macOS.

`e2e/binary-review.spec.ts` compares image and PDF bytes after disk copy actions,
library ZIP export, and project ZIP export. Binary copies must stay unlinked.
An oversized restored PDF must produce an export error. `e2e/pdf-viewer.spec.ts`
checks the native browser viewer under the production CSP. Retain fixture PDFs,
downloads, ZIP files, screenshots, and JSON reports. Run both specs with
`npx playwright test e2e/binary-review.spec.ts e2e/pdf-viewer.spec.ts --project=chromium --workers=1`.

The native Git tests use real repositories. They check executable filters,
included configuration, parent-repository confinement, literal diff paths, and
unstage before the first commit. Check unchanged index and working-tree bytes.
The commit cases capture the staged tree and repository identity, then add a
staged file, restage a file, move HEAD, or switch branch before the commit. A
rejection must leave HEAD, the index and the committed tree unchanged. The
initial commit must create exactly the captured tree. A browser cannot inspect
native subprocesses or the Git index. Run
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
boundary. The retained cancellation risks are a cancel that arrives before the
command registers, a connection that stays open during headers or a streaming
body, a stalled response that reaches the full timeout, a second window that
cancels another request, a request that stays registered after completion, and
later requests that fail after one cancellation. A loopback server holds the
response and records the request arrival. Each case checks the stable
`cancelled` code, a measured bound below the request timeout, and no secret or
prompt text in the error. Run
`cargo test --manifest-path src-tauri/Cargo.toml ai::tests` and
`cargo test --manifest-path src-tauri/Cargo.toml vault::tests`. The frontend
`AbortSignal` still needs a Desktop panel check. Keep the report in
`/tmp/opencode/ai-review-cargo-final-evidence.json`. The operating-system keyring
still needs a desktop session. Old host-only entries require key re-entry.

Web provider redirects are refused before the approved prompt can move to a new
origin. `e2e/ai-patches.spec.ts` starts two real loopback HTTPS origins with a
short-lived self-signed certificate generated by `openssl` at test start and
`ignoreHTTPSErrors`. The private key stays in a temporary directory and is never
committed. Origin A
answers 307 to origin B, and B records every request body. The case fails when B
receives the canary context and passes when the Web adapter refuses the redirect
with a redacted error. `src/lib/ai/openai-compatible.test.ts` checks the
`redirect: 'error'` option on chat and model discovery and checks that a
redirect-style fetch failure does not echo the token or prompt. Run
`npx vitest run src/lib/ai/openai-compatible.test.ts --maxWorkers=1` and
`npx playwright test e2e/ai-patches.spec.ts --project=chromium --workers=1 --retries=0 --grep 'provider redirect'`.
The browser case does not prove external provider behavior or every redirect
status. Native parity comes from the existing `redirect::Policy::none()` client.

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

`src/lib/components/DesktopBackupPanel.component.test.ts` retains the snapshot
list and preview identity risks. A late list must not replace the rows of a new
backup folder. A late rejection must not show an error for the old folder. A
preview must read the exact root and filename that the row displayed. The test
also covers A to B to A changes, the same filename with different bytes, a
missing file, and panel unmount. The Web edition does not load this panel, so
the browser suite cannot mount it. These cases replace the native bridge and
use deferred list and read promises. Run
`npx vitest run src/lib/components/DesktopBackupPanel.component.test.ts --maxWorkers=1`.
The cases do not replace the native picker, grant confinement, or scheduler
checks above.

`e2e/capture-snippets-review.spec.ts` checks snippet updates across windows.
Desktop-edition cases also check first-mount templates, duplicate and concurrent
saves, and failed writes that retain capture input. Set `CAPTURE_REVIEW_DESKTOP=1`
with a Desktop server for those cases. The native-command fixture does not prove
the operating-system shortcut or native window lifecycle. Native smoke covers
those paths. Each browser case retains source metadata, fixtures, and screenshots.
The PDF viewer case uses full Chromium headless mode because the headless shell
does not include the PDF viewer.

The Quick Capture key handler must not cancel or save during IME composition.
The retained risks are an Escape that closes the window while it dismisses a
candidate list, a Ctrl/Cmd+Enter save before the composition commits, a legacy
key code 229 event, a lost draft and a lost focus. The Web edition does not mount
this component, so a browser workflow cannot reach it. `QuickCapture.component.test.ts`
replaces the native window bridge and the stores. It dispatches composition and
legacy key code sequences, then checks the normal Escape and Ctrl+Enter paths,
the draft text, the focus and the call counts. Run
`npx vitest run src/lib/components/QuickCapture.component.test.ts --maxWorkers=1`.
Synthetic composition events do not prove a physical IME, Windows WebView2,
macOS WKWebView or Linux WebKitGTK behavior.

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

## Browser download object URL risks

A browser reads an object URL after the click task returns. WebKit fails a
download when the URL is revoked in that same task (WebKit bug 211234). The
retained risks are a revocation before the browser has consumed the bytes, a
second consecutive download that loses the URL of the first download, a failed
click that leaves the URL allocated, and a large ZIP or image blob that stays
reachable without a bound.

`e2e/export-download-lifetime.spec.ts` instruments `URL.createObjectURL`,
`URL.revokeObjectURL` and `HTMLAnchorElement.prototype.click` before the
application starts. It downloads Markdown three times, a library ZIP and an
image above one MiB. It compares bytes and SHA-256 digests, checks that each
URL is not revoked within one second of its click, checks that each URL is
revoked within the bound, and checks that a failed click still revokes. The
spec is in the Chromium, Firefox and WebKit projects. A download filename is
browser and platform specific: the checks compare bytes and do not require one
ZIP or binary filename from another engine. Native Tauri save and cancellation
are not part of this browser case; the isolated export tests keep that path.

Run `npx playwright test e2e/export-download-lifetime.spec.ts --project=chromium --workers=1 --retries=0`
and repeat with `--project=firefox` and `--project=webkit`.

## Edition and hosting checks

### Retained hosting failure risks

Record these risks before changes to the deployment workflow or production checks:

- Removal of a publisher can leave a public origin on an old build while the
  other origin continues to update.
- A missing or stale `edition.json` can hide the deployed source revision.
  A matching version alone cannot identify the source commit.
- A successful upload or a recorded SHA can hide stale public HTML and assets.
  Verify the normal public URLs after deployment.
- A GitHub Pages custom domain can redirect the fallback to the mirror and remove
  its independence.
- Missing Cloudflare credentials can silently skip the mirror deployment unless
  the deployment fails explicitly.
- A wrong base path can produce a blank offline shell or an empty precache.
- A service worker with the wrong scope can lose deep-link refresh and offline
  first use. An old worker can also keep stale application assets.
- An absolute asset URL can work on one host and fail on the other.
- A Desktop-only module can enter the Web bundle or precache.
- An update can reload before a draft reaches IndexedDB.
- A daily check can report repair too early after it starts a deployment.
  Keep the detection run failed. A separate post-deployment check confirms repair.
- A metadata check alone cannot prove startup, saved edits, or offline use.
- Cloudflare can inject Web Analytics outside the EU even when Pages project
  analytics are disabled. The HTML digest check must detect this change.
  `static/_headers` prevents proxy transformations with `no-transform`.
- A first public install fetches hundreds of precache files in sequence. Allow
  90 seconds for **Ready offline**. A download still in progress at 45 seconds
  is not proof of an offline failure. Keep network traces when this check fails.

### Local hosting checks

Cloudflare Pages and GitHub Pages publish Web Light as independent sites. Check
Web Light and Desktop Complete as different editions. A browser result does not
replace a native Desktop check, and a native result does not replace a browser result.

The deployment workflow builds the root path for Cloudflare Pages and
`/deckmark` for GitHub Pages. Both must produce a usable PWA with the correct
service worker scope. `deploy` and `deploy-cloudflare` publish in parallel after
the correctness, build, E2E and Lighthouse gates. The final `verify-public` job then checks
both origins, so one stale origin fails the run.

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

Confirm HTTPS and an independent app at each origin. The GitHub Pages URL must
not redirect to the Cloudflare site. Keep the existing DNS setup and leave the
GitHub Pages custom domain empty. Each origin has separate browser storage and
a separate service worker. A local preview cannot establish a production result.

Keep the command, source revision, browser version, base path, domain state, and
results in the run artifact. The browser suite still produces the standard
`playwright-report/index.html` and `test-results/results.json` files.

### Public production checks

Run the standalone production suite from the checkout of the expected deployment:

```sh
EXPECTED_SHA=$(git rev-parse HEAD) npx playwright test --config=playwright.production.config.ts
```

This configuration checks live sites without a local build or preview server:

| Playwright project | Normal public URL | Expected base path |
| --- | --- | --- |
| `github-pages` | `https://thomascrouzet.github.io/deckmark/` | `/deckmark` |
| `cloudflare-pages` | `https://www.deckmark.dev/` | Empty string for the root |

For each project, verify these observable results:

1. The normal public URL opens the app on the expected origin and path.
2. `edition.json` reports Web Light, `sourceSha` equal to `EXPECTED_SHA`, the
   checkout's package version, and the expected base path.
   The served HTML must match the manifest's `htmlSha256` digest.
3. The app starts in a fresh browser context and accepts a note edit.
4. The edit remains after the save completes and the page reloads.
5. After **Ready offline**, the app reloads without the network and retains the edit.

Missing metadata, an old source SHA, or a wrong version or base path fails the
check. Check normal public URLs, not only a deployment preview or a URL with a
cache-bypass query. A metadata match alone does not prove that the app works.

For local runs, keep `production-report/` and `production-results/`, including
failed runs. Retain the command, expected and observed source revisions,
environment, browser version, public URLs, fixture content, results and browser
evidence. These files must permit another maintainer to repeat the same checks.
Hosted CI creates these files on its runner without uploading them. They are
temporary and are lost when the runner VM is destroyed.

### Daily drift detection and repair

The daily check compares both public origins with the expected source revision.
A missing or stale deployment starts `.github/workflows/deploy.yml` through a
workflow dispatch. The repair uses the same build, E2E, and Lighthouse gates as
a normal deployment. Cloudflare Pages project `deckmark` receives the tested
root artifact. Missing `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN` fails the
deployment instead of skipping the mirror.

The detection run remains failed and reports that it requested repair. Keep the
observed public metadata and the repair message with that run. A successful
dispatch, an upload, or a saved SHA record is not proof of repair. Only the
post-deployment production browser checks can confirm that both public sites
serve the expected source and pass the startup, edit, and offline checks.

See [EDITIONS.md](EDITIONS.md#hosting-and-downloads) for the hosting contract and
[DEVELOPMENT.md](DEVELOPMENT.md#web-publishing) for the maintainer steps.

## Dialog visual viewport risks

The search, command, settings and library dialogs use a fixed overlay. A fixed
overlay follows the layout viewport, so an on-screen keyboard, browser chrome or
pinch zoom can hide the focused field or the close control. The retained risks
are a lost query or selection after a viewport change, a dialog that leaves the
visible region, a close control that is not reachable, and a changed desktop
layout when no keyboard is present.

`src/lib/a11y/focusTrap.ts` exports the `visualViewportPanel` action that keeps
the overlay inside the visual viewport.
It applies only when the visual viewport is smaller than the layout viewport or
moves from the top. It restores the CSS defaults when the viewport is unchanged.
The action sets the overlay top and height and a panel maximum height from the
visible height and the overlay padding.

`e2e/dialog-visual-viewport.spec.ts` replaces `window.visualViewport` before the
application starts and moves or shrinks it for all four dialogs. It checks the
dialog panel, the focused field, the close control, the query, the input
selection and the dialog scroll. It also checks that a normal viewport keeps the
CSS defaults. This is a simulation and does not prove a physical iOS keyboard,
Safari viewport panning, VoiceOver output or a native WebView.

Run `npx playwright test e2e/dialog-visual-viewport.spec.ts --project=chromium --workers=1 --retries=0`.
Keep `visual-viewport-dialogs.json` with the source revision, browser version,
command and the viewport cases. Physical iPhone Safari in tab and PWA mode, and
iPad Safari in portrait and landscape, remain required evidence.

## Presentation inspector width risks

The presentation Properties inspector uses a 252 px side panel above an 800 px
container width and an absolute overlay below it. The retained risks are a
default open state from the outer window width, a stale open state after an
orientation or window change, a reopen after the user closed the panel, a lost
focus when the panel closes, an overlay without a reachable dismiss control, and
a changed selected object.

`SlideEditor.svelte` reads the actual presentation container width with a
`ResizeObserver`. The automatic state follows the 800 px breakpoint. A manual
toggle sets an explicit open or closed preference that later resizes keep. An
automatic close moves focus to the Properties toggle when the panel held focus.

`e2e/presentation-inspector-width.spec.ts` resizes one open deck without a
reload across the breakpoint in both directions. It checks the container width,
the panel presence, the toggle state, the overlay bounds, the dismiss control
and the focused control. It attaches the geometry JSON and a screenshot. The
case does not prove iPad multitasking, native window minimum size, browser zoom
or a native WebView.

Run `npx playwright test e2e/presentation-inspector-width.spec.ts --project=chromium --workers=1 --retries=0`.

## Note scroll shortcut scope

The Alt+Home and Alt+End note shortcuts listen on `window`. The retained risks
are a scroll of an inert note while a dialog is open, a consumed key that
belongs to a foreground control, a scroll of a short note with no scroll target,
a stale scroller after a mode or file switch, and a scroll during IME
composition.

`ScrollNav.svelte` resolves the live scroller on each keydown. It ignores an
event that is already prevented, a composition event, a repeat, a target in an
inert subtree, an open modal dialog, and an editable field outside the active
note. It also ignores a note without a scroll range. The pointer and touch
buttons stay available when the note is scrollable.

`e2e/scroll-nav-scope.spec.ts` checks both boundaries in a long note, then the
same keys with Settings open, with an outside field focused, during a synthetic
composition, and in a short note. It records `defaultPrevented` and the scroller
position. Synthetic events and desktop emulation do not prove a physical iPad
keyboard, a screen reader or a native WebView.

Run `npx playwright test e2e/scroll-nav-scope.spec.ts --project=chromium --workers=1 --retries=0`.

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

A folder import can read and parse an oversized `.mdsh/project.json` before it applies
the ZIP manifest limit. `src/lib/project-archive.test.ts` keeps the no-read case with a
fake `File` whose `arrayBuffer()` records a call. The browser suite cannot observe
whether a real file read occurred. The Chromium case in
`e2e/project-archive-risks.spec.ts` checks the visible rejection and the absence of a
stored project. Run `npx vitest run src/lib/project-archive.test.ts --maxWorkers=1` and
`npx playwright test e2e/project-archive-risks.spec.ts --project=chromium --workers=1 --retries=0 --grep 'oversized folder manifest'`.

A typed image or PDF document stores its bytes in `data` with an empty `content`.
A project capacity check that sums only `content` omits those bytes and can accept a
project that later fails portable export. `src/lib/project-transfer-capacity.test.ts`
keeps the occupancy, legacy manifest fallback, import, Create Document and manifest
projection cases. A browser workflow cannot fill a 64 MiB project cheaply or forge a
legacy manifest key. Run
`npx vitest run src/lib/project-transfer-capacity.test.ts --maxWorkers=1`. The portable
project workflows in `e2e/binary-review.spec.ts` and `e2e/project-archive-risks.spec.ts`
still prove binary bytes and archive import through the application.

A portable project manifest can carry a MIME value for a text or code document.
`src/lib/projects.test.ts` keeps the direct `buildProjectZip` to `readProjectZip`
path, the manifest value, a malformed value and the schema 1 default. The browser
workflow in `e2e/project-archive-risks.spec.ts` checks the user-facing import, export
and reimport. Run `npx vitest run src/lib/projects.test.ts --maxWorkers=1` and
`npx playwright test e2e/project-archive-risks.spec.ts --project=chromium --workers=1 --retries=0 --grep 'explicit code MIME'`.
A ZIP manifest check alone cannot show that the durable row keeps the value.

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

### Native project refresh cost risks

A metadata-first refresh can still hide whole-project work in the webview. The
retained risks are a full deferred-document hydration before the no-change check,
a full project scan for each new entry, a baseline map written once per entry,
and a project body read disguised as a metadata query. `projects-native.ts` builds
path identity from compound index keys and hydrates only matched entries. The
baseline writer deduplicates changes and flushes once per operation or per 128
changes. `scripts/native-refresh-cost-smoke.mjs` creates 600, 1000 and 3000
document native projects, reloads so closed bodies are deferred, and records
p50/p95 refresh time, body reads, baseline writes, manifest versus snapshot IPC
bytes, RSS and Linux process CPU. The same file ran against the pre-fix commit:
the 601-document first refresh read 344 document bodies and the save wrote the
baseline 601 times; the 1001-document run read 744 bodies and wrote 1001 times.
The post-fix runs read and write zero at 600, 1000 and 3000 documents. These are
local diagnostics on the native smoke build, not a browser heap or a universal
CPU budget. The verified manual refresh still hashes every file on the native side
so a same-size, same-mtime external write cannot be missed; the hashes are
metadata and no file body crosses IPC.

### Native project removal review risks

An external disk removal must not drop the last record of a local document or
asset. The `project-native-missing:` metadata review keeps the exact path, kind,
last disk revision and local-only choice. A refresh reports pending paths; it
does not remove local bytes, history or the disk baseline. Recreate writes the
exact local bytes with a null expected revision. Keep local skips later project
saves until the path is recreated. A failed review write, a cancelled operation
and a restart keep the review retryable. A path restored on disk closes it.
`scripts/native-projects.mjs` checks clean and dirty Markdown, a binary asset,
a second refresh, a restart, an injected metadata failure, recreate, keep local
and a later save. That workflow requires the native smoke binary on a desktop
session. The browser suite cannot run these Tauri commands.

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

### Disk-link ownership fences

The `mdsh` owner rows and the `mdsh-fs` link records cannot share one
IndexedDB transaction. A purge cleanup, a manual unlink, a relink, a restore
and a backup import can interleave. Retain these failure risks:

- A cleanup reads "no owner", then a restore or import creates the same id and
  relinks it. The old cleanup must not delete the new record or revoke its path.
- A link moves from P to P2 during cleanup. The P job must not delete P2.
- Two live drafts share one native path. Unlinking one must keep the other
  draft and its capability valid.
- A failed handle delete must not revoke the grant first.
- A stale record from an older epoch is still removed without touching a newer
  record.

`src/lib/disk-2.ts` provides the document and path locks, the durable link
generation and the captured link identity. `src/lib/disk-cleanup.test.ts`
keeps the cross-database interleavings with deferred I/O. A browser workflow
cannot pause between the owner read and the link delete, so these isolated
cases are required. Run:

```sh
npx vitest run src/lib/disk-cleanup.test.ts src/lib/disk-sync.test.ts --maxWorkers=1
```

`e2e/disk-link-ownership.spec.ts` checks the observable result: unlinking one
of two drafts that share a handle keeps the other draft linked. Run:

```sh
npx playwright test e2e/disk-link-ownership.spec.ts --project=chromium --workers=1 --retries=0
```

The browser case replaces the native path backend with FSA handles. The
native grant reference count still needs the isolated cleanup cases and a
Desktop smoke check.

### Disk-link health checks

A health scan awaits link and file-status I/O after a library load or a
cross-tab change. Retain these failure risks:

- A late old-path result can mark a repaired link broken or clear its linked
  state.
- A newer successful scan can finish before an older scan resumes publication.
- A reload can replace the object under the same id.
- A truly missing or broken link must still be reported, including FSA
  permission-needed and native path failure.

`src/lib/disk-sync.test.ts` and `src/lib/broken-links.test.ts` keep the checked
link epoch, path, revision and handle identity with deferred I/O. The browser
suite cannot hold one publication between the link read and the compare-and-set.
Run:

```sh
npx vitest run src/lib/disk-sync.test.ts src/lib/broken-links.test.ts --maxWorkers=1
```

`e2e/disk-link-health.spec.ts` checks the observable result: a late failed read
leaves a repaired handle linked and saving to its new file. Run:

```sh
npx playwright test e2e/disk-link-health.spec.ts --project=chromium --workers=1 --retries=0
```

The browser case uses OPFS handles. Native path checks still need the isolated
cases and a Desktop smoke check.

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

## Durable draft projection reuse

The `manifest` and `metadata` keys are index projections on the `drafts` table.
Dexie reports a field in the update hook only when its value changed. A save
that keeps the content, name, kind, project location and binary presence can
therefore reuse the content-derived slots of the durable manifest key. The
metadata hook already skips an update that touches none of these fields.

Retain these failure risks: a reused slot can describe a previous content
revision; a rename can keep an old document kind; a project move can keep an old
byte count; a missing or damaged key must fall back to a full projection; and an
external or raw write must still be detected at boot. An unchanged image-rich
save must report `reused` with zero scanned bytes. A source edit must report the
new metadata title, targets and content length.

`e2e/draft-projection-performance.spec.ts` creates real drafts with 0, 1 and 4
embedded images, waits for the durable projections, then closes the tab. It
reads the instrumented `mdsh:draft-manifest` and `mdsh:draft-metadata` measures
and checks the durable key values after the save. Run:

```sh
npx playwright test e2e/draft-projection-performance.spec.ts --project=chromium --workers=1 --retries=0
```

Keep the attached `draft-projection-reuse-*.json` and
`draft-projection-recompute.json` files with the standard report metadata. The
measure records hook duration, reuse state and scanned bytes. It does not
measure garbage collection, native WebView behavior or another browser engine.
Next-input latency stays in `editor-input-latency.spec.ts`.

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

## AI context serialization risks

The provider context must keep an independent approval manifest and one JSON
entry for each approved file. A file name or body that contains `</file>`, a
fake `<file path="...">` tag, quote characters, newlines or Unicode separators
must stay inside its JSON string. The preview manifest must list the same
approved paths and token totals as the transmitted payload.

`src/lib/ai/context.test.ts` checks hostile names and bodies, quote and newline
handling, deterministic order and the selection payload. `e2e/ai-panel.spec.ts`
sends the real request through the panel with a hostile body and checks that
the provider receives one approved entry, not an invented one. Run:

```sh
npx vitest run src/lib/ai/context.test.ts --maxWorkers=1
npx playwright test e2e/ai-panel.spec.ts --project=chromium --workers=1 --retries=0 --grep 'hostile file markers'
```

The preview path must not encode or hash a body that is ignored, secret,
binary, outside the token budget or absent from the approved scope. A large
library can hold 3000 documents, so a full-body pass on each input or scope
change is the failure. The same isolated file spies on
`TextEncoder.prototype.encode` for the budget and path exclusions, checks that
`previewContext` does not encode a body, and compares the preview manifest with
the transmitted entries. The panel builds the preview for the review UI and
uses Set and Map indexes for the send revision guard. A browser timing check
cannot attribute that work to one preview rebuild.

## Retained isolated risks

### Service worker update lifecycle risks

The update entry point is a page singleton. The retained risks are a second
`updatefound` listener, a second hourly poller, a late failed attempt that
reports an error after a newer attempt succeeded, a duplicate offline or update
notification, and a retry that stacks a poller on the active registration. The
browser suite cannot count duplicated pollers or hold a registration promise in
the out-of-order state without a test-only hook in the production page.

`src/lib/ui/pwa-update.test.ts` holds fake timers and deferred registration
promises for these cases. It checks one base path for the root host and one for
the nested GitHub Pages host. It also checks that an update activation flushes
the draft queue before the reload, and that a failed flush stops the reload.
Run `npx vitest run src/lib/ui/pwa-update.test.ts --maxWorkers=1`.
These cases do not prove real browser activation, a native WebView, or the
update check of a live deployment.

### Statistics counting risks

`stats.test.ts` compares the exact legacy stripping order and UTF-16 counts with
a frozen oracle. Its deterministic malformed-syntax corpus includes lone
surrogates, CRLF, Unicode whitespace and headings exposed by earlier replacements.
Editor normalization and DOM text cannot reliably preserve every such input.
Keep this isolated differential check for those concrete boundaries, not coverage.
Run `npx vitest run src/lib/stats.test.ts --maxWorkers=1`.

The stats cases in `navigation-stats-scroll.spec.ts` check selection in Source,
Edit and Read, coalesced edits across file switches, and fresh counts without
focus loss for deterministic 1 MB and 5 MB multiline and single-line notes.
They also hold the on-demand statistics module during a file switch and reject
its first load. The latest file must win. Editing and local saves must remain
available, and a reload must recover both the edit and the counters.
The two asset-failure cases block service workers so the network fixture can hold
or reject the module request. They do not prove offline use.
They find the unique runtime export in the served build instead of guessing its
hash-only filename. This also works with the prebuilt CI artifact.
Run `npx playwright test e2e/navigation-stats-scroll.spec.ts --project=chromium
--workers=1 --grep 'counts the current selection|stats '`.
Keep the standard source metadata and attached fixture hashes, counts, publication
intervals and screenshots. These workflow assertions are not timing budgets.
Counter-only heap and timing diagnostics must retain raw samples, fixture hashes,
Node or engine identity, source hashes, warmups and post-GC versus temporary heap.
They do not replace browser or native performance gates.
### Project wiki indexes

Record these risks before changes to project resolution and backlinks:

- Exact IDs, relative paths, root paths, extension rules, and basename collisions
  can change candidate priority or library order.
- Encoded separators, invalid encoding, Unicode, traversal, fragments, reserved
  paths, and case collisions can change confinement or ambiguity.
- Content, type, name, path, project membership, delete, restore, and cross-tab
  changes can leave stale references. A new candidate can shadow an old target.
- Repeated reads can scan unrelated files or links. An edit can rebuild every
  path. Cached results can grow without a bound or retain removed documents.
- A non-reactive index can leave the sidebar unchanged after a pending save.

`src/lib/project-paths.test.ts` compares indexed answers with the original
resolver over generated and adversarial paths. It checks affected-reference work
through observed property reads. The browser suite cannot exhaust this path space
or distinguish a fast full scan from an indexed lookup on a small fixture.
The guarded-publication case checks that location updates retain complete targets
without deriving a pending body. It also rejects publication after removal.
The deferred worker belongs to issue 307 and needs combined browser checks after
integration. This branch uses the existing synchronous metadata adapter.
`e2e/project-wiki-index.spec.ts` checks visible project backlinks and real document
switches at 300, 600, and 3000 documents. It retains raw times, fixture hashes,
Chromium CPU profiles, heap samples, screenshots, and source identity. Baseline
mode records switch measurements only, without claiming an index gate pass.
Strict mode also checks the saved edit and affected backlinks.
`e2e/project-wiki-updates.spec.ts` checks cross-tab path collisions, moves,
removal, restoration, and project rename through visible backlinks and navigation.

Run the focused checks:

```sh
npx vitest run src/lib/project-paths.test.ts src/lib/meta-index.test.ts --maxWorkers=1
npx playwright test e2e/project-wiki-index.spec.ts e2e/project-wiki-updates.spec.ts e2e/wiki-links.spec.ts e2e/project-link-performance.spec.ts e2e/project-scale.spec.ts e2e/metadata-index-incremental.spec.ts e2e/project-explorer.spec.ts --project=chromium --workers=1 --retries=0
```

Keep each run in separate local storage. The campaign report names the exact
command, revision, working diff, OS, browser, build mode, fixtures, and results.
A Chromium result does not establish native Desktop or other browser acceptance.

### Presentation input snapshot risks

`presentation-performance.spec.ts` inserts 24 characters into text and notes in
100- and 300-slide decks. It records model serialization and parse counters,
raw input-to-frame and synchronous samples, p50/p95, CPU profiles, frame gaps,
heap metrics, browser identity, and fixture hashes. These are local diagnostics,
not a replacement for the existing performance budgets. Net heap size is not
an allocated-byte measurement.

`presentation-editor.spec.ts` checks idle publication without textarea or
selection replacement, continuous notes input with a maximum wait, idempotent
flushes, undo/redo, slide switches, immediate Markdown export, close followed by
backup, concurrent external revisions, and failed serialization followed by retry.
A materialization failure must stop a backup or detach and keep local input.
Generic flush must not apply an advanced-source draft.
`presentation-format.spec.ts` compares stored and exported bytes after idle edits.
It keeps BOM/CRLF frontmatter, comments, IDs, notes, and literal marker framing.
Textarea values normalize CRLF, so exact byte checks use downloads and IndexedDB.

Run focused Chromium evidence with:

```sh
npm run test:e2e -- presentation-editor.spec.ts presentation-format.spec.ts presentation-performance.spec.ts --project=chromium --workers=1
```

Keep the command, revision and diff hash, environment, fixtures, JSON and HTML
reports, downloads, and failure traces locally. Native WebView close and abrupt
process termination need separate evidence. A synchronous source snapshot does
not confirm an IndexedDB commit. Keep the existing 400 ms draft save delay.

### Incremental source bytes

`src/lib/code/source-text.test.ts` checks the raw separator map before editor
integration. Normalized CodeMirror positions differ from raw positions at CRLF
and bare CR. Multi-range changes can shift a later separator, and a delayed
snapshot can read a later edit. Browser export cases cannot inspect an immutable
pending revision or prove that applying a change does not read a full raw string.
The isolated cases compare exact mixed-EOL and BOM bytes, retained snapshots,
multi-range edits, and boundary edits in 1 MB and 5 MB documents. A seeded change
sequence compares the new buffer with the existing raw conversion function.
Run `npx vitest run src/lib/code/source-text.test.ts --maxWorkers=1`.
This check does not establish editor, persistence, or native integration.

### Editor raw-buffer integration

`SourceEditor` and `CodeEditor` keep an immutable `SourceText` buffer for the
mounted file. An accepted change updates only the touched separators. Ordinary
typing does not scan all line endings or rebuild the raw string in the change
filter. Raw publication is throttled: the first change after a pause publishes
immediately, and a typing burst coalesces to one materialization per 150 ms.
Explicit boundaries materialize synchronously: `mdsh:flush-editor`, save, export,
pagehide, editor detach and `getSnapshot()`. `getSnapshot()` returns the captured
file ID, the buffer-local revision and the exact text. The buffer revision is not
a store generation.

The E2E build records `mdsh:source-buffer-apply`, `mdsh:code-buffer-apply`,
`mdsh:source-full-rebuild`, `mdsh:code-full-rebuild`, `mdsh:source-change` and
`mdsh:code-snapshot` performance marks. Ordinary typing must show zero full
rebuilds and at least one buffer apply per accepted change. Run:

```sh
npx playwright test editor-input-latency.spec.ts code-editor.spec.ts \
  --project=chromium --workers=1 --retries=0
```

These checks do not cover Firefox, WebKit, native WebViews, a full local CI
profile or a paint/allocation budget. Keep those as separate acceptance work.

### Native store revision wire

`SourceEditor` and `CodeEditor` accept optional `getRevision`, `applyChange` and
`resyncSnapshot` functions. `EditorPane` and `+page.svelte` supply the existing
`documentRevision`, `applyDocumentChange` and `documentSnapshot` store methods.
On the native path an accepted change updates the immutable buffer and applies a
`DocumentChange` whose `readText` captures that exact `SourceText` instance. The
editor does not publish a string per key. The store materializes at its own
100 ms publication boundary and keeps the 400 ms Dexie save.

Identified failure modes before the adapter test and code:

1. A rejected base is replaced with a fresh store revision, and the next edit
   publishes an unchanged stale buffer over an external change.
2. The store's own publication is treated as an external replacement, which
   rebuilds the document and loses undo, selection or scroll.
3. A lazy reader closes over a mutable buffer and later returns newer text than
   the change it represents.
4. A canceled outgoing flush still writes or claims a save.

`src/lib/code/native-adapter.test.ts` keeps the pure rejection decision: adopt
only a same-file snapshot whose captured text equals the accepted text, otherwise
block. A browser cannot deterministically force a stale store generation between
two accepted keystrokes without a mock or a test-only hook. The own-echo and
outgoing-cancellation failures are proven through the real application in
`editor-state.spec.ts`, `document-revisions.spec.ts` and the latency cases.
The own-echo case accepts either engine history grouping: one undo must remove
typed text, and one redo must restore the full echo. Firefox can group two
adjacent insertions that Chromium and WebKit keep separate. Do not assert the
exact intermediate prefix.

The test build sets `VITE_SOURCE_FIDELITY_METRICS=1`. Under that flag only,
`+page.svelte` exposes `window.__mdshTest.forceNativeConflict(external, fileId)`.
The seam advances the real store revision with an external change and makes the
next native apply return null. It does not change production scheduling, guards
or budgets; the flag is compile-time and the block is removed from production.
The E2E then checks that the local rejected text remains, the authoritative store
bytes are not overwritten, a conflict is visible, and close is cancelled. This
is the deterministic reproduction of failure modes 1 and 4.

### Revisioned document publication

The revision scheduler must reject an obsolete base, isolate files, retain pending
text after a snapshot error, and invalidate callbacks after removal or reload.
A lazy reader can also accept another edit while it materializes an old snapshot.
The current string editor adapters cannot create these internal races through the
browser. `src/lib/document-revisions.test.ts` retains these cases until native
editor adapters expose equivalent browser observations. Write these checks before
the scheduler implementation. Do not use local revision numbers as cross-tab or
portable format identifiers.

The save queue also retains a snapshot-reader failure and retries it at the next
explicit barrier. Its internal saved callback must carry the captured revision,
not the revision that happens to be current when the write completes. Browser
storage rows deliberately exclude these process-local identities. The isolated
save queue cases inspect this internal boundary and the unchanged durable row.

`e2e/document-revisions.spec.ts` checks immediate visual close and source mode/file
switches. It compares the first closed draft write, saved bytes, and restored undo.
It also cancels one outgoing capture, checks that the view and dirty input remain,
and retries close. Cancellation must not write a stale closed snapshot or claim a save.
Run `npx playwright test e2e/document-revisions.spec.ts --project=chromium --workers=1 --retries=0`.
Keep the JSON report, source identity, fixture bytes, and trace with the run.
### Deferred note metadata

An edit queues its file ID. The next task sends the current source to one
persistent worker. Reads keep the last complete per-file snapshot until the
worker returns the current revision. Publication changes the snapshot, tag
counts, and backlink contributions together, then updates reactive consumers.
Closing a tab does not remove its library metadata. Removal cancels queued work.
Reload disposes the old worker. Bulk changes keep the lazy index rebuild.

The worker keeps only its last document for the plain-line fast path. Other
edits use the same full parser as cold reads. If workers are unavailable or fail,
the queue processes one file per task on the main thread. This recovery path
preserves correctness, but does not establish nonblocking large-note performance.
The initial library read can still parse cold documents synchronously.

`metadata-index-incremental.spec.ts` checks one MB input tasks, visible tag and
backlink parity through seeded structural edits, and a delayed worker result
after a newer edit and tab close. Keep the input CPU profile, raw samples,
fixture content, source identity, screenshot, and standard browser reports.

The retained risks are a reader that forces a full parse during input, stale
publication after replacement or removal, mismatched tags and backlinks,
unbounded queued source copies, and changed code or front matter boundaries.
`meta-index.test.ts` compares the conservative worker fast path with full
derivation through 600 seeded edits. The short visible browser sequence cannot
exhaust these parser-state combinations. Keep full recomputation as the oracle.

```sh
npm exec -- vitest run src/lib/meta-index.test.ts src/lib/wiki-links.test.ts --maxWorkers=1
E2E_PORT=4307 npm exec -- playwright test e2e/metadata-index-incremental.spec.ts e2e/wiki-links.spec.ts e2e/cross-window-review.spec.ts --project=chromium --workers=1
```

Browser results do not establish native WebView performance. Keep native and
large-library resource acceptance separate from the short browser workflows.

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

### Gesture geometry cache risks

Issue 317 retains these risks: equal-distance candidate order, signed connectors,
moving connector targets, selected groups, fractional canvas scales, stale static
geometry, slide dimensions, and queued frames after cancel, undo, or slide change.
`src/lib/presentation/gestures-cache.test.ts` compares real gesture results with the
previous scan over seeded layouts. It also counts stationary geometry reads. A
browser timing sample cannot prove that no geometry read occurs or exhaustively
check tie ordering. The isolated checks use the real editor and render geometry.

Run `npx vitest run src/lib/presentation/gestures-cache.test.ts --maxWorkers=1`.
Run `npx playwright test presentation-performance.spec.ts --project=chromium --workers=1`.
The dense cases retain raw frame intervals, p50/p95, long tasks, fixture hashes,
source identity, environment and browser identity. These additive measurements do
not replace the existing strict performance assertions or native acceptance.
Run the `gesture guides` case in `presentation-responsive-tasks.spec.ts` for
visible pointer cancellation, undo, slide changes and exact keyboard nudges.
Keep all reports local with the standard JSON and HTML run artifacts.
### Cross-mode stress checks

The separate stress matrix and commands are in
[PERFORMANCE.md](PERFORMANCE.md#cross-mode-stress-evidence). Run
`node --test scripts/benchmark-stress.test.mjs` for the focused CLI contract.
Run a selected production browser set with
`node scripts/benchmark-local.mjs --suite stress --prebuilt --runs 20 --cases source/markdown-1mb/lib-0,code/code-1mb/lib-0,json/json-1mb/lib-0 --output "$OUT/stress.json"`.
`OUT` must exist outside the repository. Record clean build provenance first.

Before isolated checks, retain these failure risks: absent cases, duplicate or
dropped samples, aborted input, missing required stages, negative values, low
counts, mismatched profiles, missing source/build identities, lost bytes,
missing export/history/reload assertions, unknown optional metric support,
unreviewed limits, and a forged summary that hides a raw regression. Browser
E2E cannot exercise malformed report files or verify audit process exits. The
CLI tests start the real audit process and retain those risks. They also check
the listed mode/size tiers and deterministic exact-size fixture output.

The version 2 contract retains these additional concrete false-green risks:
missing method/input evidence, untrusted or wrong input type, an invalid position
schedule/selection/offset, a relabeled fixture/library/mode, dirty or inconsistent
source/provenance, absent external artifact trust, missing capabilities/resources,
invalid supported units/values, ignored resource limits and booleans that hide
missing export/history/reload observations. The parent reproduced G1-G4 through
the real frozen CLI before hardening. New process controls precede validator code.
Each semantic mutation uses a fresh synthetic receipt, so rejection cannot rely
only on a stale report digest. A separate control checks a wrong receipt pin.
One unsupported heap sample must fail a configured heap limit even when other
samples have supported values. A partial maximum is not complete resource evidence.

Controls use real deterministic fixture/export bytes but explicitly synthetic
timings, keyboard records and build identities. They prove the CLI's structural,
replay, artifact-binding and process-exit behavior, not execution of the browser
producer. An independent external receipt is a stated trust input, not browser
attestation. Old version 1 reports remain historical and cannot be promoted by
inventing missing observations. Preserve original controls and failed attempts.

Each browser case checks a trusted input event, exact editor and saved bytes
after each measured edit, a second file's undo isolation, redo, downloaded bytes
and saved reload. Its external JSON report retains raw samples, fixture hashes,
source/build identity, command, environment, renderer, support limits, resource
sizes and failures. Preserve failed reports as well as passing cases. A low-count
diagnostic, an unavailable case or an unreviewed profile is not a strict pass.

This first delivery implements Source, Code, JSON and Split browser adapters.
The listed remaining modes, bursts/paste timing, failed-save/crash recovery,
native stress transport and calibrated release/resource limits remain open.
Existing browser and native suites still own their existing checks. A catalog
entry does not replace them. Reports remain local and are not uploaded.

### Native mode transport

`scripts/benchmark-modes-native.mjs` runs the mode matrix against the built Tauri
WebView through the embedded test WebDriver. Retain these failure risks:

- The WebKitGTK driver reports injected key events as untrusted. The input probe
  uses the editing command channel and requires a trusted `beforeinput`. A future
  driver that changes that channel must fail the trusted-input assertion.
- The native Markdown export opens a GTK save dialog. The Linux run answers it
  through `xdotool` and reads the exact written bytes. A missing tool must report
  unsupported, never a zero byte count or a stored-source substitute.
- A large note opens a render confirmation. The clock starts after acceptance;
  measuring the confirmation wait as Read render time would mix two workflows.
- A debug test binary, Xvfb, no window manager and an isolated profile are part
  of the measurement. Do not compare it with a release WebView, a packaged
  installer or the Web production profile.
- Windows WebView2 and macOS WKWebView save dialogs are not automated. Their
  profiles stay report-only and must not be marked as passed.

Build and run the focused matrix:

```sh
npm run tauri -- build --debug --features native-smoke --no-bundle \
  --config src-tauri/tauri.smoke.conf.json
WEBKIT_DISABLE_DMABUF_RENDERER=1 dbus-run-session -- xvfb-run -a \
  node scripts/benchmark-modes.mjs --profile native-complete-linux-webkitgtk-debug \
  --cases "$CASES" --runs 20 --output "$OUT/native-modes.json"
```

Keep the raw JSON report, the fixture and export sidecars, the external receipt,
the binary SHA-256, the source identity and the failing screenshots. The native
transport is not a browser result and does not replace the per-mode browser
checks.

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

### Scroll sample timeline diagnostics

A `scrollFrame` budget failure keeps the existing summary line and adds one
bounded numeric line for each scroll sample. The CI gate uses five samples. The
line records the run, the scroll ratio, the measured duration, the start time,
the two animation frame times, the requested and applied `scrollTop`, the scroll
room and the number of reported long-task entries that overlap the sample. A
final line records the long-task support and a bounded entry list.

The two-frame timer does not wait for paint or compositing. The timeline can show
a delayed frame or a deferred charge to a later sample. It does not prove the
cause.

The long-task observer is installed once for the scroll samples, only when the
engine lists the `longtask` entry type. It keeps at most 32 entries, performs no
DOM read, and is disconnected in a `finally` block. The observer adds one
callback per reported long task. The first-frame timestamp adds one monotonic
clock read. The second frame keeps the existing end read. If the engine does not
support the entry type, the output says `unavailable`. A zero entry count is not
proof that no stall occurred.

These diagnostics never enter the numeric samples, the summary, the budget, the
exit code or the thrown error. Use them only on a dedicated regression run with a
local report outside the repository. Do not upload the report or print paths,
document text or private data.

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

### Viewport annotation risks

`e2e/read-annotations.spec.ts` checks active ink on 1 MB and 5 MB notes at DPR 2.
The bitmap must fit the read viewport, with a 4096 pixel side limit and a 16 MiB
RGBA area limit. Keep document dimensions separate from bitmap dimensions.
The generated notes use repeated plain paragraphs and record exact fixture hashes.

The projection workflow checks pen, transparent highlighter and eraser pixels after
vertical and horizontal scroll, resize, offscreen culling and a file switch. It
forces article width to exercise horizontal overflow. A separate workflow injects
DPR 16 to test the allocation cap, then checks pointer input at CSS zoom 1.25.
This is not physical-device or native browser zoom evidence. DPR 2 is a real
browser-context setting. Existing cases keep Clear, print, reload and keyboard
coverage. `e2e/image-annotations.spec.ts` retains flattened PNG export and original
image byte checks. Read-view strokes remain temporary and do not enter exports.

The canvas must stay at the same viewport position in the task that changes native
scroll offsets. A delayed scroll event or ink frame must not move the surface.
The same-task scroll regression records the actual offset change, canvas identity,
scroller identity and scroller rectangle before it checks exact canvas coordinates.
It does not replace the original workflow or add a wait before its position check.
An absent scroll, changed surface or changed layout is not position-failure proof.

A viewport overlay can cover scrollbars, escape the scroll viewport or break pointer
input. Keep both canvas dimensions within the scroller client area and keep clipping.
A stationary box can still hold wrongly projected ink. Keep the point-specific
scroll, resize, DPR, pen, highlighter and eraser checks. Keep pointer capture, file
switch, reload, keyboard and print checks. Same-task geometry does not prove correct
stroke projection before a queued redraw or establish a past remote callback order.

The zero-size sticky anchor keeps the canvas in the native scroller for clipping
and wheel input. It must not add document width or height. Canvas position does
not depend on the queued ink renderer. Raster redraw still uses the current scroll
offsets and the existing animation-frame scheduler.

Stroke paint is also queued in an animation frame. The first pen pixel assertion
must run `inkFrame()` after `drawOnCanvas()` and before the unchanged greater-than
100 check. The remote WebKit flake read 43 pixels before that frame. Local WebKit
passed without the wait, so this is a timing precondition, not a product defect.
Do not add a fixed delay or change the threshold.

Clear removes stroke data immediately and clears the bitmap in the queued animation
frame. A completed button click does not confirm that this frame has run. Use the
existing `inkFrame()` helper before the Clear pixel check. Require exactly zero
nontransparent pixels. Do not use a fixed delay or a pixel tolerance. A browser
probe must distinguish pixels before and after the queued clear. A missing canvas
clear must still fail the zero-pixel check after the frame wait.

Scroll also queues canvas compensation. Use `inkFrame()` after the scroll change
and before reading the canvas box. Keep exact viewport y equality. The retained
issue 314 probe observed y=-108 before compensation and y=52 on frame 2. Releasing
a held callback restored y=52. A persistent transform defect still failed the
same equality after the wait. Both positive cases kept ink, content, saved-state,
print and reload assertions. Local evidence does not establish the remote cause.

Run the focused checks against the production preview:

```sh
npm run test:e2e -- e2e/read-annotations.spec.ts e2e/image-annotations.spec.ts --project=chromium --workers=1 --retries=0
npm run test:e2e -- e2e/read-annotations.spec.ts --project=webkit --workers=1 --retries=0
npm run test:e2e -- e2e/read-annotations.spec.ts --project=chromium --workers=1 --retries=0 --grep 'keeps the ink viewport fixed in the native scroll task' --trace=on
```

Keep JSON and HTML reports, source snapshots, command exits, screenshots, engine
versions, OS, build mode and fixture hashes. Long-note cases retain raw intervals
from a scroll change to two animation frames, p50 and p95, estimated canvas bytes
and Chromium heap usage. Other engines report heap measurement as unavailable.
These timings are diagnostic, not a new performance budget or a strict gate pass.
Native Desktop and physical display checks remain separate acceptance work.
The same-task case attaches `native-scroll-position.json` and a screenshot even
when its position assertion fails. Keep that first failure and its trace. A later
green run does not remove the original remote flake or complete issue acceptance.

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

### CI tier and routing failure risks

Browser tests cannot observe Actions event routing or aggregate process exits.
The CLI workflow tests retain these failures: a deferred draft becomes green,
a failed tier decision starts heavy work, a ready transition does not rerun,
or a failed, skipped, cancelled or absent shard passes the final aggregate.
Run `node --test scripts/ci-web-workflow.test.mjs` to exercise the aggregate
shell from the actual workflow and check its heavy-job dependency guards.

The same test keeps the documentation-only class honest. It runs the aggregate
with `class=docs` and three skipped browser jobs, then with each job changed to
`success`, `failure`, `cancelled` and an empty value. Each mixed result must fail.
It also rejects an empty, misspelled, differently cased or unknown class, a
`docs` class with a non-documentation reason, and a `full` class with no reason.

`scripts/ci-changes.test.mjs` starts the real classifier. It retains these
routing risks:

- A root documentation file with a known name must select `docs`, with or without
  an extension.
- A same-named file in another directory, a `docs/` file with an unknown
  extension, a source file, a test file, a workflow file and a policy script
  must select `full`.
- An absolute path, a trailing slash, a duplicated slash, a newline in the path,
  a parent segment or a nested non-documentation path must not reach the cheap
  route.
- An empty change set and every event other than `pull_request` must select
  `full`.
- A missing or malformed event name and an unknown argument must exit nonzero
  with no class on standard output.

`scripts/ci-playwright-image.test.mjs` retains the image-pin risks. A manifest
version that differs from `package.json` or from the three lockfile entries, a
tag that does not match the version, an invalid digest, an untrusted image
repository, and a missing or malformed manifest must fail with no image reference.
`scripts/ci-web-workflow.test.mjs` then runs the resolver shell step from both
`deploy.yml` and `verify-deployment.yml` and checks the written Action outputs.

### Benchmark and native CI evidence

`.github/workflows/desktop.yml` runs these jobs for a Desktop change:

- `web-benchmark` on Ubuntu for Chromium, Firefox and WebKit. It downloads the
  single `web-build` artifact and verifies its provenance before it measures.
  Local report: `$RUNNER_TEMP/web-benchmark-<browser>.json`.
- `native-validation` on Ubuntu, Windows and macOS. Each job builds one isolated
  debug test application, records the native source before and after the build,
  runs `scripts/native-smoke.mjs` on the real WebView, then measures the
  benchmark after every smoke process stops. Local results: `native-test-results/`.
  Local report: `$RUNNER_TEMP/native-benchmark.json`, with screenshots and the
  application log beside it. The macOS job asserts an ARM64 runner before it runs.
- `desktop-validation` requires every requested job above to succeed. A reused
  validation run must contain one successful `validate-desktop` job and one
  successful `native-validation` job for each platform, one successful
  `web-benchmark` job for each browser, and one successful gate.

The shared native job keeps these additional risks. A smoke failure must remain
the first error and must not be replaced by a later benchmark failure. The
benchmark must not start while a smoke process is still running, or its samples
include competing work. The source snapshots before and after the build still
identify the exact revision that the binary came from. The debug application
carries the test feature and is never an installer input.

The performance jobs pass `--enforce-budgets` and fail on a non-ok budget
result. A harness failure, missing result or functional native check failure
also fails the job. Shared-runner variance does not turn a failed budget into
a passing result. See [PERFORMANCE.md](PERFORMANCE.md) for the metric contract.

These reports are not GitHub Actions artifacts. Hosted-runner cleanup discards
them; no report download remains after the VM is destroyed. Keep local
reproduction reports outside Git. Build inputs transferred between jobs and
release deliverables remain separate from test reports.
Lighthouse CI writes its output to the filesystem at `test-results/lighthouse`
on the hosted runner, not to temporary public storage. That output is discarded
with the runner. The existing collection and assertion settings stay unchanged.

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

### Pathological long lines in the code and source editors

One physical line above 16,384 UTF-16 code units selects a reduced editor
configuration. The guard suspends the language grammar, folding, bracket
matching, automatic indentation, image-data decorations and effective line
wrapping. Text, selection, search, undo, manual indentation, save and exact byte
export stay active. A visible status reports the reduced highlighting and the
paused wrapping. The guard removes itself after the content shrinks and a
debounced full scan finds only short lines.

The retained failure risks are a late grammar reply that restores syntax on an
unsafe document, a guard scan that itself blocks input, a stale risk state after
undo or an external replacement, and a fallback that hides lost content. The
browser cases compare stored and exported bytes, keep the selection usable, and
check that ordinary files keep syntax tokens.

The Chromium fixtures are generated in the spec. They cover a 1,000,000-byte
JavaScript line, a 1,000,000-byte minified JSON document, a 100,000-column log
line and a Markdown note with 20,000-character fence lines. Each case attaches
the fixture byte count, UTF-16 length, maximum line length and SHA-256. The
measurement case keeps raw synchronous and next-frame input samples for four
named scenarios: long line, requested wrapping, invisibles and ordinary
grammar. Those samples are diagnostic. The strict platform budgets stay under
the common benchmark owner.

```sh
E2E_PORT=4398 npx playwright test e2e/code-editor.spec.ts e2e/editor-input-latency.spec.ts e2e/json-tools.spec.ts --project=chromium --workers=1 --retries=0
```

Keep the HTML and JSON reports, the attached fixture metadata and measurement
samples, downloads and failure traces. A browser result does not prove native
WebView performance. The JSON worker boundary remains a separate dependency.

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

### Command palette shortcut after reload

`e2e/audit-ui.spec.ts` proves a customized palette shortcut persists across a
reload. A shortcut sent before the application is interactive is discarded by
design, so the case waits for `.mdsh-shell[aria-busy="false"]:not([inert])`
immediately after `page.reload()`, as `resetAppState` does. Without that wait a
bootstrap race can fail the case for a reason it does not intend to test. The
readiness wait does not relax the click, the custom value, the chord, the dialog
assertion, or the assertion timeout. Removing the stored override must still keep
the configured shortcut from opening the palette after the app is interactive.

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
event. A valid run has one `validate-desktop` job and one `native-validation` job
for each of Ubuntu, Windows, and macOS, one `web-benchmark` job for each of
Chromium, Firefox, and WebKit, plus one successful aggregate gate. The workflow
trigger must reach the same path classifier for frontend and native changes.

The packaging matrix builds exactly four installers: macOS ARM64 DMG, Windows x64
NSIS EXE, and Linux x64 deb plus AppImage. `scripts/desktop-release-policy.mjs` is
the single policy. It must refuse a missing, duplicated, misplaced or foreign
file, and a name with a removed `.msi` or `.rpm` extension. The collector records
the source SHA and tag beside `SHA256SUMS`. A `packaging_only` run applies the same
collection and checksum steps and creates no tag, release or attestation.

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
does not prove an operating system print dialog. The workflow writes these
results to `native-test-results/` on the runner and does not upload them, so
they disappear when the runner is destroyed.

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

CI runs eight browser shards with one worker each. The protected `e2e` check
requires every planned shard to succeed. Chromium runs all scenarios. Firefox and
WebKit run engine-sensitive persistence, editing, layout, and source checks. CI
partitions the suite with duration-balanced `--test-list` selections, not with
Playwright `--shard`. To repeat one CI shard, build the same plan locally and run
its list:

```sh
npx playwright test --list --ignore-snapshots --grep-invert "Snapshots visuels" --reporter=json > /tmp/all-tests.json
node scripts/e2e-shards.mjs plan --list /tmp/all-tests.json --weights scripts/e2e-shard-weights.json --shards 8 --out /tmp/e2e-plan
npx playwright test --ignore-snapshots --grep-invert "Snapshots visuels" --test-list=/tmp/e2e-plan/shard-3.list
```

CI runs the browser and native tests without uploading reports to GitHub.
Hosted-runner files are temporary. Keep repeatable local-run evidence in local
storage. Compare its source commit with the release tag before using it.

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

## Local diagnostics report

`src/lib/diagnostics.test.ts` plants sentinels in error messages, unsafe error
codes and document text. It checks that the automatically collected report keeps
error names only, keeps structural statistics only, and reports unknown values as
null. `e2e/diagnostics.spec.ts` plants a file name, document body and API key,
builds a report from Settings through the command palette, and checks that:

- the preview and the downloaded bytes are identical;
- all sentinels are absent;
- no network request occurs while the report is built;
- Cancel leaves no preview and downloads nothing.

Run `npx playwright test e2e/diagnostics.spec.ts --project=chromium` and keep the
preview and downloaded JSON attachments. The issue template asks for the optional
bundle and warns that free text can contain sensitive data.
## First-run and storage recovery

`e2e/first-run-recovery.spec.ts` denies IndexedDB, checks the visible blocking
message and the retry action, restores storage access, and verifies that the retry
loads an empty library without deleting data. The artifact records the retry and
the row count. This covers a first visit where the storage API fails. The browser
can recover after the user restores access; the library is not reset.

The other first-run risks reuse existing specs instead of a second harness:

- Quota failure and draft preservation: `e2e/storage-pressure.spec.ts`.
- Prepared app offline and stale cache: `e2e/offline-review.spec.ts`.
- Remote media consent: `e2e/media-consent-review.spec.ts`.
- Reload during a pending save: `e2e/durability.spec.ts`.
- Corrupt archive refusal: `e2e/format-compat.spec.ts` and
  `e2e/project-archive-risks.spec.ts`.

A first visit with no cached application and no network cannot show DeckMark's
own error interface. That case is a browser limitation, not an application test.
Offline guarantees start after the service worker installs the required assets.

The **Ready offline** label comes from service worker activation. If registration
fails, Settings shows **Offline cache unavailable** and a retry action. The retry
runs the existing registration path. It does not claim that an uncached first visit
can recover without a network.

## Optional AI privacy and review

`e2e/ai-idle-privacy.spec.ts` configures a mock provider, enables AI, and then
edits and imports documents. It checks that the request count stays at zero until
an explicit action. The mock provider uses a loopback-style host name and no real
credential or paid call.

The other AI requirements reuse existing coverage:

- disabled state, session key lifetime and local storage exclusion:
  `e2e/ai-settings.spec.ts`
- reviewed context, streamed reply and cancellation: `e2e/ai-panel.spec.ts`
- stale patch refusal and scoped application: `e2e/ai-patches.spec.ts`
- patch parsing and adversarial fixtures: `src/lib/ai/patches.test.ts`

Web keys stay in tab session storage. Desktop keys stay behind the native
boundary and are tested by the Rust vault suite. A failed provider request must
leave the editor state intact; the existing error cases assert this.

## CI contract test suite

`npm run test:ci` is the single entry point for the Node tests that guard the CI
protocol. `npm test` runs it after Vitest, and `npm run test:coverage` runs it
after the local coverage report. `npm run test:benchmark-gate` is an alias for the
same command. The step uses `--test-concurrency=1` because several files start
real child processes, write temporary output files and run workflow shell
fragments. Parallel files would change those shared inputs.

The suite covers:

- The benchmark contracts and the fail-closed benchmark gate.
- Build provenance for the instrumented and production builds.
- The E2E manifest check and the duration-balanced shard plan.
- The CI tier policy and the Web aggregate, including the documentation class.
- The Ubuntu APT helper.
- The Playwright image pin, its failure cases and its two workflow steps.
- The Web documentation classifier and the Desktop path filter.
- The security scope classifier, the gitleaks range helper and the cargo audit helper.
- The installed CLI package contract.
- The Desktop release policy, the installer collector and the release notes.

A failing assertion means the workflow, the script and the documented contract
disagree. Correct the file that is wrong. Do not delete the assertion or relax it
to accept a skipped, deferred or unknown result.

The security tests retain these failure risks. Rust, GLib and Cargo inputs must
request the Cargo audit and the Rust CodeQL scan. Node dependency inputs must
request the npm audit only. Shared workflow scripts and actions must request both.
An unknown top-level path, an empty change set or an unreadable range must request
both audits. A malformed path must exit nonzero. The required `dependency-audit`
and Rust CodeQL aggregates must fail when the classifier fails or when the scan is
missing. `codeql (rust, none)` must use build mode `none` without a full build, and
analysis must stay local.

## CI tier policy tests

`scripts/ci-tier.mjs` classifies a workflow run as full or draft from the event
identity. The browser suite cannot observe this decision. These failure risks
need an isolated test:

- A pull request event with a missing or non-boolean `draft` field can start the
  full matrix or skip it. The script must exit nonzero instead.
- A `ready_for_review` event with `draft: true`, or a `converted_to_draft` event
  with `draft: false`, is contradictory. A stale payload must not select the tier.
- A `synchronize` event on a ready pull request must stay full. An action-name
  only rule would defer it.
- Push, schedule, workflow_dispatch, workflow_call and release runs have no draft
  state. They must always be full.
- A malformed event file, a missing event name and an unknown event name must not
  fall back to the fast tier.
- A label, a workflow input or a missing output must not select the fast tier.

`scripts/ci-tier.test.mjs` starts the real CLI as a child process. It checks
stdout and the exit code for each case. Run `node --test scripts/ci-tier.test.mjs`.
A nonzero exit on a malformed event is the expected result, not a test failure.
Keep the command, the source revision and the exit codes with the run evidence.

## Benchmark gate tests

`scripts/benchmark-shared.test.mjs` checks the fail-closed benchmark gate. It
covers an over-budget p95, a missing baseline, a missing required metric, too few
samples, a unit mismatch, a non-finite value, an ungated summary metric, and an
invalid budget. It also starts `scripts/benchmark-gate.mjs` as a child process and
checks that valid evidence exits 0 while over-budget or incomplete evidence exits
nonzero. Run `node --test scripts/benchmark-shared.test.mjs`, or `npm run test:ci`
for the complete CI contract. Keep the JSON report and the exit code
with the run evidence. The gate does not replace a browser or native benchmark
run. It decides whether the retained measurements permit publication.

## Database upgrade safety

`e2e/upgrade-safety.spec.ts` creates a real IndexedDB version 5 database with a
draft before the app starts. It checks that the current Dexie schema upgrades to
version 80, keeps the draft bytes, and renders the content.

A second case holds a version 5 connection open in another tab. The app must not
stay on an endless loading shell: after the reviewed timeout it shows the storage
error and the retry action. Closing the stale tab and retrying recovers the draft.
The artifact records the blocked state and the recovery.

The timeout is a bounded recovery path, not a migration shortcut. A stale tab
cannot be forced to close, and unsaved text that was never written remains outside
the durability guarantee.
## Dual-host transfer

`e2e/host-transfer.spec.ts` starts a second local origin from the same production
build. It creates a note and an AI session key on the first origin, exports a
portable backup, imports it on the second origin with **Merge**, and checks that
the document content arrives while the key stays absent. It also checks the host
identity text and cancellation path. The artifact records both origins and the
key result.

`src/lib/host.test.ts` covers the main host, the fallback host, local development
and an unknown self-hosted copy. The public deployment checks in
`playwright.production.config.ts` and `verify-deployment.yml` still verify each
live host independently against its own expected base path and source SHA.

## Local semantic search query risks

`e2e/semantic-search.spec.ts` checks the observable results. A scoped clear keeps
the library and the other project rows. An edited document stays out of the
ranking until a rebuild. A saved index from another model revision is never
scored.

```sh
E2E_PORT=4399 npx playwright test e2e/semantic-search.spec.ts --project=chromium --workers=1 --retries=0
```

The query race needs an out-of-order completion that the browser suite cannot
schedule without replacing IndexedDB request objects. `src/lib/semantic-search-query.test.ts`
holds a deferred read for query A, resolves query B first, then releases A. Only
B may publish. `src/lib/semantic-search.test.ts` checks the trained-revision
boundary, the A to B to A corpus transition, a fresh-index oracle, and scoped row
reads at 300, 900 and 3,000 rows. The 3,000-row timing budget stays with #327.
Keep the Playwright JSON and HTML reports with the command and source revision.

## CI failure evidence and typewriter setup

Keep these risks and evidence boundaries for #628:

- An enforcing benchmark can fail without preserving the values that crossed a budget. `scripts/benchmark-local.mjs` now prints one bounded line for each failed metric: metric name, count, min, max, p50, p95 and at most 64 numeric samples in run order. It does not print paths, notes, capabilities or the complete report. An ok budget emits no failure-sample line. The failure message, tolerance, budget and nonzero exit remain unchanged. A negative control uses the existing `--budgets` option with a stricter private budget file outside Git; retain its failed exit separately from a healthy run.
- The image input probe retains the product duration events `imageMarkdownScopedStage`, `imageMarkdownFullStage`, `restoreMarkdown`, `filterTransaction` and `sourceFidelityScopeAttempt`. It clears events with the samples and long tasks before each position. Its local attachment has raw samples, overall and per-position stage summaries, and the count of samples at or above 100 ms. The console has the overall stage summary and gated sample metrics. These stage values are not gated p50 or p95. They have no timestamp or sample index, so they cannot identify the stage behind one named slow sample. The extra event listener and array push have unmeasured observer cost.
- Work already queued before a typewriter burst can enter the burst observation. The probe `ready()` waits for two quiet frames with no queued object measure request and no new centre dispatch. It uses the frame function captured at installation, outside the pending-frame counter. It reads `view.measureRequests` from the pinned CodeMirror 6.43.15 and rejects a detached view, unavailable queue or two-second deadline. This is a pre-burst barrier, not a change to product scheduling.
- A first burst at the clamped top can record no centre, which makes the same-head assertion vacuous. The retained first case requires at least one centre in addition to the existing upper bound, same-head check and `maxPending <= 2`. Before capture, PageDown moves the caret off the top, `ready()` drains the caret measure, a 40 px scroll offset queues the scroll measure, one frame lets it enter the queue, and a second `ready()` drains it. The original 30-key burst and 20-frame settle stay unchanged. A later centered collapse can legitimately need no centre. The zero-centre RED and external zero/duplicate controls are coverage and assertion controls, not product regressions.
- The inactive-editor history selection poll can fail without retaining its DOM boundary. On failure only, `editor-state.spec.ts` prints `[selection-boundary]` and attaches the same JSON: focus, active element, range endpoints/text, mounted content count, active file, cached position and available EditorView selection/viewport/measure state. Missing fields stay null. Capture is bounded to two seconds and rethrows the original error. The 35-file sequence, selection assertion and timeout stay unchanged.
- A TOC visibility failure can lack evidence of headings, mode and resource loading. On failure only, `editor-width.spec.ts` prints `[toc-boundary]` and attaches heading presence, bounded text, aside connectivity/inert/display/visibility, nav/items, active/stored mode and at most 20 same-origin script timings. It retains the exact 5000 ms visibility assertion, adds no pre-assertion wait and rethrows the original error after bounded capture.

Run the focused positive coalescing case with one worker and no retries:

```sh
E2E_PORT=4216 npx playwright test e2e/navigation-stats-scroll.spec.ts \
  --project=chromium --project=webkit --workers=1 --retries=0 \
  --grep 'typewriter coalesces'
```

Retain the direct exit, source and working diff identity, command, environment, list log and per-project burst/centered attachments locally. Do not mistake a separate control `results.json` for the GREEN reporter object. Do not upload reports. These local controls do not establish the cause or recovery of the hosted Firefox scroll, WebKit input tail, history selection, TOC or typewriter failures. Record fresh exact-head CI evidence separately.

