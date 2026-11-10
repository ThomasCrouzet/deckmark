// Native project refresh decision.
//
// A metadata manifest is cheaper than a full snapshot, but a timestamp and a
// size alone cannot prove that the bytes did not change. The caller must read
// an entry again when the metadata differs, when no verified revision exists,
// or while the write time is close to the scan time. The last rule covers two
// writes within one filesystem timestamp tick.

export interface ProjectEntryStamp {
	kind: 'markdown' | 'asset';
	relativePath: string;
	mtimeMs: number;
	size: number;
	first: number;
	second: number;
	revision: string;
}

export type ProjectEntryMetadata = Omit<ProjectEntryStamp, 'revision'>;

/** Window in which a file write may share its timestamp with a scan. */
export const PROJECT_REFRESH_RACY_WINDOW_MS = 2_000;

export function shouldReadProjectEntry(
	known: ProjectEntryStamp | undefined,
	current: ProjectEntryMetadata,
	now = Date.now()
): boolean {
	if (!known || known.revision === '') return true;
	if (
		known.kind !== current.kind ||
		known.mtimeMs !== current.mtimeMs ||
		known.size !== current.size ||
		known.first !== current.first ||
		known.second !== current.second
	)
		return true;
	return Math.abs(now - current.mtimeMs) < PROJECT_REFRESH_RACY_WINDOW_MS;
}
