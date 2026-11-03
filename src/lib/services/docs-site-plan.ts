// Pure planning for the static documentation site export. The module reads a
// project snapshot and returns page paths, asset paths, and resource issues.
// It does not render HTML, use storage, or start requests.

import { IMPORT_LIMITS } from '../config';
import { documentHeadings } from '../document-navigation';
import { stripFileExtension } from '../file-utils';
import {
	isExternalDestination,
	pathKey,
	projectPath,
	projectWikiCandidates,
	resolveProjectPath,
	relativeDestination
} from '../project-paths';
import { projectDestinations } from '../project-links';
import { slugify, wikiLinkOccurrences } from '../wiki-links';

export type DocsSiteDocumentKind = 'note' | 'presentation' | 'code' | 'image';

export interface DocsSiteDocumentInput {
	id: string;
	relativePath: string;
	content: string;
	kind?: DocsSiteDocumentKind;
	/** Data URL for an image document. */
	data?: string;
	mime?: string;
}

export interface DocsSiteAssetInput {
	path: string;
	mime: string;
	data: Uint8Array;
}

export interface DocsSiteExportInput {
	name: string;
	documents: DocsSiteDocumentInput[];
	assets: DocsSiteAssetInput[];
	locale?: string;
	includeSearchIndex?: boolean;
}

export type DocsSiteIssueCode =
	| 'anchor-missing'
	| 'document-skipped'
	| 'image-external'
	| 'image-missing'
	| 'link-ambiguous'
	| 'link-external'
	| 'link-missing'
	| 'link-outside-project';

export interface DocsSiteIssue {
	code: DocsSiteIssueCode;
	severity: 'error' | 'warning';
	/** Source document path. */
	path: string;
	target: string;
	/** Stable English message for the JSON report. The UI localizes the code. */
	message: string;
}

export interface PlannedPage {
	documentId: string;
	sourcePath: string;
	outputPath: string;
	content: string;
	anchorIds: Set<string>;
}

export interface PlannedAsset {
	sourcePath: string;
	outputPath: string;
	mime: string;
	data: Uint8Array;
}

export interface PlannedFile {
	sourcePath: string;
	outputPath: string;
	mime: string;
	data: Uint8Array;
}

export interface DocsSiteInternalPaths {
	directory: string;
	stylesheet: string;
	script: string;
	searchIndex: string;
	marker: string;
}

export interface DocsSiteFile {
	path: string;
	mime: string;
	data: Uint8Array;
}

export interface DocsSitePlan {
	name: string;
	locale: 'en' | 'fr';
	includeSearchIndex: boolean;
	pages: PlannedPage[];
	assets: PlannedAsset[];
	files: PlannedFile[];
	internal: DocsSiteInternalPaths;
	issues: DocsSiteIssue[];
	pageBySource: Map<string, PlannedPage>;
	pageByOutput: Map<string, PlannedPage>;
	assetBySource: Map<string, PlannedAsset>;
	assetByOutput: Map<string, PlannedAsset>;
	fileBySource: Map<string, PlannedFile>;
	fileByOutput: Map<string, PlannedFile>;
}

export type SiteDestinationKind =
	| 'asset'
	| 'data'
	| 'external'
	| 'file'
	| 'fragment'
	| 'missing'
	| 'outside-project'
	| 'page'
	| 'scheme';

export interface SiteDestination {
	kind: SiteDestinationKind;
	href?: string;
	outputPath?: string;
	/** Fragment including the leading hash. */
	fragment?: string;
	/** External resource type. */
	external?: 'image' | 'link';
	reason?: 'ambiguous' | 'missing' | 'outside-project';
}

const MARKDOWN_EXTENSIONS = /\.(?:md|markdown|mdx)$/i;
const CODE_EXTENSIONS =
	/\.(?:txt|text|log|csv|json|jsonc|js|mjs|cjs|ts|mts|cts|jsx|tsx|py|rs|go|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|rb|sh|bash|zsh|fish|ps1|sql|css|scss|less|html|htm|xml|svg|yaml|yml|toml|ini|conf|env|lua|pl|r|dart|ex|exs|erl|hs|clj|groovy|gradle|mk)$/i;

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function issue(
	code: DocsSiteIssueCode,
	severity: 'error' | 'warning',
	path: string,
	target: string,
	message: string
): DocsSiteIssue {
	return { code, severity, path, target, message };
}

export function docsSiteIssue(
	code: DocsSiteIssueCode,
	severity: 'error' | 'warning',
	path: string,
	target: string,
	message: string
): DocsSiteIssue {
	return issue(code, severity, path, target, message);
}

/** Heading identifiers produced by the Markdown renderer. */
export function headingAnchorIds(markdown: string): Set<string> {
	const ids = new Set<string>();
	const counts = new Map<string, number>();
	for (const heading of documentHeadings(markdown)) {
		const base = slugify(heading.text).slice(0, 80) || `section-${heading.level}`;
		const seen = counts.get(base) ?? 0;
		counts.set(base, seen + 1);
		let id = base;
		let suffix = 2;
		while (ids.has(id)) id = `${base}-${suffix++}`;
		ids.add(id);
	}
	return ids;
}

function outputForDocument(relativePath: string): string {
	const parts = relativePath.split('/');
	const name = parts.pop()!;
	const stem = stripFileExtension(name) || 'index';
	const folder = parts.join('/');
	if (/^(?:index|readme)$/i.test(stem)) return folder ? `${folder}/index.html` : 'index.html';
	return folder ? `${folder}/${stem}.html` : `${stem}.html`;
}

function uniqueOutput(preferred: string, occupied: Set<string>): string {
	let candidate = preferred;
	let suffix = 2;
	while (occupied.has(pathKey(candidate))) {
		const dot = preferred.lastIndexOf('.');
		candidate =
			dot > 0
				? `${preferred.slice(0, dot)}-${suffix}${preferred.slice(dot)}`
				: `${preferred}-${suffix}`;
		suffix++;
	}
	return candidate;
}

function decodeDataUrl(data: string): Uint8Array | null {
	const comma = data.indexOf(',');
	if (comma < 0) return null;
	const header = data.slice(0, comma);
	if (!/;base64$/i.test(header)) return null;
	try {
		const binary = atob(data.slice(comma + 1).replace(/\s/g, ''));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		return null;
	}
}

function internalDirectory(occupied: Set<string>): string {
	let suffix = 1;
	while (true) {
		const directory = suffix === 1 ? '_mdsh' : `_mdsh-${suffix}`;
		const prefix = `${directory.toLowerCase()}/`;
		if (![...occupied].some((path) => path.startsWith(prefix))) return directory;
		suffix++;
	}
}

function documentPageKind(document: DocsSiteDocumentInput): boolean {
	if (document.kind === 'note') return true;
	if (document.kind) return false;
	return MARKDOWN_EXTENSIONS.test(document.relativePath);
}

function documentCodeKind(document: DocsSiteDocumentInput): boolean {
	if (document.kind === 'code') return !document.data;
	if (document.kind) return false;
	return CODE_EXTENSIONS.test(document.relativePath);
}

function buildMaps(
	plan: Omit<
		DocsSitePlan,
		| 'pageBySource'
		| 'pageByOutput'
		| 'assetBySource'
		| 'assetByOutput'
		| 'fileBySource'
		| 'fileByOutput'
	>
): DocsSitePlan {
	return {
		...plan,
		pageBySource: new Map(plan.pages.map((page) => [pathKey(page.sourcePath), page])),
		pageByOutput: new Map(plan.pages.map((page) => [pathKey(page.outputPath), page])),
		assetBySource: new Map(plan.assets.map((asset) => [pathKey(asset.sourcePath), asset])),
		assetByOutput: new Map(plan.assets.map((asset) => [pathKey(asset.outputPath), asset])),
		fileBySource: new Map(plan.files.map((file) => [pathKey(file.sourcePath), file])),
		fileByOutput: new Map(plan.files.map((file) => [pathKey(file.outputPath), file]))
	};
}

/** Builds the deterministic page and asset plan without rendering content. */
export function planDocsSite(input: DocsSiteExportInput): DocsSitePlan {
	if (input.documents.length > IMPORT_LIMITS.maxFiles) throw new Error('Project document limit');
	const locale = input.locale === 'fr' ? 'fr' : 'en';
	const name = input.name.trim() || 'Documentation';
	const includeSearchIndex = input.includeSearchIndex !== false;
	const documents = input.documents
		.map((document) => ({
			...document,
			relativePath: projectPath(document.relativePath)
		}))
		.toSorted((a, b) => compareText(a.relativePath, b.relativePath));
	const assets = input.assets
		.map((asset) => ({ ...asset, path: projectPath(asset.path) }))
		.toSorted((a, b) => compareText(a.path, b.path));

	const seen = new Set<string>();
	for (const path of [
		...documents.map((document) => document.relativePath),
		...assets.map((asset) => asset.path)
	]) {
		const key = pathKey(path);
		if (seen.has(key)) throw new Error('Duplicate project path');
		seen.add(key);
	}

	const preferredPages: Array<{ document: DocsSiteDocumentInput; outputPath: string }> = [];
	const skipped: DocsSiteDocumentInput[] = [];
	const imageDocuments: Array<{ document: DocsSiteDocumentInput; data: Uint8Array }> = [];
	const codeDocuments: DocsSiteDocumentInput[] = [];
	for (const document of documents) {
		if (documentPageKind(document)) {
			preferredPages.push({
				document,
				outputPath: outputForDocument(document.relativePath)
			});
			continue;
		}
		if (document.kind === 'image' && document.data) {
			const data = decodeDataUrl(document.data);
			if (data) {
				imageDocuments.push({ document, data });
				continue;
			}
		}
		if (documentCodeKind(document)) {
			codeDocuments.push(document);
			continue;
		}
		skipped.push(document);
	}

	const occupied = new Set<string>([pathKey('.nojekyll')]);
	const provisionalPaths = [
		...preferredPages.map((page) => page.outputPath),
		...assets.map((asset) => asset.path),
		...imageDocuments.map((entry) => entry.document.relativePath),
		...codeDocuments.map((document) => document.relativePath)
	];
	const directory = internalDirectory(new Set(provisionalPaths.map((path) => pathKey(path))));
	const internal: DocsSiteInternalPaths = {
		directory,
		stylesheet: `${directory}/site.css`,
		script: `${directory}/site.js`,
		searchIndex: `${directory}/search-index.js`,
		marker: '.nojekyll'
	};
	for (const path of [
		internal.stylesheet,
		internal.script,
		...(includeSearchIndex ? [internal.searchIndex] : [])
	]) {
		occupied.add(pathKey(path));
	}

	const pages: PlannedPage[] = [];
	for (const entry of preferredPages) {
		const outputPath = uniqueOutput(entry.outputPath, occupied);
		occupied.add(pathKey(outputPath));
		pages.push({
			documentId: entry.document.id,
			sourcePath: entry.document.relativePath,
			outputPath,
			content: entry.document.content,
			anchorIds: headingAnchorIds(entry.document.content)
		});
	}

	const plannedAssets: PlannedAsset[] = [];
	for (const asset of assets) {
		const outputPath = uniqueOutput(asset.path, occupied);
		occupied.add(pathKey(outputPath));
		plannedAssets.push({
			sourcePath: asset.path,
			outputPath,
			mime: asset.mime || 'application/octet-stream',
			data: asset.data
		});
	}
	for (const entry of imageDocuments) {
		const outputPath = uniqueOutput(entry.document.relativePath, occupied);
		occupied.add(pathKey(outputPath));
		plannedAssets.push({
			sourcePath: entry.document.relativePath,
			outputPath,
			mime: entry.document.mime || 'image/png',
			data: entry.data
		});
	}
	plannedAssets.sort((a, b) => compareText(a.sourcePath, b.sourcePath));

	const files: PlannedFile[] = [];
	const encoder = new TextEncoder();
	for (const document of codeDocuments) {
		const outputPath = uniqueOutput(document.relativePath, occupied);
		occupied.add(pathKey(outputPath));
		const data = encoder.encode(document.content);
		if (data.length > IMPORT_LIMITS.maxFileBytes) throw new Error('Project document size limit');
		files.push({
			sourcePath: document.relativePath,
			outputPath,
			mime: document.mime || 'text/plain;charset=utf-8',
			data
		});
	}

	const plan = buildMaps({
		name,
		locale,
		includeSearchIndex,
		pages,
		assets: plannedAssets,
		files,
		internal,
		issues: []
	});

	const issues: DocsSiteIssue[] = skipped.map((document) =>
		issue(
			'document-skipped',
			'warning',
			document.relativePath,
			document.relativePath,
			`"${document.relativePath}" is not a Markdown page and is not included.`
		)
	);
	for (const page of pages) {
		issues.push(...scanPageIssues(plan, page));
	}
	plan.issues = sortIssues(issues);
	return plan;
}

function findPage(plan: DocsSitePlan, sourcePath: string): PlannedPage | undefined {
	return plan.pageBySource.get(pathKey(sourcePath));
}

function suffixFor(destination: string): string {
	const hash = destination.indexOf('#');
	const query = destination.indexOf('?');
	const cut = hash < 0 ? query : query < 0 ? hash : Math.min(hash, query);
	return cut < 0 ? '' : destination.slice(cut);
}

function pathPartFor(destination: string): string {
	const hash = destination.indexOf('#');
	const query = destination.indexOf('?');
	const cut = hash < 0 ? query : query < 0 ? hash : Math.min(hash, query);
	return cut < 0 ? destination : destination.slice(0, cut);
}

function fragmentFor(destination: string): string {
	const hash = destination.indexOf('#');
	return hash < 0 ? '' : destination.slice(hash + 1);
}

function siteTargets(
	plan: DocsSitePlan,
	target: string
): {
	asset: PlannedAsset | undefined;
	file: PlannedFile | undefined;
	page: PlannedPage | undefined;
} {
	const key = pathKey(target);
	return {
		page: plan.pageBySource.get(key) ?? plan.pageByOutput.get(key),
		asset: plan.assetBySource.get(key) ?? plan.assetByOutput.get(key),
		file: plan.fileBySource.get(key) ?? plan.fileByOutput.get(key)
	};
}

function candidateTargets(target: string): string[] {
	const candidates = [
		target,
		`${target}.md`,
		`${target}.markdown`,
		`${target}.mdx`,
		`${target}/index.md`,
		`${target}/README.md`
	];
	return [...new Set(candidates)];
}

function lookupTarget(plan: DocsSitePlan, target: string): ReturnType<typeof siteTargets> | null {
	for (const candidate of candidateTargets(target)) {
		try {
			const found = siteTargets(plan, candidate);
			if (found.page || found.asset || found.file) return found;
		} catch {
			continue;
		}
	}
	return null;
}

function relativeHref(
	plan: DocsSitePlan,
	sourcePath: string,
	outputPath: string,
	suffix: string
): string {
	const source = findPage(plan, sourcePath);
	if (!source) return outputPath + suffix;
	return source.outputPath === outputPath
		? suffix || outputPath
		: relativeDestination(source.outputPath, outputPath) + suffix;
}

/** Resolves one Markdown destination from a page to a site URL or an issue. */
export function resolveSiteDestination(
	plan: DocsSitePlan,
	sourcePath: string,
	destination: string,
	hint: 'image' | 'link' = 'link'
): SiteDestination {
	const trimmed = destination.trim();
	if (!trimmed) return { kind: 'missing', reason: 'missing' };
	if (trimmed.startsWith('#')) return { kind: 'fragment', href: trimmed, fragment: trimmed };
	const suffix = suffixFor(trimmed);
	const rawPath = pathPartFor(trimmed);
	if (/^data:/i.test(rawPath)) return { kind: 'data' };
	if (isExternalDestination(rawPath)) {
		if (/^(?:https?:)?\/\//i.test(rawPath))
			return { kind: 'external', external: hint === 'image' ? 'image' : 'link', href: trimmed };
		return { kind: 'scheme', href: trimmed };
	}
	let target: string | null;
	try {
		const decoded = decodeURIComponent(rawPath);
		if (decoded.startsWith('/')) target = projectPath(decoded.replace(/^\/+/, ''));
		else target = resolveProjectPath(sourcePath, rawPath);
	} catch {
		return { kind: 'outside-project', reason: 'outside-project' };
	}
	if (!target) return { kind: 'missing', reason: 'missing' };
	const found = lookupTarget(plan, target);
	if (!found) return { kind: 'missing', reason: 'missing' };
	if (found.page) {
		if (hint === 'image') return { kind: 'missing', reason: 'missing' };
		return {
			kind: 'page',
			outputPath: found.page.outputPath,
			href: relativeHref(plan, sourcePath, found.page.outputPath, suffix)
		};
	}
	const asset = found.asset;
	const file = found.file;
	const outputPath = asset?.outputPath ?? file?.outputPath ?? '';
	const mime = asset?.mime ?? file?.mime ?? '';
	if (hint === 'image' && !mime.startsWith('image/')) return { kind: 'missing', reason: 'missing' };
	return {
		kind: asset ? 'asset' : 'file',
		outputPath,
		href: relativeHref(plan, sourcePath, outputPath, suffix)
	};
}

export interface SiteWikiDestination extends SiteDestination {
	candidates?: number;
}

/** Resolves a wiki link target through the project path rules. */
export function resolveSiteWikiDestination(
	plan: DocsSitePlan,
	sourcePath: string,
	target: string
): SiteWikiDestination {
	const source = findPage(plan, sourcePath);
	if (!source) return { kind: 'missing', reason: 'missing' };
	const wikiDocuments = plan.pages.map((page) => ({
		id: page.documentId,
		projectId: 'project',
		relativePath: page.sourcePath
	}));
	const candidates = projectWikiCandidates(
		{ projectId: 'project', relativePath: sourcePath },
		target,
		wikiDocuments
	);
	if (!candidates.length) return { kind: 'missing', reason: 'missing' };
	if (candidates.length > 1)
		return { kind: 'missing', reason: 'ambiguous', candidates: candidates.length };
	const page = findPage(plan, candidates[0]!.relativePath!);
	if (!page) return { kind: 'missing', reason: 'missing' };
	const value = target.trim().split('#', 1)[0]!;
	const suffix = target.trim().slice(value.length);
	return {
		kind: 'page',
		outputPath: page.outputPath,
		href: relativeHref(plan, sourcePath, page.outputPath, suffix)
	};
}

function addAnchorIssue(
	page: PlannedPage,
	targetPage: PlannedPage | undefined,
	target: string,
	issues: DocsSiteIssue[]
): void {
	const fragment = fragmentFor(target);
	if (!fragment || !targetPage || targetPage.anchorIds.has(fragment)) return;
	issues.push(
		issue('anchor-missing', 'warning', page.sourcePath, target, `Missing anchor "${fragment}".`)
	);
}

function checkAnchor(
	plan: DocsSitePlan,
	page: PlannedPage,
	target: string,
	issues: DocsSiteIssue[]
): void {
	const source = findPage(plan, page.sourcePath);
	const path = pathPartFor(target);
	const fragment = fragmentFor(target);
	if (!fragment) return;
	let targetPage: PlannedPage | undefined = source;
	if (path) {
		const resolved = resolveSiteDestination(plan, page.sourcePath, path);
		if (resolved.kind === 'page' && resolved.outputPath)
			targetPage = plan.pageByOutput.get(pathKey(resolved.outputPath));
	}
	addAnchorIssue(page, targetPage, target, issues);
}

function scanPageIssues(plan: DocsSitePlan, page: PlannedPage): DocsSiteIssue[] {
	const issues: DocsSiteIssue[] = [];
	for (const destination of projectDestinations(page.content)) {
		const resolved = resolveSiteDestination(
			plan,
			page.sourcePath,
			destination.source,
			destination.image ? 'image' : 'link'
		);
		if (resolved.kind === 'missing') {
			issues.push(
				issue(
					destination.image ? 'image-missing' : 'link-missing',
					'error',
					page.sourcePath,
					destination.source,
					destination.image
						? `Missing image "${destination.source}".`
						: `Missing link target "${destination.source}".`
				)
			);
			continue;
		}
		if (resolved.kind === 'outside-project') {
			issues.push(
				issue(
					destination.image ? 'image-missing' : 'link-outside-project',
					'error',
					page.sourcePath,
					destination.source,
					`"${destination.source}" is outside the project.`
				)
			);
			continue;
		}
		if (resolved.kind === 'external') {
			issues.push(
				issue(
					destination.image ? 'image-external' : 'link-external',
					'warning',
					page.sourcePath,
					destination.source,
					destination.image
						? `Remote image "${destination.source}" is not downloaded. The export removes its source.`
						: `External link "${destination.source}" is kept as a link.`
				)
			);
			continue;
		}
		if (destination.image) continue;
		if (fragmentFor(destination.source)) checkAnchor(plan, page, destination.source, issues);
	}
	for (const occurrence of wikiLinkOccurrences(page.content)) {
		const resolved = resolveSiteWikiDestination(plan, page.sourcePath, occurrence.target);
		if (resolved.kind === 'missing') {
			issues.push(
				issue(
					resolved.reason === 'ambiguous' ? 'link-ambiguous' : 'link-missing',
					'error',
					page.sourcePath,
					occurrence.target,
					resolved.reason === 'ambiguous'
						? `Several documents match "${occurrence.target}".`
						: `Missing link target "${occurrence.target}".`
				)
			);
			continue;
		}
		if (occurrence.target.includes('#')) {
			const targetPage =
				resolved.kind === 'page' && resolved.outputPath
					? plan.pageByOutput.get(pathKey(resolved.outputPath))
					: undefined;
			addAnchorIssue(page, targetPage, occurrence.target, issues);
		}
	}
	return issues;
}

export function sortIssues(issues: DocsSiteIssue[]): DocsSiteIssue[] {
	const seen = new Set<string>();
	const severityOrder = { error: 0, warning: 1 } as const;
	return issues
		.filter((entry) => {
			const key = [entry.code, entry.severity, entry.path, entry.target, entry.message].join(
				'\u0000'
			);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort(
			(a, b) =>
				severityOrder[a.severity] - severityOrder[b.severity] ||
				compareText(a.path, b.path) ||
				compareText(a.code, b.code) ||
				compareText(a.target, b.target) ||
				compareText(a.message, b.message)
		);
}

export function mergeIssues(
	left: readonly DocsSiteIssue[],
	right: readonly DocsSiteIssue[]
): DocsSiteIssue[] {
	return sortIssues([...left, ...right]);
}

export function pageFallbackTitle(page: PlannedPage): string {
	const name = page.sourcePath.split('/').pop() ?? page.sourcePath;
	return stripFileExtension(name) || 'Documentation';
}
