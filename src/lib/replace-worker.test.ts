import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '#lib/i18n/index.js';
import {
	LITERAL_FALLBACK_MAX_BYTES,
	replaceInFilesAsync,
	REGEX_EXECUTION_TIMEOUT_MS
} from './replace-worker';
import { replaceInFiles } from './replace';

vi.mock('./replace', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./replace')>();
	return { ...actual, replaceInFiles: vi.fn(actual.replaceInFiles) };
});

class FakeWorker extends EventTarget {
	postMessage = vi.fn();
	terminate = vi.fn();
}

const files = [{ id: 'a', name: 'a.md', content: `${'a'.repeat(60)}!` }];
const opts = { caseSensitive: true, wholeWord: false, useRegex: true };
const unavailable = { results: [], total: 0, regexError: t('search.unavailable') };

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.mocked(replaceInFiles).mockClear();
});

describe('replacement in an isolated worker', () => {
	it('stops a blocked worker without a partial result', async () => {
		vi.useFakeTimers();
		const worker = new FakeWorker();
		const query = '(a+){10}$';
		const result = replaceInFilesAsync(files, query, 'x', opts, { createWorker: () => worker });
		expect(worker.postMessage).toHaveBeenCalledWith({ files, query, replacement: 'x', opts });
		await vi.advanceTimersByTimeAsync(REGEX_EXECUTION_TIMEOUT_MS);
		await expect(result).resolves.toEqual({
			results: [],
			total: 0,
			regexError: t('search.timeout')
		});
		expect(worker.terminate).toHaveBeenCalledOnce();
	});

	it('uses a new worker after timeout and releases the successful worker', async () => {
		vi.useFakeTimers();
		const stuck = new FakeWorker();
		const first = replaceInFilesAsync(files, '(a+){10}$', 'x', opts, { createWorker: () => stuck });
		await vi.advanceTimersByTimeAsync(REGEX_EXECUTION_TIMEOUT_MS);
		await first;
		const next = new FakeWorker();
		const second = replaceInFilesAsync(files, 'a+', 'x', opts, { createWorker: () => next });
		const outcome = {
			results: [{ id: 'a', name: 'a.md', content: 'x!', count: 1 }],
			total: 1,
			regexError: null
		};
		next.dispatchEvent(new MessageEvent('message', { data: outcome }));
		await expect(second).resolves.toEqual(outcome);
		expect(next.terminate).toHaveBeenCalledOnce();
	});

	it('reports a load error without changing the corpus', async () => {
		const worker = new FakeWorker();
		const result = replaceInFilesAsync(files, 'a+', 'x', opts, { createWorker: () => worker });
		worker.dispatchEvent(new Event('error'));
		await expect(result).resolves.toEqual(unavailable);
		expect(files[0]?.content).toBe(`${'a'.repeat(60)}!`);
	});

	it('fails closed when Worker is undefined', async () => {
		vi.stubGlobal('Worker', undefined);
		await expect(replaceInFilesAsync(files, 'a+', 'x', opts)).resolves.toEqual(unavailable);
		expect(replaceInFiles).not.toHaveBeenCalled();
	});

	it('fails closed when the Worker constructor throws', async () => {
		const createWorker = () => {
			throw new Error('Worker blocked');
		};
		await expect(replaceInFilesAsync(files, 'a+', 'x', opts, { createWorker })).resolves.toEqual(
			unavailable
		);
		expect(replaceInFiles).not.toHaveBeenCalled();
	});

	it('runs a bounded literal replacement without a Worker', async () => {
		vi.stubGlobal('Worker', undefined);
		const outcome = await replaceInFilesAsync(files, 'aa', 'x', {
			...opts,
			useRegex: false
		});
		expect(outcome).toMatchObject({ total: 30, regexError: null });
		expect(replaceInFiles).toHaveBeenCalledOnce();
	});

	it('refuses an oversized literal corpus without a Worker', async () => {
		vi.stubGlobal('Worker', undefined);
		const large = [
			{
				id: 'big',
				name: 'big.md',
				content: 'a'.repeat(LITERAL_FALLBACK_MAX_BYTES + 1)
			}
		];
		const outcome = await replaceInFilesAsync(large, 'a', 'x', { ...opts, useRegex: false });
		expect(outcome).toEqual(unavailable);
		expect(replaceInFiles).not.toHaveBeenCalled();
	});

	it('does not run a pathological regex on a large corpus without a Worker', async () => {
		vi.stubGlobal('Worker', undefined);
		const large = [{ id: 'big', name: 'big.md', content: 'a'.repeat(5 * 1024 * 1024) }];
		const outcome = await replaceInFilesAsync(large, '(a+)+$', 'x', {
			caseSensitive: true,
			wholeWord: false,
			useRegex: true
		});
		expect(outcome).toEqual(unavailable);
		expect(replaceInFiles).not.toHaveBeenCalled();
	});
});
