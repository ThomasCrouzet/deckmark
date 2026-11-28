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
protection or in the ruleset. Since the fail-fast sentinel (2026-11-27), a
Desktop failure cancels the Web run of the same commit and `e2e` reports a
failure, so Desktop blocks a merge in practice. Desktop runs on every pull
request, so the aggregate always reports. Recommendation: add
`desktop-validation` to both lists after one month of recorded history. `pr-body`
is a candidate on the same terms.

The CI changes keep every required context name. Shard count, fail-fast and the
same-tree proof do not rename a job. A documentation-only path must prove that
validation is not applicable; a missing, failed, deferred or cancelled result
must not become a passing gate. After a workflow change, confirm the names with
`gh api repos/ThomasCrouzet/deckmark/commits/<sha>/check-runs --jq '.check_runs[].name' | sort -u`.

### Merge method (2026-11-27)

Squash merge only, in the repository settings and in ruleset 25495229
(`allowed_merge_methods: ["squash"]`). The squash commit title is the pull request
title and the message is the pull request body. release-please reads the
`BEGIN_COMMIT_OVERRIDE` block of that body (see `CONTRIBUTING.md`).

### Intended settings

- Require a pull request before merging.
- Require conversation resolution.
- Block force pushes and branch deletion.
- Require these checks: `check`, `e2e`, `build (false)`,
  `build (/deckmark, true)`, `lighthouse`, `dependency-review`,
  `dependency-audit`, `codeql (javascript-typescript, none)`,
  `codeql (rust, none)`, and `secrets`.
- Add `desktop-validation` to the required set only by a separate settings change, after one month of history.
- Review the exact check names after the first workflow run because GitHub displays matrix suffixes.
- Allow squash merge only. Keep merge commits and rebase merges disabled.
- Keep strict status checks off. The same-tree proof falls back to full validation for a `BEHIND` merge.

## Dependabot

- Keep the `deps-staging` branch. Create it from `main` once; `deps-staging-sync.yml` resets it every Monday. Do not add a ruleset to it.
- Fold Dependabot proposals into a batch pull request. Merge security update pull requests only through the normal checks.
- Keep Dependabot security updates enabled. They target `main` whatever `target-branch` says.
- Set `allow_auto_merge` to false. No workflow enables auto-merge.
- Set the Actions default workflow permissions to read. Each job that needs more declares it.
- Keep "Allow GitHub Actions to create and approve pull requests" enabled. GitHub has one setting for both, and release-please opens the release pull request with `GITHUB_TOKEN`. No workflow approves a pull request.
- Remove the `DEPENDABOT_AUTO_APPROVE` variable if it exists.

## Release and deployment verification

- Confirm every merged `main` SHA has a successful Pages deployment before announcing it.
- Keep Desktop artifacts in the distinct `desktop-v*` prerelease, not the stable source release.
- Require environment protection for `github-pages` if an approver is available.
