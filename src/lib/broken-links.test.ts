import { describe, it, expect, vi } from 'vitest';
import type { FileItem } from './types';
import { computeBrokenLinks } from './broken-links';

function makeFile(overrides: Partial<FileItem> & { id: string }): FileItem {
	return {
		name: 'test.md',
		content: '',
		createdAt: 0,
		updatedAt: 0,
		dirty: false,
		linkedToDisk: false,
		...overrides
	};
}

describe('computeBrokenLinks', () => {
	it('handle absent → brokenLink: true, handleMissing: true', async () => {
		const files = [makeFile({ id: 'f1', linkedToDisk: true })];
		const getHandleFn = vi.fn().mockResolvedValue(null);
		const checkHandleFn = vi.fn();

		const updates = await computeBrokenLinks(files, {
			getHandleFn,
			checkHandleFn,
			getPathLinkFn: vi.fn().mockResolvedValue(null)
		});

		expect(updates).toHaveLength(1);
		expect(updates[0]).toEqual({
			id: 'f1',
			brokenLink: true,
			handleMissing: true,
			link: { kind: 'handle', handle: null, epoch: 'legacy' }
		});
		expect(checkHandleFn).not.toHaveBeenCalled();
	});

	it('sets brokenLink for a broken path link without an FSA handle', async () => {
		const files = [makeFile({ id: 'p1', linkedToDisk: true })];
		const updates = await computeBrokenLinks(files, {
			getHandleFn: vi.fn(),
			checkHandleFn: vi.fn(),
			getPathLinkFn: vi.fn().mockResolvedValue({ kind: 'path', path: '/tmp/gone.md' }),
			checkPathFn: vi.fn().mockResolvedValue('broken')
		});
		expect(updates[0]).toEqual({
			id: 'p1',
			brokenLink: true,
			handleMissing: false,
			link: { kind: 'path', path: '/tmp/gone.md', epoch: 'legacy' }
		});
	});

	it('marks an existing broken handle as broken but not missing', async () => {
		const fakeHandle = {} as FileSystemFileHandle;
		const files = [makeFile({ id: 'f2', linkedToDisk: true })];
		const getHandleFn = vi.fn().mockResolvedValue(fakeHandle);
		const checkHandleFn = vi.fn().mockResolvedValue('broken');

		const updates = await computeBrokenLinks(files, {
			getHandleFn,
			checkHandleFn,
			getPathLinkFn: vi.fn().mockResolvedValue(null)
		});

		expect(updates).toHaveLength(1);
		expect(updates[0]).toEqual({
			id: 'f2',
			brokenLink: true,
			handleMissing: false,
			link: { kind: 'handle', handle: fakeHandle, epoch: 'legacy' }
		});
	});

	it('does not mark a handle as broken when it needs permission', async () => {
		const fakeHandle = {} as FileSystemFileHandle;
		const files = [makeFile({ id: 'f4', linkedToDisk: true })];
		const getHandleFn = vi.fn().mockResolvedValue(fakeHandle);
		const checkHandleFn = vi.fn().mockResolvedValue('permission-needed');

		const updates = await computeBrokenLinks(files, {
			getHandleFn,
			checkHandleFn,
			getPathLinkFn: vi.fn().mockResolvedValue(null)
		});

		expect(updates).toHaveLength(1);
		expect(updates[0]!.brokenLink).toBe(false);
		expect(updates[0]!.handleMissing).toBe(false);
	});
});
