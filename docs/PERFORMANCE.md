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
