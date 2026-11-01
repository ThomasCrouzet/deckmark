# Source fidelity and library export

A sentence edit must change that sentence and only the Markdown syntax that the
edit needs. The browser harness imports UTF-8 files, edits them through the
interface, and exports the saved source in a ZIP file. Each case has an explicit
expected file. An exact string comparison also checks UTF-8 bytes, line endings,
and the final newline.

Run the harness in Chromium, Firefox, and WebKit:

```sh
E2E_PORT=4287 npm run test:fidelity -- --workers=3
```

Use `--project=chromium` to run one browser. Use `--grep` with a test title to
repeat one case. The command builds the current source and starts a new preview
server. It uses a new browser context for each test.

## Failure risks and fixtures

The corpus in `e2e/fixtures/source-fidelity.ts` contains setext headings, nested
lists, ordered lists, tasks, reference links, definitions, HTML, comments, code
fences, indented code, tables, hard breaks, emphasis, escapes, entities, and blank
lines. It checks sentence edits in paragraphs, headings, lists, quotes, table
cells, marked text, links, and code. It includes Unicode, CRLF, and a file without
a final newline.

The other cases check these risks:

- A mode visit can change source without an edit.
- A second edit, undo, redo, reload, or a tab switch can use an obsolete source map.
- Repeated sentences can send a change to the wrong occurrence.
- A long document can cause changes far from the edited sentence.
- A selection across marks can remove syntax inside the changed sentence.
- Inserted Markdown characters can change the meaning of visual text.
- Source and Split view can replace CRLF or mixed line endings with LF.
- A UTF-8 byte order mark can disappear or prevent front matter detection.
  A presentation visit must keep this prefix and must not split YAML into slides.
- A JSON backup can have its own byte order mark. Restore must keep the byte
  order mark inside Markdown content while it reads the JSON prefix correctly.
- Definitions inside a quote and default image scale comments can disappear.
- Link scanners can treat a BOM as source text before YAML or a code fence.
  A project rename must keep those regions exact and update body links only.
- A library export can exceed the 300-document limit before a download.

The portable project workflow also checks that a same-document link moves to its
heading. Run it with `npm run test:e2e -- portable-projects.spec.ts --project=chromium`.

## Evidence

Each run writes `test-results/source-fidelity.json`. It records the command,
source revision, working diff hash, untracked file hashes, OS, Node version,
browser version, fixture hashes, expected source, exported source, and results.
It contains real `git diff --no-index` output for both comparisons:

- Original source against exported source: all changed lines.
- Expected source against exported source: changes outside the required edit.

The report sorts comparisons by the number of unexpected changed lines. Its
`exact` count must equal its comparison count, and `unexpectedLines` must be zero.
Also check the test statuses. A failed action before export has no comparison.
Retries remain separate records so that a later pass cannot hide an earlier failure.

The HTML report at `playwright-report/index.html` retains the same source files,
Git diffs, and metrics as attachments. Failed cases also retain screenshots and
traces. `test-results/results.json` contains the browser results. Keep these
artifacts local. Use a separate `--output=test-results/<run-name>` directory and
copy the two JSON reports there before the next run if the evidence must remain.

## Source rules

The visual editor retains the source from its current mount. It compares the
original, initial serialized, and current Markdown trees. It patches changed
source spans and keeps source syntax outside those spans. Link definitions and
source comments that have no visual node remain in the file. A parse check must
confirm that a patch has the same meaning as the visual editor document. If a
small patch changes the meaning, the editor serializes the changed block. The
full serializer remains a fallback when source nodes cannot be mapped safely.

A structural edit can require new delimiters, indentation, or separators. A
whole inline-code selection can lose its code mark when the browser inserts
plain text. These changes belong to the edited content. The harness specifies
the expected source for those operations. It does not permit changes elsewhere.
Source mode applies CodeMirror change ranges to the stored text. It retains
untouched line endings and uses the local line ending for an inserted line.

The harness measures the listed operations and fixtures. It does not prove byte
identity for every possible Markdown extension or every structural operation.
Add a fixture with an explicit expected file when a new source change is found.

Code text cases include CRLF, indented code, and a code info string that repeats
the sentence. The source map must use the code content span. A text search must
not replace the code info string or force a new fence style.

Two sentence edits in one paragraph must keep entities and soft line breaks
between the edits. The text comparison must keep separate change ranges. Code
line endings can differ between the parser and CodeMirror. Compare their meaning
without changing the stored code delimiters or line endings.
