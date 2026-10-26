import { describe, it, expect, vi } from 'vitest';
import { handleCrossTabPolicy, type CrossTabPolicyHost } from './cross-tab-policy';
import { t } from '#lib/i18n/index.js';

function mockHost(
	partial: Partial<CrossTabPolicyHost> & {
		loaded?: string[];
		pending?: string[];
		names?: Record<string, string>;
	} = {}
): CrossTabPolicyHost {
	const loaded = new Set(partial.loaded ?? []);
	const pending = new Set(partial.pending ?? []);
	const names = partial.names ?? {};
	return {
		isLoaded: (id) => loaded.has(id),
		isPending: (id) => pending.has(id),
		hasAnyPending: () => pending.size > 0,
		fileName: (id) => names[id] ?? id,
		syncDraft: vi.fn(async (_id: string) => {}),
		closeRemoved: vi.fn((_id: string) => {}),
		reloadQuiet: vi.fn(() => {}),
		reloadSiblings: vi.fn(() => {}),
		invalidateAll: vi.fn(() => {}),
		notifyConflict: vi.fn((_message: string) => {}),
		t,
		...partial
	};
}

describe('handleCrossTabPolicy', () => {
	it('notifies without discarding dirty writers on backup-applied', () => {
		const dirty = mockHost({ loaded: ['a'], pending: ['a'], names: { a: 'note.md' } });
		handleCrossTabPolicy({ type: 'backup-applied' }, dirty);
		expect(vi.mocked(dirty.invalidateAll)).not.toHaveBeenCalled();
		expect(vi.mocked(dirty.notifyConflict)).toHaveBeenCalledOnce();
		expect(vi.mocked(dirty.reloadQuiet)).not.toHaveBeenCalled();
	});
});
