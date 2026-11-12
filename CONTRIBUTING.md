# Contributing to DeckMark

DeckMark is a solo-maintained, local-first project with a deliberate scope. Contributions must preserve its offline and privacy boundaries.

**Welcome:**

- Bug fixes (with a clear repro).
- Accessibility improvements (contrast, keyboard, screen readers, `prefers-reduced-motion`).
- Performance gains / bundle reduction (the `size-limit` budget is a hard gate).
- Documentation, typo, and consistency fixes.
- Translations in `src/lib/i18n`, including fixes to the `en` and `fr` dictionaries.
- New locales when the contributor agrees to maintain them.

**Out of scope (unless discussed first):**

- Anything that adds a backend, an account, cloud sync, or telemetry.
- Heavy new features that broaden the tool's reach.

Open an issue before you start a large change or feature.

## Setup

```sh
npm install --legacy-peer-deps   # required (Milkdown peer deps)
npm run dev
```

Use Node 22 or later, as specified by `engines.node` in `package.json`. Web CI
jobs and Desktop jobs read the declared version from `.node-version`.
The project does not test `pnpm` or Yarn.

Desktop development also needs Rust 1.97.1. Linux packaging needs `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, and `patchelf`. `rust-toolchain.toml` specifies the Rust toolchain. Builds require `package-lock.json` and `src-tauri/Cargo.lock`. The project does not claim bit-for-bit reproducible builds.

## Conventions

- **Language**: Write documentation, comments, identifiers, file names, and class names in English. Use short, direct sentences and consistent technical terms. Write Conventional Commit messages in English.
- **UI strings**: Put all user-facing text in `src/lib/i18n`. Add each message key to the `en` and `fr` dictionaries. English is the default. The first launch can detect French, and Settings can change the locale. Do not hard-code UI text.
- **Svelte 5 runes required** (`$state`, `$derived`, `$effect`, `$props`) - no `$:` and no reactive `let`.
- **TypeScript strict**, `checkJs` enabled.
- **Tailwind 4**, dark theme by default, with light and system choices (see `theme.ts` and the `data-theme` attribute). Use theme tokens for colors. Do not use `text-align: justify` (WCAG 1.4.8).
- **Offline-first**: Use system fonts. Do not add an app-initiated network request by default. Remote document images require explicit consent. Import `marked`, `katex`, `highlight.js`, `mermaid`, `jszip`, and `js-yaml` dynamically. Do not import them statically.
- **Browser guards** : any access to `window`/`document`/`localStorage`/`IndexedDB` must be inside `onMount` or guarded by `if (browser)`.
- **A11y** : contrast ≥ 4.5:1 (text) / 3:1 (UI), `aria-label` on icon-only buttons, full keyboard navigation.

Additional conventions (module map, pitfalls, debugging recipes): see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Workflow

1. Fork the repository and create a branch from `main`.
2. Before you push, run `npm run check && npm run lint && npm test && npm run build`.
3. For a visual change, test the golden path, edge cases, focus mode, and mobile layout in a browser.
4. Open a pull request against `main`.

CI runs check, lint, tests, builds, accessibility audits, Lighthouse, dependency
review, and security scans. The security audits are scoped to the changed inputs,
and an unknown path requests both audits. Merge Dependabot pull requests manually
after required checks pass. This action starts the normal post-merge deployment.

`npm install` installs lefthook hooks. `pre-commit` runs Prettier and ESLint on staged files. `pre-push` runs check and tests.

## Draft pull requests and CI tiers

Open a draft pull request for fast feedback. Draft runs defer the Desktop native
matrix and the heavy browser and benchmark gates. A deferred gate is not a pass.

Use this loop for each change:

1. Reproduce the failure with the smallest command.
2. Run only the targeted tests while you edit.
3. Freeze the change when the local targeted tests pass.
4. Mark the pull request ready for review. The ready run uses the full matrix on
   the exact head commit. Keep the head commit fixed while it runs.

Do not update from `main` only to clear a `BEHIND` state. Rebase only for a real
conflict or a required dependency change. When branch protection requires an
up-to-date branch, update once after the change is final.

Do not bypass a required check. Do not edit a workflow to accept a draft result
or a deferred job. A green draft check does not prove the full matrix.

A pull request that changes only documentation gets one accepted not-applicable
result. The classifier accepts a root documentation file, such as `README.md` or
`CONTRIBUTING.md`, and a `docs/` file with a documentation extension, such as
`.md`, `.txt`, `.png` or `.webp`. Any other path selects full validation. On a
ready pull request, types, lint, the isolated tests, both production builds and
Lighthouse still run. Only the browser build, the browser shards and the partition
check are skipped. A draft documentation-only pull request still fails `e2e` until
it is ready, and a skipped browser job never passes as a success.

## Test policy

Prefer E2E tests for complex features. Never write unit tests after implementation.
If a system needs isolated tests, first record its failure risks. Keep each isolated
test only when it detects a concrete failure absent from the E2E suite. Coverage
percentages are diagnostic, not a release gate.

`npm test` runs Vitest, then `npm run test:ci`, then the desktop backup scheduler
check. `npm run test:ci` runs the Node tests for the benchmark gates, build
provenance, E2E partition, CI tier and routing class, image pin, security scope
and Desktop release policy. Run it alone when you change a workflow, a CI script
or a release script. `npm run test:coverage` keeps the local coverage report for
diagnosis; CI writes no coverage file.

Each standard browser run writes an HTML report, a JSON result file, and run
metadata. Keep the command, source revision, environment, fixtures, and results
with the artifact. CI evidence stays on the runner and is not uploaded to GitHub.
See [docs/TESTING.md](docs/TESTING.md) for commands and artifact paths.

## Visual tests (snapshots)

The Playwright snapshots (`e2e/visual.spec.ts`) are **local-only by design** - not a CI gate (`--ignore-snapshots --grep-invert "Snapshots visuels"` in `deploy.yml`). Font rendering differs between a container, a hosted runner and a desktop, so a mismatched baseline can fail an unrelated pull request. Linux and macOS baselines remain versioned for local comparison only.

To compare locally against your platform's own baseline :

```sh
npm run test:e2e -- visual.spec.ts
```

To regenerate the **Linux** baseline (for local reference, not currently CI-enforced), use the same pinned image as CI. Do not copy a digest into this file:

```sh
image="$(node scripts/ci-playwright-image.mjs)"
docker run --rm -v "$(pwd)":/work -w /work --ipc=host "$image" \
  bash -c "npm ci --legacy-peer-deps && npm run build && npx playwright test visual.spec.ts --project=chromium --update-snapshots"
```

`node scripts/ci-playwright-image.mjs` reads `.github/ci/playwright-image.json` and prints the full image reference. It fails when that manifest, `package.json` or `package-lock.json` disagree. The current pin is Playwright 1.65.0, tag `v1.65.0-noble`, platform `linux/amd64`. CI uses the same reference for the browser shards, the partition check and the public-origin check. A Playwright update must change the manifest, the dependency and the lockfile together.

To regenerate the **macOS** baselines:

```sh
npm run test:e2e -- visual.spec.ts --update-snapshots
```

Do not commit snapshots from a platform other than the two already versioned (Linux CI baseline, macOS local baseline) without agreement.

## Portable formats

Read [portable format compatibility](docs/FORMAT-COMPATIBILITY.md) before you
change a presentation, backup or project manifest format. Add a fixture and the
expected result before a format version bump. Do not describe a hand-authored
fixture as a released artifact.

## Issues

[Bugs / features](https://github.com/ThomasCrouzet/deckmark/issues). For a large PR, open an issue before coding.

## License

MIT - by contributing, you agree that your code is published under this license.
