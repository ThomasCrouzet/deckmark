import { parseFrontmatter } from './frontmatter';
import { documentKindForFile } from './document-kind';
import type { FileItem } from './types';

export interface CollectionRow {
	id: string;
	name: string;
	title: string;
	projectId?: string;
	relativePath?: string;
	updatedAt: number;
	values: Record<string, string | number | boolean | string[]>;
}

export interface CollectionView {
	id: string;
	name: string;
	filter: string;
	sortKey: string;
	sortDirection: 'asc' | 'desc';
	groupKey: string;
	mode: 'table' | 'board';
}

const STORAGE_KEY = 'mdsh:collection-views';

function scalar(value: unknown): string | number | boolean | string[] | null {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
		return value;
	if (Array.isArray(value)) return value.map((item) => String(item));
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	return null;
}

/** Reads front matter into a table-friendly shape. Image and code files are skipped. */
export async function buildCollection(files: readonly FileItem[]): Promise<CollectionRow[]> {
	const rows: CollectionRow[] = [];
	for (const file of files) {
		if (documentKindForFile(file) !== 'note') continue;
		const parsed = await parseFrontmatter(file.content);
		const values: CollectionRow['values'] = {};
		for (const [key, raw] of Object.entries(parsed.data)) {
			const value = scalar(raw);
			if (value !== null) values[key] = value;
		}
		rows.push({
			id: file.id,
			name: file.name,
			title:
				typeof parsed.data.title === 'string' && parsed.data.title.trim()
					? parsed.data.title.trim()
					: file.name.replace(/\.[^.]+$/, ''),
			...(file.projectId ? { projectId: file.projectId } : {}),
			...(file.relativePath ? { relativePath: file.relativePath } : {}),
			updatedAt: file.updatedAt,
			values
		});
	}
	return rows;
}

export function collectionColumns(rows: readonly CollectionRow[]): string[] {
	const keys = new Set<string>();
	for (const row of rows) for (const key of Object.keys(row.values)) keys.add(key);
	return [...keys].sort((a, b) => a.localeCompare(b));
}

function comparable(value: CollectionRow['values'][string] | undefined): string | number {
	if (value === undefined) return '';
	if (Array.isArray(value)) return value.join(', ').toLowerCase();
	if (typeof value === 'number') return value;
	if (typeof value === 'boolean') return value ? 0 : 1;
	return value.toLowerCase();
}

export function filterRows(rows: readonly CollectionRow[], query: string): CollectionRow[] {
	const value = query.trim().toLowerCase();
	if (!value) return [...rows];
	return rows.filter((row) =>
		`${row.title} ${row.name} ${row.relativePath ?? ''} ${Object.values(row.values)
			.map((entry) => (Array.isArray(entry) ? entry.join(' ') : String(entry)))
			.join(' ')}`
			.toLowerCase()
			.includes(value)
	);
}

export function sortRows(
	rows: readonly CollectionRow[],
	key: string,
	direction: 'asc' | 'desc'
): CollectionRow[] {
	const sorted = [...rows].sort((a, b) => {
		const left =
			key === 'title'
				? a.title.toLowerCase()
				: key === 'updatedAt'
					? a.updatedAt
					: comparable(a.values[key]);
		const right =
			key === 'title'
				? b.title.toLowerCase()
				: key === 'updatedAt'
					? b.updatedAt
					: comparable(b.values[key]);
		if (left < right) return -1;
		if (left > right) return 1;
		return a.title.localeCompare(b.title);
	});
	return direction === 'asc' ? sorted : sorted.reverse();
}

export function groupRows(
	rows: readonly CollectionRow[],
	key: string
): Array<{ key: string; rows: CollectionRow[] }> {
	if (!key) return [{ key: '', rows: [...rows] }];
	const groups = new Map<string, CollectionRow[]>();
	for (const row of rows) {
		const raw = key === 'title' ? row.title : row.values[key];
		const value = Array.isArray(raw) ? raw.join(', ') : raw === undefined ? '' : String(raw);
		const label = value.trim() || 'None';
		const list = groups.get(label) ?? [];
		list.push(row);
		groups.set(label, list);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([group, list]) => ({ key: group, rows: list }));
}

export function readCollectionViews(): CollectionView[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const values = JSON.parse(raw) as unknown;
		return Array.isArray(values)
			? values.filter((value): value is CollectionView => {
					if (!value || typeof value !== 'object') return false;
					const view = value as Partial<CollectionView>;
					return (
						typeof view.id === 'string' &&
						typeof view.name === 'string' &&
						typeof view.filter === 'string' &&
						typeof view.sortKey === 'string' &&
						(view.sortDirection === 'asc' || view.sortDirection === 'desc') &&
						typeof view.groupKey === 'string' &&
						(view.mode === 'table' || view.mode === 'board')
					);
				})
			: [];
	} catch {
		return [];
	}
}

export function saveCollectionViews(views: readonly CollectionView[]): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
}
