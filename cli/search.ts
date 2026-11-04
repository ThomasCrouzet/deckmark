import { basename, dirname, relative, resolve } from 'node:path';
import { isCodeExtension, isMarkdownExtension } from '../src/lib/document-kind';
import { matchInCorpus } from '../src/lib/search-core';
import { CliError, EXIT } from './exit';
import {
	Deadline,
	displayPath,
	mapPool,
	readText,
	requireDirectory,
	requireFile,
	toProjectPath,
	walkFiles
} from './paths';

export interface SearchInput {
	query: string;
	input: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	regex: boolean;
	maxResults: number;
	concurrency: number;
	timeoutMs: number;
	json: boolean;
}

interface SearchScope {
	root: string;
	files: string[];
}

async function resolveScope(input: string, deadline: Deadline): Promise<SearchScope> {
	try {
		const file = await requireFile(resolve(input));
		const root = dirname(file);
		return { root, files: [toProjectPath(relative(root, file))] };
	} catch (error) {
		if (!(error instanceof CliError) || error.code !== 'input-not-found') throw error;
		const root = await requireDirectory(resolve(input));
		const files = await walkFiles(root, {
			accept: (path) => isMarkdownExtension(path) || isCodeExtension(path)
		});
		deadline.check();
		return { root, files };
	}
}

function isTextPath(path: string): boolean {
	return isMarkdownExtension(path) || isCodeExtension(path);
}

interface SearchMatch {
	path: string;
	line: number;
	column: number;
	endColumn: number;
	snippet: string;
}

export async function runSearch(input: SearchInput): Promise<number> {
	const query = input.query.trim();
	if (query.length < 2)
		throw new CliError(EXIT.USAGE, 'query-too-short', 'Search query needs at least 2 characters');
	const deadline = new Deadline(input.timeoutMs);
	const scope = await resolveScope(input.input, deadline);
	const paths = scope.files.filter(isTextPath);
	const corpus = await mapPool(paths, input.concurrency, deadline, async (path) => ({
		id: path,
		name: basename(path),
		content: await readText(scope.root, path)
	}));
	deadline.check();
	const result = matchInCorpus(
		corpus,
		{
			query,
			caseSensitive: input.caseSensitive,
			wholeWord: input.wholeWord,
			useRegex: input.regex
		},
		input.maxResults
	);
	if (result.regexError)
		throw new CliError(
			EXIT.USAGE,
			'invalid-regex',
			`Invalid regular expression: ${result.regexError}`
		);
	const matches: SearchMatch[] = result.hits.map((hit) => {
		const ellipsis = hit.snippet.startsWith('…') ? 1 : 0;
		return {
			path: hit.fileId,
			line: hit.line,
			column: hit.matchStart + 1 - ellipsis,
			endColumn: hit.matchEnd + 1 - ellipsis,
			snippet: hit.snippet
		};
	});
	const truncated = matches.length >= input.maxResults;
	if (input.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					schema: 'deckmark-search/1',
					query,
					root: displayPath(scope.root),
					options: {
						caseSensitive: input.caseSensitive,
						wholeWord: input.wholeWord,
						regex: input.regex,
						maxResults: input.maxResults
					},
					total: matches.length,
					truncated,
					matches
				},
				null,
				2
			)}\n`
		);
	} else {
		const lines = matches.map(
			(match) => `${match.path}:${match.line}:${match.column}: ${match.snippet}`
		);
		lines.push(
			`${matches.length} match${matches.length === 1 ? '' : 'es'}${truncated ? ' (limit reached)' : ''}.`
		);
		process.stdout.write(`${lines.join('\n')}\n`);
	}
	return EXIT.OK;
}
