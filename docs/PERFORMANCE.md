# Desktop performance work

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
Native stress transport is still not implemented.

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

WYSIWYG, annotation, slide canvas, Advanced Presentation Source and native mode
transport remain unavailable. Do not treat the mode suite as evidence for those
workloads.

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

Parent review must still approve the limits, full native adapters, the remaining
modes and CI workload selection before #327 can close. Read, slide text and slide
notes now have the mode suite above. WYSIWYG, annotation, slide canvas and
Advanced Presentation Source have no stress adapter. Native mode transport is
also absent. This delivery does not change release workflows or claim full
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
tree render, presentation load and visual typing, 3 samples for the library
reload, and up to 5 samples for the remaining scenarios. Heap collects four
samples. The five startup metrics on each web platform set `minimumRuns` to 20,
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
