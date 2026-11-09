// Metadata-only trash projection. Startup must not load every trashed body.
//
// The codec has no parser imports and is safe for the boot bundle.

export const TRASH_SUMMARY_VERSION = 1;

export interface TrashSummary {
	id: string;
	name: string;
	projectId?: string;
	relativePath?: string;
	kind?: 'note' | 'presentation' | 'code' | 'image' | 'pdf';
	mime?: string;
	createdAt: number;
	updatedAt: number;
	order: number;
	trashedAt: number;
	contentLength: number;
	hasData: boolean;
}

export function encodeTrashSummary(row: {
	id: string;
	file: {
		id: string;
		name: string;
		projectId?: string;
		relativePath?: string;
		kind?: TrashSummary['kind'];
		mime?: string;
		createdAt: number;
		updatedAt: number;
		content: string;
		data?: string;
	};
	order: number;
	trashedAt: number;
}): string {
	return JSON.stringify([
		TRASH_SUMMARY_VERSION,
		row.id,
		row.file.name,
		row.file.projectId ?? '',
		row.file.relativePath ?? '',
		row.file.kind ?? '',
		row.file.mime ?? '',
		row.file.createdAt,
		row.file.updatedAt,
		row.order,
		row.trashedAt,
		row.file.content.length,
		row.file.data ? 1 : 0
	]);
}

export function decodeTrashSummary(key: unknown): TrashSummary | null {
	if (typeof key !== 'string') return null;
	let value: unknown;
	try {
		value = JSON.parse(key);
	} catch {
		return null;
	}
	if (!Array.isArray(value) || value.length !== 13) return null;
	const [
		version,
		id,
		name,
		projectId,
		relativePath,
		kind,
		mime,
		createdAt,
		updatedAt,
		order,
		trashedAt,
		contentLength,
		hasData
	] = value;
	if (version !== TRASH_SUMMARY_VERSION) return null;
	if (
		typeof id !== 'string' ||
		typeof name !== 'string' ||
		typeof projectId !== 'string' ||
		typeof relativePath !== 'string' ||
		typeof kind !== 'string' ||
		typeof mime !== 'string' ||
		typeof createdAt !== 'number' ||
		typeof updatedAt !== 'number' ||
		typeof order !== 'number' ||
		typeof trashedAt !== 'number' ||
		typeof contentLength !== 'number' ||
		(hasData !== 0 && hasData !== 1)
	)
		return null;
	return {
		id,
		name,
		...(projectId ? { projectId } : {}),
		...(relativePath ? { relativePath } : {}),
		...(kind ? { kind: kind as NonNullable<TrashSummary['kind']> } : {}),
		...(mime ? { mime } : {}),
		createdAt,
		updatedAt,
		order,
		trashedAt,
		contentLength,
		hasData: hasData === 1
	};
}
