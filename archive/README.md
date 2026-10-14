# Retired documents

This index identifies historical material. Use [the documentation index](../docs/README.md) for current procedures.
Git preserves the original text. Relative links inside an original document refer to its earlier location.
The October 14 cleanup removed the local copies after verification of an external recovery archive.
Local recovery root: `/Volumes/backups/annex-cleanup-20261014/projects-h-o/files/Projects/markdown-tool/archive/`.

| Original path | Recoverable copy | SHA-256 |
| --- | --- | --- |
| `docs/PRODUCT_REVIEW.md` | [Product review](https://github.com/ThomasCrouzet/mdsh/blob/372d83349886d8c58d4da2462996ca4d6ea7acbb/archive/2026-09-25/PRODUCT_REVIEW.md) | `836c5cf05ebdf7b8f994263af5e128c5b8b45f27e74e3c26264f8ef5b917ee44` |
| `docs/announcement-draft.md` | [Announcement draft](https://github.com/ThomasCrouzet/mdsh/blob/372d83349886d8c58d4da2462996ca4d6ea7acbb/archive/2026-09-25/announcement-draft.md) | `a07cff62a2c0b436907f6347db1fb0efe8514b861e77aec93a2219e391021cbd` |

The product review describes version 1.6.0. Its delivered changes are documented in the user guide, architecture, and changelog.
Remaining proposals are in [ROADMAP.md](../ROADMAP.md).
The current announcement source is [docs/outreach/announcement.md](../docs/outreach/announcement.md).

Verify the originals with:

```sh
git show 372d83349886d8c58d4da2462996ca4d6ea7acbb:archive/2026-09-25/PRODUCT_REVIEW.md | shasum -a 256
git show 372d83349886d8c58d4da2462996ca4d6ea7acbb:archive/2026-09-25/announcement-draft.md | shasum -a 256
```

## Documents removed on 2026-09-26

Git retains these originals at revision `ef03dfe7bdab0cf807e8794cd5632a963638f6c1`.
The issue drafts duplicated maintenance work and used obsolete test or visual
rules. Remaining proposals are in [ROADMAP.md](../ROADMAP.md). Screenshot
instructions and the asset list are in [BRANDING.md](../docs/BRANDING.md).
The five improvement priorities are now repeatable workflows in
[Testing](../docs/TESTING.md#durability-and-resource-pressure-evidence). Each run
retains its own results; this manifest is not a test report.

| Original path | SHA-256 |
| --- | --- |
| `.github/ISSUE_DRAFTS/01-keyboard-audit.md` | `7fd7ade23b8f77c89f7652c410e220e721c2e9382df8cd4c1a4e6a7066235016` |
| `.github/ISSUE_DRAFTS/02-empty-export-names.md` | `1aeea03d45441bc9d4aa47d5a25677c9ec106b759f949f33dd8d01c10d89c071` |
| `.github/ISSUE_DRAFTS/03-storage-health-copy.md` | `4c6bdeffb06ca505f66e97c7930554e596f12434460da7e8539e686f1324c00e` |
| `.github/ISSUE_DRAFTS/04-focus-visible-review.md` | `92e35b7563bda74c66113fd48de3baa2478d5240b24461c59055b5da43980dcb` |
| `.github/ISSUE_DRAFTS/05-backup-fixture-docs.md` | `5d695c2a87c647537e3c39a41a10012f0702218ab9dba53e828c583952fd7c14` |
| `.github/ISSUE_DRAFTS/06-offline-export-smoke.md` | `ac9f78845eafdfdf6a84cf30ddf52b0f2e26aae72458ccc9f07f42fd438f0eed` |
| `docs/screenshots/README.md` | `43f6c15ce46803d73c47a324ccafff71ec6378ed88e05f8ea7a29cbb33f5033d` |
| `IMPROVEMENTS.md` | `4582ac75f55ae2b5bad7e2ff22b0d4d542e4a41b8eaeb64ced4e492cab64130b` |

Read an original with `git show <revision>:<original-path>`. Pipe that command to
`shasum -a 256` to check its identity. The paths and full revision above also work
with the repository's GitHub file history.

## Version 2.0 implementation plan

The roadmap now lists product scope and remaining proposals.
Issue 134 and the release workflows track delivery checks.
Git and the external recovery archive preserve the original plan.

| Original path | Recoverable copy | SHA-256 |
| --- | --- | --- |
| `ROADMAP.md` | [Version 2.0 plan](https://github.com/ThomasCrouzet/mdsh/blob/372d83349886d8c58d4da2462996ca4d6ea7acbb/archive/2026-10-10/ROADMAP.md) | `e4e05645b29ceb50cee412e98b9871b5a0c415e4c2ad8751b11fff041f42e538` |
