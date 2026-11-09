import type { DraftRow, ProjectAssetRow } from './db';
import { pathKey, projectPath } from './project-paths';

/** Assigns a free sibling path while retaining the project and relative destinations. */
export function projectConflictVariant(
	row: DraftRow,
	documents: readonly DraftRow[],
	assets: readonly ProjectAssetRow[],
	occupiedPaths?: ReadonlySet<string>
): DraftRow {
	if (!row.projectId || !row.relativePath) return row;
	const parts = row.relativePath.split('/');
	const originalName = parts.pop()!;
	const parent = parts.length ? `${parts.join('/')}/` : '';
	const dot = originalName.lastIndexOf('.');
	const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
	const extension = dot > 0 ? originalName.slice(dot) : '';
	const occupied =
		occupiedPaths ??
		new Set(
			[
				...documents
					.filter((document) => document.projectId === row.projectId)
					.flatMap((document) => (document.relativePath ? [pathKey(document.relativePath)] : [])),
				...assets
					.filter((asset) => asset.projectId === row.projectId)
					.map((asset) => pathKey(asset.path))
			].map((path) => path.toLowerCase())
		);
	let sequence = 2;
	while (true) {
		const suffix = ` (${sequence})`;
		const stemLimit = Math.max(1, 1024 - parent.length - extension.length - suffix.length);
		const name = `${stem.slice(0, stemLimit)}${suffix}${extension}`;
		const relativePath = projectPath(`${parent}${name}`);
		if (!occupied.has(pathKey(relativePath).toLowerCase())) {
			return { ...row, name, relativePath };
		}
		sequence += 1;
	}
}
