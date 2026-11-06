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
| `e2e-shard` (4 shards) | `e2e-build` | Browser suite on Chromium, Firefox and WebKit |
| `pages-config` | Checkout | Expected base path for each host |
| `build (root)` and `build (/deckmark)` | `pages-config` | Production artifacts and bundle budgets |
| `lighthouse` | `build` | Performance and accessibility gate |

`e2e` waits for the verified build and all four shards. `deploy` waits for
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

Stage 3 still owns the shard and worker comparison. The four-shard setting and
the two CI retries are unchanged in stage 2.

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
