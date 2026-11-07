# Continuous integration scheduling

This page records the dependency choices for the Web and Desktop workflows.
The goal is earlier feedback without weaker checks. The final gates still require
every result.

## Triggers and skip rules

`Deploy to GitHub Pages` starts on a push to `main`, on a pull request to
`main`, and by hand. It has no path filter. A ready documentation-only pull
request still runs the browser and Lighthouse gates. Drafts use the fast tier.

`Desktop` starts on the same push and pull request events. The pull request
trigger includes `opened`, `synchronize`, `reopened`, `ready_for_review` and
`converted_to_draft`. It also runs weekly and by hand. Its `changes` job runs
`scripts/desktop-changes.mjs` as the single path filter. The filter requests
native coverage for these paths:

| Path group | Current patterns |
| --- | --- |
| Web source and assets | `src/`, `src-tauri/`, `static/`, `patches/` |
| Build and test scripts | `scripts/` |
| Desktop workflow | `.github/workflows/desktop.yml` |
| Toolchain and build configuration | `.node-version`, `.npmrc`, `package.json`, `package-lock.json`, `rust-toolchain.toml`, `svelte.config.js`, `tsconfig.json`, `vite.config.ts` |

`src/**/*.test.*`, `src/**/*.spec.*` and `src/**/__tests__/` do not request
native coverage. A manual run, a release tag and a push with no previous commit
request the full Desktop matrix. A pull request compares its base and head
commits. A normal push compares the previous and new commits.

A change under `src/` or `static/` needs Desktop coverage because the same
frontend is compiled into the native WebView. A Web-only run cannot detect a
Rust, WebView or packaging regression in that shared frontend. The script and
the workflow conditions are the source of truth. A skipped Desktop matrix is a
path decision, not a passed native test.

`CLI package` uses path filters for CLI sources, shared library modules, bundle
and package scripts, dependency files, and runtime configuration. It also runs
by hand. It validates the installed companion on Linux x64, Windows x64 and
macOS ARM64. The workflow does not publish a release. See
`.github/workflows/cli-package.yml` for the exact filters. A filtered-out run
does not prove that the installed-package tests ran.

## Web workflow

The `Deploy to GitHub Pages` workflow has these independent paths:

| Path | Starts after | Produces |
| --- | --- | --- |
| `typecheck` | Checkout | Svelte and TypeScript checks |
| `lint` | Checkout | ESLint, Prettier, third-party notices |
| `unit` | Checkout | Isolated failure tests and diagnostic coverage |
| `check` | `typecheck`, `lint`, `unit` | Required stable aggregate name |
| `e2e-build` | Checkout | One instrumented Web build with provenance |
| `e2e-shard` (8 shards) | `e2e-build` | Browser suite on Chromium, Firefox and WebKit |
| `pages-config` | Checkout | Expected base path for each host |
| `build (root)` and `build (/deckmark)` | `pages-config` | Production artifacts and bundle budgets |
| `lighthouse` | `build` | Performance and accessibility gate |

`e2e-config` is the single source for the shard count. The shard matrix,
duration planner, list loop and partition check read its outputs.
Each shard compares its local JSON report with its expected shard test list and
prints executed, justified skip and retry counts. `e2e-manifest` lists the full
test set and every shard, then checks that the shard lists partition the full
set. A list report is not accepted as execution proof. `e2e` waits for the
verified build, all shards and the complete test partition. `deploy` waits for
`check`, `build`, `e2e` and `lighthouse`. A failure in any path blocks
publication. The required check names stay the same.

Before this change, the type check, lint, notices and unit tests ran in one
`check` job, every browser shard waited for `check`, and `build` waited for both
`check` and `pages-config`. A lint error delayed the browser suite even though
the suite does not use the lint result. The three fast jobs now run in parallel
and expose their own result. The `check` aggregate keeps the required name and
does not let a failure pass.

## Desktop workflow

| Path | Starts after | Notes |
| --- | --- | --- |
| `changes` | Checkout | Path filter and tier policy |
| `resolve-source` | `changes` | Source SHA and tag identity |
| `validate-desktop` (Linux, Windows, macOS) | `resolve-source` | Rust checks on each OS |
| `native-smoke` (Linux, Windows, macOS) | `resolve-source` | Builds and exercises its own app |
| `native-benchmark` (Linux, Windows, macOS) | `resolve-source` | Builds and measures its own app |
| `web-build` | `resolve-source` | One production Web build with provenance |
| `web-benchmark` (Chromium, Firefox, WebKit) | `resolve-source`, `web-build` | Measures the verified build |
| `desktop-validation` | All of the above | Final aggregate gate |

Before this change, `web-benchmark` and `native-smoke` waited for the complete
`validate-desktop` matrix. `native-benchmark` waited for the complete
`native-smoke` matrix. A slow macOS Rust check could delay a Windows WebView
measurement with no dependency between them.

Each OS now reaches its own build, smoke and benchmark steps without waiting for
another OS. The aggregate `desktop-validation` job still checks that every
matrix result is `success`. Reused validation runs also keep the same job-name
checks.

## Draft and ready tiers

A draft pull request gets a fast correctness path. It does not get the full
native or browser matrix. `scripts/ci-tier.mjs` is the single policy input. It
reads the event identity and prints three workflow outputs:

```sh
node scripts/ci-tier.mjs --event-name "$GITHUB_EVENT_NAME" --event "$GITHUB_EVENT_PATH"
full=false
tier=draft
reason=event:pull_request:synchronize:draft
```

The script accepts these event names: `pull_request`, `push`, `schedule`,
`workflow_dispatch`, `workflow_call` and `release`. Only a `pull_request` event
with `draft: true` selects `full=false`. Every other valid event selects
`full=true`, including `ready_for_review` and a later `synchronize` on a ready
pull request. A `converted_to_draft` event returns to `full=false`.

The script fails closed. It exits 2 and prints no tier when the event name is
missing, the event file is malformed, the `draft` field is absent or not a
boolean, the pull request identity is incomplete, or the action contradicts the
`draft` flag. A failed step fails the `changes` job. The workflow never falls
back to the fast tier.

The script also accepts explicit environment input for a pull request without an
event file: `CI_TIER_ACTION`, `CI_TIER_DRAFT`, `CI_TIER_PR_NUMBER`,
`CI_TIER_HEAD_SHA` and `CI_TIER_BASE_SHA`. A missing value fails closed.

The Web workflow retains types, lint, isolated tests and both production builds
on drafts. It defers the instrumented build, browser matrix, partition check and
Lighthouse. The required `e2e` aggregate fails with an explicit deferred message.
This intentional red prevents a skipped matrix from satisfying merge protection.
Mark the final head ready to replace it with a full execution result. Security
and installed CLI workflows retain their existing checks and triggers.

`Desktop` applies the tier in `changes` and keeps the existing path filter. A
draft run keeps the `changes` job and defers `resolve-source`, `validate-desktop`,
`web-build`, `web-benchmark`, `native-smoke` and `native-benchmark`. The
`desktop-validation` aggregate then exits 1 with an incomplete message. A draft
run is never reported as a pass. The same job reports a path decision when the
path filter does not require Desktop coverage.

`ready_for_review`, and every later `synchronize` on the ready pull request,
starts a new run at the exact head commit. That run uses the full matrix on all
three operating systems, all browsers and all benchmarks. The Desktop aggregate
still requires every requested result. The live branch rules require the Web and
security checks, but do not currently require `desktop-validation`. Maintainers
must also inspect Desktop before accepting a shared frontend or native change.
This scheduling change does not alter branch protection.

A workflow that uses this script must gate each expensive job on `full` and must
fail its required aggregate when the tier is not `full`. Do not use labels,
workflow inputs or missing outputs to select the fast tier.

## Verified build reuse

Stage 2 builds each configuration once.

- `e2e-build` builds the Web app with `VITE_SOURCE_FIDELITY_METRICS=1`. The
  source-fidelity instrumentation is a distinct input, so this artifact is not
  a public production build.
- `web-build` builds the Web app with `BASE_PATH=''` and no instrumentation.
  This is a root production build, not the project-path build for GitHub Pages.
- `scripts/build-provenance.mjs` writes `build/build-provenance.json`. The
  manifest records the source commit, source tree, hashes of the lockfile,
  build scripts, TypeScript and Vite configuration and the two workflows, the
  edition, base path, build mode, instrumentation, builder identity and a hash
  of the exact build tree. The manifest itself is excluded from the tree hash.
- The Playwright preview server runs
  `node scripts/build-provenance.mjs verify --kind e2e --instrumentation source-fidelity`
  before it starts. The benchmark runs the matching `verify` command when it
  receives `--prebuilt`.
- Verification rejects a missing or different manifest, a dirty working tree, a
  different source commit, a changed input file and any changed build byte. The
  artifact upload keeps hidden files, so the downloaded tree matches the hash.

The E2E build and the production benchmark build are separate artifacts. Do not
use one kind for the other. The two public host builds stay independent because
their base paths differ.

Local checks:

```sh
VITE_SOURCE_FIDELITY_METRICS=1 BASE_PATH='' npm run build
node scripts/build-provenance.mjs write --kind e2e --instrumentation source-fidelity
E2E_PREBUILT=1 npx playwright test e2e/wiki-links.spec.ts --project=chromium

BASE_PATH='' npm run build
node scripts/build-provenance.mjs write --kind web-benchmark --instrumentation none
node scripts/benchmark-local.mjs --browser chromium --runs 5 --prebuilt
```

A tampered build must fail the check:

```text
$ node scripts/build-provenance.mjs verify --kind e2e --instrumentation source-fidelity
build-provenance: The build tree does not match the recorded artifact.
```

## Shard and report balance

Stage 3 changes the browser suite from four shards to eight. The measured
four-shard runs on 2026-11-06 had shard durations of about 13, 14, 17 and 25
minutes in one sample. The slowest shard set the critical path, and the other
three runners were idle when it finished. Eight shards halve the tests per
shard and use eight standard runners instead of four.

The worker count stays at `1` in CI. Each shard already has a dedicated runner.
Extra workers would put several browsers and their memory on one runner, and
the suite includes CPU-sensitive timing and drag checks. The stage 3 PR records
the eight-shard critical path next to the four-shard sample. If eight shards do
not reduce the maximum, this setting returns to four.

Retries stay at `2` for temporary runner failures. The manifest check prints the
number of retried results, so a flaky success is visible and is not counted as a
clean first attempt. A missing, duplicated or unexpected test fails the shard
check or `e2e-manifest`; a failed shard still fails `e2e` even when the manifest
contains every test.

Each shard writes its Playwright JSON report to the runner and compares it with
`npx playwright test --list --test-list=<selection> --reporter=json`. The execution
check requires at least one result for each expected test. A skipped test must
declare `expectedStatus: "skipped"` and carry a skip reason. An interrupted or
empty result fails. `e2e-manifest` compares the shard lists with the full
`npx playwright test --list` output and rejects a list report in execution mode.
The comparison covers every project, including Firefox and WebKit, so a shard
cannot silently drop a browser project. The expected and actual E2E reports stay
in the runner temp directory or in the ignored `test-results` directory. This
workflow does not upload those reports. Web benchmark, native smoke, native
benchmark and public-deployment reports also stay on the runner. Hosted-runner
cleanup discards those temporary files; they cannot be downloaded after the VM
is destroyed. Retain reports from local reproductions in ignored local storage.
Reusable build artifacts and release deliverables are separate and still pass
to their required consumers. The check also compares source, tree, projects,
filters, shard and prebuilt identity, so a list and a run are only compared
under the same effective inputs.

Stage 1 and stage 2 own the scheduling and build reuse. Stage 3 does not remove
a check, a browser project, a benchmark or a native platform.

### Duration-balanced partitions

`scripts/e2e-shards.mjs` groups the full current list by browser project and
test file. It assigns the heaviest group to the least-loaded shard until every
group is assigned. The eight runners still use one worker each. New groups use
the documented fallback weight and remain in the full test list.

`scripts/e2e-shard-weights.json` contains scheduling weights from Web run
`42338368121`. These are inputs to scheduling, not test reports or budgets.
The estimate reduces the slowest shard from 712.9 seconds to 457.5 seconds for
that recorded workload. This estimate excludes setup and is not a measured CI
speedup. Refresh weights when the measured distribution changes.

Each runner creates the same deterministic plan from the current source. Its
`--test-list` selection drives both listing and execution. Report metadata
records the partition identity and a digest of that shard's planned test keys.
Execution mode recomputes that digest from both the expected and actual test
sets. Substituting the same wrong selection into both reports fails.
`check-e2e-manifest.mjs plan` rejects missing,
duplicated or different selections and proves full-suite membership. Execution
mode still rejects list-only, incomplete and unjustifiably skipped results.
Stale weights for renamed or deleted files produce a warning, not a CI failure.
The current discovered suite, never the weights file, defines test membership.

## Verification and rollback

The CI tier and partition checks run in `npm test` and `npm run test:coverage`.
Use `npm run test:benchmark-gate` for the targeted CLI checks. Validate workflow
expressions with `actionlint` before publication. Exercise a real draft run,
then its `ready_for_review` transition on the same head before acceptance.

To roll back this scheduling change, revert its commits through a pull request.
Keep the existing required check names and branch protection. Rollback restores
full validation on every pull request and the previous count-based partition.
It does not change performance thresholds, release signing or runner ownership.

## Timing boundaries

The 3 minute fast-feedback target and the 10 minute ordinary pull-request
target are targets. They are not guarantees. Issue #263 defines the 10 minute
target with warm caches and excludes the runner allocation queue. Dependency
setup, cache state, retries, native builds and final publication checks also
change the result.

One measured Web example: run `42289127802` on `main` commit `d64ffee` used
eight E2E shards on 2026-11-06. The shards ran from 6 minutes 02 seconds to
13 minutes 04 seconds. The slowest shard set the critical path. The workflow
ran 15 minutes 55 seconds from start to the final public-origin check. The
first jobs started 3 seconds after the workflow, and deployment plus public
verification took about 2 minutes after the E2E gate.

This is one execution example. It is not a p50 or p95 statistic. Do not use it
as a distribution or as a promise for another runner or cache state.

| Boundary | What it includes |
| --- | --- |
| Runner queue | Wait before a hosted runner starts the job |
| Job setup | Checkout, toolchain, dependency restore and build reuse |
| Test execution | One shard run, including any retry |
| Native jobs | Rust checks, native smoke and native benchmark in `Desktop` |
| Full workflow | Every job from workflow start to the last job end, including deployment and verification jobs in that workflow |
| End to end | The event-to-verified-public-target interval, including runner queues, all required workflows, deployment and public-origin verification |

The shard figures above are whole job durations, including checkout and setup,
not the test step alone. A retry adds to that time and the shard report prints
the retry count. Cache state changes setup time. The native jobs are in the
separate `Desktop` workflow and are not part of the Web E2E figure.

The earlier four-shard sample of about 13 to 25 minutes per shard is historical
data from 2026-11-06. Keep it as the reason for the eight-shard change. Do not
read it as a current result.

## Rules for later stages

- Build reuse must record source, lockfile, toolchain, edition, base path, OS,
  architecture, build profile and instrumentation.
- Test shard and worker changes must compare measured critical paths and keep a
  complete test manifest.
- Benchmark jobs must stay isolated from competing CPU-heavy work.
- The aggregate and release gates must reject failures, cancellations, missing
  results and unjustified skips.
- Both public hosts keep independent deployment verification.

The timing targets and the remaining stages are tracked in issue #263.
