// Pure provenance and synchronization state for one document.
//
// A browser draft is not a disk file. Keep the two facts separate so the UI
// never labels an autosaved draft as safely written to disk.

export type StorageOrigin = 'draft' | 'temporary' | 'disk' | 'broken';
export type StorageSync = 'saved' | 'pending' | 'error' | 'conflict' | 'broken';

export interface StorageStatusInput {
	origin?: 'created' | 'imported' | 'template' | undefined;
	linkedToDisk?: boolean | undefined;
	brokenLink?: boolean | undefined;
	dirty?: boolean | undefined;
	saveError?: boolean | undefined;
	conflict?: boolean | undefined;
}

export interface StorageStatus {
	origin: StorageOrigin;
	sync: StorageSync;
}

export function resolveStorageStatus(input: StorageStatusInput): StorageStatus {
	const origin: StorageOrigin = input.brokenLink
		? 'broken'
		: input.linkedToDisk
			? 'disk'
			: input.origin === 'imported'
				? 'temporary'
				: 'draft';
	const sync: StorageSync = input.conflict
		? 'conflict'
		: input.saveError
			? 'error'
			: input.brokenLink
				? 'broken'
				: input.dirty
					? 'pending'
					: 'saved';
	return { origin, sync };
}
