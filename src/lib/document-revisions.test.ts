import { afterEach, expect, it, vi } from 'vitest';
import { DocumentRevisions, type DocumentSnapshot } from './document-revisions';

afterEach(() => vi.useRealTimers());

it('coalesces interleaved file edits without reading discarded snapshots', () => {
	vi.useFakeTimers();
	const published: DocumentSnapshot[] = [];
	const documents = new DocumentRevisions(
		(snapshot) => published.push(snapshot),
		() => {}
	);
	const a = documents.open('a', 'A');
	const b = documents.open('b', 'B');
	let reads = 0;
	const nextA = documents.apply({
		base: a,
		edits: { kind: 'text' },
		readText: () => {
			reads += 1;
			return 'A1';
		}
	})!;
	documents.apply({ base: b, edits: { kind: 'text' }, readText: () => 'B1' });
	documents.apply({ base: nextA, edits: { kind: 'text' }, readText: () => 'A12' });
	expect(reads).toBe(0);
	expect(published).toEqual([]);
	vi.runAllTimers();
	expect(published.map(({ revision, text }) => [revision.fileId, text])).toEqual([
		['a', 'A12'],
		['b', 'B1']
	]);
	expect(reads).toBe(0);
	expect(documents.snapshot('a')?.text).toBe('A12');
});

it('refuses a delayed change and completion without overwriting a newer revision', async () => {
	const documents = new DocumentRevisions(
		() => {},
		() => {}
	);
	const base = documents.open('a', 'A');
	const oldSnapshot = documents.snapshot('a')!;
	const delayed = Promise.resolve().then(() =>
		documents.isCurrent(oldSnapshot.revision) ? oldSnapshot.text : null
	);
	const current = documents.apply({ base, edits: { kind: 'text' }, readText: () => 'new' })!;
	expect(documents.apply({ base, edits: { kind: 'text' }, readText: () => 'stale' })).toBeNull();
	expect(await delayed).toBeNull();
	expect(documents.flush('a')).toEqual({ revision: current, text: 'new' });
	expect(oldSnapshot.text).toBe('A');
	expect(documents.isCurrent({ ...current, fileId: 'b' })).toBe(false);
});

it('invalidates pending readers on removal and does not reuse a revision on reopen', () => {
	vi.useFakeTimers();
	const published: string[] = [];
	const documents = new DocumentRevisions(
		({ text }) => published.push(text),
		() => {}
	);
	const base = documents.open('a', 'A');
	const removed = documents.apply({ base, edits: { kind: 'text' }, readText: () => 'removed' })!;
	documents.forget('a');
	const reopened = documents.open('a', 'restored');
	expect(documents.isCurrent(removed)).toBe(false);
	expect(reopened.generation).toBeGreaterThan(removed.generation);
	vi.runAllTimers();
	expect(published).toEqual([]);
	expect(documents.snapshot('a')?.text).toBe('restored');
	documents.clear();
	expect(documents.isCurrent(reopened)).toBe(false);
});

it('keeps the pending revision after a read failure and permits an explicit retry', () => {
	const published: string[] = [];
	const documents = new DocumentRevisions(
		({ text }) => published.push(text),
		() => {}
	);
	const base = documents.open('a', 'A');
	let unavailable = true;
	const revision = documents.apply({
		base,
		edits: { kind: 'text' },
		readText: () => {
			if (unavailable) throw new Error('snapshot-unavailable');
			return 'retained';
		}
	})!;
	expect(() => documents.flush('a')).toThrow('snapshot-unavailable');
	expect(documents.isCurrent(revision)).toBe(true);
	unavailable = false;
	expect(documents.flush('a')?.text).toBe('retained');
	expect(published).toEqual(['retained']);
});

it('does not publish a snapshot superseded while its lazy reader runs', () => {
	const published: string[] = [];
	const documents = new DocumentRevisions(
		({ text }) => published.push(text),
		() => {}
	);
	const base = documents.open('a', 'A');
	const old = documents.apply({
		base,
		edits: { kind: 'text' },
		readText: () => {
			documents.apply({ base: old!, edits: { kind: 'text' }, readText: () => 'newest' });
			return 'obsolete';
		}
	});
	documents.flush('a');
	expect(published).not.toContain('obsolete');
	expect(documents.flush('a')?.text).toBe('newest');
	expect(published).toEqual(['newest']);
});
