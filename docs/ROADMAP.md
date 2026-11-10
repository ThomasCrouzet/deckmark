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
- Update the `Checked` line when the register changes.

| Register | Count |
| --- | --- |
| Active implementation issues | 12 |
| Active benchmark tracker | 1 |
| Closed implementation issues | 54 |
| Source audit commit | `0cb455e3` |
| Checked | 2026-11-10 at `e61f5885` |

The roadmap issue #345 and the benchmark tracker #327 are separate records. This
file replaces the roadmap issue body as the maintained register.

## Active register

### Editing and high-density renderers

- [ ] #384 - Use globally bounded shared Markdown parse admission across active slide and thumbnails
- [ ] #415 - Incrementally serialize changed presentation slides and elements instead of cloning and validating entire decks
- [ ] #386 - Share incremental TOC, Find and Outline source, DOM and geometry projections
- [ ] #363 - Prioritize and cancel serialized Mermaid preview and export jobs

### Large libraries, corpus tools, search and metadata

- [ ] #364 - Build an indexed project folder tree and bound the mounted DOM
- [ ] #358 - Key semantic vectors by the actual trained corpus and model revision, and bound query chunk scoring and IndexedDB reads
- [ ] #389 - Reuse validated project media by exact asset content revision and correct project context

### Native I/O and project assets

- [ ] #351 - Use metadata-first native project refresh and scoped IPC instead of large snapshots

### Reported closed in the 2026-11-08 audit, open at delivery

The audit recorded these issues as closed. GitHub reports them open. They stay
active until they close.

- [ ] #374 - Revalidate source revisions after async checkpoints and apply AI patch files atomically
- [ ] #381 - Do not publish executable raw SVG assets after preview-only sanitization
- [ ] #382 - Align Desktop project depth, file-count and size contracts across Web, native and site export
- [ ] #397 - Do not report durable linked-save success when revision metadata cannot persist

### Shared release-like validation

- [ ] #327 - Enforce real Web, native, Node CLI and MCP stress checks with exact bytes and revisions, input-to-paint timing, CPU, heap and RSS limits, documented source and build SHA and negative controls. Never count an unsupported or skipped case as passing.

## Scope separation

Keep these pairs distinct during implementation and review:

- #420 per-file lazy hydration is not #398 workspace batch restore. Both are now closed.
- #421 synchronous MCP server is not #412 async CLI. Both are now closed.
- #378 AI completion limits are not #417 signed updater response. Both are now closed.
- #414 operating-system image drop is not #395 Read-mode image incorporation. Both are now closed.
- #415 source serializer is not #416 thumbnail filmstrip. #416 is closed.

## Remaining order

1. **Healthy render queues:** #384 must throttle the shared Markdown parser across
   all SlideContent instances. #415 reduces deck serialization. #363 is the
   separate global Mermaid queue.
2. **Navigation and project views:** #386 shares heading projections. #364 bounds
   the project tree DOM and index.
3. **Local source and image ownership:** #389 caches project media by true content
   revision. #358 gives semantic vectors a unique trained-model identity. No eager
   whole-corpus read is allowed only to display labels.
4. **Native refresh:** #351 bounds native project IPC volume.
5. **Reopened corrections:** #374 keeps AI patch commits atomic. #397 keeps durable
   save truth. #382 aligns project limits. #381 blocks executable SVG publication.
6. **Evidence:** #327 holds the unified fixture matrix. It must capture
   failing-before and passing-after correctness, memory, p95 and longest-frame
   results and platform provenance. Preserve source, undo and history, cross-tab
   conflict branches, offline and CSP behavior and permission boundaries.

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
- [x] #369 - Transmit metadata Worker deltas and retain per-file bounded baselines
- [x] #370 - Fail closed before exporting ZIP if draft durability is unconfirmed
- [x] #371 - Bind Frontmatter, Comments and History dialogs to immutable document identity
- [x] #372 - Indexed strongly connected components and stack-safe linked-block dependency analysis
- [x] #373 - Evict closed durable document bodies and snapshots with LRU byte budgets
- [x] #375 - Guard timed-out IndexedDB startup and reloads with a generation token
- [x] #376 - Hydrate only approved outbound AI context using immutable revisions
- [x] #377 - Index backup merge and replace matching, and bound comments and row counts
- [x] #380 - One-pass Markdown link rewriting and scoped project rename and move indexes
- [x] #383 - Offload large initial and switch statistics, and bound selectionchange text copying
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

## Audit provenance and interpretation

The source was read at `0cb455e3`. Previous audits used `30a69269`, `4318db42` and
`b8cfbf1d`. This register was checked against the GitHub issue state on
2026-11-10 at `e61f5885`. The check found 21 issues in the audit active list that
were closed, and 4 issues in the audit closed list that were open. This file
records the corrected state.

The platform counts are static audit records. They are not runtime benchmark
results. Each child issue holds the measured evidence for its own platform.
