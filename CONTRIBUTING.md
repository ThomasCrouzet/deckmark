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

Use Node 22 or later, as specified by `engines.node` in `package.json`. CI uses Node 22. The project does not test `pnpm` or Yarn.

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

CI runs check, lint, tests, builds, accessibility audits, dependency review, security scans, and Lighthouse. Merge Dependabot pull requests manually after required checks pass. This action starts the normal post-merge deployment.

`npm install` installs lefthook hooks. `pre-commit` runs Prettier and ESLint on staged files. `pre-push` runs check and tests.

## Test policy

Prefer E2E tests for complex features. Never write unit tests after implementation.
If a system needs isolated tests, first record its failure risks. Keep each isolated
test only when it detects a concrete failure absent from the E2E suite. Coverage
percentages are diagnostic, not a release gate.

Each browser run writes an HTML report and a JSON result file. Keep test reports in local storage.
CI does not upload test reports to GitHub. See [docs/TESTING.md](docs/TESTING.md) for commands and artifact paths.

## Visual tests (snapshots)

The Playwright snapshots (`e2e/visual.spec.ts`) are **local-only by design** - not a CI gate (`--ignore-snapshots --grep-invert "Snapshots visuels"` in `deploy.yml`). A Linux baseline generated via the official Playwright Docker image diverges enough from the fixed GitHub runner's font rendering to fail unrelated PRs. Linux and macOS baselines remain versioned for local comparison only.

To compare locally against your platform's own baseline :

```sh
npm run test:e2e -- visual.spec.ts
```

To regenerate the **Linux** baseline (for local reference, not currently CI-enforced) :

```sh
docker run --rm -v "$(pwd)":/work -w /work --ipc=host \
  mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e \
  bash -c "npm ci --legacy-peer-deps && npm run build && npx playwright test visual.spec.ts --project=chromium --update-snapshots"
```

The digest above is the multi-platform manifest for `v1.62.1-noble`, matching the exact `@playwright/test` version in `package.json`. To regenerate the **macOS** baselines:

```sh
npm run test:e2e -- visual.spec.ts --update-snapshots
```

Do not commit snapshots from a platform other than the two already versioned (Linux CI baseline, macOS local baseline) without agreement.

## Issues

[Bugs / features](https://github.com/ThomasCrouzet/deckmark/issues). For a large PR, open an issue before coding.

## License

MIT - by contributing, you agree that your code is published under this license.
