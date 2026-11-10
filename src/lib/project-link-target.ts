import { pathKey, resolveProjectPath } from './project-paths';

/**
 * Finds the one project file for a canonical destination. The comparison uses
 * the same path key as project storage, so case and Unicode normalization
 * variants resolve together. A malformed library with two rows for one key is
 * ambiguous and resolves to no target.
 */
export function findProjectDocument<T extends { projectId?: string; relativePath?: string }>(
	files: readonly T[],
	projectId: string,
	path: string
): T | null {
	let key: string;
	try {
		key = pathKey(path);
	} catch {
		return null;
	}
	const matches = files.filter((file) => {
		if (file.projectId !== projectId || !file.relativePath) return false;
		try {
			return pathKey(file.relativePath) === key;
		} catch {
			return false;
		}
	});
	return matches.length === 1 ? matches[0]! : null;
}

export interface ResolvedProjectLink {
	targetId: string;
	anchor: { id: string; fragment: string } | null;
}

/** Resolves a Read-mode destination and its heading anchor in one call. */
export function resolveProjectLink<
	T extends { id: string; projectId?: string; relativePath?: string }
>(files: readonly T[], source: T, destination: string): ResolvedProjectLink | null {
	if (!source.projectId || !source.relativePath) return null;
	const path = resolveProjectPath(source.relativePath, destination);
	if (!path) return null;
	const target = findProjectDocument(files, source.projectId, path);
	if (!target) return null;
	return { targetId: target.id, anchor: projectAnchor(target.id, destination) };
}

/** Decodes the heading fragment for the opened project document. */
export function projectAnchor(
	id: string,
	destination: string
): { id: string; fragment: string } | null {
	const fragment = destination.split('#').slice(1).join('#');
	if (!fragment) return null;
	try {
		return { id, fragment: decodeURIComponent(fragment) };
	} catch {
		return null;
	}
}
