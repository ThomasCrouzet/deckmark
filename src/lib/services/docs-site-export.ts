// Static documentation site export. The module plans page and asset paths,
// lazy-loads the HTML renderer, and creates a deterministic ZIP for offline
// hosting. It never changes the source Markdown.

import { abortable, checkAborted } from '../abort';
import {
	docsSiteIssue,
	mergeIssues,
	planDocsSite,
	type DocsSiteExportInput,
	type DocsSiteFile,
	type DocsSiteIssue,
	type DocsSitePlan
} from './docs-site-plan';

export * from './docs-site-plan';

export interface DocsSiteReportPage {
	source: string;
	path: string;
	title: string;
}

export interface DocsSiteReportAsset {
	source: string;
	path: string;
}

export interface DocsSiteReport {
	schema: 'mdsh-docs-site/1';
	siteName: string;
	locale: 'en' | 'fr';
	summary: {
		pages: number;
		assets: number;
		errors: number;
		warnings: number;
		searchIndex: boolean;
	};
	pages: DocsSiteReportPage[];
	assets: DocsSiteReportAsset[];
	issues: DocsSiteIssue[];
}

export interface DocsSiteResult {
	blob: Blob;
	report: DocsSiteReport;
	files: DocsSiteFile[];
}

export interface BuildDocsSiteOptions {
	signal?: AbortSignal;
}

export class DocsSiteExportError extends Error {
	constructor(public readonly report: DocsSiteReport) {
		super('Documentation site export has resource errors');
		this.name = 'DocsSiteExportError';
	}
}

const ZIP_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

function buildReport(
	plan: DocsSitePlan,
	pages: { source: string; path: string; title: string }[],
	issues: DocsSiteIssue[]
): DocsSiteReport {
	const sortedPages = pages.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const assets = [
		...plan.assets.map((asset) => ({ source: asset.sourcePath, path: asset.outputPath })),
		...plan.files.map((file) => ({ source: file.sourcePath, path: file.outputPath }))
	].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return {
		schema: 'mdsh-docs-site/1',
		siteName: plan.name,
		locale: plan.locale,
		summary: {
			pages: sortedPages.length,
			assets: assets.length,
			errors: issues.filter((issue) => issue.severity === 'error').length,
			warnings: issues.filter((issue) => issue.severity === 'warning').length,
			searchIndex: plan.includeSearchIndex
		},
		pages: sortedPages,
		assets,
		issues
	};
}

/** Serializes the report with stable key order and no time or locale data. */
export function serializeDocsSiteReport(report: DocsSiteReport): string {
	return `${JSON.stringify(report, null, 2)}\n`;
}

async function buildZip(files: readonly DocsSiteFile[], signal?: AbortSignal): Promise<Blob> {
	const { default: JSZip } = await import('jszip');
	const zip = new JSZip();
	const ordered = files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	for (const file of ordered) {
		checkAborted(signal);
		zip.file(file.path, file.data, {
			date: ZIP_DATE,
			createFolders: false
		});
	}
	checkAborted(signal);
	return zip.generateAsync({
		type: 'blob',
		compression: 'DEFLATE',
		compressionOptions: { level: 6 },
		platform: 'DOS',
		mimeType: 'application/zip'
	});
}

/**
 * A published SVG is a navigable document, so preview-level `<img>` safety is
 * not sufficient. Every SVG asset is sanitized again for publication. The
 * private project asset stays untouched, and a rejected SVG blocks the ZIP.
 */
async function sanitizePublishedSvgAssets(plan: DocsSitePlan): Promise<DocsSiteIssue[]> {
	const issues: DocsSiteIssue[] = [];
	const { sanitizeSvgBytes } = await import('../render/image-media');
	for (const asset of plan.assets) {
		const declaresSvg = asset.mime.toLowerCase().split(';', 1)[0] === 'image/svg+xml';
		const namedSvg = /\.svg$/i.test(asset.outputPath);
		if (!declaresSvg && !namedSvg) continue;
		try {
			asset.data = await sanitizeSvgBytes(asset.data);
			asset.mime = 'image/svg+xml';
		} catch {
			issues.push(
				docsSiteIssue(
					'asset-unsafe',
					'error',
					asset.sourcePath,
					asset.sourcePath,
					`"${asset.sourcePath}" is not a safe standalone SVG and is not published.`
				)
			);
		}
	}
	return issues;
}

/**
 * Builds the complete static site in memory. The function throws a
 * `DocsSiteExportError` before ZIP creation when a local resource is missing.
 * A cancelled signal rejects with an AbortError.
 */
export async function buildDocsSite(
	input: DocsSiteExportInput,
	options: BuildDocsSiteOptions = {}
): Promise<DocsSiteResult> {
	checkAborted(options.signal);
	const plan = planDocsSite(input);
	if (!plan.pages.length) throw new Error('The project contains no Markdown documents');
	const sanitized = await sanitizePublishedSvgAssets(plan);
	checkAborted(options.signal);
	const renderer = await abortable(import('./docs-site-render'), options.signal);
	const rendered = await renderer.renderDocsSite(plan, {
		...(options.signal ? { signal: options.signal } : {})
	});
	checkAborted(options.signal);
	const issues = mergeIssues(rendered.issues, sanitized);
	const report = buildReport(
		plan,
		rendered.pages.map((page) => ({
			source: page.page.sourcePath,
			path: page.page.outputPath,
			title: page.title
		})),
		issues
	);
	if (report.summary.errors > 0) throw new DocsSiteExportError(report);
	const files = renderer.buildDocsSiteFiles(plan, { pages: rendered.pages, issues });
	checkAborted(options.signal);
	const blob = await abortable(buildZip(files, options.signal), options.signal);
	checkAborted(options.signal);
	return { blob, report, files };
}
