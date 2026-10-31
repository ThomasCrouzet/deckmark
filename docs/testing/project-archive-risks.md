# Project archive risk scenarios

These browser scenarios cover archive boundaries that can damage portable projects.

## Failure risks

- A case variant of `.mdsh` can replace internal metadata on a case-insensitive filesystem.
- A filename with parentheses can produce an invalid Markdown destination after a rename.
- A rename can change links inside quoted fences, list fences, or raw HTML examples.
- A reference-style remote image can bypass the remote-image link diagnostic.
- Generated image assets can collide with existing paths after Unicode and case folding.
- Export metadata and generated directory entries can exceed archive entry limits.
- Generated assets can exceed per-file or aggregate expanded-size limits.
- Internal wiki IDs can become unresolved after archive import in another browser.
- Wiki filenames with brackets or number signs can break target syntax after a rename.
- A basename-only wiki link can match multiple documents in different directories.
  The link report must identify the target as ambiguous.

## Browser scenarios

`project-archive-risks.spec.ts` imports archives through the Projects panel.

1. Import rejects a case variant of the reserved `.mdsh` directory before storage changes.
2. Rename encodes a closing parenthesis and keeps links inside protected examples unchanged.
3. The link report identifies a reference-style remote image without a network request.
4. The link report identifies a basename-only wiki link with multiple project targets.
5. Export keeps distinct generated assets when an existing path collides after case folding.
6. Export rejects a project when generated ZIP entries exceed the import entry limit.
7. Export converts an internal wiki ID to a relative path without changing stored source.
8. Rename keeps reserved wiki characters encoded through export and reimport.

The export cases inspect the downloaded ZIP. The artifact proves that the output can be
read as a portable project without path replacement.

## Repeatable command and artifacts

Run the focused workflow after the coordinated build freeze:

```sh
npm run test:e2e -- project-archive-risks.spec.ts --project=chromium --workers=1
```

Keep `playwright-report/index.html` and `test-results/results.json`. Failed cases retain
screenshots and traces under `test-results/`. The test also attaches input and output ZIPs.
