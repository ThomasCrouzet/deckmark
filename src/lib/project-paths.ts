import { PROJECT_SCALE_LIMITS } from './project-limits';

/** Project paths use slash separators and remain inside the selected root. */
export function projectPath(value: string): string {
	if (!value || value.length > 1024 || value.includes('\\') || value.startsWith('/')) {
		throw new Error('Invalid project path');
	}
	const parts = value.normalize('NFC').split('/');
	if (
		parts.length > PROJECT_SCALE_LIMITS.maxDepth + 1 ||
		parts.some(
			(part) =>
				!part ||
				part === '.' ||
				part === '..' ||
				// eslint-disable-next-line no-control-regex
				/[\x00-\x1f\x7f:*?"<>|]/.test(part) ||
				/[. ]$/.test(part) ||
				/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
		)
	)
		throw new Error('Invalid project path');
	return parts.join('/');
}

export function pathKey(path: string): string {
	return projectPath(path).toLowerCase();
}

export function isExternalDestination(destination: string): boolean {
	return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(destination.trim());
}

/**
 * Decodes percent escapes in one URL fragment exactly once. A malformed escape
 * keeps the raw fragment so a validator can report it without stopping export.
 */
export function decodeUrlFragment(fragment: string): string {
	try {
		return decodeURIComponent(fragment);
	} catch {
		return fragment;
	}
}

/** Returns the decoded fragment after the first `#`, or null when absent. */
export function fragmentOf(destination: string): string | null {
	const hash = destination.indexOf('#');
	return hash < 0 ? null : decodeUrlFragment(destination.slice(hash + 1));
}

export function resolveProjectPath(from: string, destination: string): string | null {
	if (!destination || destination.startsWith('#') || isExternalDestination(destination))
		return null;
	try {
		const raw = destination.split(/[?#]/, 1)[0]!;
		const decoded = decodeURIComponent(raw).replace(/\\([()])/g, '$1');
		if (decoded.startsWith('/') || decoded.includes('\\')) return null;
		const parts = from.split('/').slice(0, -1);
		for (const part of decoded.split('/')) {
			if (part === '.') continue;
			if (part === '..') {
				if (!parts.length) return null;
				parts.pop();
			} else parts.push(part);
		}
		return projectPath(parts.join('/'));
	} catch {
		return null;
	}
}

export function relativeDestination(from: string, to: string): string {
	const base = from.split('/').slice(0, -1);
	const target = to.split('/');
	while (base.length && target.length && base[0] === target[0]) {
		base.shift();
		target.shift();
	}
	return [
		...base.map(() => '..'),
		...target.map((part) =>
			encodeURIComponent(part).replace(
				/[()]/g,
				(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
			)
		)
	].join('/');
}

interface WikiProjectBucket<T> {
	files: T[];
	byId: Map<string, T>;
	byPath: Map<string, T[]>;
	byStem: Map<string, T[]>;
}

/** One reusable index for every wiki target in a project. */
export interface ProjectWikiIndex<T> {
	byProject: Map<string, WikiProjectBucket<T>>;
}

function wikiStem(relativePath: string): string {
	return relativePath
		.split('/')
		.pop()!
		.replace(/\.(md|markdown|mdx|txt)$/i, '')
		.toLowerCase();
}

export function createProjectWikiIndex<
	T extends { id: string; projectId?: string; relativePath?: string }
>(documents: readonly T[]): ProjectWikiIndex<T> {
	const byProject = new Map<string, WikiProjectBucket<T>>();
	for (const file of documents) {
		if (!file.projectId || !file.relativePath) continue;
		let bucket = byProject.get(file.projectId);
		if (!bucket) {
			bucket = { files: [], byId: new Map(), byPath: new Map(), byStem: new Map() };
			byProject.set(file.projectId, bucket);
		}
		bucket.files.push(file);
		bucket.byId.set(file.id, file);
		const key = pathKey(file.relativePath);
		const pathMatches = bucket.byPath.get(key);
		if (pathMatches) pathMatches.push(file);
		else bucket.byPath.set(key, [file]);
		const stem = wikiStem(file.relativePath);
		const stemMatches = bucket.byStem.get(stem);
		if (stemMatches) stemMatches.push(file);
		else bucket.byStem.set(stem, [file]);
	}
	return { byProject };
}

/** Resolve wiki paths within the source project before considering a basename. */
export function projectWikiCandidates<
	T extends { id: string; projectId?: string; relativePath?: string }
>(
	source: { projectId?: string; relativePath?: string },
	target: string,
	documents: readonly T[],
	index?: ProjectWikiIndex<T>
): T[] {
	const value = target.trim().split('#', 1)[0]!;
	if (!value || !source.projectId || !source.relativePath) return [];
	const bucket = index?.byProject.get(source.projectId);
	const files =
		bucket?.files ??
		documents.filter((file) => file.projectId === source.projectId && file.relativePath);
	const byId = bucket ? bucket.byId.get(value) : files.find((file) => file.id === value);
	if (byId) return [byId];
	const names = /\.(?:md|markdown|mdx|txt)$/i.test(value) ? [value] : [value, `${value}.md`];
	for (const name of names) {
		const encodedName = name
			.split('/')
			.map((part) => {
				try {
					const decoded = decodeURIComponent(part);
					return encodeURIComponent(
						decoded.includes('/') || decoded.includes('\\') ? part : decoded
					);
				} catch {
					return encodeURIComponent(part);
				}
			})
			.join('/');
		const relative = resolveProjectPath(source.relativePath, encodedName);
		if (relative) {
			const key = pathKey(relative);
			const matches = bucket
				? (bucket.byPath.get(key) ?? [])
				: files.filter((file) => pathKey(file.relativePath!) === key);
			if (matches.length) return matches;
		}
		try {
			const root = pathKey(name);
			const matches = bucket
				? (bucket.byPath.get(root) ?? [])
				: files.filter((file) => pathKey(file.relativePath!) === root);
			if (matches.length) return matches;
		} catch {
			/* A relative parent path has no root-relative candidate. */
		}
	}
	if (value.includes('/')) return [];
	const stem = value.replace(/\.(md|markdown|mdx|txt)$/i, '').toLowerCase();
	if (bucket) return bucket.byStem.get(stem) ?? [];
	return files.filter((file) => wikiStem(file.relativePath!) === stem);
}

export function imageMime(path: string): string | null {
	const extension = path.split('.').pop()?.toLowerCase();
	return (
		(
			{
				png: 'image/png',
				jpg: 'image/jpeg',
				jpeg: 'image/jpeg',
				gif: 'image/gif',
				webp: 'image/webp',
				svg: 'image/svg+xml',
				avif: 'image/avif'
			} as Record<string, string>
		)[extension ?? ''] ?? null
	);
}
