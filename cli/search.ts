import { basename, dirname, relative, resolve } from 'node:path';
import { isCodeExtension, isMarkdownExtension } from '../src/lib/document-kind';
import { matchInCorpus } from '../src/lib/search-core';
import { CliError, EXIT } from './exit';
import {
	Deadline,
	displayPath,
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
			accept: (path) => isMarkdownExtension(path) || isCodeExtension(path),
			deadline
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
	const order = new Map(paths.map((path, index) => [path, index]));
	const matches: SearchMatch[] = [];
	let regexError: string | null = null;
	let next = 0;
	// Read and match a few files at a time. Stop taking new files as soon as the
	// result limit is met, so an early hit does not load the rest of the corpus.
	const worker = async () => {
		for (;;) {
			if (matches.length >= input.maxResults || regexError) return;
			const index = next++;
			const path = paths[index];
			if (path === undefined) return;
			deadline.check();
			const content = await readText(scope.root, path);
			if (matches.length >= input.maxResults || regexError) return;
			const result = matchInCorpus(
				[{ id: path, name: basename(path), content }],
				{
					query,
					caseSensitive: input.caseSensitive,
					wholeWord: input.wholeWord,
					useRegex: input.regex
				},
				input.maxResults - matches.length
			);
			if (result.regexError) {
				regexError = result.regexError;
				return;
			}
			for (const hit of result.hits) {
				const ellipsis = hit.snippet.startsWith('…') ? 1 : 0;
				matches.push({
					path: hit.fileId,
					line: hit.line,
					column: hit.matchStart + 1 - ellipsis,
					endColumn: hit.matchEnd + 1 - ellipsis,
					snippet: hit.snippet
				});
				if (matches.length >= input.maxResults) return;
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.max(1, Math.min(input.concurrency, paths.length)) }, () => worker())
	);
	if (regexError)
		throw new CliError(EXIT.USAGE, 'invalid-regex', `Invalid regular expression: ${regexError}`);
	matches.sort(
		(left, right) =>
			(order.get(left.path) ?? 0) - (order.get(right.path) ?? 0) ||
			left.line - right.line ||
			left.column - right.column
	);
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
