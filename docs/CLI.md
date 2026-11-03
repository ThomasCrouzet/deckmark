# DeckMark command-line interface

The DeckMark command-line interface (CLI) is a local Node companion executable.
It reuses the documentation checker, project archive, search matcher, front
matter parser, and link rules from the application. It does not start the GUI,
the Tauri shell, a server, or a network request.

Use the CLI for local scripts and CI pipelines. The application remains offline,
private, and client-side.

## Requirements

- Node 22 or later.
- A repository checkout with its dependencies installed.

The first command builds a cached CLI bundle in `.cli/`. The build uses the
existing Vite dependency. A later source change rebuilds the bundle. The Web
build does not read `.cli/`, and the PWA precache does not include it.

## Start a command

Use one of these forms:

```sh
node bin/deckmark.mjs --help
npm run cli -- check docs
npm run cli:build
```

The package declares a `deckmark` bin entry. After `npm link`, run `deckmark`
directly.

## Commands

| Command | Purpose |
| --- | --- |
| `check [path]` | Validate links, anchors, front matter, and document structure. |
| `search <query> [path]` | Search text files with stable order. |
| `render <file>` | Render one Markdown note to standalone HTML. |
| `export <path> --format <md\|html\|zip> --out <file>` | Export a note, file, or project. |
| `inspect <file>` | Report the document kind, front matter, headings, and link counts. |

Each command accepts `--help`. Use `deckmark --version` for the package version.

## Common options

| Option | Default | Meaning |
| --- | --- | --- |
| `--json` | off | Write machine-readable JSON on standard output. |
| `--timeout <ms>` | `30000` | Stop after this time. `0` disables the limit. Maximum: `3600000`. |
| `--concurrency <n>` | `4` | Read this many files at the same time. Range: `1` to `32`. |

`check`, `search`, `render`, and `export` accept the timeout and concurrency
options. `inspect` does not read files in parallel.

## Exit codes

The exit codes are stable for scripts.

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | Success | The command completed. |
| `1` | Failure | An unexpected failure occurred. |
| `2` | Usage | An option, command, format, or output extension is not supported. |
| `3` | Input | An input path is missing, unreadable, too large, or not UTF-8 text. |
| `4` | Unsafe path | An output path contains `..` or leaves the working directory. |
| `5` | Check failed | `check` found errors. With `--strict`, it also fails on warnings. |
| `6` | Output | The CLI cannot create or write the output file. |
| `7` | Aborted | The timeout expired or the operator cancelled with `SIGINT`. |

`search` exits `0` when it finds no match.

## check

```sh
deckmark check docs --json
deckmark check docs/guide.md --root . --strict
```

`check` uses the same `runDocsCheck` function as the application. It reads
Markdown, MDX, and text documents, plus all other files as project assets. The
default path is the current directory.

- `--root <dir>` sets the project root for links and assets.
- `--strict` also fails on warnings.
- A file path filters the report to that file. Link resolution still uses the
  full project root.

Human output uses one line for each issue:

```text
docs/guide.md:12:4: error link-missing: Missing link target "setup.md".
Checked 8 documents: 1 error, 0 warnings.
```

JSON output is the existing `mdsh-docs-check/1` report. It has these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | string | `mdsh-docs-check/1`. |
| `documents` | number | Count of checked documents. |
| `summary.errors` | number | Count of error issues. |
| `summary.warnings` | number | Count of warning issues. |
| `issues[]` | array | Sorted issues. |
| `issues[].code` | string | Stable check code, for example `link-missing`. |
| `issues[].severity` | string | `error` or `warning`. |
| `issues[].documentId` | string | Document identifier. The CLI uses the project path. |
| `issues[].path` | string | Project path. |
| `issues[].line` | number | One-based source line. |
| `issues[].column` | number | One-based source column. |
| `issues[].target` | string | Optional link, anchor, or resource. |
| `issues[].message` | string | Stable English message. |
| `skipped[]` | array | Checks that need a renderer or network access. |

## search

```sh
deckmark search "release" docs --json
deckmark search "TODO" . --whole-word --max-results 50
deckmark search "fix\(.*\)" . --regex
```

`search` reads Markdown, text, and code files. It uses the same matcher as the
application search worker.

| Option | Meaning |
| --- | --- |
| `--case-sensitive` | Match letter case. |
| `--whole-word` | Match whole words with Unicode word boundaries. |
| `--regex` | Use a regular expression. Unsafe patterns are rejected. |
| `--max-results <n>` | Stop after this count. Default: `200`. Maximum: `5000`. |

The query needs at least 2 characters. Results use path, line, and column order.
The JSON output uses the `deckmark-search/1` schema:

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | string | `deckmark-search/1`. |
| `query` | string | Trimmed query. |
| `root` | string | Search root. `.` is the current directory. |
| `options` | object | Case, whole-word, regex, and maximum values. |
| `total` | number | Count of matches. |
| `truncated` | boolean | True when the result reached the maximum. |
| `matches[].path` | string | Project path. |
| `matches[].line` | number | One-based line. |
| `matches[].column` | number | One-based start column. |
| `matches[].endColumn` | number | One-based end column. |
| `matches[].snippet` | string | Context text with ellipsis markers from the shared matcher. |

## render

```sh
deckmark render notes/guide.md --out guide.html
deckmark render notes/guide.md --json
```

`render` writes one self-contained HTML file. It uses Marked with escaped raw
HTML. The file has an inline style and a restrictive content security policy.
It has no script and no network dependency.

Options:

- `--out <file>` writes a file. Without it, the HTML goes to standard output.
- `--title <text>` overrides the document title.
- `--lang <tag>` sets the HTML language. The default is `en`.
- `--no-frontmatter` omits the front matter block.
- `--json` writes a report. If `--out` is absent, the report contains the HTML.

The JSON output uses the `deckmark-render/1` schema:

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | string | `deckmark-render/1`. |
| `input` | string | Input path. |
| `output` | string or null | Output path. Null means standard output. |
| `title` | string | Document title. |
| `bytes` | number | HTML byte count. |
| `html` | string | HTML text. Present only when `--out` is absent. |

## export

```sh
deckmark export notes/guide.md --format html --out guide.html
deckmark export notes/guide.md --format md --out guide.md
deckmark export . --format zip --out project.zip --name my-project
```

| Format | Input | Result |
| --- | --- | --- |
| `md` | One Markdown or text file. | An exact byte copy. |
| `html` | One Markdown note. | The same output as `render`. |
| `zip` | A directory or one Markdown file. | A portable project archive. |

For `zip`, a directory is a project. A file becomes the only document. The
archive uses the shared `buildProjectZip` function. It includes project
documents, assets, embedded image extraction, `.mdsh/project.json`, and
`.mdsh/link-report.json`.

- `--name <name>` sets the project name in `.mdsh/project.json`.
- The ZIP entry date is `1980-01-01T00:00:00.000Z` for all entries.

The JSON output uses the `deckmark-export/1` schema:

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | string | `deckmark-export/1`. |
| `input` | string | Input path. |
| `format` | string | `md`, `html`, or `zip`. |
| `output` | string | Output path. |
| `title` | string or null | Title for `md` and `html`. Null for `zip`. |
| `documents` | number | Exported document count. |
| `assets` | number | Exported asset count. |
| `bytes` | number | Output byte count. |

## inspect

```sh
deckmark inspect notes/guide.md --json
```

`inspect` reports one text document. It uses the shared document kind detection,
front matter parser, heading scanner, and link scanner.

The JSON output uses the `deckmark-inspect/1` schema:

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | string | `deckmark-inspect/1`. |
| `path` | string | Input path. |
| `kind` | string | `note`, `presentation`, `code`, or `image`. |
| `title` | string | Front matter title, first H1, or file name. |
| `frontmatter` | object | Parsed YAML values. |
| `headings[]` | array | Items with `level`, `text`, and `line`. |
| `links.markdown` | number | Markdown links without images. |
| `links.images` | number | Markdown image destinations. |
| `links.wiki` | number | Wiki links. |
| `links.external` | number | External destinations. |
| `links.internal` | number | Resolved project destinations. |
| `links.anchors` | number | In-document anchors. |
| `links.total` | number | Markdown, image, and wiki count. |
| `statistics.lines` | number | Source line count. |
| `statistics.words` | number | Word count without front matter. |
| `statistics.characters` | number | Source character count. |

Image inspection is not supported. The command exits `3` for an image file.

## JSON errors

When a command fails and `--json` is present, standard error receives one JSON
object. Standard output stays empty.

```json
{
  "schema": "deckmark-error/1",
  "code": "unsafe-output",
  "message": "Unsafe output path: ../escape.html"
}
```

Stable error codes include `usage`, `unsupported-format`, `unsupported-output`,
`unsafe-output`, `input-not-found`, `input-unreadable`, `input-not-text`,
`file-too-large`, `entry-limit`, `no-documents`, `invalid-regex`, `timeout`, and
`output-failed`.

## Reproducible output

The CLI is designed for repeated runs:

- Project paths use slash separators and code point order.
- JSON keys follow the documented order. Reports contain no time or locale data.
- HTML output has no timestamp and no random identifier.
- ZIP output sorts documents and assets, uses a fixed entry date, and uses
  deterministic DEFLATE settings.
- The project name is the `--name` value or the input directory name. Use
  `--name` when the directory name can change between runs.

## Limits and cancellation

| Limit | Value |
| --- | --- |
| Files in a scan | `5000` |
| File size | `16 MiB` |
| Project archive entries | `1300` |
| Project archive bytes | `64 MiB` |
| Project documents | `300` |
| Concurrent reads | `1` to `32`, default `4` |
| Default timeout | `30000` ms |

The CLI does not follow symbolic links during a directory scan. It ignores
`.git`, `.mdsh`, `.svelte-kit`, `build`, `coverage`, `dist`, `node_modules`,
`playwright-report`, `target`, and `test-results`.

`SIGINT` stops the process with exit code `7`. A timeout uses the same code.
The timeout is checked between file reads and before output. A synchronous
check pass is not interrupted in the middle.

## Output path safety

The CLI accepts user-supplied paths. It applies these rules to every output:

- Reject a NUL byte or any `..` path segment.
- Reject an extension that does not match the format.
- Reject an existing directory.
- Keep a relative path below the current directory. Resolve the nearest existing
  parent and compare its real path with the working directory.
- Accept an absolute path as an explicit user decision.
- Write to a temporary file in the target directory, then rename it.

The input paths are read only. The CLI never deletes a project file.

## Known differences from the GUI

`check` uses the same checker and the same codes as the GUI.

The CLI HTML renderer is a small Node-safe path. It does not have these GUI
features:

- No DOMPurify pass. The renderer escapes all raw HTML instead.
- No KaTeX formula rendering. Formula source stays visible as text.
- No Mermaid SVG rendering. Diagram source stays in a code block.
- No highlight theme. Code has `hljs` classes but no stylesheet theme.
- No remote image download and no project image embedding. Local and remote
  image paths stay as written.
- No heading permalink control.
- No presentation HTML export. Use the GUI for a slide show or slide PDF.
- No PDF export. Use the GUI print dialog.

`export --format zip` uses the shared project archive. It keeps the GUI link
report and portable path rules. It does not start the GUI or a print dialog.

## Web bundle isolation

The CLI source is in `cli/` and `bin/`. The Web build does not import it. The
CLI bundle goes to `.cli/`, which is ignored by Git, Prettier, ESLint, the Web
build, and the PWA precache. The CLI uses existing dependencies and adds no Web
dependency.

## Tests

The Node tests use real temporary directories and golden files:

```sh
npx vitest run cli/cli.test.ts
npm run cli:build
```

Fixtures and golden output are in `cli/test/fixtures` and `cli/test/golden`.
