# GitHub repository settings checklist

This file records settings that a maintainer must apply manually. Repository automation must not change them.

## General

- Description: `Local-first offline Markdown workspace for web and Desktop Beta with visual editing, reading, and slides`.
- Website: `https://thomascrouzet.github.io/deckmark/`.
- Topics: `markdown-editor`, `wysiwyg`, `local-first`, `offline-first`, `privacy`, `pwa`, `svelte`, `sveltekit`, `tauri`, `typescript`.
- Enable Issues. Enable Discussions only if the maintainer wants another support channel.
- Enable Private Vulnerability Reporting and verify the private advisory link in `SECURITY.md`.
- Keep GitHub Pages source set to GitHub Actions.

## Main branch protection

- Require a pull request before merging.
- Require the branch to be up to date before merging.
- Require conversation resolution.
- Block force pushes and branch deletion.
- Require these checks: `check`, `e2e`, `build (false)`, `build (/deckmark, true)`, `lighthouse`, `desktop-validation`, `dependency-review`, `dependency-audit`, `codeql (javascript-typescript, none)`, `codeql (rust, none)`, and `secrets`.
- Review the exact check names after the first workflow run because GitHub displays matrix suffixes.
- Merge Dependabot pull requests manually after required checks pass. The removed token-based workflow bypassed the normal post-merge `push` workflows.

## Release and deployment verification

- Confirm every merged `main` SHA has a successful Pages deployment before announcing it.
- Keep Desktop artifacts in the distinct `desktop-v*` prerelease, not the stable source release.
- Require environment protection for `github-pages` if an approver is available.
