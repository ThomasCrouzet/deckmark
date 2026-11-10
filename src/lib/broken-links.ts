import type { FileItem } from './types';
import { checkHandle, getHandle, getPathLink, isFSASupported } from './fsa';
import { isDesktop } from './desktop';
import { tauriCheckPath } from './disk-tauri';
import type { PathLinkRecord } from './disk-link';

/**
 * Per-file result after checking its disk handle. The store applies
 * `brokenLink` (and resets `linkedToDisk` when the handle disappears entirely)
 * directly on the corresponding `FileItem`.
 */
export type BrokenLinkIdentity =
	{ kind: 'path'; path: string } | { kind: 'handle'; handle: FileSystemFileHandle | null };

export interface BrokenLinkUpdate {
	id: string;
	brokenLink: boolean;
	handleMissing: boolean;
	/** The link that was actually checked, so a late result can be fenced. */
	link: BrokenLinkIdentity;
}

/**
 * Computes the "broken link" state for each file marked `linkedToDisk`. Pure
 * (no side-effect on the files passed as arguments): returns an array of
 * updates that the caller applies to the store. This lets the logic be tested
 * without mounting the full store (which depends on Svelte 5 runes).
 *
 * Injectable deps allow mocking FSA and path checks in unit tests.
 */
export async function computeBrokenLinks(
	files: ReadonlyArray<FileItem>,
	deps: {
		getHandleFn?: typeof getHandle;
		checkHandleFn?: typeof checkHandle;
		getPathLinkFn?: (id: string) => Promise<PathLinkRecord | null>;
		checkPathFn?: (path: string) => Promise<'ok' | 'broken' | 'permission-needed'>;
	} = {}
): Promise<BrokenLinkUpdate[]> {
	const get = deps.getHandleFn ?? getHandle;
	const check = deps.checkHandleFn ?? checkHandle;
	const getPath = deps.getPathLinkFn ?? getPathLink;
	const checkPath = deps.checkPathFn ?? tauriCheckPath;
	const candidates = files.filter((f) => f.linkedToDisk);
	const updates = new Array<BrokenLinkUpdate>(candidates.length);
	let next = 0;
	const worker = async () => {
		while (next < candidates.length) {
			const index = next++;
			const file = candidates[index]!;
			const pathRec = await getPath(file.id);
			if (pathRec) {
				const status = await checkPath(pathRec.path);
				updates[index] = {
					id: file.id,
					brokenLink: status === 'broken',
					handleMissing: false,
					link: { kind: 'path', path: pathRec.path }
				};
				continue;
			}
			const handle = await get(file.id);
			if (!handle) {
				updates[index] = {
					id: file.id,
					brokenLink: true,
					handleMissing: true,
					link: { kind: 'handle', handle: null }
				};
				continue;
			}
			const status = await check(handle);
			updates[index] = {
				id: file.id,
				brokenLink: status === 'broken',
				handleMissing: false,
				link: { kind: 'handle', handle }
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
