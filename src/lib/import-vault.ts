import type { ProjectInput } from './project-archive';
import { rewriteProjectDestinations } from './project-links';
import {
	isExternalDestination,
	projectPath,
	pathKey,
	projectWikiCandidates,
	relativeDestination,
	resolveProjectPath
} from './project-paths';
import { rewriteWikiLinkTargets } from './wiki-links';

export type VaultKind = 'obsidian' | 'notion' | 'generic';

export type MigrationLinkReason = 'unresolved' | 'ambiguous';

export interface MigrationLinkIssue {
	document: string;
	destination: string;
	reason: MigrationLinkReason;
}

export interface MigrationReport {
	kind: VaultKind;
	documents: number;
	assets: number;
	renamed: Array<{ from: string; to: string }>;
	skipped: string[];
	unsupported: string[];
	/** Link destinations that could not be mapped to a renamed target. */
	links: MigrationLinkIssue[];
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

const MARKDOWN_LINK = /\.(?:md|markdown|mdx|txt)$/i;

function wikiDestination(from: string, to: string, target: string): string {
	const next = relativeDestination(from, to);
	if (!next) return target.split('#', 1)[0]!;
	const suffix = target.slice(target.split('#', 1)[0]!.length);
	return (
		(MARKDOWN_LINK.test(target.split('#', 1)[0]!) ? next : next.replace(MARKDOWN_LINK, '')) + suffix
	);
}

function reportLink(
	links: MigrationLinkIssue[],
	document: string,
	destination: string,
	reason: MigrationLinkReason
): void {
	links.push({ document, destination, reason });
}

/**
 * Rewrites supported Markdown and wiki destinations from the original paths to
 * the reserved project paths. Unresolved destinations keep their exact source
 * bytes and appear in the migration report.
 */
function rewriteImportedContent(
	content: string,
	from: string,
	to: string,
	renamed: ReadonlyMap<string, string>,
	documents: ReadonlyArray<{ id: string; projectId: string; relativePath: string }>,
	links: MigrationLinkIssue[]
): string {
	const markdown = rewriteProjectDestinations(content, ({ source }) => {
		if (!source || source.startsWith('#') || isExternalDestination(source)) return null;
		const target = resolveProjectPath(from, source);
		if (!target) {
			reportLink(links, to, source, 'unresolved');
			return null;
		}
		const mapped = renamed.get(pathKey(target));
		if (!mapped) {
			reportLink(links, to, source, 'unresolved');
			return null;
		}
		if (mapped === target && from === to) return null;
		const suffix = source.match(/[?#].*$/)?.[0] ?? '';
		const newRelative = relativeDestination(to, mapped);
		// Keep the authored bytes when the destination still resolves to the
		// same relative target after both documents moved.
		if (newRelative === relativeDestination(from, target)) return null;
		return (newRelative || encodeURIComponent(mapped.split('/').pop()!)) + suffix;
	});
	return rewriteWikiLinkTargets(markdown, (target) => {
		const value = target.split('#', 1)[0]!;
		if (!value) return target;
		const candidates = projectWikiCandidates(
			{ projectId: 'import', relativePath: from },
			target,
			documents
		);
		if (candidates.length > 1) {
			reportLink(links, to, target, 'ambiguous');
			return target;
		}
		const candidate = candidates[0];
		const mapped = candidate?.relativePath
			? renamed.get(pathKey(candidate.relativePath))
			: undefined;
		if (!mapped) {
			reportLink(links, to, target, 'unresolved');
			return target;
		}
		return wikiDestination(to, mapped, target);
	});
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
		unsupported: [],
		links: []
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

	// Reserve every destination before rewriting any body. All documents and
	// assets share one canonical map, so a link can target a renamed asset.
	const renamed = new Map<string, string>();
	const documentEntries: Array<{
		original: string;
		path: string;
		document: ProjectInput['documents'][number];
	}> = [];
	const assetEntries: Array<{
		original: string;
		path: string;
		asset: ProjectInput['assets'][number];
	}> = [];
	for (const document of input.documents) {
		const path = rename(document.relativePath);
		if (!path) continue;
		report.documents++;
		renamed.set(pathKey(document.relativePath), path);
		documentEntries.push({ original: document.relativePath, path, document });
	}
	for (const asset of input.assets) {
		const path = rename(asset.path);
		if (!path) continue;
		if (!/\.(?:png|jpe?g|gif|webp|avif|svg|pdf|zip|canvas|base|excalidraw|csv)$/i.test(path)) {
			report.unsupported.push(path);
		}
		report.assets++;
		renamed.set(pathKey(asset.path), path);
		assetEntries.push({ original: asset.path, path, asset });
	}
	const originalDocuments = documentEntries.map((entry) => ({
		id: entry.original,
		projectId: 'import',
		relativePath: entry.original
	}));
	const documents = documentEntries.map((entry) => ({
		...entry.document,
		relativePath: entry.path,
		content: rewriteImportedContent(
			entry.document.content,
			entry.original,
			entry.path,
			renamed,
			originalDocuments,
			report.links
		)
	}));
	const assets = assetEntries.map((entry) => ({ ...entry.asset, path: entry.path }));
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
