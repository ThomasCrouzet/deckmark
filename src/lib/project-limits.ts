import { IS_DESKTOP_EDITION } from './edition';

/**
 * Project scale limits. Web Light keeps bounded operations for its storage and
 * startup budgets. Desktop Complete raises the limits for large local repos.
 * The Rust scanner in `src-tauri/src/projects.rs` repeats these values.
 */
export const PROJECT_SCALE_LIMITS = IS_DESKTOP_EDITION
	? {
			maxDocuments: 3000,
			maxEntries: 6500,
			maxBytes: 256 * 1024 * 1024,
			maxDepth: 16,
			boundedFolderRows: 250
		}
	: {
			maxDocuments: 300,
			maxEntries: 1300,
			maxBytes: 64 * 1024 * 1024,
			maxDepth: 8,
			boundedFolderRows: 150
		};

/** Entries reserved for project metadata inside the advertised entry budget. */
export const PROJECT_ENTRY_RESERVE = 3;

export interface ProjectOccupancy {
	documents: number;
	assets: number;
	bytes: number;
}

export interface ProjectCapacityChange {
	documents: number;
	assets: number;
	bytes: number;
}

const textEncoder = new TextEncoder();

/** Exact UTF-8 byte length of a planned Markdown or code body. */
export function draftBytes(content: string): number {
	return textEncoder.encode(content).byteLength;
}

/**
 * Decoded byte length of a binary document data URL. The project budget counts
 * decoded payload bytes, not base64 text or the stored string length. A
 * malformed payload uses a conservative base64 estimate and never throws.
 */
export function binaryDataBytes(data: string | undefined): number {
	if (!data) return 0;
	const comma = data.indexOf(',');
	if (comma < 0) return 0;
	const header = data.slice(0, comma);
	const payload = data.slice(comma + 1).replace(/\s/g, '');
	if (/;base64/i.test(header)) {
		if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload))
			return Math.floor((payload.length * 3) / 4);
		const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
		return Math.max(0, (payload.length / 4) * 3 - padding);
	}
	try {
		return textEncoder.encode(decodeURIComponent(payload)).byteLength;
	} catch {
		return payload.length;
	}
}

/** Planned project payload: document source bytes plus decoded binary bytes. */
export function draftPayloadBytes(row: { content: string; data?: string }): number {
	return draftBytes(row.content) + binaryDataBytes(row.data);
}

export function projectDocumentLimit(): number {
	return PROJECT_SCALE_LIMITS.maxDocuments;
}

/**
 * Reads the durable project occupancy from index projections only, so a large
 * project does not load its bodies for a capacity decision. Rows written before
 * the byte projection existed are read once and then replaced on their next save.
 * The storage import stays lazy so pure planning modules can use the limits.
 */
export async function projectOccupancy(projectId: string): Promise<ProjectOccupancy> {
	const { db } = await import('./db');
	const manifestKeys = await db.drafts.orderBy('manifest').keys();
	const legacyIds: string[] = [];
	let documents = 0;
	let documentBytes = 0;
	for (const raw of manifestKeys) {
		try {
			const key = JSON.parse(String(raw)) as unknown[];
			if (key[3] !== projectId) continue;
			documents += 1;
			const contentBytes = typeof key[15] === 'number' ? key[15] : null;
			const hasData = key[14] === 1;
			const binaryBytes = typeof key[16] === 'number' ? key[16] : null;
			// A v1 key has no binary payload length. Read that row once so a
			// typed binary document still counts before its next save.
			if (contentBytes === null || (hasData && binaryBytes === null)) {
				if (typeof key[1] === 'string') legacyIds.push(key[1]);
				continue;
			}
			documentBytes += contentBytes + (binaryBytes ?? 0);
		} catch {
			/* An invalid manifest key is not a project document. */
		}
	}
	if (legacyIds.length) {
		const rows = await db.drafts.bulkGet(legacyIds);
		for (const row of rows) if (row) documentBytes += draftPayloadBytes(row);
	}
	const assetKeys = await db.projectAssets
		.where('[projectId+bytes]')
		.between([projectId, -Infinity], [projectId, Infinity])
		.keys();
	let bytes = documentBytes;
	for (const key of assetKeys)
		if (Array.isArray(key) && typeof key[1] === 'number') bytes += key[1];
	return { documents, assets: assetKeys.length, bytes };
}

/**
 * Rejects a planned project mutation when the durable destination plus the
 * planned change exceeds an advertised limit. A negative document or asset
 * count is valid for a same-project move and reduces the resulting totals.
 */
export function assertProjectCapacity(
	occupancy: ProjectOccupancy,
	change: ProjectCapacityChange,
	entryReserve = PROJECT_ENTRY_RESERVE
): void {
	const documents = occupancy.documents + change.documents;
	const assets = occupancy.assets + change.assets;
	const bytes = occupancy.bytes + change.bytes;
	if (documents > PROJECT_SCALE_LIMITS.maxDocuments) throw new Error('Project document limit');
	if (documents + assets > PROJECT_SCALE_LIMITS.maxEntries - entryReserve)
		throw new Error('Project entry limit');
	if (bytes > PROJECT_SCALE_LIMITS.maxBytes) throw new Error('Project size limit');
}
