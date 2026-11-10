import type { FileItem } from './types';

export interface ProjectTreeFolder {
	name: string;
	path: string;
	folders: ProjectTreeFolder[];
	files: FileItem[];
}

export interface ProjectTreeRoot {
	id: string;
	name: string;
	folders: ProjectTreeFolder[];
	files: FileItem[];
}

export interface ProjectTreeStats {
	/** Folders created by the build. */
	folders: number;
	/** Documents placed in the tree. */
	files: number;
	/** Path segments visited. */
	pathSegments: number;
	/** Linear searches of a sibling list. A Map index must keep this at zero. */
	siblingScans: number;
}

export interface ProjectTreeResult {
	roots: ProjectTreeRoot[];
	stats: ProjectTreeStats;
}

function compareNames(left: { name: string }, right: { name: string }): number {
	return left.name.localeCompare(right.name);
}

function sortFolder(folder: ProjectTreeFolder): void {
	folder.folders.sort(compareNames);
	folder.files.sort(compareNames);
	for (const child of folder.folders) sortFolder(child);
}

/**
 * Builds the project tree with one index lookup per path segment.
 *
 * The index key combines the project ID and the normalized full folder path,
 * so sibling width never changes the lookup cost. Children are sorted by name
 * at every level, independently from document order.
 */
export function buildProjectTree(
	documents: readonly FileItem[],
	projects: readonly { id: string; name: string }[]
): ProjectTreeResult {
	const roots = new Map<string, ProjectTreeRoot>();
	const folders = new Map<string, ProjectTreeFolder>();
	for (const project of projects)
		roots.set(project.id, { id: project.id, name: project.name, folders: [], files: [] });
	const stats: ProjectTreeStats = { folders: 0, files: 0, pathSegments: 0, siblingScans: 0 };
	for (const file of documents) {
		if (!file.projectId) continue;
		let root = roots.get(file.projectId);
		if (!root) {
			root = { id: file.projectId, name: file.projectId, folders: [], files: [] };
			roots.set(file.projectId, root);
		}
		const parts = (file.relativePath ?? file.name).split('/');
		parts.pop();
		let folder: ProjectTreeFolder = {
			name: root.name,
			path: '',
			folders: root.folders,
			files: root.files
		};
		let path = '';
		for (const part of parts) {
			stats.pathSegments++;
			path = path ? `${path}/${part}` : part;
			const key = `${file.projectId}\u0000${path}`;
			let child = folders.get(key);
			if (!child) {
				child = { name: part, path, folders: [], files: [] };
				folders.set(key, child);
				folder.folders.push(child);
				stats.folders++;
			}
			folder = child;
		}
		folder.files.push(file);
		stats.files++;
	}
	const ordered = Array.from(roots.values());
	for (const root of ordered) sortFolder(root);
	ordered.sort(compareNames);
	return { roots: ordered, stats };
}
