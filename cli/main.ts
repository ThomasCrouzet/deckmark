import { basename, dirname, resolve } from 'node:path';
import { hasOption, numberOption, option, parseArgs, requireOption, type ParsedArgs } from './args';
import { runCheck } from './check';
import { CliError, EXIT } from './exit';
import { runExport, type ExportFormat } from './export';
import { runInspect } from './inspect';
import { displayPath, readText, requireFile, resolveOutput, writeOutput } from './paths';
import { buildStandaloneHtml, renderMarkdownToHtml } from './render';
import { runSearch } from './search';
import { documentKindForFile } from '../src/lib/document-kind';
import { stripMdExtension } from '../src/lib/file-names';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 32;
const MAX_TIMEOUT_MS = 3_600_000;

const GENERAL_HELP = `DeckMark CLI

Usage:
  deckmark <command> [options]

Commands:
  check [path]            Validate links, anchors, front matter, and structure.
  search <query> [path]   Search text files in a directory.
  render <file>           Render a Markdown note to standalone HTML.
  export <path> --format <md|html|zip> --out <file>
                          Export a note, project, or single file.
  inspect <file>          Show document kind, front matter, headings, and links.

Global options:
  -h, --help              Show help.
  --version               Show the version.
  --json                  Write machine-readable JSON.

Run "deckmark <command> --help" for command options and limits.
Full documentation: docs/CLI.md
Exit codes: 0 success, 1 failure, 2 usage, 3 input, 4 unsafe path,
            5 check failed, 6 output, 7 timeout or cancellation.
`;

const CHECK_HELP = `Usage: deckmark check [path] [options]

Validates Markdown documents with the shared documentation checker.
The default path is the current directory.

Options:
  --root <dir>            Project root for links and assets.
  --strict                Fail when warnings are present.
  --json                  Write the mdsh-docs-check/1 report.
  --timeout <ms>          Stop after this time. Default: 30000. 0 disables.
  --concurrency <n>       File reads at the same time. Default: 4, max: 32.
`;

const SEARCH_HELP = `Usage: deckmark search <query> [path] [options]

Searches Markdown, text, and code files. Results use path, line, and column order.

Options:
  --case-sensitive        Match letter case.
  --whole-word            Match whole words only.
  --regex                 Use a regular expression. Unsafe patterns are rejected.
  --max-results <n>       Stop after this count. Default: 200.
  --json                  Write the deckmark-search/1 report.
  --timeout <ms>          Stop after this time. Default: 30000. 0 disables.
  --concurrency <n>       File reads at the same time. Default: 4, max: 32.
`;

const RENDER_HELP = `Usage: deckmark render <file> [options]

Renders a Markdown note to one HTML file with no external dependency.
Raw HTML is escaped. Math, diagrams, and remote images are not processed.

Options:
  --out <file>            Write to a file. Default: standard output.
  --title <text>          Override the document title.
  --lang <tag>            Set the HTML language. Default: en.
  --no-frontmatter        Omit the front matter block.
  --json                  Write the deckmark-render/1 report.
  --timeout <ms>          Stop after this time. Default: 30000. 0 disables.
`;

const EXPORT_HELP = `Usage: deckmark export <path> --format <md|html|zip> --out <file> [options]

Exports a note, a single file, or a project directory.

Formats:
  md                      Copy Markdown or text without conversion.
  html                    Render one Markdown note to standalone HTML.
  zip                     Build a portable project archive with a link report.

Options:
  --name <name>           Project name for --format zip.
  --lang <tag>            Set the HTML language. Default: en.
  --json                  Write the deckmark-export/1 report.
  --timeout <ms>          Stop after this time. Default: 30000. 0 disables.
  --concurrency <n>       File reads at the same time. Default: 4, max: 32.
`;

const INSPECT_HELP = `Usage: deckmark inspect <file> [options]

Options:
  --json                  Write the deckmark-inspect/1 report.
`;

function commandHelp(command: string): string {
	switch (command) {
		case 'check':
			return CHECK_HELP;
		case 'search':
			return SEARCH_HELP;
		case 'render':
			return RENDER_HELP;
		case 'export':
			return EXPORT_HELP;
		case 'inspect':
			return INSPECT_HELP;
		default:
			return GENERAL_HELP;
	}
}

function commonOptions(args: ParsedArgs): {
	concurrency: number;
	timeoutMs: number;
	json: boolean;
} {
	return {
		concurrency: numberOption(args, 'concurrency', DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
		timeoutMs: numberOption(args, 'timeout', DEFAULT_TIMEOUT_MS, 0, MAX_TIMEOUT_MS),
		json: hasOption(args, 'json')
	};
}

function onePositional(args: ParsedArgs, command: string, fallback?: string): string {
	const value = args.positionals[0] ?? fallback;
	if (value === undefined)
		throw new CliError(EXIT.USAGE, 'usage', `${command} needs one input path`);
	if (args.positionals.length > 1)
		throw new CliError(EXIT.USAGE, 'usage', `${command} takes one input path`);
	return value;
}

async function renderCommand(args: ParsedArgs): Promise<number> {
	const input = onePositional(args, 'render');
	const common = commonOptions(args);
	const file = await requireFile(resolve(input));
	const content = await readText(dirname(file), basename(file));
	const kind = documentKindForFile({ name: file, content });
	if (kind !== 'note')
		throw new CliError(
			EXIT.USAGE,
			'unsupported-format',
			`render supports Markdown notes only. The input is ${kind}.`
		);
	const rendered = await renderMarkdownToHtml(content, {
		showFrontmatter: !hasOption(args, 'no-frontmatter')
	});
	const title = option(args, 'title')?.trim() || rendered.title || stripMdExtension(basename(file));
	const lang = option(args, 'lang');
	const html = buildStandaloneHtml(rendered.html, { title, ...(lang ? { lang } : {}) });
	const out = option(args, 'out');
	if (!out) {
		if (common.json) {
			process.stdout.write(
				`${JSON.stringify(
					{
						schema: 'deckmark-render/1',
						input: displayPath(file),
						output: null,
						title,
						bytes: Buffer.byteLength(html, 'utf8'),
						html
					},
					null,
					2
				)}\n`
			);
		} else process.stdout.write(html);
		return EXIT.OK;
	}
	const target = await resolveOutput(out, 'html');
	await writeOutput(target, html);
	if (common.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					schema: 'deckmark-render/1',
					input: displayPath(file),
					output: displayPath(target),
					title,
					bytes: Buffer.byteLength(html, 'utf8')
				},
				null,
				2
			)}\n`
		);
	} else {
		process.stdout.write(`Rendered ${displayPath(file)} to ${displayPath(target)}.\n`);
	}
	return EXIT.OK;
}

async function run(argv: readonly string[]): Promise<number> {
	if (argv.includes('--version')) {
		process.stdout.write(`deckmark ${__DECKMARK_VERSION__}\n`);
		return EXIT.OK;
	}
	const command = argv[0];
	if (!command || command === '--help' || command === '-h' || command === 'help') {
		process.stdout.write(GENERAL_HELP);
		return EXIT.OK;
	}
	const tokens = argv.slice(1);
	if (tokens.includes('--help') || tokens.includes('-h')) {
		process.stdout.write(commandHelp(command));
		return EXIT.OK;
	}
	switch (command) {
		case 'check': {
			const args = parseArgs(tokens, {
				values: ['root', 'concurrency', 'timeout'],
				flags: ['json', 'strict']
			});
			const common = commonOptions(args);
			const input = args.positionals[0] ?? '.';
			if (args.positionals.length > 1)
				throw new CliError(EXIT.USAGE, 'usage', 'check takes one input path');
			return runCheck({
				input,
				...(option(args, 'root') ? { root: option(args, 'root')! } : {}),
				strict: hasOption(args, 'strict'),
				...common
			});
		}
		case 'search': {
			const args = parseArgs(tokens, {
				values: ['max-results', 'concurrency', 'timeout'],
				flags: ['json', 'case-sensitive', 'whole-word', 'regex']
			});
			const query = args.positionals[0];
			if (!query) throw new CliError(EXIT.USAGE, 'usage', 'search needs a query');
			if (args.positionals.length > 2)
				throw new CliError(EXIT.USAGE, 'usage', 'search takes a query and one path');
			return runSearch({
				query,
				input: args.positionals[1] ?? '.',
				caseSensitive: hasOption(args, 'case-sensitive'),
				wholeWord: hasOption(args, 'whole-word'),
				regex: hasOption(args, 'regex'),
				maxResults: numberOption(args, 'max-results', 200, 1, 5000),
				...commonOptions(args)
			});
		}
		case 'render':
			return renderCommand(
				parseArgs(tokens, {
					values: ['out', 'title', 'lang', 'timeout'],
					flags: ['json', 'no-frontmatter']
				})
			);
		case 'export': {
			const args = parseArgs(tokens, {
				values: ['format', 'out', 'name', 'lang', 'concurrency', 'timeout'],
				flags: ['json']
			});
			const format = requireOption(args, 'format');
			if (!['md', 'html', 'zip'].includes(format))
				throw new CliError(EXIT.USAGE, 'unsupported-format', `Unsupported format: ${format}`);
			return runExport({
				input: onePositional(args, 'export'),
				format: format as ExportFormat,
				out: requireOption(args, 'out'),
				...(option(args, 'name') ? { name: option(args, 'name')! } : {}),
				...(option(args, 'lang') ? { lang: option(args, 'lang')! } : {}),
				...commonOptions(args)
			});
		}
		case 'inspect': {
			const args = parseArgs(tokens, { values: [], flags: ['json'] });
			return runInspect({ input: onePositional(args, 'inspect'), json: hasOption(args, 'json') });
		}
		default:
			throw new CliError(EXIT.USAGE, 'usage', `Unknown command: ${command}`);
	}
}

export async function main(argv: readonly string[]): Promise<number> {
	const wantsJson = argv.includes('--json');
	try {
		return await run(argv);
	} catch (error) {
		const known =
			error instanceof CliError
				? error
				: new CliError(
						EXIT.FAILURE,
						'failure',
						error instanceof Error ? error.message : String(error)
					);
		if (wantsJson)
			process.stderr.write(
				`${JSON.stringify({ schema: 'deckmark-error/1', code: known.code, message: known.message }, null, 2)}\n`
			);
		else process.stderr.write(`deckmark: ${known.message}\n`);
		return known.exitCode;
	}
}
