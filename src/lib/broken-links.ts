import type { FileItem } from './types';
import {
	checkHandle,
	getFsaLink,
	getHandle,
	getPathLink,
	getPathLinkWithEpoch,
	isFSASupported
} from './fsa';
import { isDesktop } from './desktop';
import { tauriCheckPath } from './disk-tauri';
import { getDiskLinkEpoch } from './db';
import type { PathLinkRecord } from './disk-link';

/**
 * Per-file result after checking its disk handle. The store applies
 * `brokenLink` (and resets `linkedToDisk` when the handle disappears entirely)
 * directly on the corresponding `FileItem`.
 */
export type BrokenLinkIdentity =
	| { kind: 'path'; path: string; epoch: string; revision?: string }
	| { kind: 'handle'; handle: FileSystemFileHandle | null; epoch: string };

export interface BrokenLinkUpdate {
	id: string;
	brokenLink: boolean;
	handleMissing: boolean;
	/** The exact link that was checked, so a late result can be fenced. */
	link: BrokenLinkIdentity;
}

/**
 * Computes the "broken link" state for each file marked `linkedToDisk`. Pure
 * (no side-effect on the files passed as arguments): returns an array of
 * updates that the caller applies to the store. This lets the logic be tested
 * without mounting the full store (which depends on Svelte 5 runes).
 *
 * Injectable deps allow mocking FSA, path checks and the link epoch in unit tests.
 */
export async function computeBrokenLinks(
	files: ReadonlyArray<FileItem>,
	deps: {
		getHandleFn?: typeof getHandle;
		checkHandleFn?: typeof checkHandle;
		getPathLinkFn?: (id: string) => Promise<PathLinkRecord | null>;
		getPathLinkWithEpochFn?: typeof getPathLinkWithEpoch;
		getFsaLinkFn?: typeof getFsaLink;
		getEpochFn?: () => Promise<string>;
		checkPathFn?: (path: string) => Promise<'ok' | 'broken' | 'permission-needed'>;
	} = {}
): Promise<BrokenLinkUpdate[]> {
	const get = deps.getHandleFn ?? getHandle;
	const check = deps.checkHandleFn ?? checkHandle;
	const getPath = deps.getPathLinkFn ?? getPathLink;
	const checkPath = deps.checkPathFn ?? tauriCheckPath;
	const epoch = deps.getEpochFn ? await deps.getEpochFn() : await getDiskLinkEpoch();
	const candidates = files.filter((f) => f.linkedToDisk);
	const updates = new Array<BrokenLinkUpdate>(candidates.length);
	let next = 0;
	const worker = async () => {
		while (next < candidates.length) {
			const index = next++;
			const file = candidates[index]!;
			let pathRecord: PathLinkRecord | null;
			let linkEpoch = epoch;
			let revision: string | undefined;
			if (deps.getPathLinkWithEpochFn) {
				const stored = await deps.getPathLinkWithEpochFn(file.id);
				pathRecord = stored?.record ?? null;
				if (stored) {
					linkEpoch = stored.epoch;
					revision = stored.revision;
				}
			} else {
				pathRecord = await getPath(file.id);
			}
			if (pathRecord) {
				const status = await checkPath(pathRecord.path);
				updates[index] = {
					id: file.id,
					brokenLink: status === 'broken',
					handleMissing: false,
					link: {
						kind: 'path',
						path: pathRecord.path,
						epoch: linkEpoch,
						...(revision ? { revision } : {})
					}
				};
				continue;
			}
			let handle: FileSystemFileHandle | null;
			if (deps.getFsaLinkFn) {
				const stored = await deps.getFsaLinkFn(file.id);
				handle = stored?.handle ?? (await get(file.id));
				if (stored) linkEpoch = stored.epoch;
			} else {
				handle = await get(file.id);
			}
			if (!handle) {
				updates[index] = {
					id: file.id,
					brokenLink: true,
					handleMissing: true,
					link: { kind: 'handle', handle: null, epoch: linkEpoch }
				};
				continue;
			}
			const status = await check(handle);
			updates[index] = {
				id: file.id,
				brokenLink: status === 'broken',
				handleMissing: false,
				link: { kind: 'handle', handle, epoch: linkEpoch }
			};
		}
	};
	// Bound concurrent IDB and native stat work so a large linked library does
	// not submit hundreds of checks at once after startup.
	await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, () => worker()));
	return updates;
}

/**
 * Short guard that determines whether the environment supports checking disk
 * links (FSA and/or desktop path links). Lets callers (the store) avoid useless
 * calls on Firefox / Safari where `linkedToDisk` was never set anyway.
 */
export function canCheckBrokenLinks(): boolean {
	return isFSASupported() || isDesktop();
}
