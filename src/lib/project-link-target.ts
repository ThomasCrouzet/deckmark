import { pathKey } from './project-paths';

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
