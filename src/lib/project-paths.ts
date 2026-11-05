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

/** Resolve wiki paths within the source project before considering a basename. */
export function projectWikiCandidates<
	T extends { id: string; projectId?: string; relativePath?: string }
>(
	source: { projectId?: string; relativePath?: string },
	target: string,
	documents: readonly T[]
): T[] {
	const value = target.trim().split('#', 1)[0]!;
	if (!value || !source.projectId || !source.relativePath) return [];
	const files = documents.filter(
		(file) => file.projectId === source.projectId && file.relativePath
	);
	const byId = files.find((file) => file.id === value);
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
			const matches = files.filter((file) => pathKey(file.relativePath!) === pathKey(relative));
			if (matches.length) return matches;
		}
		try {
			const root = pathKey(name);
			const matches = files.filter((file) => pathKey(file.relativePath!) === root);
			if (matches.length) return matches;
		} catch {
			/* A relative parent path has no root-relative candidate. */
		}
	}
	if (value.includes('/')) return [];
	const stem = value.replace(/\.(md|markdown|mdx|txt)$/i, '').toLowerCase();
	return files.filter(
		(file) =>
			file
				.relativePath!.split('/')
				.pop()!
				.replace(/\.(md|markdown|mdx|txt)$/i, '')
				.toLowerCase() === stem
	);
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
