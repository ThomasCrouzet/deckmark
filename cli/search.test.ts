import { describe, expect, it } from 'vitest';
import { CliError, EXIT } from './exit';
import { Deadline } from './paths';
import { searchPathsInOrder, type SearchMatch } from './search';

const base = {
	query: 'needle',
	caseSensitive: false,
	wholeWord: false,
	regex: false
};

interface ReaderStats {
	reads: string[];
}

function delayedReader(
	files: Record<string, string>,
	delays: Record<string, number>,
	stats?: ReaderStats
) {
	return async (path: string): Promise<string> => {
		stats?.reads.push(path);
		const delay = delays[path] ?? 0;
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		const content = files[path];
		if (content === undefined) throw new Error(`missing fixture: ${path}`);
		return content;
	};
}

function pathsOf(matches: readonly SearchMatch[]): string[] {
	return matches.map((match) => match.path);
}

describe('ordered CLI search', () => {
	// Risk: with more than one reader, a fast later file can fill the result
	// cap before a slow earlier file returns, so `--max-results 1` depends on
	// I/O timing. The injected delays make that completion order deterministic.
	// A browser cannot exercise the CLI process or its shared result buffer.
	it('returns the lexicographically first match when the earlier read finishes last', async () => {
		const files = { 'a.md': 'needle', 'b.md': 'needle', 'c.md': 'needle' };
		const result = await searchPathsInOrder(['a.md', 'b.md', 'c.md'], {
			...base,
			maxResults: 1,
			concurrency: 3,
			read: delayedReader(files, { 'a.md': 40, 'b.md': 0, 'c.md': 0 })
		});
		expect(pathsOf(result.matches)).toEqual(['a.md']);
	});

	it('returns the first N matches for every concurrency value', async () => {
		const files: Record<string, string> = {};
		const delays: Record<string, number> = {};
		const paths: string[] = [];
		for (let index = 0; index < 12; index++) {
			const path = `${String(index).padStart(2, '0')}.md`;
			paths.push(path);
			files[path] = `needle\nneedle`;
			delays[path] = (12 - index) * 3;
		}
		for (const concurrency of [1, 2, 4, 8]) {
			const result = await searchPathsInOrder(paths, {
				...base,
				maxResults: 3,
				concurrency,
				read: delayedReader(files, delays)
			});
			expect(pathsOf(result.matches)).toEqual(['00.md', '00.md', '01.md']);
			expect(result.truncated).toBe(true);
		}
	});

	it('skips a delayed first file with no match', async () => {
		const files = { 'a.md': 'nothing here', 'b.md': 'needle' };
		const result = await searchPathsInOrder(['a.md', 'b.md'], {
			...base,
			maxResults: 1,
			concurrency: 2,
			read: delayedReader(files, { 'a.md': 30, 'b.md': 0 })
		});
		expect(pathsOf(result.matches)).toEqual(['b.md']);
	});

	it('stops reading after the first N matches and the read window', async () => {
		const files: Record<string, string> = {};
		const delays: Record<string, number> = {};
		const paths: string[] = [];
		for (let index = 0; index < 500; index++) {
			const path = `${String(index).padStart(3, '0')}.md`;
			paths.push(path);
			files[path] = `needle ${index}`;
			delays[path] = (index % 7) * 2;
		}
		const stats: ReaderStats = { reads: [] };
		const result = await searchPathsInOrder(paths, {
			...base,
			maxResults: 3,
			concurrency: 4,
			read: delayedReader(files, delays, stats)
		});
		expect(pathsOf(result.matches)).toEqual(['000.md', '001.md', '002.md']);
		expect(result.truncated).toBe(true);
		expect(stats.reads.length).toBeLessThanOrEqual(result.matches.length + 4);
	});

	it('produces identical output for different completion orders', async () => {
		const files = {
			'a.md': 'needle\nneedle',
			'b.md': 'needle',
			'c.md': 'needle\nneedle',
			'd.md': 'needle'
		};
		const paths = ['a.md', 'b.md', 'c.md', 'd.md'];
		const forward = await searchPathsInOrder(paths, {
			...base,
			maxResults: 4,
			concurrency: 4,
			read: delayedReader(files, { 'a.md': 5, 'b.md': 25, 'c.md': 10, 'd.md': 40 })
		});
		const reverse = await searchPathsInOrder(paths, {
			...base,
			maxResults: 4,
			concurrency: 4,
			read: delayedReader(files, { 'a.md': 40, 'b.md': 10, 'c.md': 25, 'd.md': 5 })
		});
		expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
		expect(pathsOf(forward.matches)).toEqual(['a.md', 'a.md', 'b.md', 'c.md']);
	});

	it('fails the whole search when one read fails', async () => {
		const files = { 'a.md': 'needle', 'b.md': 'needle' };
		const read = async (path: string): Promise<string> => {
			if (path === 'a.md') throw new Error('read failed');
			return files[path as keyof typeof files];
		};
		await expect(
			searchPathsInOrder(['a.md', 'b.md'], {
				...base,
				maxResults: 1,
				concurrency: 2,
				read
			})
		).rejects.toThrow('read failed');
	});

	it('aborts a slow read at the deadline', async () => {
		const files = { 'a.md': 'needle' };
		let error: unknown;
		try {
			await searchPathsInOrder(['a.md'], {
				...base,
				maxResults: 1,
				concurrency: 1,
				deadline: new Deadline(10),
				read: delayedReader(files, { 'a.md': 50 })
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(CliError);
		expect((error as CliError).code).toBe('timeout');
		expect((error as CliError).exitCode).toBe(EXIT.ABORTED);
	});

	it('reports an invalid regular expression', async () => {
		const result = await searchPathsInOrder(['a.md'], {
			...base,
			query: 'a(',
			regex: true,
			maxResults: 1,
			concurrency: 1,
			read: delayedReader({ 'a.md': 'needle' }, {})
		});
		expect(result.regexError).not.toBeNull();
		expect(result.matches).toEqual([]);
	});
});
