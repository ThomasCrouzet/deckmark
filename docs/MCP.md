# Local MCP server

DeckMark provides an optional local Model Context Protocol server. It is a
separate command-line process. It is not part of the Web build, starts no
listener, and is not enabled by default.

## Start

```sh
node bin/deckmark-mcp.mjs --root /path/to/project --root /path/to/notes
```

Use `--root` at least once. Up to eight roots are accepted. Access is limited to
resolved paths inside those roots.

The server reads newline-delimited JSON-RPC on stdin and writes JSON-RPC on
stdout. Send diagnostics to stderr from the client.

## Tools

| Tool | Purpose | Writes |
| --- | --- | --- |
| `list_files` | List files under the roots. | No |
| `read_file` | Read one text file. Images and PDFs return metadata only. | No |
| `search` | Literal search with path and line. | No |
| `check` | Report missing wiki targets and unclosed front matter. | No |
| `project_metadata` | Count files, kinds and bytes. | No |
| `propose_patch` | Validate one before/after replacement and return a proposal. | No |

`propose_patch` returns `applied: false`, the base hash, the edit and the
resulting text. A client or user must review and apply it through DeckMark or
the CLI.

## Security boundary

- No `write_file`, shell, process, network or arbitrary command tool exists.
- Path traversal, absolute paths and symlinks outside the roots are rejected.
- `.env`, `.git`, private keys, certificates and similar paths are excluded.
- Reads are limited to 1 MiB per text file and 500 files per listing.
- The process exits when stdin closes. It binds no port.
- The Web Light build contains no MCP or Node process code.

## Client example

```json
{
  "mcpServers": {
    "deckmark": {
      "command": "node",
      "args": ["/path/to/deckmark/bin/deckmark-mcp.mjs", "--root", "/path/to/project"]
    }
  }
}
```

## Tests

```sh
npx vitest run cli/mcp.test.ts --maxWorkers=1
```

The test starts the real process, checks initialization and tool discovery,
reads and searches a temporary project, proposes a patch without writing, and
rejects traversal and sensitive files.
