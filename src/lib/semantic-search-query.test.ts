import { describe, expect, it } from 'vitest';
import { LatestOnly } from './semantic-search-query';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('latest semantic query job', () => {
	it('publishes only the latest job when IndexedDB reads resolve out of order', async () => {
		const job = new LatestOnly();
		const published: string[] = [];
		const run = async (read: Promise<string>, value: string) => {
			const token = job.begin();
			await read;
			if (job.isCurrent(token)) published.push(value);
		};

		const slow = deferred<string>();
		const fast = deferred<string>();
		const first = run(slow.promise, 'query A');
		const second = run(fast.promise, 'query B');
		fast.resolve('rows B');
		await second;
		slow.resolve('rows A');
		await first;

		expect(published).toEqual(['query B']);
	});

	it('discards a job invalidated by a scope change, clear or close', async () => {
		const job = new LatestOnly();
		const pending = deferred<string>();
		let published = '';
		const task = (async () => {
			const token = job.begin();
			const rows = await pending.promise;
			if (job.isCurrent(token)) published = rows;
		})();
		job.invalidate();
		pending.resolve('stale rows');
		await task;
		expect(published).toBe('');

		const fresh = deferred<string>();
		const current = (async () => {
			const token = job.begin();
			const rows = await fresh.promise;
			if (job.isCurrent(token)) published = rows;
		})();
		fresh.resolve('current rows');
		await current;
		expect(published).toBe('current rows');
	});
});
