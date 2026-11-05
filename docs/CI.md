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
| `e2e-shard` (4 shards) | Checkout | Browser suite on Chromium, Firefox and WebKit |
| `pages-config` | Checkout | Expected base path for each host |
| `build (root)` and `build (/deckmark)` | `pages-config` | Production artifacts and bundle budgets |
| `lighthouse` | `build` | Performance and accessibility gate |

`e2e` waits for all four shards. `deploy` waits for `check`, `build`, `e2e`
and `lighthouse`. A failure in any path blocks publication. The required check
names stay the same.

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
| `web-benchmark` (Chromium, Firefox, WebKit) | `resolve-source` | Builds the production Web app |
| `desktop-validation` | All of the above | Final aggregate gate |

Before this change, `web-benchmark` and `native-smoke` waited for the complete
`validate-desktop` matrix. `native-benchmark` waited for the complete
`native-smoke` matrix. A slow macOS Rust check could delay a Windows WebView
measurement with no dependency between them.

Each OS now reaches its own build, smoke and benchmark steps without waiting for
another OS. The aggregate `desktop-validation` job still checks that every
matrix result is `success`. Reused validation runs also keep the same job-name
checks.

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
