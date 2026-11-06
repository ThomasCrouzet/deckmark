# Continuous integration scheduling

This page records the dependency choices for the Web and Desktop workflows.
The goal is earlier feedback without weaker checks. The final gates still require
every result.

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

`e2e-report` merges the shard reports and checks the union against the expected
test list. `e2e` waits for the verified build, all eight shards and the merged
report. `deploy` waits for `check`, `build`, `e2e` and `lighthouse`. A failure
in any path blocks publication. The required check names stay the same.

Before this change, the type check, lint, notices and unit tests ran in one
`check` job, every browser shard waited for `check`, and `build` waited for both
`check` and `pages-config`. A lint error delayed the browser suite even though
the suite does not use the lint result. The three fast jobs now run in parallel
and expose their own result. The `check` aggregate keeps the required name and
does not let a failure pass.

## Desktop workflow

| Path | Starts after | Notes |
| --- | --- | --- |
| `changes` | Checkout | Path filter |
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
four-shard runs on 2026-11-06 had shard durations of about 11, 16, 14 and 26
minutes. The slowest shard set the critical path, and the other three runners
were idle when it finished. Eight shards halve the tests per shard and use
eight standard runners instead of four.

The worker count stays at `1` in CI. Each shard already has a dedicated runner.
Extra workers would put several browsers and their memory on one runner, and
the suite includes CPU-sensitive timing and drag checks. The stage 3 PR records
the eight-shard critical path next to the four-shard sample above. If eight
shards do not reduce the maximum, this setting returns to four.

Retries stay at `2` for temporary runner failures. The merged report prints the
number of retried results, so a flaky success is visible and is not counted as a
clean first attempt. A missing, duplicated or unexpected test fails
`e2e-report`; a failed shard still fails `e2e` even when the merged report
contains every test.

The shards upload Playwright blob reports. `e2e-report` merges them with
`npx playwright merge-reports --reporter=json`, compares the result with
`npx playwright test --list --reporter=json`, and keeps both reports as the
`e2e-merged-report` artifact. The comparison covers every project, including
Firefox and WebKit, so a shard cannot silently drop a browser project.

Stage 1 and stage 2 own the scheduling and build reuse. Stage 3 does not remove
a check, a browser project, a benchmark or a native platform.

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
