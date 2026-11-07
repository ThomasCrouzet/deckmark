# AGENTS.md - mdsh

## Scope

Keep this Markdown PWA offline, private, and on the client. Do not add a required backend, telemetry, network request, or cloud storage.

## Rules

- Use Svelte 5 runes and strict TypeScript.
- Check browser API availability before access to `localStorage` or IndexedDB.
- Save drafts with Dexie. Keep the 400 ms save delay. Report write failures.
- Use i18n for interface text. Keep English as the default and French as an option.
- Write project documentation, comments, docstrings, and new commit text in English with ASD-STE100 rules and vocabulary.
- Keep translation catalogs and their keys. Preserve licenses, external quotations, and generated files.
- Do not use U+2014 or U+2013 in controlled content. Do not add automated attribution.

## Testing policy

- Never write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism.
- Use E2E tests to verify complex features through observable results.
- At the end of each E2E run, produce a verifiable and repeatable artifact.
- Record the command, source revision, environment, fixtures, and results with the artifact.
- If isolation is necessary, first document all identified failure modes. Then write the tests and implementation.
- Keep an isolated test only for a concrete failure that E2E tests cannot detect.
- Do not add tests for coverage percentages, type contracts, dependency behavior, or mocked call sequences alone.
- Use `docs/TESTING.md` for the retained failure risks, browser commands, and report artifacts.

## Iteration workflow

- Reproduce the failure first. Use the smallest command that shows it.
- Run targeted tests while you edit. Do not run the full matrix for each edit.
- Freeze the change after the targeted tests pass. Do not reformat or refactor after the final local run.
- Mark the pull request ready only when the head commit is final. The ready run executes the full required checks on that exact commit.
- Do not update from `main` only to clear a `BEHIND` state. Rebase only for a real conflict, a required dependency change, or a branch protection rule that requires an up-to-date branch.
- Do not bypass a required check. Do not change a workflow to accept a draft, deferred or missing result.
- Read `docs/CI.md` for the tier protocol and `docs/TESTING.md` for the failure risks.

## Commands

```bash
npm run dev
npm run check
npm run lint
npm run test
npm run build
npm run test:e2e       # For a changed browser workflow.
```

Start with the applicable check. Use the full suite for shared state, storage, export, PWA, or release changes.

## References by task

- Product scope, supported browsers, and limits: `README.md`.
- Contribution and writing rules: `CONTRIBUTING.md`.
- Modules, storage, export, and PWA: `.codex/references/project-map.md`.
- Architecture decisions: `ARCHITECTURE.md`.
- Portable format compatibility and version policy: `docs/FORMAT-COMPATIBILITY.md`.
