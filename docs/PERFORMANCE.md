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

The browser benchmark collects 3 samples for reload and presentation load, and 5
samples for the other scenarios. A report from fewer runs is not valid evidence.

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

Firefox stayed inside its earlier budget. These changes move a provisional
development baseline to the actual runner. They do not remove the gate. A later
run that exceeds the reviewed limit by more than 25 percent still fails.
