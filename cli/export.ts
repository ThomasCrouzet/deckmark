import { basename, dirname, resolve } from 'node:path';
import { IMPORT_LIMITS } from '../src/lib/config';
import { documentKindForFile } from '../src/lib/document-kind';
import { stripMdExtension } from '../src/lib/file-names';
import { imageMime, projectPath } from '../src/lib/project-paths';
import {
	buildProjectZip,
	PROJECT_LIMITS,
	type ProjectAssetInput,
	type ProjectDocumentInput
} from '../src/lib/project-archive';
import { CliError, EXIT } from './exit';
import {
	Deadline,
	displayPath,
	mapPool,
	MAX_FILE_BYTES,
	readBytes,
	readText,
	requireDirectory,
	requireFile,
	resolveOutput,
	type OutputFormat,
	toProjectPath,
	walkFiles,
	writeOutput
} from './paths';
import { buildStandaloneHtml, renderMarkdownToHtml } from './render';

export type ExportFormat = OutputFormat;

export interface ExportInput {
	input: string;
	format: ExportFormat;
	out: string;
	name?: string;
	lang?: string;
	concurrency: number;
	timeoutMs: number;
	json: boolean;
}

const FORMATS = new Set<ExportFormat>(['html', 'md', 'zip']);
const FIXED_ZIP_DATE = new Date('1980-01-01T00:00:00.000Z');
const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdx|txt)$/i;

function totalBytes(chunks: readonly Uint8Array[]): number {
	return chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
}

async function exportZip(
	input: ExportInput,
	deadline: Deadline
): Promise<{
	output: string;
	documents: number;
	assets: number;
	bytes: number;
}> {
	const target = await resolveOutput(input.out, 'zip');
	let root: string;
	let documentPaths: string[];
	let assetPaths: string[];
	try {
		const file = await requireFile(resolve(input.input));
		root = dirname(file);
		documentPaths = [toProjectPath(file.slice(root.length + 1))];
		assetPaths = [];
	} catch (error) {
		if (!(error instanceof CliError) || error.code !== 'input-not-found') throw error;
		root = await requireDirectory(resolve(input.input));
		const paths = await walkFiles(root);
		documentPaths = paths.filter((path) => MARKDOWN_EXTENSION.test(path));
		assetPaths = paths.filter((path) => !MARKDOWN_EXTENSION.test(path));
	}
	deadline.check();
	if (documentPaths.length === 0)
		throw new CliError(EXIT.INPUT, 'no-documents', 'The input contains no Markdown documents');
	if (documentPaths.length > IMPORT_LIMITS.maxFiles)
		throw new CliError(EXIT.INPUT, 'document-limit', 'Project document limit reached');
	if (documentPaths.length + assetPaths.length > PROJECT_LIMITS.maxEntries - 3)
		throw new CliError(EXIT.INPUT, 'entry-limit', 'Project entry limit reached');
	for (const path of [...documentPaths, ...assetPaths]) {
		try {
			projectPath(path);
		} catch {
			throw new CliError(EXIT.INPUT, 'unsupported-path', `Unsupported project path: ${path}`);
		}
	}
	const documents: ProjectDocumentInput[] = await mapPool(
		documentPaths,
		input.concurrency,
		deadline,
		async (path) => ({ id: path, relativePath: path, content: await readText(root, path) })
	);
	const assets: ProjectAssetInput[] = await mapPool(
		assetPaths,
		input.concurrency,
		deadline,
		async (path) => {
			const data = await readBytes(root, path);
			if (data.byteLength > MAX_FILE_BYTES)
				throw new CliError(EXIT.INPUT, 'file-too-large', `Project file is too large: ${path}`);
			return { path, mime: imageMime(path) ?? 'application/octet-stream', data };
		}
	);
	deadline.check();
	const bytes =
		totalBytes(documents.map((document) => new TextEncoder().encode(document.content))) +
		totalBytes(assets.map((asset) => asset.data));
	if (bytes > IMPORT_LIMITS.maxBatchBytes)
		throw new CliError(EXIT.INPUT, 'batch-limit', 'Project size limit reached');
	const name = input.name?.trim() || basename(root) || 'deckmark-export';
	let archive: Uint8Array;
	try {
		const blob = await buildProjectZip(name, documents, assets, { date: FIXED_ZIP_DATE });
		archive = new Uint8Array(await blob.arrayBuffer());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new CliError(EXIT.INPUT, 'export-failed', `Cannot build project archive: ${message}`);
	}
	deadline.check();
	await writeOutput(target, archive);
	return {
		output: target,
		documents: documents.length,
		assets: assets.length,
		bytes: archive.byteLength
	};
}

async function exportHtml(
	input: ExportInput,
	deadline: Deadline
): Promise<{
	output: string;
	title: string;
	documents: number;
	assets: number;
	bytes: number;
}> {
	const file = await requireFile(resolve(input.input));
	const content = await readText(dirname(file), basename(file));
	const kind = documentKindForFile({ name: file, content });
	if (kind === 'presentation')
		throw new CliError(
			EXIT.USAGE,
			'unsupported-format',
			'Presentation HTML export needs the GUI. Use --format md or --format zip.'
		);
	if (kind === 'image' || kind === 'code')
		throw new CliError(
			EXIT.USAGE,
			'unsupported-format',
			`HTML export supports Markdown notes only. The input is ${kind}.`
		);
	const target = await resolveOutput(input.out, 'html');
	const rendered = await renderMarkdownToHtml(content);
	const title = rendered.title || stripMdExtension(basename(file));
	const html = buildStandaloneHtml(rendered.html, {
		title,
		...(input.lang ? { lang: input.lang } : {})
	});
	deadline.check();
	await writeOutput(target, html);
	return {
		output: target,
		title,
		documents: 1,
		assets: 0,
		bytes: Buffer.byteLength(html, 'utf8')
	};
}

async function exportMarkdown(
	input: ExportInput,
	deadline: Deadline
): Promise<{
	output: string;
	title: string;
	documents: number;
	assets: number;
	bytes: number;
}> {
	const file = await requireFile(resolve(input.input));
	const content = await readText(dirname(file), basename(file));
	const kind = documentKindForFile({ name: file, content });
	if (kind === 'image')
		throw new CliError(
			EXIT.USAGE,
			'unsupported-format',
			'Markdown export does not support images.'
		);
	const target = await resolveOutput(input.out, 'md');
	deadline.check();
	await writeOutput(target, content);
	return {
		output: target,
		title: stripMdExtension(basename(file)),
		documents: 1,
		assets: 0,
		bytes: Buffer.byteLength(content, 'utf8')
	};
}

export async function runExport(input: ExportInput): Promise<number> {
	if (!FORMATS.has(input.format))
		throw new CliError(EXIT.USAGE, 'unsupported-format', `Unsupported format: ${input.format}`);
	const deadline = new Deadline(input.timeoutMs);
	const result =
		input.format === 'zip'
			? await exportZip(input, deadline)
			: input.format === 'html'
				? await exportHtml(input, deadline)
				: await exportMarkdown(input, deadline);
	if (input.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					schema: 'deckmark-export/1',
					input: displayPath(input.input),
					format: input.format,
					output: displayPath(result.output),
					title: 'title' in result ? result.title : null,
					documents: result.documents,
					assets: result.assets,
					bytes: result.bytes
				},
				null,
				2
			)}\n`
		);
	} else {
		process.stdout.write(
			`Exported ${result.documents} document${result.documents === 1 ? '' : 's'} and ${result.assets} asset${result.assets === 1 ? '' : 's'} to ${displayPath(result.output)} (${result.bytes} bytes).\n`
		);
	}
	return EXIT.OK;
}
