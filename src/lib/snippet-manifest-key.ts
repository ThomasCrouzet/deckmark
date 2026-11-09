import type { SnippetRow } from './db';

// Compact index key for the snippet catalog. Code bodies stay in the row and
// are read only for a selected snippet, copy, edit or export.
export const SNIPPET_MANIFEST_VERSION = 1;

export interface SnippetManifest {
	id: string;
	title: string;
	language: string;
	tags: string[];
	folder?: string;
	projectId?: string;
	favorite: boolean;
	createdAt: number;
	updatedAt: number;
	codeHash?: string;
}

export function encodeSnippetManifest(row: SnippetRow): string {
	return JSON.stringify([
		SNIPPET_MANIFEST_VERSION,
		row.id,
		row.title,
		row.language,
		row.tags,
		row.folder ?? '',
		row.projectId ?? '',
		row.favorite ? 1 : 0,
		row.createdAt,
		row.updatedAt,
		row.codeHash ?? ''
	]);
}

export function decodeSnippetManifest(key: unknown): SnippetManifest | null {
	if (typeof key !== 'string') return null;
	let value: unknown;
	try {
		value = JSON.parse(key);
	} catch {
		return null;
	}
	if (!Array.isArray(value) || value.length !== 11) return null;
	const [
		version,
		id,
		title,
		language,
		tags,
		folder,
		projectId,
		favorite,
		createdAt,
		updatedAt,
		codeHash
	] = value;
	if (
		version !== SNIPPET_MANIFEST_VERSION ||
		typeof id !== 'string' ||
		typeof title !== 'string' ||
		typeof language !== 'string' ||
		!Array.isArray(tags) ||
		!tags.every((tag) => typeof tag === 'string') ||
		typeof folder !== 'string' ||
		typeof projectId !== 'string' ||
		(favorite !== 0 && favorite !== 1) ||
		typeof createdAt !== 'number' ||
		typeof updatedAt !== 'number' ||
		typeof codeHash !== 'string'
	)
		return null;
	return {
		id,
		title,
		language,
		tags,
		...(folder ? { folder } : {}),
		...(projectId ? { projectId } : {}),
		favorite: favorite === 1,
		createdAt,
		updatedAt,
		...(codeHash ? { codeHash } : {})
	};
}
