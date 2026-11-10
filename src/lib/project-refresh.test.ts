import { describe, expect, it } from 'vitest';
import { PROJECT_REFRESH_RACY_WINDOW_MS, shouldReadProjectEntry } from './project-archive';
import type { ProjectEntryStamp } from './project-archive';

function stamp(overrides: Partial<ProjectEntryStamp> = {}): ProjectEntryStamp {
	return {
		kind: 'markdown',
		relativePath: 'notes/start.md',
		mtimeMs: 1_000,
		size: 12,
		first: 7,
		second: 11,
		revision: 'sha256:aaa',
		...overrides
	};
}

describe('native project refresh decision', () => {
	it('skips a read when the verified metadata is old and unchanged', () => {
		expect(shouldReadProjectEntry(stamp(), stamp(), 10_000)).toBe(false);
	});

	it('reads a file again when a same-time write can share the recorded stamp', () => {
		const now = 1_000 + PROJECT_REFRESH_RACY_WINDOW_MS - 1;
		expect(shouldReadProjectEntry(stamp(), stamp(), now)).toBe(true);
	});

	it('reads a file when its identity, size, kind, or time changes', () => {
		for (const change of [
			{ second: 12 },
			{ size: 13 },
			{ mtimeMs: 2_000 },
			{ kind: 'asset' as const }
		]) {
			expect(shouldReadProjectEntry(stamp(), stamp(change), 10_000)).toBe(true);
		}
	});

	it('reads a file when the stored entry has no verified revision', () => {
		expect(shouldReadProjectEntry(stamp({ revision: '' }), stamp(), 10_000)).toBe(true);
		expect(shouldReadProjectEntry(undefined, stamp(), 10_000)).toBe(true);
	});
});
