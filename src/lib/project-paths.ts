/** Project paths use slash separators and remain inside the selected root. */
export function projectPath(value: string): string {
	if (!value || value.length > 1024 || value.includes('\\') || value.startsWith('/')) {
		throw new Error('Invalid project path');
	}
	const parts = value.normalize('NFC').split('/');
	if (
		parts.length > 9 ||
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

export interface ProjectPathIndex<T> {
	byId: Map<string, T>;
	byPath: Map<string, T[]>;
	byStem: Map<string, T[]>;
	byProject: Map<string, Map<string, T>>;
}

/**
 * Build the path lookup once for a library. Backlink resolution calls the
 * lookup for every link, so a per-link scan over hundreds of project documents
 * is too slow. The index keeps references to the live file objects.
 */
export function buildProjectPathIndex<
	T extends { id: string; projectId?: string; relativePath?: string }
>(documents: readonly T[]): ProjectPathIndex<T> {
	const index: ProjectPathIndex<T> = {
		byId: new Map(),
		byPath: new Map(),
		byStem: new Map(),
		byProject: new Map()
	};
	for (const file of documents) {
		if (!file.projectId || !file.relativePath) continue;
		let project = index.byProject.get(file.projectId);
		if (!project) {
			project = new Map();
			index.byProject.set(file.projectId, project);
		}
		project.set(file.id, file);
		index.byId.set(file.id, file);
		const key = pathKey(file.relativePath);
		const pathMatches = index.byPath.get(key);
		if (pathMatches) pathMatches.push(file);
		else index.byPath.set(key, [file]);
		const stem = file.relativePath
			.split('/')
			.pop()!
			.replace(/\.(md|markdown|mdx|txt)$/i, '')
			.toLowerCase();
		const stemMatches = index.byStem.get(stem);
		if (stemMatches) stemMatches.push(file);
		else index.byStem.set(stem, [file]);
	}
	return index;
}

/** Resolve one wiki target against a prepared project path index. */
export function projectWikiCandidatesFromIndex<
	T extends { id: string; projectId?: string; relativePath?: string }
>(
	source: { projectId?: string; relativePath?: string },
	target: string,
	index: ProjectPathIndex<T>
): T[] {
	const value = target.trim().split('#', 1)[0]!;
	if (!value || !source.projectId || !source.relativePath) return [];
	const project = index.byProject.get(source.projectId);
	if (!project) return [];
	const byId = project.get(value);
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
			const matches = index.byPath.get(pathKey(relative));
			if (matches?.length) return matches;
		}
		try {
			const matches = index.byPath.get(pathKey(name));
			if (matches?.length) return matches;
		} catch {
			/* A relative parent path has no root-relative candidate. */
		}
	}
	if (value.includes('/')) return [];
	const stem = value.replace(/\.(md|markdown|mdx|txt)$/i, '').toLowerCase();
	return index.byStem.get(stem) ?? [];
}

/**
 * Build a resolver for backlink scans. The resolver builds the project path
 * index and the global name index once, then answers every link in constant
 * time. Call it with note documents only.
 */
export function createWikiTargetResolver<
	T extends { id: string; name: string; projectId?: string; relativePath?: string }
>(documents: readonly T[]): (target: string, source: T) => T[] {
	const projectIndex = buildProjectPathIndex(documents);
	const byId = new Map<string, T>();
	const byStem = new Map<string, T[]>();
	for (const file of documents) {
		byId.set(file.id, file);
		const stem = stripMarkdownExtension(file.name).toLowerCase();
		const matches = byStem.get(stem);
		if (matches) matches.push(file);
		else byStem.set(stem, [file]);
	}
	return (target, source) => {
		if (source.projectId && source.relativePath) {
			return projectWikiCandidatesFromIndex(source, target, projectIndex);
		}
		const value = target.trim();
		if (!value) return [];
		const exact = byId.get(value);
		if (exact) return [exact];
		return byStem.get(value.toLowerCase()) ?? [];
	};
}

function stripMarkdownExtension(name: string): string {
	return name.replace(/\.(md|markdown|mdx|txt)$/i, '');
}

/** Resolve wiki paths within the source project before considering a basename. */
export function projectWikiCandidates<
	T extends { id: string; projectId?: string; relativePath?: string }
>(
	source: { projectId?: string; relativePath?: string },
	target: string,
	documents: readonly T[]
): T[] {
	return projectWikiCandidatesFromIndex(source, target, buildProjectPathIndex(documents));
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
