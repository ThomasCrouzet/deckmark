# Performance and integrity roadmap

This file is the performance and integrity register for DeckMark. It replaces the
append-only checklists in the tracking issues. It has one active register and one
closed register. Each child issue holds the code evidence, the reproduction, the
acceptance criteria and the tests.

## State rule

- An entry is active while GitHub reports the issue open.
- An entry moves to the closed register only after the issue is closed.
- A closed issue is not proof of a measured speedup on every runtime platform.
- A register entry does not override the GitHub state. A reopened issue returns to
  the active register.
- Update the `Checked` line and both counts when the register changes.

| Register | Count |
| --- | --- |
| Active implementation issues | 27 |
| Active benchmark tracker | 0 |
| Closed implementation issues | 65 |
| Source audit commit | `babfff5b` |
| Checked | 2026-11-11 at `babfff5b` |

The roadmap issue #345 and the benchmark tracker #327 are closed. This file keeps
them in the closed register. The GitHub issue state is the source of truth.

## Check procedure

No hidden CI job reads GitHub. A maintainer runs these commands before a register
change. Every listed active issue must report `OPEN`, and each count must match
the number of entries in its register.

```sh
sed -n '/^## Active register/,/^## Scope separation/p' docs/ROADMAP.md \
  | grep -o '#[0-9]\+' | tr -d '#' | sort -un \
  | while read -r issue; do
      state=$(gh issue view "$issue" --repo ThomasCrouzet/deckmark --json state -q .state)
      [ "$state" = "OPEN" ] || echo "active entry is $state: #$issue"
    done

sed -n '/^## Active register/,/^## Scope separation/p' docs/ROADMAP.md | grep -c '^- \[ \] #'
sed -n '/^## Closed register/,/^## Audit provenance/p' docs/ROADMAP.md | grep -c '^- \[x\] #'
```

## Active register

### Native I/O and project assets

- [ ] #351 - Use metadata-first native project refresh and scoped IPC instead of large snapshots
- [ ] #369 - Transmit metadata Worker deltas and retain per-file bounded baselines
- [ ] #383 - Offload large initial and switch statistics, and bound selectionchange text copying

### 2026-11-11 audit cycle

These issues come from the 2026-11-11 audit. The docs-site campaign delivers #557,
#564 and #566 in the `campaign/docs-site` pull request, so they are not separate
register entries.

- [ ] #552 - Investigate the Source typing p95 spike that blocks Desktop validation
- [ ] #553 - Gate large-note multi-paragraph visibility and persistence in WebKit
- [ ] #554 - Index presentation connector endpoints once per slide render
- [ ] #555 - Enforce the folder manifest size limit before reading and parsing
- [ ] #556 - Make service-worker registration retries and update polling idempotent
- [ ] #558 - Account for typed binary payloads and enforce size limits on every mutation
- [ ] #559 - Retain the blob URL until the browser has begun a download in WebKit
- [ ] #560 - Exclude ignored trees before path validation and capacity checks
- [ ] #561 - Prevent file-boundary spoofing in serialized AI context
- [ ] #562 - Preserve text and code MIME metadata across portable ZIP round trips
- [ ] #563 - Reconcile disk deletions during Refresh without discarding local recovery copies
- [ ] #565 - Avoid quadratic scope scans and full-file encoding beyond the token budget
- [ ] #569 - Reproduce and attribute typing stalls caused by large embedded images
- [ ] #570 - Render bounded resolution-adaptive previews instead of full-size bitmaps
- [ ] #571 - Avoid rereading and four-pass hashing cached image assets on editor resolution
- [ ] #572 - Avoid reassembling large embedded image data URIs on every text publish
- [ ] #573 - Bound image resize work and fix offscreen image geometry
- [ ] #574 - Remove synchronous full-document scans from IndexedDB draft projection hooks
- [ ] #575 - Skip redundant image proxy resolution and fence stale NodeView results
- [ ] #576 - Stop transferring unchanged Base64 image payloads on every document-stat update
- [ ] #577 - Preserve scoped image and source restoration on paragraph splits and adjacent edits
- [ ] #578 - Set stable image fetch policies before src to avoid reload and decode churn
- [ ] #579 - Decouple large-document interaction and paint heuristics from embedded image URI length
- [ ] #580 - Do not force full image restoration for unchanged punctuation in edited paragraphs

## Scope separation

Keep these pairs distinct during implementation and review:

- #420 per-file lazy hydration is not #398 workspace batch restore. Both are now closed.
- #421 synchronous MCP server is not #412 async CLI. Both are now closed.
- #378 AI completion limits are not #417 signed updater response. Both are now closed.
- #414 operating-system image drop is not #395 Read-mode image incorporation. Both are now closed.
- #415 source serializer is not #416 thumbnail filmstrip. Both are now closed.

## Remaining order

1. **Native refresh:** #351 bounds native project IPC volume. #369 bounds metadata
   Worker deltas. #563 keeps disk and local recovery state consistent.
2. **Large-document statistics:** #383 keeps switches and long selections off the
   input thread.
3. **Image pipeline:** #569 attributes typing stalls before #570 through #580
   change preview size, source restoration, fetch policy and media caching.
4. **AI context:** #561 blocks file-boundary spoofing. #565 bounds scope scans and
   full-file encoding.
5. **Project storage and import:** #555 and #560 bound import work. #558 enforces
   quota on every mutation. #562 keeps MIME metadata exact. #559 keeps downloads
   reliable in WebKit.
6. **Web platform:** #552 and #553 keep the WebKit performance gate and its
   large-note coverage honest. #556 makes service-worker updates idempotent.
7. **Evidence:** each issue must capture failing-before and passing-after
   correctness, memory, p95 and longest-frame results and platform provenance.
   Preserve source, undo and history, cross-tab conflict branches, offline and CSP
   behavior and permission boundaries.

## Closed register

### Closed before the 2026-11-08 audit

- [x] #346 - Remove full-file image decoration parsing from Source typing
- [x] #347 - Keep blocking native backup, filesystem and Git IO off UI-critical threads
- [x] #348 - Reconcile Read and Split DOM with stable block identity rather than outerHTML
- [x] #349 - Bound literal multi-file Search corpus clones, index and results
- [x] #352 - Skip full long-line scans on local revision echoes
- [x] #353 - Preserve accurate tags, titles and backlinks for deferred closed notes
- [x] #354 - Avoid redundant wiki index rebuilds and O(N^2) per-ID metadata lookup
- [x] #355 - Linear duplicate heading IDs and consistent rendered and exported anchors
- [x] #356 - Metadata-first Library and Linked Blocks panels with bounded hydration
- [x] #359 - Match indexed title and tags to valid YAML frontmatter semantics
- [x] #360 - Metadata-only and atomic SaveQueue with Trash conflict preservation
- [x] #361 - Recover failed and silent Workers with bounded main-thread fallback
- [x] #362 - Lazy version-history body loading and bounded line-diff output
- [x] #365 - Isolate decoded image, ink and export state by active file ID
- [x] #367 - Avoid main-thread PDF Base64 decode and buffer copies
- [x] #368 - Coalesce binary image ink frames and bound undo and export canvas work
- [x] #370 - Fail closed before exporting ZIP if draft durability is unconfirmed
- [x] #371 - Bind Frontmatter, Comments and History dialogs to immutable document identity
- [x] #372 - Indexed strongly connected components and stack-safe linked-block dependency analysis
- [x] #373 - Evict closed durable document bodies and snapshots with LRU byte budgets
- [x] #375 - Guard timed-out IndexedDB startup and reloads with a generation token
- [x] #376 - Hydrate only approved outbound AI context using immutable revisions
- [x] #377 - Index backup merge and replace matching, and bound comments and row counts
- [x] #380 - One-pass Markdown link rewriting and scoped project rename and move indexes
- [x] #387 - Workerize and bound literal Replace All and large before and after preview buffers
- [x] #388 - Metadata-only trash startup and bounded expired-entry cleanup
- [x] #391 - Indexed selection membership and inspector updates on 2,000-object slides
- [x] #393 - Virtualize collapsed closed-file and dense backlink Sidebar rows
- [x] #396 - Index native disk-link open dedup and bound link-health IPC bursts
- [x] #410 - Fix stale whole-row metadata backfill writes and unconditional Trash rewrites
- [x] #411 - Bound Git status and Command Palette DOM and normalize and filter work

### Closed after the 2026-11-08 audit

- [x] #420 - Fence deferred file reads by source revision and latest tab activation intent (2026-11-09)
- [x] #394 - Never skip undecoded images when bounded print workers encounter cached images (2026-11-09)
- [x] #390 - Use transaction-scoped source-fidelity diffs and assemble multi-block patches in one pass (2026-11-10)
- [x] #357 - Move quadratic force layout off the UI thread and support large graph overviews (2026-11-09)
- [x] #392 - Save and reactively list 5,000 snippets without cloning every code body (2026-11-09)
- [x] #385 - Update anchored comment ranges incrementally instead of rescanning each large note (2026-11-10)
- [x] #398 - Restore 300-tab sessions with metadata-first hydration and batched state transitions (2026-11-09)
- [x] #416 - Virtualize 1,000-slide thumbnails and share visibility observation (2026-11-09)
- [x] #366 - Index typed frontmatter incrementally and virtualize collection table and board views (2026-11-10)
- [x] #395 - Enforce image budgets before decoding and batch Markdown replacements (2026-11-10)
- [x] #399 - Share indexed link and anchor projections and avoid whole-source rescans in Docs Check and site export (2026-11-09)
- [x] #412 - Stream corpus searches, bound aggregate memory and enforce deadlines inside CLI scans (2026-11-09)
- [x] #421 - Bound synchronous filesystem walks, wiki diagnostic scans and JSON-RPC request sizes (2026-11-09)
- [x] #400 - Avoid cloning complete parsed JSON back to the UI for optional schema validation (2026-11-09)
- [x] #418 - Keep template selection metadata-first, lazy-load source and bound dialog DOM (2026-11-09)
- [x] #419 - Calculate asset usage without reading every binary blob on Settings open (2026-11-09)
- [x] #379 - Recover two-phase file renames across disk, IndexedDB and baseline failures (2026-11-09)
- [x] #350 - Bound memory and avoid redundant full-corpus work in backup and ZIP export (2026-11-09)
- [x] #417 - Enforce HTTP manifest and signature byte limits while streaming (2026-11-09)
- [x] #378 - Bound untrusted AI response and patch-hunk scan memory before review (2026-11-09)
- [x] #414 - Validate each dropped project image once and discard stale drop jobs safely (2026-11-09)

### Closed after the 2026-11-10 audit

- [x] #345 - Active hardening backlog and completed scope register (2026-11-10)
- [x] #327 - Cross-mode large-file benchmark matrix and release-like regression budgets (2026-11-10)
- [x] #358 - Cache model training, workerize indexing and avoid repeated chunk embeddings (2026-11-10)
- [x] #363 - Avoid serial global rendering stalls and make large diagram previews cancellable (2026-11-10)
- [x] #364 - Build and render deep project trees with indexed folders and bounded DOM (2026-11-10)
- [x] #374 - Revalidate source revisions after async checkpoints and apply all files atomically (2026-11-10)
- [x] #381 - Do not publish executable raw SVG assets after preview-only sanitization (2026-11-10)
- [x] #382 - Align Desktop project depth, file-count and size contracts across Web, native and site export (2026-11-10)
- [x] #384 - Backpressure text-heavy slide renders instead of overflowing the Markdown Worker queue (2026-11-10)
- [x] #386 - Share incremental heading projections and avoid full DOM rescans across TOC and find (2026-11-10)
- [x] #389 - Avoid per-slide full-draft reads and repeated project-image decoding on each render (2026-11-10)
- [x] #397 - Do not report durable linked-save success when revision metadata cannot persist (2026-11-10)
- [x] #415 - Avoid whole-deck clone, validation and serialization for one-element edits (2026-11-10)

## Audit provenance and interpretation

The source was read at `babfff5b`. Previous audits used `0cb455e3`, `30a69269`,
`4318db42` and `b8cfbf1d`. This register was checked against the GitHub issue state
on 2026-11-11 at `babfff5b`.

The 2026-11-10 check found 21 issues in the audit active list that were closed,
and 4 issues in the audit closed list that were open. This check corrects both
lists again. The 11 issues that closed after the previous check moved to the
closed register. #369 and #383 returned to the active register because GitHub
reports them open. #327 and #345 are closed and keep their completed evidence.

The platform counts are static audit records. They are not runtime benchmark
results. Each child issue holds the measured evidence for its own platform.
