import type { ProjectInput } from './project-archive';
import { projectPath, pathKey } from './project-paths';

export type VaultKind = 'obsidian' | 'notion' | 'generic';

export interface MigrationReport {
	kind: VaultKind;
	documents: number;
	assets: number;
	renamed: Array<{ from: string; to: string }>;
	skipped: string[];
	unsupported: string[];
}

export interface MigrationResult {
	input: ProjectInput;
	report: MigrationReport;
}

const OBSIDIAN_INTERNAL = /(^|\/)\.(obsidian|trash|git)(\/|$)/i;
const NOTION_ID = /(?:^|[ \t])([0-9a-f]{32})(?=\.[^.]+$)/i;

function commonRoot(paths: readonly string[]): string | null {
	if (paths.length === 0) return null;
	const first = paths[0]!.split('/')[0];
	if (!paths.every((path) => path.split('/')[0] === first)) return null;
	return paths.every((path) => path.split('/').length > 1) ? first! : null;
}

function stripRoot(path: string, root: string | null): string {
	if (!root || !path.startsWith(`${root}/`)) return path;
	return path.slice(root.length + 1);
}

function notionName(path: string): string {
	const parts = path.split('/');
	const name = parts.pop()!;
	const cleaned = name.replace(NOTION_ID, '');
	parts.push(cleaned);
	return parts.join('/');
}

export function detectVaultKind(paths: readonly string[]): VaultKind {
	if (paths.some((path) => /(^|\/)\.obsidian(\/|$)/i.test(path))) return 'obsidian';
	if (paths.some((path) => NOTION_ID.test(path))) return 'notion';
	return 'generic';
}

/**
 * Converts an Obsidian vault or Notion export into a DeckMark project. The
 * source archive is never modified. Unsupported entries stay as assets.
 */
export function normalizeImportedProject(input: ProjectInput): MigrationResult {
	const allPaths = [
		...input.documents.map((entry) => entry.relativePath),
		...input.assets.map((entry) => entry.path)
	];
	const kind = detectVaultKind(allPaths);
	const root =
		kind === 'generic'
			? null
			: commonRoot(allPaths.filter((path) => !OBSIDIAN_INTERNAL.test(path)));
	const report: MigrationReport = {
		kind,
		documents: 0,
		assets: 0,
		renamed: [],
		skipped: [],
		unsupported: []
	};
	const used = new Set<string>();
	const rename = (original: string): string | null => {
		let path = projectPath(stripRoot(original, root));
		if (kind === 'notion') path = projectPath(notionName(path));
		if (kind === 'obsidian' && OBSIDIAN_INTERNAL.test(original)) {
			report.skipped.push(original);
			return null;
		}
		if (path.startsWith('.mdsh/') || path.split('/').includes('..')) {
			report.skipped.push(original);
			return null;
		}
		let candidate = path;
		let index = 2;
		while (used.has(pathKey(candidate))) {
			const slash = path.lastIndexOf('/');
			const dot = path.lastIndexOf('.');
			const stem = dot > slash ? path.slice(0, dot) : path;
			const extension = dot > slash ? path.slice(dot) : '';
			candidate = `${stem} (${index})${extension}`;
			index++;
		}
		used.add(pathKey(candidate));
		if (candidate !== original) report.renamed.push({ from: original, to: candidate });
		return candidate;
	};

	const documents = input.documents.flatMap((document) => {
		const path = rename(document.relativePath);
		if (!path) return [];
		report.documents++;
		return [{ ...document, relativePath: path }];
	});
	const assets = input.assets.flatMap((asset) => {
		const path = rename(asset.path);
		if (!path) return [];
		if (!/\.(?:png|jpe?g|gif|webp|avif|svg|pdf|zip|canvas|base|excalidraw|csv)$/i.test(path)) {
			report.unsupported.push(path);
		}
		report.assets++;
		return [{ ...asset, path }];
	});
	const hashes = assets.filter((asset) => /\.(?:canvas|excalidraw|base)$/i.test(asset.path));
	for (const asset of hashes) report.unsupported.push(asset.path);

	return {
		input: {
			name: input.name,
			documents,
			assets
		},
		report
	};
}
