# Continuous integration scheduling

This page records the CI protocol for the Web and Desktop workflows. It describes
current behavior and the checks that enforce it. The workflow files, the policy
scripts and the tests are the source of truth. This page does not promise timings.

The goal is earlier feedback without weaker checks. Every required aggregate still
rejects failed, deferred, missing or cancelled validation. A skipped result is
accepted only for a proved not-applicable route.

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

`CLI package` uses path filters for CLI sources, shared library modules, bundle
and package scripts, dependency files, and runtime configuration. It also runs
by hand. It validates the installed companion on Linux x64, Windows x64 and
macOS ARM64. The workflow does not publish a release. See
`.github/workflows/cli-package.yml` for the exact filters. A filtered-out run
does not prove that the installed-package tests ran.

## Policy job, tier and shard count

`ci-tier` is one job on `ubuntu-24.04` with a 5 minute timeout. It reads the event
identity, reads the changed paths, resolves the pinned Playwright image and
defines the shard count. It publishes these outputs:

| Output | Source |
| --- | --- |
| `full`, `tier` | `scripts/ci-tier.mjs` |
| `class`, `class_reason` | `scripts/ci-changes.mjs` |
| `image`, `playwright` | `scripts/ci-playwright-image.mjs` and `package.json` |
| `shard_count`, `shard_matrix` | One `shards` step: `[1,2,3,4,5,6,7,8]` and `8` |

There is no `e2e-config` job and no second shard definition. `scripts/ci-web-workflow.test.mjs`
fails when a second literal shard list appears or when a heavy job stops reading
the policy outputs. A failed step fails `ci-tier`, so a missing output cannot
select a cheap route.

## Web workflow

| Path | Starts after | Produces |
| --- | --- | --- |
| `ci-tier` | Checkout | Tier, change class, image pin and shard count |
| `typecheck` | Checkout | Svelte and TypeScript checks |
| `lint` | Checkout | ESLint, Prettier, third-party notices |
| `unit` | Checkout | Isolated failure tests and the CI contract tests; no coverage report |
| `check` | `typecheck`, `lint`, `unit` | Required stable aggregate name |
| `e2e-build` | `ci-tier` (full class) | One instrumented Web build with provenance |
| `e2e-shard` (8 shards) | `ci-tier`, `e2e-build` | Browser suite on Chromium, Firefox and WebKit |
| `e2e-manifest` | `ci-tier` | Partition proof for the full test list |
| `pages-config` | Checkout | Expected base path for each host |
| `build` (two matrix jobs) | `pages-config` | Production artifacts and bundle budgets |
| `lighthouse` | `ci-tier`, `build` | Performance and accessibility gate |
| `e2e` | `ci-tier`, `e2e-build`, `e2e-shard`, `e2e-manifest` | Required browser aggregate |
| `deploy` and `deploy-cloudflare` | `build`, `e2e`, `lighthouse` (`deploy` also needs `check`) | Publication to both origins |
| `verify-public` | `deploy`, `deploy-cloudflare` | Public checks on both origins |

`typecheck`, `lint`, `unit`, `pages-config` and both `build` matrix jobs have no
job condition. They run on a draft, on a ready pull request and on the
documentation-only class.

`e2e` is the required browser name. It checks the tier first. A draft fails with
an explicit deferred message. A ready run then accepts one of two outcomes:

- `class=full` with a `full:*` or `event:*` reason. The build, every shard and the
  manifest job must be `success`.
- `class=docs` with a `docs-only:*` reason. The build, shard and manifest jobs
  must be `skipped`. A `success`, `failure`, `cancelled` or empty result fails.

A missing, unknown or differently cased class fails. So does a `docs` class with
a non-documentation reason. A skipped matrix therefore never satisfies merge
protection unless the classifier proved that validation is not applicable.

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
| `playwrightVersion` | `1.65.0` |
| `image` | `mcr.microsoft.com/playwright` |
| `tag` | `v1.65.0-noble` |
| `digest` | `sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d` |
| `platform` | `linux/amd64` |

The digest matches the `v1.65.0-noble` manifest in the Microsoft registry. The
manifest was verified on 2026-11-11. The JSON file is authoritative; this table
describes that pin. Workflows resolve it through the script.

`node scripts/ci-playwright-image.mjs` prints the full reference
`mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3f...`. It fails with no
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
| `changes` | Checkout | Path filter and tier policy |
| `resolve-source` | `changes` | Source SHA and tag identity, reused validation identity |
| `validate-desktop` (Linux, Windows, macOS) | `resolve-source` | Rust format, Clippy, tests, GLib check and cargo audit |
| `web-build` | `changes`, `resolve-source` | One production Web build with provenance |
| `web-benchmark` (Chromium, Firefox, WebKit) | `web-build` | Measures the verified build |
| `native-validation` (Linux, Windows, macOS) | `resolve-source` | Builds one test app, runs smoke, then measures |
| `desktop-validation` | All of the above | Final aggregate gate |

`native-validation` builds the isolated debug test application once per operating
system. It records the native source before and after the build, runs the smoke
suite on the real WebView, and then measures the benchmark after every smoke
process stops. The sample counts, fixtures, budgets and failure propagation are
unchanged. The macOS job asserts an ARM64 runner. A debug test application never
becomes a public installer.

The earlier scheduling work in issue #263 removed cross-platform waits. This
change removes the remaining duplicate debug application build for smoke and
benchmark on each OS. Each OS builds once and each Web benchmark waits only for
its own build. A slow macOS Rust check cannot delay a Windows WebView measurement.

The aggregate `desktop-validation` calls `scripts/ci-release-coordinator.mjs gate`
and checks the current run's validation dependencies. Every requested Rust,
native, Web build and browser benchmark matrix result must be `success`. A path
decision is not evidence that native checks ran. Release planning uses this same
run and does not accept a different run ID as substitute validation.

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
draft run keeps the `changes` job and defers `resolve-source`, `validate-desktop`,
`web-build`, `web-benchmark` and `native-validation`. The `desktop-validation`
aggregate then exits 1 with an incomplete message. A draft run is never reported
as a pass. The same job reports a path decision when the path filter does not
require Desktop coverage.

`ready_for_review`, and every later `synchronize` on the ready pull request,
starts a new run at the exact head commit. That run uses the full matrix on all
three operating systems, all browsers and all benchmarks. The Desktop aggregate
still requires every requested result. The live branch rules require the Web and
security checks, but do not currently require `desktop-validation`. Maintainers
must also inspect Desktop before accepting a shared frontend or native change.
This scheduling change does not alter branch protection. See
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

The browser suite runs in eight shards with one worker each. The policy job
defines the count once. Each shard runs on a dedicated runner, so extra workers
would put several browsers and their memory on one machine. The suite includes
CPU-sensitive timing and drag checks.

The historical reason for eight shards is the measured four-shard sample of
2026-11-06. Shard durations were about 13, 14, 17 and 25 minutes. The slowest
shard set the critical path while three runners were idle. That sample is a
historical source example, not a current result.

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
workflow does not upload those reports. Web benchmark, native validation and
public-deployment reports also stay on the runner. Hosted-runner cleanup discards
those temporary files; they cannot be downloaded after the VM is destroyed.
Retain reports from local reproductions in ignored local storage. Reusable build
artifacts and release deliverables are separate and still pass to their required
consumers. The check also compares source, tree, projects, filters, shard and
prebuilt identity, so a list and a run are only compared under the same effective
inputs.

This change does not remove a check, a browser project, a benchmark or a native
platform.

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

## Deployment

`deploy` publishes the Pages artifact and `deploy-cloudflare` publishes the root
artifact from the same run. They start in parallel after `build`, `e2e` and
`lighthouse`. Both require `contents: read`; only `deploy` writes Pages and takes
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
npm audit --audit-level=high
node scripts/vendor-glib.mjs --check
bash scripts/ci-security-cargo-audit.sh ensure
bash scripts/ci-security-cargo-audit.sh audit src-tauri/Cargo.lock
```

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
`workflow_run` trigger. A nearby successful PR or another workflow run is not
accepted as a replacement for this run's validation.

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

## Verification and rollback

`npm test` runs Vitest, then `npm run test:ci`, then the desktop backup scheduler
check. `npm run test:ci` runs the Node test files with
`--test-concurrency=1`. It covers the benchmark contracts, build provenance,
E2E manifest and shard plan, the CI tier and Web workflow guards, the APT helper,
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
distribution and not a promise for another runner or cache state. Issue #628
records the current measurements; use that evidence for a current comparison.

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
- Keep diagnostic reports and raw evidence in local storage. Do not add report,
  SARIF or build-record uploads to GitHub.

Issue #263 records the completed earlier stages and historical timing targets.
The current CI reduction work is tracked in issue #628.
