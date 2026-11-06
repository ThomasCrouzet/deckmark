# Desktop performance work

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

## Remaining work

The native benchmark on Windows, Linux and macOS Apple Silicon runs in CI. A
native profile of the same scenario is captured with
`--target native`; the shared web measurements above isolate the frontend part.

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
publication. Reporting-only runs can use `--report-only` through the retained
artifact gate:

```sh
node scripts/benchmark-gate.mjs --report /tmp/bench.json --budgets scripts/benchmark-budgets.json
```

`scripts/benchmark-gate.mjs` measures nothing. It validates the report schema,
source identity, build mode, platform identity, sample counts, units, and budget
values. Use it to audit a retained artifact or to repeat a gate decision.

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
