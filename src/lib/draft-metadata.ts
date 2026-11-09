// Encoder for the durable derived metadata projection.
//
// The codec lives in `draft-metadata-codec.ts` so readers do not pull the
// frontmatter and wiki scanners into the boot bundle.

import { db, type DraftRow } from './db';
import { fastFrontmatter } from './metadata-derive';
export const DRAFT_METADATA_VERSION = 2;

export interface DraftMetadata {
	id: string;
	contentHash: string;
	contentLength: number;
	title: string;
	documentTitle: string;
	tags: string[];
	targets: string[];
	/** The body defines or includes a linked block. */
	hasBlocks: boolean;
	hasIncludes: boolean;
}

/** Decodes a metadata index key. Returns null for unknown or damaged values. */
export function decodeDraftMetadata(key: unknown): DraftMetadata | null {
	if (typeof key !== 'string') return null;
	let value: unknown;
	try {
		value = JSON.parse(key);
	} catch {
		return null;
	}
	if (!Array.isArray(value) || value.length !== 10) return null;
	const [
		version,
		id,
		contentHash,
		contentLength,
		title,
		documentTitle,
		tags,
		targets,
		hasBlocks,
		hasIncludes
	] = value;
	if (version !== DRAFT_METADATA_VERSION) return null;
	if (
		typeof id !== 'string' ||
		typeof contentHash !== 'string' ||
		typeof contentLength !== 'number' ||
		typeof title !== 'string' ||
		typeof documentTitle !== 'string' ||
		!Array.isArray(tags) ||
		!tags.every((tag) => typeof tag === 'string') ||
		!Array.isArray(targets) ||
		!targets.every((target) => typeof target === 'string') ||
		(hasBlocks !== 0 && hasBlocks !== 1) ||
		(hasIncludes !== 0 && hasIncludes !== 1)
	)
		return null;
	return {
		id,
		contentHash,
		contentLength,
		title,
		documentTitle,
		tags,
		targets,
		hasBlocks: hasBlocks === 1,
		hasIncludes: hasIncludes === 1
	};
}

function hashContent(content: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < content.length; index++) {
		hash ^= content.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

function splitFrontmatter(content: string): { raw: string; body: string } {
	const prefix = content.startsWith('\uFEFF') ? '\uFEFF' : '';
	const source = content.slice(prefix.length);
	const match = /^(---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/.exec(source);
	return { raw: match?.[1] ?? '', body: source.slice(match?.[0].length ?? 0) };
}

function isNoteRow(row: DraftRow): boolean {
	if (row.kind) return row.kind === 'note';
	return /\.(?:md|markdown|mdx)$/i.test(row.name);
}

function textTargets(content: string): string[] {
	const { body } = splitFrontmatter(content);
	const withoutFences = body
		.replace(/^ {0,3}(```+|~~~+)[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, '')
		.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*$/gm, '')
		.replace(/^(?: {4}|\t).*$/gm, '')
		.replace(/`[^`\n]*`/g, '');
	const targets = new Set<string>();
	for (const match of withoutFences.matchAll(/\[\[([^[\]|\n]+)(?:\|[^[\]\n]*)?\]\]/g)) {
		const target = match[1]?.trim();
		if (target) targets.add(target);
	}
	return [...targets];
}

function fallbackTitle(name: string, body: string): string {
	const heading = /^[ \t]*#[ \t]+(.+?)[ \t]*$/m.exec(body)?.[1]?.trim();
	if (heading) return heading;
	return name.replace(/\.[^.]+$/, '') || name;
}

export function draftMetadataFor(row: DraftRow): DraftMetadata {
	const { raw, body } = splitFrontmatter(row.content);
	const fast = raw ? fastFrontmatter(raw) : {};
	const fallback = fallbackTitle(row.name, body);
	const title = fast.title?.trim() || fallback;
	const note = isNoteRow(row);
	return {
		id: row.id,
		contentHash: hashContent(row.content),
		contentLength: row.content.length,
		title,
		documentTitle: title,
		tags: note ? (fast.tags ?? []) : [],
		targets: note ? textTargets(row.content) : [],
		hasBlocks: /<!--\s*mdsh-block\b/.test(row.content),
		hasIncludes: /<!--\s*mdsh-include\b/.test(row.content)
	};
}

/** Encodes the metadata index key. Keep the field order stable. */
export function encodeDraftMetadata(row: DraftRow): string {
	const metadata = draftMetadataFor(row);
	return JSON.stringify([
		DRAFT_METADATA_VERSION,
		metadata.id,
		metadata.contentHash,
		metadata.contentLength,
		metadata.title,
		metadata.documentTitle,
		metadata.tags,
		metadata.targets,
		metadata.hasBlocks ? 1 : 0,
		metadata.hasIncludes ? 1 : 0
	]);
}

let installed = false;

export function installDraftMetadataHooks(): void {
	if (installed) return;
	installed = true;
	db.drafts.hook('creating', (_primaryKey, row) => {
		row.metadata = encodeDraftMetadata(row);
	});
	db.drafts.hook('updating', (modifications, _primaryKey, row) => {
		return { metadata: encodeDraftMetadata({ ...row, ...modifications } as DraftRow) };
	});
}

/** Fills missing projections in idle-sized batches, without retaining bodies. */
export async function backfillDraftMetadata(): Promise<void> {
	installDraftMetadataHooks();
	const ids = await db.drafts.toCollection().primaryKeys();
	for (let offset = 0; offset < ids.length; offset += 25) {
		const rows = await db.drafts.bulkGet(ids.slice(offset, offset + 25));
		const present = rows.filter((row): row is DraftRow => row !== undefined);
		if (present.length) {
			await db.drafts.bulkPut(
				present.map((row) => ({ ...row, metadata: encodeDraftMetadata(row) }))
			);
		}
		await new Promise<void>((resolve) => {
			if (typeof requestIdleCallback === 'function')
				requestIdleCallback(() => resolve(), { timeout: 200 });
			else setTimeout(resolve, 50);
		});
	}
}
