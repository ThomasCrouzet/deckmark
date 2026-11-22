# Desktop performance work

## Revision and changed-span contract

Issue [#345](https://github.com/ThomasCrouzet/deckmark/issues/345) coordinates
the shared source revision record. The contract lives in `src/lib/source-edit.ts`.
It is the only accepted revision shape for the large-file work.

One accepted edit produces one `SourceEdit` record. The record holds:

- `documentId` and `revision`, the source identity after the edit.
- `baseRevision`, the revision that the previous span refers to.
- `space`, either `editor-markdown` or `portable-source`.
- `kind`, either `insert`, `replace` or `full`.
- `previous` and `next`, the changed ranges in each snapshot.
- `previousLength` and `nextLength`, when the producer knows the snapshot size.

The visual editor records the `editor-markdown` space. Source and Code edits
record the `portable-source` space. The canonical revision layer in
`document-revisions.ts` records each accepted CodeMirror edit as it applies.
One changed range stays exact. Multiple ranges become an explicit `full`
revision. The length chain links each record to the next accepted revision. The
metadata codec (#369) keeps its own accepted-span chain, and its Worker applies
the spans with `applySourceTextSpans`.

The contract has these rules:

- A consumer applies a span only to the previous snapshot of the stated
  `baseRevision` and `space`.
- A consumer must take a full snapshot when `kind` is `full`, the base
  revision differs, or the apply helper returns null.
- A consumer must not compare complete sources again when the record is exact.
- A 32-bit hash is not a source identity.
- A rendered span stays in editor Markdown coordinates. A consumer on the
  portable source maps the frontmatter and restoration boundary, or uses a
  full fallback.

Owner map: [#572](https://github.com/ThomasCrouzet/deckmark/issues/572) owns
rendered source restoration, [#574](https://github.com/ThomasCrouzet/deckmark/issues/574)
owns durable projections, [#369](https://github.com/ThomasCrouzet/deckmark/issues/369)
owns metadata and statistics consumers, [#373](https://github.com/ThomasCrouzet/deckmark/issues/373)
owns source release, and [#327](https://github.com/ThomasCrouzet/deckmark/issues/327)
owns the cross-platform evidence.

The instrumented build emits each accepted record on the
`deckmark:editor-perf` event. The case installs a local collector that keeps the
last records. A record holds the spans, both lengths and the coordinate space.
It does not hold the source text. Run:

```sh
npx playwright test e2e/revision-contract.spec.ts --project=chromium \
  --workers=1 --retries=0
```

The case checks a source edit, a coalesced source burst, a structural source
edit and a rendered edit. It attaches `revision-contract.json` with the raw
records, the fixture hash, the browser version and the source identity. This
local Chromium run does not prove Firefox, WebKit, an installed PWA, a physical
device or a native WebView result.

The shared record adds 302 gzip bytes to the boot graph. The reviewed boot
budget moves from 212000 to 212500 gzip bytes. No other mode budget changes.

## Cross-mode stress evidence

Issue [#327](https://github.com/ThomasCrouzet/deckmark/issues/327) adds a separate
stress contract. The closed baseline work in
[#208](https://github.com/ThomasCrouzet/deckmark/issues/208),
[#260](https://github.com/ThomasCrouzet/deckmark/issues/260) and
[#268](https://github.com/ThomasCrouzet/deckmark/issues/268) remains the baseline.
The existing summary gate, its samples and its limits do not change.

List the complete planned matrix without a build or browser:

```sh
npm run benchmark:stress -- --list
node scripts/benchmark-stress.mjs --fixture json-1mb
```

`scripts/benchmark-fixtures/stress.mjs` defines deterministic Markdown at 50 KB,
240 KB, 1 MB and 5 MB, a 1 MB line, 1,000 headings, repeated Mermaid/math/tables,
Code at 50 KB/1 MB/5 MB, JSON at 50 KB/1 MB/5 MB/10 MB, and decks with
20/100/300 slides and ten objects per slide. Library tiers contain
0/300/900/3,000 background documents, plus the measured file and a history
sentinel. Sizes use decimal bytes. The fixture command returns exact content,
byte count and SHA-256. Decks use the existing version 1 format.

Source, Code, JSON and Split have Web browser adapters. The separate mode suite
below covers WYSIWYG, Read, slide text, slide notes, slide canvas, read
annotation and Advanced Presentation Source. The stress matrix still lists those
rows as unavailable because they use a different measurement contract; select
them with `benchmark-modes`. Listing a case is not execution or coverage proof.
Native stress transport is still not implemented; the separate native mode
transport is described under the mode benchmarks below.

Build and record a clean committed root production build, then select a bounded
set of cases. Set `OUT` to an existing local directory outside the repository.
Each output file must be new. Do not run the whole matrix on a shared host.

```sh
BASE_PATH='' npm run build
node scripts/build-provenance.mjs write --kind web-benchmark --instrumentation none
node scripts/benchmark-local.mjs --suite stress --prebuilt --runs 20 \
  --cases source/markdown-1mb/lib-0,code/code-1mb/lib-0,json/json-1mb/lib-0,split/markdown-1mb/lib-0 \
  --output "$OUT/stress-chromium.json"
```

The typing runner also accepts `--suite stress` with the same arguments.
Select Firefox or WebKit with `--profile web-light-firefox-production` or
`--profile web-light-webkit-production`. The default is
`web-light-chromium-production`. The verified build must have no source-fidelity
instrumentation. Provenance rejects a different source, dirty tree, changed
input or changed build byte. Browser contexts block service workers so that an
old cache cannot replace the verified build.

The `deckmark-stress/2` report retains every attempted sample and terminal case.
It records the source commit/tree/diff, untracked hashes, verified build tree,
fixture hashes, OS, renderer version, host or CI runner and exact command.
Samples rotate start, middle and end offsets. Each sample inserts one character
through the browser text-input channel. It requires a trusted `beforeinput`,
the exact full editor value and the exact saved value. Downloaded bytes, per-file
undo, redo and saved reload are checked after the samples. These checks do not
prove crash recovery, failed-write recovery, bursts or clipboard paste.
History checks use real keyboard actions. Redo uses CodeMirror's primary binding:
Ctrl+Y on non-Mac platforms and Cmd+Shift+Z on Mac. The report retains the actual
trusted key event and its editor target. Synthetic history events do not replace
this check.

| Raw metric | Boundary |
| --- | --- |
| `inputToFrameMs` | Trusted `beforeinput` capture to the second animation frame, with one paint opportunity. This is not an observed compositor paint. |
| `inputDispatchMs` | Input capture to its queued microtask. A browser checkpoint can precede later listeners. This is not pure transaction CPU or guaranteed full dispatch duration. |
| `saveObservedMs` | Input capture to the observed matching IndexedDB bytes, including poll and driver overhead. The 400 ms product delay stays unchanged. |

Required capability records state support and a reason. Long tasks and engine heap are
recorded when exposed. Pure transaction CPU, preview completion, validation
completion, post-idle CPU and attributable process RSS remain unavailable.
Each successful sample also records DOM count and canvas dimensions. These
resources have no calibrated stress limit yet.
Fixture and export sidecars stay beside the JSON report. Failed cases also try
to retain a screenshot. The JSON lists their paths and byte hashes.

Audit independently with the expected case selection and an external byte-review
receipt. `RECEIPT_SHA256` is the trusted receipt's raw-file SHA-256:

```sh
node scripts/benchmark-gate.mjs --suite stress --report "$OUT/stress-chromium.json" \
  --receipt "$OUT/external-trust.json" --receipt-sha256 "$RECEIPT_SHA256" \
  --cases source/markdown-1mb/lib-0,code/code-1mb/lib-0,json/json-1mb/lib-0,split/markdown-1mb/lib-0
```

The audit recomputes p50/p95 from raw values. It rejects absent or duplicated
cases, missing stages, aborted samples, wrong counts, non-finite values, wrong
profiles, missing identities and failed byte/history/reload checks. At least
20 aggregate samples are required for strict evidence. Fewer samples emit
`tail-estimate-insufficient`. Twenty aggregate samples do not supply twenty
samples per position. Read the raw samples; do not claim a stable per-position
tail. There is no minimum-of-three stress statistic.

## Save contention evidence

The stress runner measures one character to its durable completion. It does not
measure a burst that resumes during an active save. `e2e/save-contention.spec.ts`
adds that workload for Chromium, Firefox and WebKit desktop. It types bursts with
real browser input, switches to Read and switches files before the 400 ms save
delay ends, and checks the exact editor and durable bytes. It records the base
revision, accepted span, result revision and durable revision for each sample.
The report keeps raw frame opportunities, dispatch and queue proxies, p50, p95,
max and the denominator, long tasks, publication and metadata measures, save
transactions and a separate row for each environment.

A one-shot 600 ms stall inside the observed drafts put guarantees that the second
burst arrives during a save. It is a control and not a product timing claim. A
120 ms input-stage busy wait detects a deliberate CPU regression, and a corrupted
drafts write detects a persistence regression. The corrected source is tested by
the E2E case, not by a past build or a CI configuration alone. Latency stays
report-only until a reviewed 20-run baseline exists. Installed PWA, physical
iPhone and iPad, and all three optimized native clients remain **not tested**.

## Representative editor report

`e2e/representative-editor-report.spec.ts` covers the issue #327 report fields
and the issue #572 WYSIWYG route matrix on one 36 KB note. The note holds plain
and mixed inline paragraphs near the start, middle and end, a 320 item list, a
140 row table, an embedded image and a tail sentinel. The case records a
separate row for each workload. Each row keeps the raw input samples, the
nearest-rank p50, p95, max and denominator for the queue delay, dispatch proxy,
second-frame opportunity and next-input delay, every product stage with its own
start and end, the durable save measures, long tasks, the accepted edit spans,
the coarse source-route reason, the editor and durable byte counts, and the
exact-byte result. A control row waits without a key and must record no input,
no route decision and no accepted edit. A cold first mount and a warm Source to
WYSIWYG switch record the browser cache note.

One case runs 20 measured passes after one declared warmup pass. `rawRuns`
keeps every pass and `cases` pools only the measured passes. A metric record
states `measured`, `insufficient-samples` or `unsupported` with its
denominator. Firefox and WebKit do not expose long tasks or the JavaScript heap
estimate in this case, so those records are `unsupported` instead of zero. A
test-only 120 ms busy wait in the input path is a negative control: the frame
metric must show at least 80 ms.

`scripts/representative-budgets.json` holds the reviewed p95 limits from 20
measured passes per case on Linux Chromium, Firefox and WebKit. The Chromium,
Firefox and WebKit projects enforce the limits with a 50 percent tolerance when
at least 20 measured passes exist. A p95 over five samples does not satisfy the
gate. `scripts/representative-audit.mjs` recomputes the aggregates from the raw
passes and rejects a forged percentile, a dropped pass, a short tail and an
over-budget case.

The plain, mixed and Enter rows stay on the scoped route. After the container
publication change, the list and table rows also stay on the scoped route with a
full counter at zero. The reviewed p95 input values
were 31 ms to 54 ms on Chromium, 31 ms to 44 ms on Firefox and 40 ms to 88 ms on
WebKit on the earlier source. The list and table budgets stay above that earlier
whole-document route and act as upper bounds for the bounded route. A second
20-run confirmation passed every limit. The values remain desktop browser
evidence, not compositor paint or a native WebView result.

Backup and archive outputs publish local `mdsh:export-profile` performance
measures. `e2e/backup-export-bounds.spec.ts` adds a profile for the JSON and
encrypted backup and a profile for the library ZIP, the project ZIP and the
documentation site ZIP. The encrypted row separates collection, encoding and
AES-GCM encryption and counts the contiguous plaintext copy. The archive rows
separate planning from compression and output. The documentation site row also
separates rendering and entry assembly. The default corpus for these rows is
8 MiB with three binary assets. The values are local Chromium evidence, not a
heap measure, a native memory measure or a physical device result.

#
## Read and slide mode benchmarks

`scripts/benchmark-modes.mjs` covers the Read render path and the speaker text
and notes input paths that the insert stress contract cannot express. It uses the
same clean production build and provenance checks as the stress suite.

```sh
node scripts/benchmark-modes.mjs --list
node scripts/benchmark-modes.mjs --fixture read-rich-30
BASE_PATH='' npm run build
node scripts/build-provenance.mjs write --kind web-benchmark --instrumentation none
node scripts/benchmark-modes.mjs --prebuilt --runs 20 \
  --cases read/read-rich-30/lib-0,slide-text/deck-20/lib-0,slide-notes/deck-20/lib-0 \
  --output "$OUT/modes-chromium.json"
```

Fixtures are a 30-diagram Read document with math, tables and a tail sentinel, a
1 MB Read document, and the existing 20/100/300-slide decks. Read samples reload
and switch from Source to Read, so each sample is a cold render. Slide samples
reload between saves so the 400 ms draft queue starts clean.

| Raw metric | Boundary |
| --- | --- |
| `firstContentMs` | Read mode click to the first article text with the tail sentinel. Includes script and parse work, not compositor paint. |
| `fullRenderMs` | Read mode click to the last expected Mermaid SVG. |
| `inputToFrameMs` | Trusted `beforeinput` in the slide text or notes textarea to the second animation frame. Not a physical key or an IME. |
| `inputDispatchMs` | Input capture to its queued microtask. |
| `saveObservedMs` | Input capture to the exact IndexedDB source, including the 400 ms draft delay and polling. |

The suite checks the exact fixture and export bytes, the 30 diagram count, the
Read tail sentinel, the replayed slide field after every insertion, per-deck undo
and redo, the Markdown export, and reload recovery. The audit rejects missing or
duplicated cases, wrong counts, non-finite metrics, lost bytes, a wrong final
source, missing undo/redo, missing receipt files and over-budget values.

`scripts/benchmark-budgets.json` has a `modes` section. The Web Light Chromium
profile is blocking with these reviewed local limits:

| Metric | Limit |
| --- | --- |
| `readFirstContentMs` | 400 ms |
| `readFullRenderMs` | 2500 ms |
| `slideInputToFrameMs` | 60 ms |
| `slideInputDispatchMs` | 5 ms |
| `slideSaveObservedMs` | 2000 ms |

The resource limits are 10000 DOM nodes, zero canvas pixels and 128 MiB heap.
Firefox and WebKit remain report-only. The limits come from a clean 20-run
Chromium production run on 2026-11-10. The observed p95 values were 243.8 ms,
1472.5 ms, 29.6 ms, 0.1 ms and 866.3 ms (slide text; notes 793.9 ms). A copy with a 900 ms first-content
value and 5000 ms slide saves fails the strict audit with `over-budget`.

Strict audit:

```sh
node scripts/benchmark-modes-audit.mjs --report "$OUT/modes-chromium.json" \
  --receipt "$OUT/external-trust.json" --receipt-sha256 "$RECEIPT_SHA256" \
  --cases read/read-rich-30/lib-0,slide-text/deck-20/lib-0,slide-notes/deck-20/lib-0
```

The same suite covers the remaining Web interaction modes:

| Case | Workload | Raw metrics |
| --- | --- | --- |
| `wysiwyg/read-rich-30/lib-0` | ProseMirror insert at the start and end | `inputToFrameMs`, `inputDispatchMs`, `saveObservedMs` |
| `slide-canvas/deck-20/lib-0` | pointer drag of a rectangle | `pointerToFrameMs`, `saveObservedMs` |
| `annotation/read-rich-30/lib-0` | Read-mode ink strokes | `pointerToFrameMs`, `paintedPixels`, `strokeCount` |
| `slide-source/deck-20/lib-0` | advanced presentation source insert and Apply | `inputToFrameMs`, `inputDispatchMs`, `applyObservedMs` |

The WYSIWYG, canvas and advanced-source cases check the stored source hash,
undo/redo, Markdown export and reload recovery. The annotation case checks the
non-transparent canvas pixels and the completed stroke count; ink is in memory
and has no stored export. The audit replays the canvas source change and the
stored/export/reload hashes.

Additional reviewed local limits:

| Metric | Limit |
| --- | --- |
| `wysiwygInputToFrameMs` | 100 ms |
| `wysiwygInputDispatchMs` | 10 ms |
| `wysiwygSaveObservedMs` | 3000 ms |
| `canvasPointerToFrameMs` | 100 ms |
| `canvasSaveObservedMs` | 3000 ms |
| `annotationPointerToFrameMs` | 100 ms |
| `annotationPaintedPixels` | 10000000 |
| `slideSourceInputToFrameMs` | 100 ms |
| `slideSourceInputDispatchMs` | 10 ms |
| `slideSourceApplyObservedMs` | 5000 ms |

Canvas pixels are limited to 16,777,216 for the annotation canvas. A 20-run
Chromium run produced p95 values of 41.8 ms / 0.1 ms / 771.2 ms for WYSIWYG,
32.3 ms / 695.5 ms for canvas, 35.0 ms / 5096 painted pixels for annotation and
32.1 ms / 0.1 ms / 703.2 ms for slide source. A copy with 200 ms input or
pointer times fails every affected case with `over-budget`.

Strict audit:

```sh
node scripts/benchmark-modes-audit.mjs --report "$OUT/modes-chromium.json" \
  --receipt "$OUT/external-trust.json" --receipt-sha256 "$RECEIPT_SHA256" \
  --cases wysiwyg/read-rich-30/lib-0,slide-canvas/deck-20/lib-0,annotation/read-rich-30/lib-0,slide-source/deck-20/lib-0
```

Native mode transport now covers Read, slide text, slide notes, WYSIWYG,
annotation, slide canvas and Advanced Presentation Source on Linux WebKitGTK.
The Windows WebView2 and macOS WKWebView transports remain report-only; the
Linux baseline is not evidence for them.

### Native mode transport

`scripts/benchmark-modes-native.mjs` runs the same mode matrix against the built
Tauri WebView through its embedded test WebDriver. It is a separate transport,
not a browser run. Build the isolated test binary and run the matrix:

```sh
npm run tauri -- build --debug --features native-smoke --no-bundle \
  --config src-tauri/tauri.smoke.conf.json
WEBKIT_DISABLE_DMABUF_RENDERER=1 dbus-run-session -- xvfb-run -a \
  node scripts/benchmark-modes.mjs --profile native-complete-linux-webkitgtk-debug \
  --cases "$CASES" --runs 20 --output "$OUT/native-modes.json"
```

The report keeps the same schema and method contract. Its evidence kind is
`native-run`; the build provenance names the desktop edition, the debug test
binary and its SHA-256. Each case starts a fresh isolated app profile and
reloads between samples where the Web adapter reloads. The input probe uses the
trusted editing-command channel because this WebKitGTK driver reports injected
key events as untrusted. A large-note Read confirmation is accepted before the
mode clock starts.

The desktop Markdown export opens the native save dialog. The Linux transport
answers that dialog through `xdotool`, then reads the exact written bytes. A
missing tool is an explicit unsupported result, not a zero-byte export. Windows
and macOS save dialogs are not automated, so those profiles stay report-only.

The Linux WebKitGTK debug profile carries the recorded local limits:

| Metric | Limit |
| --- | --- |
| `readFirstContentMs` | 20000 ms |
| `readFullRenderMs` | 25000 ms |
| `slideInputToFrameMs` | 120 ms |
| `slideInputDispatchMs` | 10 ms |
| `slideSaveObservedMs` | 2500 ms |
| `wysiwygInputToFrameMs` | 1500 ms |
| `wysiwygInputDispatchMs` | 20 ms |
| `wysiwygSaveObservedMs` | 3000 ms |
| `canvasPointerToFrameMs` | 120 ms |
| `canvasSaveObservedMs` | 2500 ms |
| `annotationPointerToFrameMs` | 120 ms |
| `annotationPaintedPixels` | 10000000 |
| `slideSourceInputToFrameMs` | 200 ms |
| `slideSourceInputDispatchMs` | 30 ms |
| `slideSourceApplyObservedMs` | 3000 ms |

The resource limits are 200000 DOM nodes and 16777216 backing canvas pixels.
A debug build is slower than a release build. Do not compare a native debug
report with a Web production report, a release WebView or another platform.
The native save dialog, the GTK file chooser and the X11 input tool are part of
this local Linux evidence; an installer or a packaged release does not contain
the test driver.

## Version 2 report contract

`scripts/benchmark-stress-contract.mjs` defines method `codemirror-insert/1`.
It preserves target-capture beforeinput, the second animation frame, queued
microtask and exact IndexedDB observation clocks. It also preserves two frames
before input, no discarded warmup, the 550 ms wait after each sample, raw count,
nearest-rank statistics and three-decimal summaries. These names do not turn a
frame opportunity into compositor paint or a microtask into transaction CPU.

The audit requires trusted editor-target `insertText`, operation `insert`, text
`x`, actual collapsed selection and source length. It replays the deterministic
fixture at rotating start/middle/end offsets `Math.round(length * ratio)`, with
ratios 0.02/0.5/0.98. It checks before/after and final hashes against that replay.
Case mode, fixture name/bytes/hash/generator/arguments, actual library row count,
membership and background-row hashes must match the selected catalog entry.

Source must be clean before and after collection, with the same commit/tree.
Source, build digest, provenance, edition/profile, root base path, instrumentation,
builder/runtime identity and all provenance input hashes must agree. Version 1
reports remain historical evidence. Missing version 2 observations must not be
invented or filled into an old measured report to make it pass.

Each sample must retain all seven capability records: longTasks, heap,
transactionCpu, preview, validation, postIdleCpu and rss. Supported long tasks
need finite nonnegative ms values. Supported heap needs a finite nonnegative
byte value with `performance.memory-estimate` origin. This method cannot claim
the other five stages are supported; each needs an explicit unsupported reason,
not a zero value. DOM count and canvas backing dimensions require valid counts
and units. Missing maps or arrays fail.

Strict resource comparison requires configured domNodes and canvasPixels limits.
Configured heapBytes/rssBytes limits are also enforced against observed maxima.
A configured unsupported resource, an unknown limit or an invalid value fails.
Null resource limits remain an unreviewed requirement. No product limit is
calibrated or approved by these checks.

Fidelity booleans are not enough. The report records separately read CodeMirror
document and IndexedDB origins/hashes for sentinel insert/undo, main file return,
main undo/redo and reload. It retains real trusted history key events. Export
name/count/hash and actual sidecar bytes must equal the final replayed source.
This contract does not define a visual editor source snapshot or visual history.

### External artifact trust receipt

The producer does not issue its own trust receipt. After collection, an independent
reviewer must check the source/build/provenance inputs and local fixture/export
bytes, then issue `deckmark-stress-artifact-trust/1`. Pass its path and pinned
digest explicitly to the audit. A report-embedded receipt is not authoritative.

The receipt has these fields:

- `scope: "external-artifact-byte-review"`, a named `reviewer`, ISO `reviewedAt`,
  and `evidenceKind` equal to `browser-run` or `synthetic-control`.
- `reportSha256`, the exact report-file byte digest.
- `source: { revision, tree }`, the independently checked source identity.
- `provenanceSha256`, the SHA-256 of recursively key-sorted canonical JSON for
  the embedded provenance. Sorting uses the contract module's localeCompare
  ordering, not an unstated JSON canonicalization standard.
- `buildTree: { files, sha256 }` and `inputs`, equal to the independently checked
  provenance tree and complete input-hash map.
- `files`, an absolute-path map of `{ bytes, sha256 }` for each case's fixture
  and export sidecars.

The CLI checks the receipt's pinned raw-byte digest, report binding and internal
agreement, rehashes sidecar bytes and compares them with deterministic replay.
The caller explicitly trusts the external review of build/input bytes. This is
not a signature or proof that claimed browser work actually ran. A coordinated
invented report and invented trusted receipt is outside this JSON check's proof.

The collector's embedded audit cannot be strict success before independent trust
exists. Without enforcement it can finish functional collection but retains the
failed audit. `--enforce-budgets` does not bypass receipt or resource requirements.
Use the separate strict post-collection audit for acceptance. Synthetic CLI
controls declare `synthetic-control` in report, receipt and test-only budget
profile. They contain synthetic times, not new browser measurements or product
references. Preserve original positive/negative reports without rewriting them.

The new `stress` section in `scripts/benchmark-budgets.json` separates Web Light
production from Desktop Complete release and debug profiles. The Web Light
Chromium profile now carries reviewed local limits for the Source, Code, JSON and
Split 1 MB cases. The other browsers, the remaining modes and all native profiles
are **report-only and uncalibrated**. A strict stress audit still requires the
external artifact receipt and a complete case selection. `--enforce-budgets`
makes the audit result govern the measurement command exit. Without enforcement,
functional failures still exit nonzero. An audit with `--report-only` can exit
zero but retains `enforced: false` and its failed status. It is not a strict gate
pass.

The Chromium limits come from one clean `eda7dea` production build on 2026-11-10.
Four cases ran 20 times each at `lib-0`:

| Case | input-to-frame p95 | dispatch p95 | save p95 |
| --- | --- | --- | --- |
| `source/markdown-1mb/lib-0` | 39.5 ms | 0.1 ms | 513.2 ms |
| `code/code-1mb/lib-0` | 31.8 ms | 0.1 ms | 578.1 ms |
| `json/json-1mb/lib-0` | 31.6 ms | 0.1 ms | 499.9 ms |
| `split/markdown-1mb/lib-0` | 35.7 ms | 0.1 ms | 532.3 ms |

The profile limits are 60 ms, 5 ms and 1200 ms with 200000 DOM nodes, zero canvas
pixels and 128 MiB heap. They are about 50 percent above the highest observed
value. The save stage includes the unchanged 400 ms product delay. A mutated copy
of the same report with 100 ms input-to-frame fails every case with
`over-budget`; the unmodified report passes the strict audit with an external
receipt. These local results do not replace a CI baseline or a native measurement.

The limits, the available native adapters, the mode suite and CI workload
selection were accepted, and #327 closed on 2026-11-10. Read, slide text and
slide notes have the mode suite above. WYSIWYG, annotation, slide canvas and
Advanced Presentation Source still have no stress adapter. Native mode transport
is also absent. This delivery does not change release workflows or claim full
cross-mode CI. Do not copy debug native limits into a release profile or
auto-raise a limit.

The CLI controls run in `npm run test:benchmark-gate` and the standard Node test
phase. They use labelled synthetic limits, not product baselines. They reject
a deliberate raw latency increase even when a forged summary reports a lower
p95. `--inject-delay-ms 250` also adds a labelled delay inside the measured
browser event task for a local negative control. It changes only that browser
context. Keep injected evidence separate from normal evidence.

This document records the measured desktop scenarios, the confirmed root
causes, and the changes made for issue #224.

## Method

Benchmarks are reproducible and local only:

```sh
npm run build:web
node scripts/benchmark-local.mjs --browser chromium --runs 3 --build-mode production-static --output /tmp/bench.json
```

For the native WebView:

```sh
npm run tauri -- build --debug --features native-smoke --no-bundle --config src-tauri/tauri.smoke.conf.json
node scripts/benchmark-local.mjs --target native --build-mode debug --runs 5 --output /tmp/native-bench.json
```

Each run records the source revision, runtime identity, fixture hashes, raw
samples, p50 and p95 values, and the budget comparison. The fixture corpus is
the same 900 document library and 600 document project described in
`docs/TESTING.md`.

## Confirmed bottleneck: document switching with a large library

Scenario: switch between library documents while 900 documents are loaded. The
editor itself is idle before the switch, so the measured time covers the store
update, derived values, sidebar rendering, and the editor remount.

Measurement on the development laptop, Chromium production build, three runs:

| Metric | Before | After | Change |
| --- | --- | --- | --- |
| `documentSwitch` p50 | 2559.4 ms | 2239.6 ms | -12.5 percent |
| `documentSwitch` p95 | 2657.7 ms | 2264.3 ms | -14.8 percent |
| `largeDocumentOpen` p50 | 2564.0 ms | 2240.1 ms | -12.6 percent |

Root cause: `filesStore.library` built a new array on every read. The value is
read by several derived values during a document switch: the command palette,
the search panel, the metadata index, and the editor pane. With 900 documents,
each read allocated and copied 900 references, and the repeated copies ran
inside the same synchronous switch path.

Change: the getter now caches the combined array and invalidates it when the
open or closed list changes identity or length. A unit test asserts that
repeated reads return the same array and that closing or reopening a document
returns a fresh one.

No editor rewrite was needed. Typing stays on the editor thread, and no work
moved to Rust.

## Lazy French dictionary and KaTeX chunks

Issue [#730](https://github.com/ThomasCrouzet/deckmark/issues/730) removes the
French dictionary and the KaTeX renderer from the startup and editor closures.

- `src/lib/i18n/i18n.svelte.ts` keeps English as the only static dictionary.
  A French locale loads `messages/fr` with a dynamic import. `t()` falls back to
  English until that chunk arrives and then re-renders. The French chunk is part
  of the app build and the service worker precache, so French still works
  offline with no third-party request.
- `patches/milkdown/deferred-katex.patch` replaces the top-level
  `import katex from 'katex'` in `@milkdown/crepe` with a loader that imports
  KaTeX when a formula first renders. The inline math node and the LaTeX code
  block preview call the loader. `npm run patch:milkdown` applies and verifies
  the patch during install.
- `vite.config.ts` merges the two 22-byte SvelteKit facades for app state and
  paths into the startup state resource. The precache entry count stays below
  its reviewed budget after the new French chunk.

Measured with Node 26.13.1 on 2026-11-22, base commit `b6014ef`, one production
build for each tree:

| Closure | Before | After | Difference |
| --- | ---: | ---: | ---: |
| boot | 212,920 gzip bytes | 187,455 gzip bytes | -25,465 |
| read | 266,798 gzip bytes | 243,534 gzip bytes | -23,264 |
| source | 216,549 gzip bytes | 216,549 gzip bytes | 0 |
| wysiwyg | 614,621 gzip bytes | 514,515 gzip bytes | -100,106 |
| precache | 423 entries | 421 entries | -2 |

Read mode keeps the KaTeX chunk because it renders formulas. The editor closure
no longer imports that chunk statically. These numbers are directional evidence
from a local Node 26 build. CI under its pinned Node 22 toolchain is the binding
gate.

## Checks after the change

```text
boot: 33 JS, 204781 gzip bytes / 210000
read: 11 JS, 301887 gzip bytes / 327680
source: 12 JS, 216551 gzip bytes / 307200
wysiwyg: 18 JS, 601619 gzip bytes / 655360
precache: 401 entries / 410, 2954776 gzip bytes / 3350000
Budget status for web-chromium: ok
```

Startup, typing, read mode, WYSIWYG, project tree, presentation and export
stages stay inside the same budgets as before the change.

The reviewed precache limit is 412 entries. The large-document work adds the
metadata worker and one resource for the metadata-first library load. The worker
stays a separate asset so every native WebView can start it; the editor history
cache stays behind the source and code editor boundary, and the draft helpers
share one lazy chunk.
The gzip limit is unchanged. An extra entry requires a smaller merge or a new
reviewed limit; a failed build does not raise it.

## Remaining work

The native benchmark on Windows, Linux and macOS Apple Silicon runs in CI. A
native profile of the same scenario is captured with
`--target native`; the shared web measurements above isolate the frontend part.

## WYSIWYG large-document profile

Issue #324 asks for a measured viewport-rendering decision, not a forced
virtualization. The profile below used the production Web build at source
`9debaa7e5cd00c274a6543227909be49e2249606`, Chromium on Linux x64, Node 26.13.0,
and the reviewed `scripts/benchmark-editor-typing.mjs` harness (SHA-256
`0a5e1b4a917014da135fa9c980fbebbfeac5e15a45a1e9ac16ca72062d46e57f`).

```sh
node scripts/benchmark-editor-typing.mjs --browser chromium --runs 3   --sizes 240000,1000000,5000000 --modes visual --libraries both   --output /srv/dev/cache/tmp/opencode/bench-324.json
```

| Source bytes | DOM nodes | Input frame p50 / p95 (ms) | Sync p50 / p95 (ms) |
| --- | ---: | ---: | ---: |
| 240,000 | 47,483 | 66.1 / 318.6 | 6.4 / 23.3 |
| 1,000,000 | 196,823 | 149.3 / 268.5 | 29.7 / 36.9 |
| 5,000,000 | 978,395 | 607.7 / 607.7 | 134.1 / 134.1 |

The table reports the start-of-document case with an empty library. The 240 KB
and 1 MB rows have three samples; the machine stopped at one valid 5 MB sample,
so its tail estimate is not presented as stable. A 300-document library changed
the medians by less than 25 percent in the same report.

The dominant cost is the full ProseMirror document and its rich node views, not
string publication: DOM nodes grow linearly with note size and the 5 MB case
retains almost one million nodes. The measured input path still completes one
COOP edit per sample with exact source fidelity. The #310 and #335 work removed
the repeated serializer and full-source work from that path.

Decision: do not adopt DOM virtualization now. ProseMirror selection, IME,
clipboard, find, drag and drop, table editing, internal anchors, print/export
and accessibility cross the viewport boundary, and the current evidence covers
Chromium only with one valid 5 MB sample. The retained fallback is the ordinary
editor. Revisit with cross-engine and native profiles, a scrollable viewport
prototype that keeps one complete document model, and an explicit correctness
matrix for those interactions. This is a measured prototype decision, not a
claim that 5 MB visual editing is fast.

## Long-document paint containment

Issue [#709](https://github.com/ThomasCrouzet/deckmark/issues/709) covers work
item W2. Paint containment follows the rendered structure of a document, not
only its encoded source length.

### Gate rule

`src/lib/editor-document-policy.ts` holds three sufficient conditions:

| Condition | Value | Constant |
| --- | ---: | --- |
| Interaction characters | 262,144 (256 KiB) | `LONG_DOCUMENT_CHARS` |
| Rendered elements | 4,000 | `LONG_DOCUMENT_ELEMENTS` |
| Rendered top-level blocks | 800 | `LONG_DOCUMENT_BLOCKS` |

`Editor.svelte` counts the direct children and the descendant elements of the
ProseMirror root after the first layout. One condition is sufficient for the
`mdsh-long-document` class. The class stays set for the mount, so a later
shrink does not reshape the scroll region under the caret. The element count
sets the gate because the measured keystroke gain is complete at about 8,000
elements. The block count covers a document of many small blocks.

### Rendered structure at 200 KB

Chromium, production build, each document opened in Edit mode.

| Content | Elements | Top-level blocks | Gate |
| --- | ---: | ---: | --- |
| prose | 611 | 611 | off |
| code | 5,603 | 2,696 | on |
| links | 8,464 | 3,628 | on |
| headings | 8,674 | 8,674 | on |
| lists | 40,414 | 755 | on |
| tables | 55,216 | 1,228 | on |
| math (KaTeX) | 195,394 | 4,093 | on |

A 200 KB prose note stays at 611 elements. A 200 KB table note builds 55,216
elements and now receives containment.

### Measured effect

Chromium, production build, caret at 50 percent of the document, 60 ms cadence,
12 inserted characters. The table reports the second animation frame after the
`beforeinput` event.

| Document | Before p50 / p95 (ms) | After p50 / p95 (ms) |
| --- | ---: | ---: |
| tables 200 KB | 288.1 / 319.7 | 15.5 / 32.1 |
| math 200 KB | 1,166.0 / 1,417.5 | 43.7 / 59.6 |
| prose 200 KB | 9.5 / 32.4 | 9.2 / 33.1 |
| prose 1.5 MB | 27.0 / 39.4 | 21.3 / 30.0 |

The tables and math rows report the median of three runs of the per-kind sheet.
The prose rows use three interleaved runs of each build and report the median
p50. Prose does not change, and the 1.5 MB prose note does not regress. The host
ran other builds during the measurements, and each run records the load
average.

### Engine policy

The measured structure applies to Chromium only. Gecko pays the containment
work on every mounted block.

Firefox, production build, the 240 KB mixed note of the Web benchmark, visual
editor opened from Source mode, 20 samples of the mode switch. The typing value
is the same report's `typingWysiwyg` p50.

| Build | Mount p50 / p95 (ms) | Typing p50 (ms) |
| --- | ---: | ---: |
| origin/main, no structural gate | 3,778 / 4,361 | 114 |
| branch before the Gecko policy, run 1 | 5,173 / 6,589 | 123 |
| branch before the Gecko policy, run 2 | 5,104 / 5,843 | 126 |
| branch with the Gecko policy | 3,399 / 5,261 | 92 |

The runs recorded a load average of 6.9 to 11.4 on a shared host. The branch
before the policy crossed the 10,000 ms mount cap on a loaded host, and every
value above stayed inside the cap on this host.

The measurement pass is not the cost. A probe on the same document reads 2,317
bounding boxes in 5 to 15 ms. Neutralizing `content-visibility` for the same
build lowers the mount by 0.4 to 0.7 s, and the class and the generated sheet
reach the document 1.2 to 1.5 s after the ProseMirror root appears. The engine
therefore keeps the character gate alone: a note of at least 262,144
interaction characters still receives containment, as it did before this work
item, and a large table or math note below that threshold does not.

Chromium keeps the measured structure and the gain it reports. The exclusion
uses the engine family, not a version guess, in the same way as the WebKit
exclusion.

### Per-kind intrinsic size

`content-visibility: auto` reserves a fallback length for each block that has
not rendered yet: 2.4em for text, 3.2em for a heading, 12em for a table or a
code block and 320px for an image. An unrevealed table is much taller than
12em, so the document height changed while the user scrolled.

`Editor.svelte` writes one generated style sheet with a measured mean size for
each top-level block kind: heading, table, code, list or quote, and paragraph.
The mean of a kind keeps the reserved document height equal to the laid-out
height when the containment starts. `contain-intrinsic-size: auto <length>`
remembers the last rendered size of a block, so the fallback only covers a
block that has not rendered yet.

The sheet is written once per mount and never rewritten. An earlier revision
wrote one rule per top-level block and rewrote the sheet after every block
change. A style sheet change invalidates every element, so each write forced a
full style recalculation of the document:

| Sheet | Rules | Style recalculation |
| --- | ---: | ---: |
| one rule per block | 2,141 | 1.3 to 2.2 s |
| one rule per block kind | 3 | about 0.2 s |

Chromium, production build, 240 KB mixed note with 4,287 elements. The
measurement sets the sheet and forces layout. Any new sheet forces one
recalculation of every element, so even three rules cost about 0.2 s at the
mount. The per-block sheet produced two unattributed long tasks of 405 ms and
3.5 s in `e2e/editor-publish-stall.spec.ts` 'attributes a paste and a structural
split', one for the paste and one for the split. The per-kind sheet writes once
at the mount and reports no long task in the same workflow.

Four rules govern the sheet:

- The sizes live in a `<style>` element in `document.head`, not in the `style`
  attribute of a block. An attribute change inside the editable area makes the
  ProseMirror DOM observer re-render the whole document, and the re-render drops
  the attribute.
- The measured size is the content box. The code subtracts the padding and the
  border of the kind, because `contain-intrinsic-size` sizes the content box.
  Without that step a code block adds its own padding to every reserved size.
- The selector repeats `.mdsh-editor` to outrank the per-type fallback rules in
  `milkdown.css`, and wraps the kind in `:is()` so one rule covers a selector
  list. The sheet also moves to the end of `document.head`, after the Milkdown
  theme that the first mount loads.
- The sheet is written once per mount. A block insert, removal or edit changes
  no rule, so an edit never invalidates style.

The measurement reads one bounding box per top-level block after the first
layout: 21 ms for 4,093 blocks (195,394 elements) and 8 ms for 1,228 blocks
(55,216 elements). It forces no document-wide render and it runs once.

### Contained height against the laid-out height

Chromium, production build, tall documents in Edit mode. The laid-out height is
the document height with the generated sheet and the long-document class
removed.

| Document | Laid out (px) | Contained (px) | Difference |
| --- | ---: | ---: | ---: |
| tables 200 KB | 167,858 | 168,312 | +0.27% |
| math 200 KB | 186,740 | 188,432 | +0.91% |
| lists 200 KB | 137,734 | 138,047 | +0.23% |
| links 200 KB | 176,412 | 177,923 | +0.86% |
| headings 200 KB | 474,098 | 473,524 | -0.12% |
| code 200 KB | 233,770 | 234,792 | +0.44% |

Without the generated sheet the same table note starts at 103,994 px and grows
to 118,909 px during the scroll walk. The measured sizes remove that change.

### Scroll stability

`e2e/editor-containment.spec.ts` scrolls a 60-section table note through six
positions. Run it with:

```sh
npx playwright test e2e/editor-containment.spec.ts --project=chromium \
  --workers=1 --retries=0
```

At each position the case records the block under the viewport centre, waits for
the offscreen blocks to render and compares the screen position of that block.
The case fails when the block moves more than 2 px, or when the document height
moves by more than 2 percent. The case attaches a screenshot and a JSON record
of the fixture hash, the gate values, the scroll steps and the source identity.

The `mdsh-webkit-engine` exclusion is unchanged. Apple WebKit keeps every live
block in the layout tree, and no containment rule applies there. Gecko keeps the
character gate alone, as the engine policy above records. Read mode stays
out of this work item: its preview blocks use a different container, and a
change there must pass the Split mode heading geometry checks first.

## Enforced benchmark gate

`scripts/benchmark-budgets.json` is the reviewed reference for each platform and
metric. `scripts/benchmark-shared.mjs` evaluates a report as follows:

- A missing platform baseline fails the gate.
- A required metric with no measurement fails the gate.
- Fewer runs than `defaults.minimumRuns` fails the gate. A metric can set a
  reviewed `minimumRuns` value. One-shot lifecycle metrics such as cold start
  and close use 1 sample, and the report shows `runs: 1`.
- A measured metric must record `complete: true`. A missing field, a non-boolean
  value, or a false value fails the gate.
- A unit mismatch, a non-finite value, or a negative value fails the gate.
- A measured summary field with no budget entry fails the gate. Add a reviewed
  budget or an explicit `optional` entry instead of dropping the metric.
- A p95 above `p95 * (1 + toleranceRatio)` fails the gate. The default tolerance
  is 0.25. A 1.5 times regression therefore fails.
- A metric marked `optional` may stay unmeasured only when the engine does not
  expose it. The report keeps the `unsupported` status and the reason.

The CI Desktop workflow passes `--enforce-budgets`. The process exits nonzero on
any non-ok status, and the `desktop-validation` aggregate job requires the
benchmark job to succeed. A failed benchmark therefore prevents release
publication. Audit a retained local JSON report with the same gate:

```sh
node scripts/benchmark-gate.mjs --report "$PWD/test-results/bench.json" --budgets scripts/benchmark-budgets.json
```

`--report` must be an absolute path; the gate rejects a relative value before it
reads the file. The generator has the same rule for `--output`, and it also
rejects an output path inside the repository.

`scripts/benchmark-gate.mjs` measures nothing. It validates the report schema,
source identity, build mode, platform identity, sample counts, units, and budget
values. Use it to audit a retained local artifact or to repeat a gate decision.
CI does not upload benchmark reports. Hosted-runner cleanup discards its
temporary files; repeat a failing case locally when a full report is needed.

The negative cases for each rule run in `scripts/benchmark-shared.test.mjs`. The
test starts the gate as a child process and checks the exit code. This proves
that invalid evidence cannot become a successful gate. Run:

```sh
npm run test:benchmark-gate
```

The browser benchmark collects 20 samples for startup, cached restart, project
tree render, presentation load, visual typing, document switch, large document
open, scroll, source typing, driver typing, presentation slide switch, presentation
present and HTML export. The library reload keeps 3 samples. Heap collects four
samples. Every former five-sample metric now uses 20 samples, so its p95 is the
second-worst value and not the maximum. The five startup metrics on each web platform set `minimumRuns` to 20,
which matches the 20 samples that the generator collects. The gate reports every
sample and the maximum. The 20-sample metrics use that count because a p95 over
5 samples is the maximum: one browser garbage-collection pause, one slow cached
restart, one cold presentation load or one slow visual typing sample would fail
the run. With 20 samples, p95 is the second-worst value, so a systematic
slowdown still fails and one isolated stall stays visible without becoming the
gate decision. A repeated stall also fails, because the second-worst value then
exceeds the limit. The first cold presentation load stays in the samples. The
startup measurement installs a paint observer before navigation, waits a
bounded time for either the observer or the timeline entry, and records which
source supplied the value. A required metric with a missing sample fails the
gate, so a partial report cannot pass on its remaining samples.

### Mixed typing suite and the blind spots it closes

Issue #709 work item W7 keeps a mixed fixture set and a mixed typing suite. The
suite closes four measured blind spots of the earlier gate:

- The generated corpus had a longest line of 520 characters and no images. A
  purpose-built generated note therefore took the scoped source route and
  published in milliseconds.
- The visual typing metric allowed 3000 ms in Chromium, so a 1.4 s blocking
  publish passed.
- The harness installed a long-task observer but never used it for input.
- Five samples made p95 equal to the maximum.

The fixture set is `note-200k-mixed`, `note-600k-mixed` and `note-1mb-mixed` in
`scripts/benchmark-fixtures/`. Each note has uneven prose, one wide padded table
of 64 rows, one list of 96 items and inline base64 images on single long lines.
The 600 KB note has six images and a longest line of 90,002 characters. The table
ends without a blank line, as in many real notes. The manifest records bytes,
SHA-256, `maxLineChars`, `inlineImageCount`, `tableRowCount` and `listItemCount`.
`loadFixtures` recomputes the descriptor and fails closed when a mixed fixture
reports no inline image, a longest line under 20000 characters, a table under 60
rows or a list under 90 items. `npm run test:ci` runs these self-checks.

The suite measures four caret positions per note: prose middle, table cell, list
item, and a paragraph after the last chart image. Each position runs three passes
of one declared warmup key and twenty measured keys. One metric is the
input-to-frame time. The other is `publishBlockMs`: the longest engine-reported
long task that starts after the gated animation frame and ends before the next
key. The gate uses the median of the three pass p95 values and keeps every raw
sample. The report also records heartbeat gaps and the
`sourceFidelityFullReason` counters per scenario.

A tables-removed diagnostic deletes every table line at load time and edits the
same prose caret. It shows whether the table container is the cost.

Measured on the pre-fix build (`cfc9c01`, production build, Chromium, local
Linux host, reviewed command in the next paragraph). The table-cell edit took
the whole-document route on every key. The other positions took the scoped
route and reported no long task.

| Fixture | Table-cell route | Publish block p50 / p95 (ms) | Other positions |
| --- | --- | ---: | --- |
| `note-200k-mixed` | `container-table`, 60/60 keys | 379 / 755 | scoped, publish block 0 |
| `note-600k-mixed` | `container-table`, 60/60 keys | 970 / 1045 | scoped, publish block 0 |
| `note-1mb-mixed` | `container-table`, 60/60 keys | 2079 / 2489 | scoped, publish block 0 |

The tables-removed diagnostic measured a 7 ms input frame and no publish block
on the 600 KB note. The source cases measured 2.7 to 2.9 ms p95 and no publish
block. The reviewed command is:

```sh
node scripts/benchmark-local.mjs --browser chromium --runs 5 --build-mode production-static --prebuilt --enforce-budgets --output /srv/dev/cache/tmp/opencode/w7/web-chromium.json
```

That run failed on `edit200kTablePublishBlock`, `edit600kTablePublishBlock` and
`edit1mbTablePublishBlock` only. Every other metric passed. The whole Chromium
job measured 14.4 minutes on this host before the fix. The fix removes the
one-second table publish, so the expected job time after the fix is about 11 to
12 minutes, inside the 25 minute job limit.

The full plan runs on Chromium. Firefox and WebKit keep a five-key diagnostic
probe, and their mixed budget entries are optional. This also keeps the
`web-benchmark` job inside its 25 minute limit.

### Keystroke targets and the local typing profile

16 ms and 33 ms are product targets for a keystroke in the visual editor. 16 ms
is one frame at 60 Hz and 33 ms is two frames. They are not gate limits. The
reviewed budgets are the numbers in `scripts/benchmark-budgets.json`, and the
report keeps the p50 and every raw sample next to them.

Gate a typing change locally without the runner-specific cold start and paint
limits. First derive a private budget file that omits the navigation metrics.
Then run the harness with `--skip-navigation`:

```sh
node -e "const b=require('./scripts/benchmark-budgets.json'); const m=b.platforms['web-chromium'].metrics; for (const k of ['coldStart','cachedRestart','firstContentfulPaint','domInteractive','domContentLoaded','libraryReload']) delete m[k]; process.stdout.write(JSON.stringify(b,null,'\t')+'\n')" > /srv/dev/cache/tmp/opencode/bench-budgets-typing.json
node scripts/benchmark-local.mjs --browser chromium --runs 5 --build-mode production-static --skip-navigation --enforce-budgets --budgets /srv/dev/cache/tmp/opencode/bench-budgets-typing.json --output /srv/dev/cache/tmp/opencode/bench-typing.json
```

`--skip-navigation` omits cold start, cached restart, first contentful paint, DOM
timing and the library reload samples. Keep the file outside Git. CI never
passes this flag, and the reviewed budget file still gates the full run.

### WebKit source typing stall (issue 552)

The Desktop run `42874731123` on 2026-11-10 (attempt 1, source `db0af3b`)
failed `web-benchmark (webkit)` on `typingSource` only. That job measured
p50 18 ms and p95 346 ms over five samples. `typingSourceSync` measured 3 ms
p95 and the driver reference measured 23.138 ms p95. A p95 over five samples
is the maximum, so one delayed frame became the gate decision. The input
handler returned in 3 ms and the inserted text reached the editor. The product
typing work was not the late stage. The summary has no timer or frame record,
so it cannot separate a stalled runner main thread from a skipped compositor
frame. That remaining ambiguity is why the report now keeps per-sample
diagnostics.

The same source passed `web-benchmark (webkit)` on the earlier pull request
(15 ms p50 and p95). Attempt 2 of the failed run passed, and its
`desktop-validation` aggregate passed. All native smoke and native benchmark
jobs, the Chromium and Firefox Web benchmarks, and both production builds
succeeded in attempt 1. This is a single frame tail on a shared runner. It is
not a reproducible product regression.

The gate collects 20 samples for source and large-note typing, as it already
does for startup, cached restart, project tree and visual typing. The
Chromium, Firefox and WebKit budgets require `minimumRuns: 20`, so a short
report fails closed. With 20 samples, p95 is the second-worst value. One stall
stays in `samples` and `max`. Two stalls fail the gate. The WebKit 200 ms p95,
the units and the default 0.25 tolerance did not change. No retry was added.

Every source and large-note typing sample now stays in `diagnostics` with
`frameMs`, `timerMs`, `frameOverTimerMs`, `visibilityState`, `nodeCount` and
`stall`. `stall` is `app-work` for a handler of 50 ms or more,
`main-thread-block` for a late or missing zero-delay timer, `frame-delay` for a
timely timer and a frame of 100 ms or more, and `none` otherwise. These
thresholds classify evidence. They are not budgets. A future report can show
whether the delay came from the handler, the main thread or the frame.

`scripts/benchmark-shared.test.mjs` keeps the measurement contract. It shows
that one 346 ms sample in 20 leaves p95 at 18 ms and passes, and that two
samples put p95 at 346 ms and fail. The test also requires the reviewed WebKit
`typingSource` minimum to stay at 20 samples.

Reproduce the WebKit workload on Linux with a production static build:

```sh
BASE_PATH='' npm run build
node scripts/benchmark-local.mjs --browser webkit --runs 20 \
  --build-mode production-static \
  --output /srv/dev/cache/tmp/opencode/webkit-20.json
node scripts/benchmark-gate.mjs \
  --report /srv/dev/cache/tmp/opencode/webkit-20.json \
  --budgets scripts/benchmark-budgets.json
```

A local run on 2026-11-11 at source `80e4056` used WebKit 27.2 and a
production static build. All 20 `typingSource` samples were between 10 and
15 ms: p50 13 ms and p95 14 ms. `typingSourceSync` was 2 to 5 ms with p95 4 ms.
Every `typingSource` diagnostic reported `stall: "none"`, a timer of 8 to 11 ms
and a frame 10 to 15 ms after the input. `typingLarge` measured p50 14 ms, p95
15 ms and max 15 ms. The gate accepted the report with 24 metrics and no
failures. The 346 ms tail did not reproduce.

The reproducer does not create the runner tail. Read `samples.typingSource`,
`samples.typingSourceSync`, `diagnostics.typingSource` and `max` in the report.
A local pass does not prove that a later hosted runner cannot stall. The
20-sample rule keeps one such stall visible without letting it decide the gate.

The native benchmark collects 20 samples for the library reload, WYSIWYG
typing, slide switch and present mode. One unmeasured warm reload precedes the
library samples. `minimumRuns` is 20 for those metrics, so a short report fails
the gate. A p95 over five samples is the maximum, and one browser or WebView
stall failed unrelated pull requests on macOS. Twenty samples make p95 the
second-worst value: a systematic slowdown still fails, one isolated stall stays
visible in the report, and two stalls fail the gate.

The warm startup metric collects three starts and gates on the median
(`statistic: "p50"`). The report keeps the p95 and the maximum. A single start
cannot separate a runner stall from a regression, and a 32 s stall on a virtual
macOS runner failed an unrelated pull request. A median over three starts needs
two slow starts to fail. Process-tree RSS also gates on the median because a
WebView helper process can add a transient process; the p95 and maximum stay in
the report. WYSIWYG typing and present mode also gate on the median over 20
samples, because the debug WebView tail on the virtual macOS runner moves by
more than the reviewed budget while the median stays stable. The p95 and
maximum stay in the report. Cold startup, close and presentation load stay
one-shot because they require a process or window lifecycle.

### Native readiness observation

The macOS cold-start job on 2026-11-07 measured 33013.015 ms against the
15000 ms limit. Its shell phase took 30161.885 ms over two polls. This
localizes the delay to readiness observation, but does not identify its cause.
A lost completion and delayed application readiness can both fit that log.
Linux protocol controls also observed one preliminary `execute/sync` shell
check that used a 30 s script budget: spawn to driver took 27747 ms and shell
readiness 57941 ms, while another Linux run needed 333 ms for the same phase.
Fast later responses do not disprove the earlier stall. No macOS root cause or
performance repair follows from the Linux controls.

Readiness now uses `POST /wdio/eval` with a per-request server script deadline
of 2000 ms. The plugin creates an executor for the request. The deadline is an
upper bound, not a minimum response time. An unretained JS callback can produce
an earlier HTTP 500 reclamation error (`Completion handler for function call is
no longer reachable`) at about 477 ms. A rooted script that never calls back
ends at the server deadline with HTTP 500 `script timeout` at about 2003 ms. On
macOS the plugin also removes the pending result registration when the
operation ends. Linux drops the waiting receiver; page-side state can remain
until collection or window closure. The shared client transport bound remains
60 s. With a responsive driver, the server ends the attempt before that client
bound; transport failure is still an error, not readiness.

Only the readiness probe uses the new channel. The other requests, readiness
predicate, 90 s readiness budget, 100 ms retry delay, poll counter, clock marks,
sample counts, statistics and 15000 ms startupCold limit do not change. The
predicate must produce a strict boolean. Only `true` establishes readiness. An
HTTP error, malformed result or absent boolean cannot establish readiness.

This is an observation-method change, not neutral instrumentation:

- The controls observed stalled attempts between about 0.5 s and 2.1 s, ending
  at the server deadline or with an earlier reclamation error. These observations
  do not establish a minimum duration. Each attempt still counts as a poll. The
  retry count is not capped at 43: a faster error can allow more attempts within
  the existing readiness budget, and 43 is only the nominal upper bound for
  full-deadline attempts.
- Healthy observations also use a different channel. The former synchronous
  executor polled its result at 50 ms intervals. Direct evaluation and its
  platform fallback have different delivery overhead. Do not assume equal
  transport cost or compare old and new startup baselines without noting the
  method change.
- Server completion does not prove that all page-side promise state has been
  collected. The read-only probe has no application timer or mutation. The
  protocol controls distinguish completed HTTP operations from client aborts;
  they cannot inspect the driver's private result registry.
- A 16051 ms hold on a real `aria-busy` attribute kept both channels and the
  production `appReady()` pending at the 8 s marker. That hold used a 50 ms
  polling script, so its 16051 ms figure carries 50 ms control quantization;
  the 8 s marker is the stronger pending proof.
- A genuinely late shell must still exceed the unchanged startup budget. The
  complete run also fails if readiness never arrives within its existing wait.
  Workloads measured after readiness are not changed by this correction.

Local protocol controls use a real Linux native-smoke binary from an older
source tree. They verify the endpoint contract and error handling, not current
frontend parity or macOS behavior. An unretained-callback control ended at
477 ms with an early reclamation error and failed an expectation of a full
deadline wait. Keep that failure: that fault model is not a deterministic
deadline fixture. A separate budget-consumer fixture still rejects a 16000 ms
startupCold sample at the unchanged 15000 ms limit. It is not a full native
benchmark result. Fresh hosted checks on the candidate, including macOS and
Windows, remain required before acceptance.

The library reload budget is 8000 ms on all three native platforms because the
20-sample workload measures warm reloads, not the old one-shot cold reload. The
measured p95 was 4834.9 to 7532.5 ms on Linux, 5408.5 ms on Windows and
7207.6 ms on macOS on 2026-11-06. The old 5000 ms macOS and 6000 ms Linux and
Windows values covered one cold reload and are not comparable.

Native CI still builds the instrumented debug binary. Its measurements are
diagnostic only. The debug results are not release-build performance and the
baseline labels say so. An optimized native baseline needs a separate recorded
reference before it can make a release claim.

## CI calibration record

The first enforced run on 2026-11-04 (Actions run 41933449566, ubuntu-24.04)
measured the production Web build in each browser. Chromium and WebKit exceeded
some provisional development baselines. The reviewed budgets now use the CI
measurements:

| Platform and metric | Measured p95 | Budget p95 |
| --- | --- | --- |
| Chromium `heapUsedMb` | 679.8 MB | 800 MB |
| WebKit `readModeSwitch` | 5742 ms | 6000 ms |
| WebKit `wysiwygLoad` | 13579 ms | 14000 ms |
| WebKit `projectTreeRender` | 2516 ms | 2600 ms |
| WebKit `presentationPresent` | 1420 ms | 1500 ms |
| WebKit `exportHtml` | 4396 ms | 4500 ms |
| Windows native `rssMb` | 1968.8 MB | 2200 MB |
| Linux native `readModeSwitch` | 16314 ms | 17000 ms |
| Linux native `rssMb` | 1646.2 MB | 1800 MB |
| macOS native `documentSwitch` | 6359 ms | 7000 ms |
| macOS native `largeDocumentOpen` | 5156 ms | 5500 ms |
| macOS native `readModeSwitch` | 15226 ms | 16000 ms |
| macOS native `wysiwygLoad` | 14665 ms | 15500 ms |
| macOS native `presentationPresent` | 641 ms | 700 ms |
| Linux native `libraryReload` (20 warm samples) | 4834.9 to 7532.5 ms | 8000 ms |
| Windows native `libraryReload` (20 warm samples) | 5408.5 ms | 8000 ms |
| macOS native `libraryReload` (20 warm samples) | 7207.6 ms | 8000 ms |
| macOS native `projectTreeRender` | 4075 ms | 4200 ms |
| Linux native `startupCold` | 31312 ms | 32000 ms |
| WebKit `presentationLoad` | 1130 ms | 1200 ms |

Firefox stayed inside its earlier budget. These changes move a provisional
development baseline to the actual runner. They do not remove the gate. A later
run that exceeds the reviewed limit by more than 25 percent still fails.

## Document switch: project backlink scan

Issue #268 reported a slow document switch under load. A Chromium CPU profile of
the production build with the 300 document library and the 600 document project
showed that `filesStore.backlinks()` dominated the switch. The method resolved
every wiki link again on each call. For a project link, each resolution filtered
the complete project and rebuilt path keys. The cost was quadratic in the corpus
size, and the sidebar recomputes backlinks when the active document changes.

Reproduction command:

```sh
BASE_PATH='' npx vite build --sourcemap
node scripts/profile-switch.mjs
```

The profile in this work used a 100 microsecond sampling interval. It recorded
the click on a library document through the updated editor header.

| Measurement | Before | After |
| --- | --- | --- |
| Switch profile duration | 2701 ms | 307 ms |
| `projectPath()` self samples | 1193 ms | 5 ms |
| `documentSwitch` p95, 5 runs | 2194 ms | 54 ms |
| `largeDocumentOpen` p95, 5 runs | 2191 ms | 31 ms |

Change: `filesStore.backlinks()` now uses the inverted name and id index in
`MetaIndex` for library notes. The previous implementation re-resolved every link
on each call. Project documents keep the path-aware resolution path. The link
rules and ambiguity rules do not change.

Verification:

- `npx playwright test e2e/wiki-links.spec.ts --project=chromium`: 4 passed.
- `npx playwright test e2e/project-explorer.spec.ts --project=chromium`: 7 passed.
- The Chromium production benchmark stays inside every budget, including
  `documentSwitch` and `largeDocumentOpen`.
- Raw benchmark evidence: `/tmp/opencode/bench-after-switch.json` from source
  revision in this branch, 5 runs, production static build.

The change does not alter save durability, per-file undo, source bytes, focus or
conflict handling.

## Diagnostics startup budget

The local diagnostics feature keeps a bounded event ring in the startup graph so
that `reportError` and `reportWarning` can record a safe event before the panel
opens. The panel, its labels and the report builder load only when the user opens
the report. The production Web build measured 210349 gzip bytes for boot before
the limit review, against the earlier 210000 limit with 93 bytes of headroom. The
reviewed limit is now 211000. The bundle graph check still fails above that value,
and the panel stays outside the startup graph.

## Web AI client cost snapshot

A local diagnostic used the immutable production Web build from source
`98547b49e09b70367915a142f2624809935519c2`, version 2.4.0. It ran on one
Linux host with Node 22.23.4 and headless Chromium 156.0.8078.4, at a
1280 by 800 viewport with the French locale. Each case has ten samples.
Each sample opens a fresh page in a reused browser context. This is not a
cold browser-process or cold-cache benchmark. Service workers were blocked.

| Measured boundary | p50, ms | p95, ms |
| --- | ---: | ---: |
| Navigation to default app-ready state, AI disabled | 134.2 | 148.3 |
| First AI activation click to panel DOM mount | 20.3 | 20.8 |
| Stream action click to first non-empty output mutation | 18.7 | 19.6 |
| Stream action click to final text mutation | 319.3 | 320.9 |
| Last complete content frame delivered to the reader to final text mutation | 0.2 | 0.3 |

With ten samples, nearest-rank p95 is the maximum. These are observations,
not new budgets or cross-browser guarantees. No CI threshold or sample count
changed.

The provider was a labelled loopback mock, not a real model service. It
received a 4595-byte fixture document and returned six content frames with
60 ms spacing. The final text has 85 characters. The total stream time
includes that deliberate pacing. No external host request was observed.

The click timestamp comes from a capture listener on the actual clicked
element. A pass-through stream records content delivery before it gives the
bytes to the app reader. The final boundary uses the text marker's DOM
mutation on the same page clock. It excludes the trailing protocol terminator
and does not measure request completion or painted pixels. The stream wrapper
and observer add instrumentation cost; the sub-millisecond result is not a
claim of pure CPU cost.

This snapshot does not measure provider queueing, token generation, TLS, DNS,
billing, long replies or behavior on other hosts and browsers. The command,
fixture, raw samples and source identity remain in local diagnostic storage,
not in a GitHub report artifact.

## Rich-text container publication

This record covers issues #569 and #572. A text edit inside one list item or one
table cell of a large note now keeps a bounded source restoration. Before this
change the same edit parsed and normalized the complete source. The saved and
exported bytes, the image identity, the caret, undo, redo and the large-document
confirmation stay identical.

The representative note is 36 KB. It holds plain and mixed inline paragraphs, a
320 item list, a 140 row table, one embedded image and a tail paragraph. The
before run uses source `0a82d52` in a detached worktree. The after run uses this
branch. Both runs use one Chromium worker, a French locale and a blocked service
worker. Each value is the p95 of the accepted publication stage for that row.
The values are single-run observations, not budgets or a distribution.

| Row | Before route | Before stage p95, ms | After route | After stage p95, ms |
| --- | --- | ---: | --- | ---: |
| List item edit | whole document, `sourceFidelityFull` | 479.5 | scoped, `sourceFidelityScopeAttempt` | 33.8 |
| Table cell edit | whole document, `sourceFidelityFull` | 373.9 | scoped, `sourceFidelityScopeAttempt` | 45.1 |
| Mixed Enter split | scoped, full counter at zero | 4.2 | scoped, full counter at zero | 4.8 |

The exact exported Markdown and the durable row match the expected bytes in both
runs. The Enter split was already local at source `0a82d52`, so its row is a
control and not a before-and-after defect.

The container note is 345 KB. It holds a 3,000 item list, a 1,400 row table, one
embedded image and filler prose. It is above the 256 Ki character confirmation
threshold. One list edit took 4.0 to 5.6 seconds through the whole-document route
before the change. One table edit took 4.7 to 5.1 seconds. After the change the
full counter stays at zero. The edit restores in about 276 ms on Chromium, 568 ms
on Firefox and 314 ms on WebKit for the list row. The table row is about 274,
564 and 345 ms. The table and list probe totals include a redo publication, so
these values are approximate. The exported bytes and the image hash match the
seed in all three browsers. Undo and redo return the exact seed and the exact
edit. The caret stays after the inserted character. No extra confirmation
appears during the edits.

Commands:

```sh
npx vitest run src/lib/source-fidelity.test.ts --maxWorkers=1
npx playwright test e2e/container-source-publication.spec.ts --project=chromium --workers=1 --retries=0
npx playwright test e2e/container-source-publication.spec.ts --project=firefox --workers=1 --retries=0
npx playwright test e2e/container-source-publication.spec.ts --project=webkit --workers=1 --retries=0
npx playwright test e2e/representative-editor-report.spec.ts --project=chromium --workers=1 --retries=0 --trace=off
```

Environment classes:

| Class | Result in this record |
| --- | --- |
| Source only | The changed branch in `src/lib/source-fidelity.ts` is reviewed. This is not a runtime result. |
| Node isolated | `src/lib/source-fidelity.test.ts` records a parser input below 64 KiB for one list and one table edit. This is not a browser result. |
| Desktop browser | Chromium, Firefox and WebKit executed the container workflow and the representative report. |
| Emulated mobile | Not tested. No mobile project selects these cases. |
| Installed PWA | Not tested. Playwright does not install a PWA or reproduce its lifecycle. |
| Physical and native | Not tested. No physical iOS device and no optimized native WebView are attached. |

A desktop browser second frame is a frame opportunity, not compositor paint.
The values do not prove a physical iPhone or iPad, an installed PWA, a Windows
WebView2, a Linux WebKitGTK or a macOS WKWebView result.
