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

export interface SearchMatch {
	path: string;
	line: number;
	column: number;
	endColumn: number;
	snippet: string;
}

export interface OrderedSearchOptions {
	query: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	regex: boolean;
	maxResults: number;
	concurrency: number;
	/** Reads the content of one path. Throws when the file cannot be read. */
	read: (path: string) => Promise<string>;
	deadline?: Deadline;
}

export interface OrderedSearchResult {
	matches: SearchMatch[];
	regexError: string | null;
	/** True only when the result limit stopped the scan before every path was examined. */
	truncated: boolean;
}

/**
 * Searches sorted paths with bounded concurrency and commits matches in path
 * order. Each read starts with its stable path index. A completed read waits in
 * a small pending map until every earlier index has completed, so a fast later
 * file cannot take a slot that belongs to an earlier path. The final match list
 * is therefore the lexicographically first N matches for any completion order.
 */
export async function searchPathsInOrder(
	paths: readonly string[],
	options: OrderedSearchOptions
): Promise<OrderedSearchResult> {
	const total = paths.length;
	const query = options.query;
	const pending = new Map<number, SearchMatch[]>();
	const matches: SearchMatch[] = [];
	let nextToStart = 0;
	let nextToCommit = 0;
	let stopped = false;
	let regexError: string | null = null;

	const flush = () => {
		while (!stopped && pending.has(nextToCommit)) {
			const fileMatches = pending.get(nextToCommit)!;
			pending.delete(nextToCommit);
			nextToCommit += 1;
			for (const match of fileMatches) {
				matches.push(match);
				if (matches.length >= options.maxResults) {
					stopped = true;
					break;
				}
			}
		}
	};

	const worker = async () => {
		for (;;) {
			if (stopped || regexError) return;
			const index = nextToStart++;
			if (index >= total) return;
			const path = paths[index]!;
			options.deadline?.check();
			const content = await options.read(path);
			options.deadline?.check();
			if (stopped || regexError) return;
			const result = matchInCorpus(
				[{ id: path, name: basename(path), content }],
				{
					query: query,
					caseSensitive: options.caseSensitive,
					wholeWord: options.wholeWord,
					useRegex: options.regex
				},
				options.maxResults
			);
			if (result.regexError) {
				regexError = result.regexError;
				return;
			}
			const fileMatches: SearchMatch[] = [];
			for (const hit of result.hits) {
				const ellipsis = hit.snippet.startsWith('…') ? 1 : 0;
				fileMatches.push({
					path: hit.fileId,
					line: hit.line,
					column: hit.matchStart + 1 - ellipsis,
					endColumn: hit.matchEnd + 1 - ellipsis,
					snippet: hit.snippet
				});
			}
			pending.set(index, fileMatches);
			flush();
		}
	};

	await Promise.all(
		Array.from({ length: Math.max(1, Math.min(options.concurrency, total)) }, () => worker())
	);
	return {
		matches,
		regexError,
		truncated: matches.length >= options.maxResults && nextToCommit < total
	};
}

export async function runSearch(input: SearchInput): Promise<number> {
	const query = input.query.trim();
	if (query.length < 2)
		throw new CliError(EXIT.USAGE, 'query-too-short', 'Search query needs at least 2 characters');
	const deadline = new Deadline(input.timeoutMs);
	const scope = await resolveScope(input.input, deadline);
	const paths = scope.files.filter(isTextPath);
	const result = await searchPathsInOrder(paths, {
		query,
		caseSensitive: input.caseSensitive,
		wholeWord: input.wholeWord,
		regex: input.regex,
		maxResults: input.maxResults,
		concurrency: input.concurrency,
		read: (path) => readText(scope.root, path),
		deadline
	});
	if (result.regexError)
		throw new CliError(
			EXIT.USAGE,
			'invalid-regex',
			`Invalid regular expression: ${result.regexError}`
		);
	const matches = result.matches;
	const truncated = result.truncated;
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
