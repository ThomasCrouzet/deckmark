# GitHub repository settings checklist

This file records settings that a maintainer must apply manually. Repository automation must not change them.

## General

- Description: `Local-first Markdown workspace for notes and slide decks, in your browser. Offline, no account, no telemetry.` (applied 2026-11-22).
- Website: `https://www.deckmark.dev/`.
- Topics: `client-side`, `editor`, `knowledge-base`, `local-first`, `markdown`, `mcp`, `milkdown`, `note-taking`, `offline`, `presentation`, `pwa`, `slides`, `svelte`, `sveltekit`, `tauri`, `wysiwyg` (applied 2026-11-22).
- Enable Issues. Enable Discussions only if the maintainer wants another support channel.
- Enable Private Vulnerability Reporting and verify the private advisory link in `SECURITY.md`.
- Keep GitHub Pages source set to GitHub Actions.

## Main branch protection

This checklist is the intended policy, not proof of the live settings.

### Review record (2026-11-18)

The legacy branch protection and the active repository ruleset `Require pull
request checks` (ID 25495229) list the same ten required contexts. Every context
maps to a job in this repository:

| Required context | Job |
| --- | --- |
| `check` | `deploy.yml`, `check` |
| `build (false)` | `deploy.yml`, `build` matrix row |
| `build (/deckmark, true)` | `deploy.yml`, `build` matrix row |
| `e2e` | `deploy.yml`, `e2e` |
| `lighthouse` | `deploy.yml`, `lighthouse` |
| `dependency-review` | `security.yml`, `dependency-review` |
| `dependency-audit` | `security.yml`, `dependency-audit` |
| `codeql (javascript-typescript, none)` | `security.yml`, CodeQL matrix row |
| `codeql (rust, none)` | `security.yml`, CodeQL matrix row |
| `secrets` | `gitleaks.yml`, `secrets` |

Both settings set strict branch checking to false. They do not require an
up-to-date branch. The legacy protection requires conversation resolution and
blocks force pushes and branch deletion.

`desktop-validation` (`desktop.yml`) is not a required context in the legacy
protection or in the ruleset. Decision: keep it non-required. Issue #628 does
not change branch protection. Maintainers inspect the Desktop results before a
merge. A separate settings change can require the aggregate after it has a
recorded failure and success history.

The CI scheduling changes do not modify these repository settings. A
documentation-only path must prove that validation is not applicable; a missing,
failed or deferred result must not become a passing gate.

### Intended settings

- Require a pull request before merging.
- Require conversation resolution.
- Block force pushes and branch deletion.
- Require these checks: `check`, `e2e`, `build (false)`,
  `build (/deckmark, true)`, `lighthouse`, `dependency-review`,
  `dependency-audit`, `codeql (javascript-typescript, none)`,
  `codeql (rust, none)`, and `secrets`.
- Do not add `desktop-validation` to the required set in issue #628.
- Review the exact check names after the first workflow run because GitHub displays matrix suffixes.
- Merge Dependabot pull requests manually after required checks pass. The removed token-based workflow bypassed the normal post-merge `push` workflows.

## Release and deployment verification

- Confirm every merged `main` SHA has a successful Pages deployment before announcing it.
- Keep Desktop artifacts in the distinct `desktop-v*` prerelease, not the stable source release.
- Require environment protection for `github-pages` if an approver is available.
