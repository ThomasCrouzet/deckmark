import type { DocumentKind } from './document-kind';

// Compact index key for the saved-template catalog. The full Markdown body is
// read only when a template is selected or edited.
export const TEMPLATE_MANIFEST_VERSION = 1;

export interface TemplateManifest {
	id: string;
	name: string;
	builtin: boolean;
	kind: DocumentKind;
	createdAt: number;
	updatedAt: number;
	contentLength: number;
}

export function encodeTemplateManifest(row: {
	id: string;
	name: string;
	builtin: boolean;
	kind?: DocumentKind;
	createdAt: number;
	updatedAt: number;
	content: string;
}): string {
	return JSON.stringify([
		TEMPLATE_MANIFEST_VERSION,
		row.id,
		row.name,
		row.builtin ? 1 : 0,
		row.kind ?? 'note',
		row.createdAt,
		row.updatedAt,
		row.content.length
	]);
}

export function decodeTemplateManifest(key: unknown): TemplateManifest | null {
	if (typeof key !== 'string') return null;
	let value: unknown;
	try {
		value = JSON.parse(key);
	} catch {
		return null;
	}
	if (!Array.isArray(value) || value.length !== 8) return null;
	const [version, id, name, builtin, kind, createdAt, updatedAt, contentLength] = value;
	if (
		version !== TEMPLATE_MANIFEST_VERSION ||
		typeof id !== 'string' ||
		typeof name !== 'string' ||
		(builtin !== 0 && builtin !== 1) ||
		(kind !== 'note' &&
			kind !== 'presentation' &&
			kind !== 'code' &&
			kind !== 'image' &&
			kind !== 'pdf') ||
		typeof createdAt !== 'number' ||
		typeof updatedAt !== 'number' ||
		typeof contentLength !== 'number'
	)
		return null;
	return {
		id,
		name,
		builtin: builtin === 1,
		kind: kind as DocumentKind,
		createdAt,
		updatedAt,
		contentLength
	};
}
