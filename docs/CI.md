# Continuous integration scheduling

This page records the CI protocol for the Web and Desktop workflows. It describes
current behavior and the checks that enforce it. The workflow files, the policy
scripts and the tests are the source of truth. This page does not promise timings.

The goal is earlier feedback without weaker checks. Every required aggregate still
rejects failed, deferred, missing or cancelled validation. A skipped result is
accepted only for a proved not-applicable route or for a main commit whose tree a
green pull request run already validated ([Same-tree proof on main](#same-tree-proof-on-main)).
A failure anywhere stops every run of the same commit
([Fail-fast across workflows](#fail-fast-across-workflows)).

## Triggers and skip rules

`Deploy to GitHub Pages` starts on a push to `main`, on a pull request to `main`,
and by hand. The pull request trigger includes `opened`, `synchronize`, `reopened`,
`ready_for_review` and `converted_to_draft`. It has no path filter, so every pull
request runs the policy job and the fast checks. A documentation-only pull request
is the only class that skips the browser matrix. See
[Documentation-only class](#documentation-only-class).

`Desktop` starts on the same push and pull request events. It also runs weekly and
by hand. Its `changes` job runs `scripts/desktop-changes.mjs` as the single path
filter. The filter requests native coverage for these paths:

| Path group | Current patterns |
| --- | --- |
| Web source and assets | `src/`, `src-tauri/`, `static/`, `patches/` |
| Build and test scripts | `scripts/` |
| Shared CI helpers | `.github/ci/`, `.github/actions/`, `.github/scripts/` |
| Desktop workflow | `.github/workflows/desktop.yml` |
| Toolchain and build configuration | `.node-version`, `.npmrc`, `package.json`, `package-lock.json`, `rust-toolchain.toml`, `svelte.config.js`, `tsconfig.json`, `vite.config.ts` |

`src/**/*.test.*`, `src/**/*.spec.*` and `src/**/__tests__/` do not request
native coverage. A manual run, a release tag and a push with no previous commit
request the full Desktop matrix. A pull request compares its base and head
commits. A normal push compares the previous and new commits.

A change under `src/` or `static/` needs Desktop coverage because the same
frontend is compiled into the native WebView. A Web-only run cannot detect a
Rust, WebView or packaging regression in that shared frontend. A shared CI helper
also counts, because it changes the native environment. The script and the
workflow conditions are the source of truth. A skipped Desktop matrix is a
path decision, not a passed native test.

`pr-body` starts on a pull request to `main` for `opened`, `edited`, `synchronize`,
`reopened` and `ready_for_review`. It checks the release-please override block of the
pull request body. See [Squash merge and release notes](#squash-merge-and-release-notes).
It is separate from the validation workflows, so a body edit starts no other run.

Dependabot version proposals target `deps-staging`, not `main`. The validation
workflows filter `pull_request` on `main`, so a proposal starts only `gitleaks`. See
[Dependabot and the batch flow](#dependabot-and-the-batch-flow).

Every workflow keeps one concurrency group per ref (`pages-`, `desktop-`,
`security-`, `gitleaks-`, `cli-package-`) with `cancel-in-progress` on pull
requests only. A new push to a pull request cancels the runs of the previous head.
A newer main push never cancels a main run that started; GitHub replaces a pending
main run with the newest one, and a proven main run is short.

`CLI package` uses path filters for CLI sources, shared library modules, bundle
and package scripts, dependency files, and runtime configuration. It also runs
by hand. It validates the installed companion on Linux x64, Windows x64 and
macOS ARM64. The workflow does not publish a release. See
`.github/workflows/cli-package.yml` for the exact filters. A filtered-out run
does not prove that the installed-package tests ran.

## Policy job, tier and shard count

`ci-tier` is one job on `ubuntu-24.04` with a 5 minute timeout. It reads the event
identity, reads the changed paths, resolves the pinned Playwright image, defines
the shard count and, on a main push, checks the same-tree proof. It has read
permissions for contents, Actions and pull requests. It publishes these outputs:

| Output | Source |
| --- | --- |
| `full`, `tier` | `scripts/ci-tier.mjs` |
| `class`, `class_reason` | `scripts/ci-changes.mjs` |
| `image`, `playwright` | `scripts/ci-playwright-image.mjs` and `package.json` |
| `shard_count`, `shard_matrix` | One `shards` step: `[1,...,16]` and `16` |
| `reuse`, `proof_run` | `scripts/ci-tree-proof.mjs` on a main push; `false` and empty otherwise |

There is no `e2e-config` job and no second shard definition. `scripts/ci-web-workflow.test.mjs`
fails when a second literal shard list appears or when a heavy job stops reading
the policy outputs. A failed step fails `ci-tier`, so a missing output cannot
select a cheap route.

## Web workflow

| Path | Starts after | Produces |
| --- | --- | --- |
| `ci-tier` | Checkout | Tier, change class, image pin, shard count and same-tree proof |
| `fail-fast` | `ci-tier` (full tier) | Watches every run of the commit and cancels them at the first failed job |
| `typecheck` | `ci-tier` | Svelte and TypeScript checks |
| `lint` | `ci-tier` | ESLint, Prettier, third-party notices |
| `unit` | `ci-tier` | Isolated failure tests and the CI contract tests; no coverage report |
| `check` | `ci-tier`, `typecheck`, `lint`, `unit` | Required stable aggregate name |
| `e2e-build` | `ci-tier` (full class) | One instrumented Web build with provenance |
| `e2e-shard` (16 shards) | `ci-tier`, `e2e-build` | Browser suite on Chromium, Firefox and WebKit |
| `e2e-manifest` | `ci-tier` | Partition proof for the full test list |
| `pages-config` | Checkout | Expected base path for each host |
| `build` (two matrix jobs) | `pages-config` | Production artifacts and bundle budgets |
| `lighthouse` | `ci-tier`, `build` | Performance and accessibility gate |
| `e2e` | `ci-tier`, `e2e-build`, `e2e-shard`, `e2e-manifest` | Required browser aggregate |
| `deploy` and `deploy-cloudflare` | `check`, `build`, `e2e`, `lighthouse` | Publication to both origins |
| `verify-public` | `deploy`, `deploy-cloudflare` | Public checks on both origins |

`pages-config` and both `build` matrix jobs have no job condition. `typecheck`,
`lint` and `unit` skip only on a proven main tree. All of them run on a draft, on a
ready pull request and on the documentation-only class.

`e2e` is the required browser name. It checks the policy job first. A proven main
tree passes only with a numeric `proof_run` and the build, shard and manifest jobs
`skipped`; it prints the proof run URL. Otherwise a draft fails with an explicit
deferred message, and a ready run accepts one of two outcomes:

- `class=full` with a `full:*` or `event:*` reason. The build, every shard and the
  manifest job must be `success`.
- `class=docs` with a `docs-only:*` reason. The build, shard and manifest jobs
  must be `skipped`. A `success`, `failure`, `cancelled` or empty result fails.

A missing, unknown or differently cased class fails. So does a `docs` class with
a non-documentation reason. A skipped matrix therefore never satisfies merge
protection unless the classifier proved that validation is not applicable.

`check` uses the same proof rule: on a proven main tree the three fast jobs must be
`skipped`; otherwise each must be `success`. `lighthouse` runs as a pass-through
job on a proven tree, so the deployment jobs keep their implicit success check.

`deploy` waits for `check`, `build`, `e2e` and `lighthouse`, and runs only on a
push or a manual run on `main`. A failure in any path blocks publication. The
required check names stay the same.

Before the earlier scheduling work in issue #263, type check, lint, notices and unit tests ran in one
`check` job, every browser shard waited for `check`, and `build` waited for both
`check` and `pages-config`. A lint error delayed the browser suite even though
the suite does not use the lint result. The three fast jobs now run in parallel
and expose their own result. The `check` aggregate keeps the required name and
does not let a failure pass.

## Documentation-only class

`scripts/ci-changes.mjs` is the single classifier. It accepts only these paths as
documentation:

- A repository-root file whose name is one of `AGENTS`, `ARCHITECTURE`,
  `CHANGELOG`, `CODE_OF_CONDUCT`, `CONTRIBUTING`, `GOVERNANCE`, `LICENSE`,
  `README`, `SECURITY`, `SUPPORT` or `THIRD_PARTY_NOTICES`, with an optional
  documentation extension. Executable extensions do not select the cheap route.
  The pattern cannot match a path with a slash, so a same-named file
  in another directory keeps full validation.
- A file under `docs/` with one of these extensions: `gif`, `ico`, `jpeg`, `jpg`,
  `markdown`, `md`, `pdf`, `png`, `svg`, `txt`, `webp`.

The classifier rejects an absolute path, a trailing slash, a control character,
a backslash, and an empty, `.` or `..` segment. It also rejects a `docs/` file
with no extension or a trailing dot. A crafted path cannot reach the cheap route.

Only a `pull_request` event can select `docs`. Every other event selects `full`,
with `event:<name>` or `event:<name>:default-full` as the reason. A syntactically
valid unknown event selects full validation. A pull request with no changed path
selects `full:no-paths`. One non-documentation path selects
`full:non-documentation`. A missing or malformed event name exits 2 and prints no
class, so the step fails instead of falling back. Rename detection is disabled for
the path diff, so both the removed source and the added destination are classified.

The class skips only `e2e-build`, `e2e-shard` and `e2e-manifest`. On a ready pull
request, types, lint, the isolated tests, both production builds and Lighthouse
still run. The documentation checker and the changelog parser stay covered because
their tests run in `npm test`. In particular, `CHANGELOG.md` is a test input even
though it is documentation. A checker source change selects the full class.

A draft documentation-only pull request still fails `e2e` with the deferred
message, because the tier check runs before the class check. Mark the pull
request ready to obtain the accepted not-applicable result.

## Pinned browser container

`.github/ci/playwright-image.json` is the single image pin. It records:

| Field | Value |
| --- | --- |
| `playwrightVersion` | `1.65.1` |
| `image` | `mcr.microsoft.com/playwright` |
| `tag` | `v1.65.1-noble` |
| `digest` | `sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579` |
| `platform` | `linux/amd64` |

The digest matches the `v1.65.1-noble` manifest in the Microsoft registry. The
manifest was verified on 2026-11-26. The JSON file is authoritative; this table
describes that pin. Workflows resolve it through the script.

`node scripts/ci-playwright-image.mjs` prints the full reference
`mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507...`. It fails with no
standard output when the manifest, `package.json` or `package-lock.json`
disagree. It checks the exact version format, the tag derived from the version,
the 64 character digest, the image repository, the platform, the declared
`@playwright/test` version, the three Playwright package versions in the lockfile
and the root declaration.

The reference feeds `e2e-shard`, `e2e-manifest` and the `browser` job of
`verify-deployment.yml`. These jobs run with `--user root` so checkout, the
Action cache and provenance share one identity and `HOME`. They do not run APT
and they do not run `playwright install`. The image supplies the browsers and
their system libraries.

The project still pins its own Node version. Web workflow jobs use
`actions/setup-node` with `node-version-file: .node-version`, which contains `22`.
Desktop jobs also read `.node-version`. The image's default Node is not the
project runtime; setup-node selects the declared version before execution. A shard
uses `xvfb-run -a` for the headed browsers that the image provides.

`e2e-shard` and the public verification job verify the environment before any
test runs. They check the Node version against `.node-version`, a writable
`HOME`, a Git safe directory, a present `PLAYWRIGHT_BROWSERS_PATH`, the
`playwright --version` value against the pinned version, and a browser directory
for each required browser. A mismatch stops the job. `e2e-manifest` uses the same
image without that step because it only lists tests.

Visual snapshot comparison stays out of CI by policy. Shard and manifest commands
pass `--ignore-snapshots --grep-invert "Snapshots visuels"`.

The benchmark and native jobs do not use this container. A different image
changes performance measurements, and the native WebView is a separate
environment.

The container replaces the earlier hosted-runner route for the E2E shards. In
that route the browser cache restored, then `playwright install-deps` ran APT and
reported DNS failures. The step reached its existing 20 minute timeout, execution
was skipped, and the manifest check then failed because execution evidence was
absent. That is a historical record of run `43034353505` from 2026-11-11. It is
the reason for the pin, not a claim about current duration.

## Desktop workflow

| Path | Starts after | Notes |
| --- | --- | --- |
| `changes` | Checkout | Path filter, tier, coordinator tests, Cargo audit scope, same-tree proof, source SHA and tag identity |
| `validate-desktop` (Linux, Windows, macOS) | `changes` | Rust format, Clippy, tests, GLib check and, when in scope, cargo audit |
| `web-build` | `changes` | One production Web build with provenance |
| `web-benchmark` (Chromium, Firefox, WebKit) | `web-build` | Measures the verified build |
| `native-smoke` (Linux, Windows, macOS) | `changes` | Builds one debug test app and runs the smoke suite |
| `native-benchmark` (Linux, Windows, macOS) | `changes` | Builds one debug test app and measures the benchmark |
| `desktop-validation` | All of the above | Final aggregate gate |
| `desktop-cache-warm` (3 OS, 2 kinds) | `changes` | Only a proven main merge that changes Rust dependencies: rebuilds the Rust caches; gates nothing |

`native-smoke` and `native-benchmark` each build the isolated debug test
application per operating system. Both record the native source before and after
the build. The smoke job runs the smoke suite on the real WebView. The benchmark
job starts no smoke process, so no smoke process competes with the measurement.
The sample counts, fixtures, budgets and failure propagation are unchanged. The
macOS jobs assert an ARM64 runner. A debug test application never becomes a
public installer.

Issue #628 built the test application once per OS for both smoke and benchmark.
The split reverses that choice on purpose: three more debug builds per run buy a
shorter critical path (the macOS job was build 150 s, smoke 130 s and benchmark
419 s in sequence). Wall time has priority over job-minutes.

The aggregate `desktop-validation` calls `scripts/ci-release-coordinator.mjs gate`
and checks the current run's validation dependencies. Every requested Rust,
native smoke, native benchmark, Web build and browser benchmark matrix result
must be `success`. A path decision is not evidence that native checks ran. On a
main push the gate also accepts one proof route: `REUSE=true`, a numeric
`PROOF_RUN`, a resolved source identity and every validation job `skipped`. The
gate accepts no other run ID as substitute validation. See
[Same-tree proof on main](#same-tree-proof-on-main).

On a pull request, `validate-desktop` runs the three cargo-audit steps only when
`scripts/ci-security-scope.mjs` requests the Rust audit for the changed paths. A
new RUSTSEC advisory then cannot turn a frontend pull request red (and, through
fail-fast, cancel its other runs). Every other event audits. The Security
`dependency-audit` job still audits `Cargo.lock` for Rust inputs and on every push
and schedule.

### Caches

| Cache | Key | Writers |
| --- | --- | --- |
| `node_modules` | `nm-<os>-<.node-version hash>-<package-lock.json hash>` | Every job that installs dependencies; a hit skips `npm ci` |
| Rust checks | `desktop-validate-<os>-<arch>` | `validate-desktop` on main and the weekly run; `desktop-cache-warm` |
| Rust native debug build | `desktop-native-<os>-<arch>` | `native-smoke` on main and the weekly run; `desktop-cache-warm`. `native-benchmark` and `build-desktop` restore only |
| Playwright browser | `pw-<os>-<browser>-<Playwright version>` | `web-benchmark`; a hit skips the browser download, the APT part still runs |

Pull request runs never save a Rust entry, so a pull request cache cannot evict a
main entry. A shared key made the macOS native job restore the Rust check entry
and still compile more than 100 crates. Check the usage with
`gh api repos/ThomasCrouzet/deckmark/actions/cache/usage`.

The release jobs `build-desktop`, `verify-packaging` and `publish-desktop-beta`
do not run for a normal pull request. The first runs for a release tag or a
packaging-only dispatch, the second only for a packaging-only dispatch, and the
third only for a release tag. See
[Release orchestration and installers](#release-orchestration-and-installers).

## Draft and ready tiers

A draft pull request gets a fast correctness path. It does not get the full
native or browser matrix. `scripts/ci-tier.mjs` is the single tier policy. It
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
`draft` flag. A failed step fails the policy job. The workflow never falls back
to the fast tier.

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
draft run keeps the `changes` job and defers the source resolution step,
`validate-desktop`, `web-build`, `web-benchmark`, `native-smoke` and
`native-benchmark`. The `desktop-validation`
aggregate then exits 1 with an incomplete message. A draft run is never reported
as a pass. The same job reports a path decision when the path filter does not
require Desktop coverage.

`ready_for_review`, and every later `synchronize` on the ready pull request,
starts a new run at the exact head commit. That run uses the full matrix on all
three operating systems, all browsers and all benchmarks. The Desktop aggregate
still requires every requested result. The live branch rules require the Web and
security checks, but do not currently require `desktop-validation`. A Desktop
failure still makes the pull request red in practice, because the fail-fast
sentinel cancels the Web run and `e2e` then reports a failure. See
[GITHUB_SETTINGS.md](GITHUB_SETTINGS.md).

A workflow that uses this script must gate each expensive job on `full` and must
fail its required aggregate when the tier is not `full`. Do not use labels,
workflow inputs or missing outputs to select the fast tier.

## Verified build reuse

Each configuration is built once.

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

The browser suite runs in sixteen shards with one worker each. The policy job
defines the count once. Each shard runs on a dedicated runner, so extra workers
would put several browsers and their memory on one machine. The suite includes
CPU-sensitive timing and drag checks.

The suite takes about 141 runner-minutes per run, and three indivisible
representative report tests take 8.3 to 9.0 minutes each. A per-run replay of 8
green CI runs with the measured weights gives a slowest shard test step of 19.0
minutes at 8 shards and 9.8 minutes (median, max 10.6) at 16 shards. If a shard
waits more than one minute for a runner in three consecutive ready runs, reduce
the count to 14 (median 11.2 minutes).

CI retries a failed test once (`retries: 1`). A test that passes only on its retry
has status `flaky`. The shard check prints each one as
`FLAKY <project> <file>:<line> <title>`, adds a table to the job summary, and fails
the shard when the test is not in `e2e/flaky-quarantine.json`. A quarantine entry
names the project, file, line, title, the open issue, the date it was added and an
expiry date at most 14 days later. The list holds at most 10 entries. An expired
entry and a malformed file also fail. The list starts empty and must shrink.

CI also stops a shard at its first hard failure (`maxFailures: 1`). Playwright
counts a test as failed only after its last retry, so a flaky pass does not stop
the shard. The shard check then prints that the run stopped and how many tests did
not run. Set `E2E_MAX_FAILURES=0` for a diagnostic run that executes every test.
A missing, duplicated or unexpected test fails the shard check or
`e2e-manifest`; a failed shard still fails `e2e` even when the manifest contains
every test.

Each shard writes its Playwright JSON report to the runner and compares it with
`npx playwright test --list --test-list=<selection> --reporter=json`. The execution
check requires at least one result for each expected test. A skipped test must
declare `expectedStatus: "skipped"` and carry a skip reason. An interrupted or
empty result fails. `e2e-manifest` compares the shard lists with the full
`npx playwright test --list` output and rejects a list report in execution mode.
The comparison covers every project, including Firefox and WebKit, so a shard
cannot silently drop a browser project.

A failed job uploads its Playwright traces, screenshots and JSON report for 3 days.
A successful job uploads no report. Fixtures are synthetic. In CI the trace mode is
`retain-on-first-failure`, so the trace of a flaky test is its failed first
attempt. The uploads are:

| Job | Artifact | Content |
| --- | --- | --- |
| `e2e-shard` | `e2e-failure-<shard>-attempt-<n>` | `trace.zip`, screenshots, `error-context.md`, `test-results/results.json`, the expected shard list |
| `web-benchmark` | `web-benchmark-failure-<browser>-attempt-<n>` | The benchmark JSON report with the page state of the failure |
| `native-smoke` | `native-smoke-failure-<platform>-attempt-<n>` | `native-test-results/` (page dumps and smoke results, never the application) |
| `native-benchmark` | `native-benchmark-failure-<platform>-attempt-<n>` | The benchmark JSON report and `native-test-results/` |

Open a trace with `npx playwright show-trace <trace.zip>`. Public-deployment
reports stay on the runner. No workflow uploads SARIF, a coverage report or a
build record. Retain reports from local reproductions in ignored local storage.
Reusable build artifacts and release deliverables are separate and still pass to
their required consumers. The check also compares source, tree, projects, filters, shard and
prebuilt identity, so a list and a run are only compared under the same effective
inputs.

This change does not remove a check, a browser project, a benchmark or a native
platform.

### Duration-balanced partitions

`scripts/e2e-shards.mjs` groups the full current list by browser project and
test file. It assigns the heaviest group to the least-loaded shard until every
group is assigned. The sixteen runners still use one worker each. New groups use
the documented fallback weight and remain in the full test list.

`scripts/e2e-shard-weights.json` contains scheduling weights: the medians of the
list reporter durations of 64 green `e2e-shard` job logs (8 runs before
2026-11-27). A group value is the median per run of the summed test durations of
one browser project and file, all attempts included. New groups use a fallback of
5 seconds per test (the median test takes 2.8 seconds). These are inputs to
scheduling, not test reports or budgets. With the earlier weights, 121 of 308
groups had no entry and the planner gave them 60 seconds per test.

Refresh the weights once a month, and after each shard or worker change:

```sh
node scripts/e2e-shard-weights.mjs refresh --runs 8
npx prettier --write scripts/e2e-shard-weights.json
```

The command reads the newest green runs of `deploy.yml` with the GitHub CLI.
`--logs <dir>` reads saved job logs instead (one subdirectory per run).

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

## Deployment

`deploy` publishes the Pages artifact and `deploy-cloudflare` publishes the root
artifact from the same run. They start in parallel after `check`, `build`, `e2e`
and `lighthouse`. Both require `contents: read`; only `deploy` writes Pages and takes
an OIDC token. `deploy-cloudflare` fails when `CLOUDFLARE_API_TOKEN` or
`CLOUDFLARE_ACCOUNT_ID` is empty.

`verify-public` calls `verify-deployment.yml` with the workflow SHA after both
publication jobs finish. It checks both origins in one pinned-container run:
GitHub Pages at `/deckmark` and Cloudflare Pages at the root. A missing, stale or
redirected origin fails the check. A successful upload is not proof that an
origin is current.

The `build` matrix produces the production base path with `upload: true` and the
other supported path with `upload: false`. GitHub derives the job name from the
matrix values. The live run reports `build (false)` and `build (/deckmark, true)`,
and the required checks use those reported names. Do not rename the matrix keys
without a separately reviewed rule change.

## Security workflow

`.github/workflows/security.yml` owns dependency and static analysis. It is
read-only, runs no upload step and keeps CodeQL local with `upload: never`. A
successful analysis step shows that the scan ran; it does not accept a finding
set.

`security-scope` runs `scripts/ci-security-scope.mjs` on the changed paths. Its
scope is explicit:

| Input group | Audits requested |
| --- | --- |
| Rust, GLib patch, `Cargo.toml` or `Cargo.lock`, `build.rs`, `*.rs`, Rust toolchain, cargo SBOM and GLib scripts | Cargo audit, Rust CodeQL scan |
| `package.json`, `package-lock.json`, `.npmrc`, `.node-version`, CLI packaging scripts | npm audit |
| Shared workflow scripts, actions or the security workflow | Both |
| Application, test, documentation, CLI and static paths | Neither |
| Unknown top-level path, malformed path or empty change set | Both |
| Schedule and manual run | Both |

A missing, unreachable or non-ancestor commit range leaves the file list empty,
so the classifier requests both audits. An unknown event exits 2. The required
`dependency-audit` and `codeql (rust, none)` aggregates run with `always()` and
fail when the classifier failed, so a skipped classifier cannot satisfy branch
protection.

The exact audit commands are:

```sh
npm audit --audit-level=high --omit=dev
node scripts/vendor-glib.mjs --check
bash scripts/ci-security-cargo-audit.sh ensure
bash scripts/ci-security-cargo-audit.sh audit src-tauri/Cargo.lock
```

The npm audit covers the production dependency tree. Development-only
transitive packages are out of scope, because the shipped application does not
install them. The audit keeps the high level and fails the required job.

The JavaScript CodeQL job always runs for JavaScript and TypeScript. The Rust
CodeQL job runs only when the scope requests it and uses build mode `none` with
the pinned Rust toolchain and the Linux WebKit packages. Do not add a cargo build
step to that job.

`.github/workflows/gitleaks.yml` is a separate workflow. `scripts/ci-security-gitleaks-range.sh`
scans `before..head` for a normal push only when both commits resolve and are
ordered. A new branch, a force push or a malformed value scans the full history.
A pull request scans its reachable `base..head` range and fails when that range is
unavailable. The weekly schedule and a manual run scan the full history, so the
baseline is never lost.

## Fail-fast across workflows

A failure anywhere stops every run of the same commit. Four layers apply, and each
works without the next:

| Layer | Scope | Mechanism | Latency |
| --- | --- | --- | --- |
| 1 | One shard | Playwright `maxFailures: 1` (counts tests that failed their last retry) | Immediate |
| 2 | One matrix | `strategy.fail-fast: true` on every validation matrix | Seconds |
| 3 | Every run of the head SHA and event | `fail-fast` sentinel job in `deploy.yml` | Up to 15 seconds |
| 4 | Superseded pull request pushes | Concurrency groups with `cancel-in-progress` | At push |

The sentinel runs `scripts/ci-fail-fast.sh` on every full-tier run, on pull
requests and on main. Every 15 seconds it reads all runs of the same head SHA and
event, and their latest jobs. At the first job with conclusion `failure` or
`timed_out`, it prints `::error::fail-fast: <workflow> / <job> (<url>) failed` and
cancels every open run, its own run last. These rules apply:

- `e2e`, `check`, `desktop-validation`, `codeql (rust, none)` and `fail-fast` are not
  a cause. They fail only because a dependency failed or the tier is deferred.
- `pr-body` is not a cause and is never cancelled: it checks the body text.
- A run is never cancelled once a publication job is queued, in progress or
  succeeded: `deploy`, `deploy-cloudflare`, `verify-public`, `release-please`,
  `plan-release`, `build-desktop`, `verify-packaging`, `publish-desktop-beta`,
  `cli-package` and `cli-verify`.
- A run created more than 5 minutes before the sentinel run belongs to an earlier
  event on the same commit, such as a draft run. It is ignored.
- On a re-run attempt, a failure that completed before the attempt started is
  ignored. The re-run is a maintainer decision.
- On a repeated API error the sentinel prints a warning and exits 0. Fail-fast is
  an optimisation; the required aggregates stay the gate.

The sentinel is the only job with `actions: write`. It checks out only its script,
without credentials, and runs no npm package, Node script or third-party action
except checkout. A job that runs project dependencies never holds a token that
can cancel runs. A fork pull request gets a read-only token: the sentinel cannot
cancel there, and layers 1, 2 and 4 still apply. A manual run of `deploy.yml` can
set the `fail_fast` input to `false` to collect every failure. One poll reads one
run list and the jobs of each run, about 6 API requests every 15 seconds.

A cancelled run still runs its `always()` aggregates, which then report failure,
not pending, so a cancelled run never satisfies branch protection. The run
conclusion is `cancelled`; the cause is the one job with conclusion `failure`,
named in the sentinel log. To retry after a flaky failure, re-run the failed jobs
of every run of the commit that shows a failed or cancelled job. Re-run failed
jobs also reruns the cancelled jobs and their dependents.

## Same-tree proof on main

A squash merge of an up-to-date pull request creates a main commit with the tree
of the pull request head. The pull request run already validated that tree.
`scripts/ci-tree-proof.mjs` runs in `ci-tier` and in the Desktop `changes` job on a
main push. It accepts only a green pull request run of the same workflow file on
an identical tree whose base is an ancestor of the merged commit. Every condition
must hold:

1. The event is a push to `refs/heads/main`.
2. The API lists exactly one merged pull request whose merge commit is this
   commit, with base `main` and a head branch in this repository (no fork).
3. `refs/pull/<n>/head` fetches to the head SHA that the API reports.
4. The tree of the merged commit equals the tree of that head.
5. The first parent of the merged commit is an ancestor of that head. The pull
   request was therefore not `BEHIND`, and its run tested the same tree.
6. The newest successful `pull_request` run of the same workflow file for that
   head, from this repository, has every required job (latest attempt) with
   conclusion `success`. `deploy.yml`: `check`, `e2e`, `lighthouse`, `e2e-build`,
   `e2e-manifest`, every `e2e-shard` row and both `build` rows. `desktop.yml`:
   `desktop-validation`, `web-build` and every `validate-desktop`,
   `web-benchmark`, `native-smoke` and `native-benchmark` row.

Any refusal, API error or Git error writes `reuse=false` with a reason, and the run
validates in full. The script never fails the job. The proof uses API facts and Git
objects only, not files that pull request code wrote. Tree equality covers the
workflows, the scripts, the lockfile and the shard weights, so the same workflow
and tests ran.

On a proven tree the Web run skips the fast checks and the browser jobs, keeps both
production builds and the bundle budget, and deploys and verifies both origins.
The Desktop run skips the validation matrix; `release-please`, the release plan and
the installer builds still run, so a proven release merge still publishes the four
installers. Security runs in full on every main push, because audit results depend
on the advisory database at run time. A `BEHIND` merge, a pull request from a fork
and a merge whose pull request run failed all run full validation.

## Release orchestration and installers

The Desktop workflow owns one dependency chain for a main push:

```text
native and Web validation
  -> desktop-validation
  -> release-please
  -> plan-release
  -> build-desktop -> publish-desktop-beta
  -> cli-package -> cli-verify
```

The `release-please` job runs after the current run's Desktop gate. The planner
binds the created tag, source SHA and run SHA before it requests packaging or
publication. There is no runner-held `gh run watch` poll and no privileged
`workflow_run` trigger. The gate accepts only one substitute for this run's
validation: a green pull request run of the same workflow file on an identical
tree whose base is an ancestor of the merged commit
([Same-tree proof on main](#same-tree-proof-on-main)). A nearby successful pull
request on another tree, or another workflow run, is not accepted.

The separate `release-please.yml` has a manual-only source-release management
entry. It does not start on a push. A manual Desktop dispatch can package an
existing `release_tag`, or use `packaging_only` to build and verify without
publication. Run it from the intended source revision. Tag pushes alone do not
start packaging.

`build-desktop` produces four installers from three operating systems:

| Runner | Bundles | Installer |
| --- | --- | --- |
| `macos-15` | `dmg`, target `aarch64-apple-darwin` | macOS ARM64 DMG |
| `windows-2022` | `nsis` | Windows x64 NSIS EXE |
| `ubuntu-24.04` | `deb,appimage` | Linux x64 deb and AppImage |

`scripts/desktop-release-policy.mjs` holds the accepted bundle set.
`scripts/collect-desktop-assets.mjs` reads the same policy and refuses a missing,
extra, misplaced, duplicated or foreign artifact. It also verifies the recorded
source identity before checksums. `sha256sum --check SHA256SUMS` runs from the
release directory. Publication writes to a distinct `desktop-v<version>` release,
marks it as a prerelease, targets the source SHA and refuses a removed `.msi` or
`.rpm` name. `packaging_only` runs the same collection and checksum path without
a tag, release or attestation.

The callable CLI workflow emits three exact-source build archives only when the
release caller requests them. `cli-verify` checks the run, source, version and
target set. They remain run artifacts, not Desktop release assets. The Desktop
channel contains four installers and `SHA256SUMS`. See
[CLI-MCP-INSTALLATION.md](CLI-MCP-INSTALLATION.md#distribution-contract).

If an older release asset has no REST digest, publication refuses to replace it.
Do not bypass that refusal. A manual recovery run must select the source tag ref
as well as pass the same tag in `release_tag`; selecting `main` is not equivalent.

## Squash merge and release notes

The repository and ruleset allow squash merge only. The squash commit title is the
pull request title and the message is the pull request body. release-please 17
reads the `BEGIN_COMMIT_OVERRIDE` block of the merged pull request body instead of
the commit message. The rules and the generator are in
[CONTRIBUTING.md](../CONTRIBUTING.md#pull-request-body-and-release-notes).
`scripts/ci-pr-override.mjs check` enforces them in the `pr-body` workflow.
release-please pull requests (`release-please--*` branches) are skipped.

## Dependabot and the batch flow

Dependabot version proposals target the `deps-staging` branch, with a cooldown
(npm: 7 days, 30 for majors, 3 for patches; GitHub Actions and Cargo: 7 days) and
groups (npm minor and patch, Milkdown, all GitHub Actions, Cargo minor and patch).
No validation workflow runs on them, and nothing merges automatically. A
maintainer folds the proposals into the next batch pull request, keeps the exact
proposed versions, and closes each proposal as superseded after the merge.
Security update pull requests still target `main` and get the full ready pull
request route.

`deps-staging-sync.yml` resets `deps-staging` to `main` every Monday at 03:30 UTC,
before Dependabot runs. After a batch merge, you can reset it at once:

```sh
git push origin origin/main:refs/heads/deps-staging --force-with-lease
```

The batch flow keeps one head in flight, so jobs do not queue:

1. Integrate every fix and the Dependabot proposals locally on one
   `batch/YYYY-MM-DD` branch.
2. Run `npm run check`, `npm run lint`, `npm run notices:check`, one full
   `npm test`, `npm run build`, `npm run size` and the touched E2E specs on
   Chromium and WebKit.
3. Write the pull request body with `node scripts/ci-pr-override.mjs print`, and
   open the pull request as ready when the head is final.
4. On a red run, fix and push once. The sentinel already stopped the other runs.
5. Squash merge only when the pull request is not `BEHIND`, with
   `--match-head-commit`. The main run then reuses the proof.

## Verification and rollback

`npm test` runs Vitest, then `npm run test:ci`, then the desktop backup scheduler
check. `npm run test:ci` runs the Node test files with
`--test-concurrency=1`. It covers the benchmark contracts, build provenance,
E2E manifest, flaky gate, shard plan and weight refresh, the CI tier and Web
workflow guards, the fail-fast sentinel, the same-tree proof, the override block
check, the APT helper,
the Playwright image pin, the Web and Desktop change classifiers, the security
scope, gitleaks range and cargo audit helpers, the CLI package contract, and the
desktop release policy, collector and orchestration. `npm run test:benchmark-gate`
is an alias for the same command.

`npm run test:coverage` keeps the local coverage report for diagnosis. No CI step
reads it and no workflow writes a coverage file. Coverage is not a release gate.

Validate workflow expressions with `actionlint` before publication. Exercise a
real draft run, then its `ready_for_review` transition on the same head, before
acceptance. For a documentation-only change, also confirm that the three browser
jobs are skipped and that `e2e` reports the not-applicable message.

To roll back this scheduling change, revert its commits through a pull request.
Keep the existing required check names and branch protection. A full revert
restores the earlier routing and browser setup. It does not change performance
thresholds, release signing or runner ownership.

## Timing boundaries

Estimate for this design, not a measurement: a ready pull request reports all
checks in about 12 minutes (16 shards, slowest shard test step median 9.8 minutes,
plus about 2.2 minutes of fixed setup), Desktop in about 11 minutes, and a proven
main push reaches `verify-public` in about 5.5 minutes. Before the change, the
ready pull request p50 was 31 minutes. Record three ready runs before and after
a shard or worker change.

The 3 minute fast-feedback target and the 10 minute ordinary pull-request
target are targets. They are not guarantees. Issue #263 defines the 10 minute
target with warm caches and excludes the runner allocation queue. Dependency
setup, cache state, retries, native builds and final publication checks also
change the result.

Two earlier Web samples are historical source examples only:

- Run `42289127802` on `main` commit `d64ffee` used eight E2E shards on
  2026-11-06. The shards ran from 6 minutes 02 seconds to 13 minutes 04 seconds.
  The workflow ran 15 minutes 55 seconds from start to the final public-origin
  check. The first jobs started 3 seconds after the workflow, and deployment plus
  public verification took about 2 minutes after the E2E gate.
- The four-shard sample of the same date took about 13 to 25 minutes per shard.

These are single executions, not p50 or p95 statistics. They are not a
distribution and not a promise for another runner or cache state. The next
subsection records the issue #628 comparison.

| Boundary | What it includes |
| --- | --- |
| Runner queue | Wait before a hosted runner starts the job |
| Job setup | Checkout, toolchain, dependency restore and build reuse |
| Test execution | One shard run, including any retry |
| Native jobs | Rust checks and the native validation job in `Desktop` |
| Full workflow | Every job from workflow start to the last job end, including deployment and verification jobs in that workflow |
| End to end | The event-to-verified-public-target interval, including runner queues, all required workflows, deployment and public-origin verification |

The shard figures above are whole job durations, including checkout and setup,
not the test step alone. A retry adds to that time and the shard report prints
the retry count. Cache state changes setup time. The native jobs are in the
separate `Desktop` workflow and are not part of the Web E2E figure.

### Issue #628 measurement record (2026-11-18)

This record reads the REST job API on 2026-11-18. It uses executed jobs only.
A job-minute is the sum of one job duration; parallel jobs are added, so it
measures total work and not developer waiting time. The Web validation figures
exclude `deploy`, `deploy-cloudflare` and `verify-public`. Elapsed time starts at
the run start and ends at the last executed validation job. The Web pair has no
product source change; one collector test moved from `src/lib` to `scripts`. The
Desktop pair also changes the native bundle configuration, which the measured
jobs do not run. The event type differs in each pair.

Web validation, source `47d9ed9` before and `848b597` after:

| Measure | Before, run `43024132421` | After, run `43091695890` |
| --- | ---: | ---: |
| Executed validation jobs | 21 | 20 |
| Validation job-minutes | 123.38 | 115.12 |
| Validation elapsed seconds | 1124 | 1121 |
| E2E build job seconds | 47 | 33 |
| E2E build dependency setup step seconds | 15, npm ci | 5, cache hit |
| E2E build instrumented build step seconds | 21 | 17 |
| Shard 1 setup before the test step seconds | 71 | 38 |
| Shard 1 test step seconds | 972 | 1010 |
| Shard 1 build artifact download seconds | 1 | 2 |
| Eight shard job-minutes | 115.06 | 108.24 |

`Desktop`, source `47d9ed9` before and `848b597` after:

| Measure | Before, run `43024132569` | After, run `43091695630` |
| --- | ---: | ---: |
| Executed jobs | 16 | 13 |
| Native debug build steps | 6 | 3 |
| Job-minutes | 73.03 | 57.08 |
| Workflow elapsed seconds | 683 | 640 |
| Linux native jobs seconds | 888 | 563 |
| Linux debug build steps seconds | 155 | 57 |
| Linux benchmark step seconds | 451 | 301 |

The before Web shard restored a browser cache and then installed browsers and
system packages with APT. The after shard starts the pinned container and runs
the environment check. The browser download and APT steps no longer exist
(deploy.yml, `e2e-shard`). The 20 minute timeouts belonged to those APT steps
and were removed with them; the shard job keeps its 40 minute limit. No timeout
was extended.

The shard has one dependency path. The `e2e-build` job installs and saves
`node_modules` first; the shards then restore that cache. At `848b597` all eight
shards reported a cache hit and skipped the install step. Run `44177684930` at
`1f44711` started with no saved cache: `e2e-build` ran `npm ci`, and its eight
shards restored the new cache and passed. The workflow file and the image pin
are identical from `848b597` to `1f44711`, so these two runs exercise the two
cache states of the same E2E setup. A cold shard cache is not a separate path.

These are single uncontrolled pairs. They differ in event type, base revision,
runner allocation and test duration. The test step and the benchmark step vary
between the two sides; shard 1 grew by 38 seconds. The values support three
statements only: fewer jobs run, the duplicate native compile is gone, and the
APT failure path is removed. They do not support a global speedup, a percentage,
a p50 or p95 value, or the 10 minute target. Shard count, weights, samples,
fixtures, budgets and failure propagation are unchanged in this pair. Repeated
same-event trials are still necessary before a shard or worker change.

## Rules for later stages

- Keep one shard-count definition and one policy job. A new consumer reads the
  policy output; it does not repeat the constant.
- Build reuse must record source, lockfile, toolchain, edition, base path, OS,
  architecture, build profile and instrumentation.
- Test shard and worker changes must compare measured critical paths and keep a
  complete test manifest.
- Benchmark jobs must stay isolated from competing CPU-heavy work and must not
  run in a different browser image without a new comparability review.
- The container pin changes only with a verified registry digest, a matching
  `package.json` and lockfile, and a passing `npm run test:ci`.
- A documentation-only class must keep an explicit allowlist, run every fast
  check and both builds, and default unknown or sensitive paths to full
  validation.
- The aggregate and release gates must reject failures, cancellations, missing
  results and unjustified skips.
- Both public hosts keep independent deployment verification, even when they
  publish in parallel.
- Upload diagnostics only from a failed job, for 3 days, with synthetic fixtures.
  Do not add a success-path report upload, or a SARIF or build-record upload.
- Keep one job with `actions: write`: the fail-fast sentinel, which runs no
  project dependency.
- A main run may skip validation only through the same-tree proof. Any other
  shortcut on main needs a new review.

Issue #263 records the completed earlier stages and historical timing targets.
The current CI reduction work is tracked in issue #628.
