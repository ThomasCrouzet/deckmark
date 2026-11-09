import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	isQuotaError,
	reportPersistenceError,
	requestPersistentStorage,
	checkStoragePressure,
	getStorageHealth
} from './storage';
import { notify } from './notify.svelte';
import { db } from './db';

const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
function mockStorage(value: unknown): void {
	Object.defineProperty(navigator, 'storage', { value, configurable: true, writable: true });
}

beforeEach(() => {
	notify.clear();
	localStorage.clear();
});
afterEach(() => {
	if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage);
	else mockStorage(undefined);
	vi.restoreAllMocks();
});

describe('isQuotaError', () => {
	it('recognizes the legacy Firefox name', () => {
		expect(isQuotaError(new DOMException('plein', 'NS_ERROR_DOM_QUOTA_REACHED'))).toBe(true);
	});
});

describe('reportPersistenceError', () => {
	it('shows a generic message for other contexts', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		reportPersistenceError(new Error('x'), 'trash');
		expect(notify.toasts[0]!.message).toContain('opération de stockage local');
	});
});

describe('requestPersistentStorage', () => {
	it('fail-soft si persist() throw', async () => {
		mockStorage({
			persisted: async () => false,
			persist: async () => {
				throw new Error('nope');
			}
		});
		expect(await requestPersistentStorage()).toBe(false);
	});
});

describe('storage health', () => {
	it('falls back safely when persistence metadata APIs fail', async () => {
		mockStorage({
			persisted: async () => {
				throw new Error('blocked');
			},
			estimate: async () => ({})
		});
		await expect(getStorageHealth()).resolves.toMatchObject({
			persistence: 'best-effort',
			usage: null,
			quota: null
		});
	});

	it('sums asset bytes from the index without reading binary bodies', async () => {
		await db.projectAssets.clear();
		await db.projectAssets.bulkAdd([
			{
				id: 'a',
				projectId: 'p',
				path: 'a.png',
				mime: 'image/png',
				data: new Uint8Array(1234)
			},
			{
				id: 'b',
				projectId: 'p',
				path: 'b.png',
				mime: 'image/png',
				data: new Uint8Array(66)
			}
		]);
		const each = vi.spyOn(db.projectAssets, 'each');
		await expect(getStorageHealth()).resolves.toMatchObject({
			projectAssetCount: 2,
			projectAssetBytes: 1300
		});
		expect(each).not.toHaveBeenCalled();
		each.mockRestore();
		await db.projectAssets.clear();
	});

	it('ignores unavailable quota values and estimate failures', async () => {
		mockStorage({ estimate: async () => ({ usage: 0, quota: 100 }) });
		await checkStoragePressure();
		expect(notify.toasts).toHaveLength(0);
		mockStorage({
			estimate: async () => {
				throw new Error('blocked');
			}
		});
		await expect(checkStoragePressure()).resolves.toBeUndefined();
	});
});
