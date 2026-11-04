import { contentHash } from './ai/patches';
import { documentKindForFile } from './document-kind';
import type { FileItem } from './types';

export interface LinkedBlock {
	fileId: string;
	path: string;
	id: string;
	body: string;
	hash: string;
	from: number;
	to: number;
}

export interface LinkedInclude {
	fileId: string;
	path: string;
	sourcePath: string;
	blockId: string;
	hash: string;
	mode: 'linked' | 'frozen';
	body: string;
	from: number;
	to: number;
}

export type LinkState = 'current' | 'changed' | 'missing' | 'frozen' | 'cycle';

export interface LinkReport {
	include: LinkedInclude;
	state: LinkState;
	sourceBody: string;
	sourceHash: string;
}

const BLOCK =
	/<!--\s*mdsh-block id="([^"]+)"\s*-->\r?\n?([\s\S]*?)\r?\n?<!--\s*\/mdsh-block\s*-->/g;
const INCLUDE =
	/<!--\s*mdsh-include source="([^"]+)" block="([^"]+)" hash="([^"]*)" mode="(linked|frozen)"\s*-->\r?\n?<!--\s*mdsh-snapshot\s*-->\r?\n?([\s\S]*?)\r?\n?<!--\s*\/mdsh-snapshot\s*-->\r?\n?<!--\s*\/mdsh-include\s*-->/g;

function pathOf(file: FileItem): string {
	return file.relativePath ?? file.name;
}

export function extractBlocks(file: FileItem): LinkedBlock[] {
	if (documentKindForFile(file) !== 'note') return [];
	const blocks: LinkedBlock[] = [];
	for (const match of file.content.matchAll(BLOCK)) {
		const body = match[2] ?? '';
		blocks.push({
			fileId: file.id,
			path: pathOf(file),
			id: match[1]!,
			body,
			hash: contentHash(body.trim()),
			from: match.index ?? 0,
			to: (match.index ?? 0) + match[0].length
		});
	}
	return blocks;
}

export function extractIncludes(file: FileItem): LinkedInclude[] {
	if (documentKindForFile(file) !== 'note') return [];
	const includes: LinkedInclude[] = [];
	for (const match of file.content.matchAll(INCLUDE)) {
		includes.push({
			fileId: file.id,
			path: pathOf(file),
			sourcePath: match[1]!,
			blockId: match[2]!,
			hash: match[3]!,
			mode: match[4] === 'frozen' ? 'frozen' : 'linked',
			body: match[5] ?? '',
			from: match.index ?? 0,
			to: (match.index ?? 0) + match[0].length
		});
	}
	return includes;
}

function findSource(files: readonly FileItem[], sourcePath: string): FileItem | undefined {
	return files.find(
		(file) =>
			pathOf(file) === sourcePath ||
			file.name === sourcePath ||
			file.name.replace(/\.[^.]+$/, '') === sourcePath
	);
}

/** Resolves every include without changing any file. */
export function buildLinkReport(files: readonly FileItem[]): LinkReport[] {
	const blocksByFile = new Map<string, LinkedBlock[]>();
	for (const file of files) blocksByFile.set(file.id, extractBlocks(file));
	const graph = new Map<string, string[]>();
	for (const file of files) {
		graph.set(
			file.id,
			extractIncludes(file)
				.map((include) => findSource(files, include.sourcePath)?.id)
				.filter((id): id is string => !!id)
		);
	}
	const inCycle = new Set<string>();
	const visit = (id: string, stack: Set<string>): boolean => {
		if (stack.has(id)) return true;
		stack.add(id);
		for (const next of graph.get(id) ?? []) {
			if (visit(next, stack)) {
				inCycle.add(id);
				stack.delete(id);
				return true;
			}
		}
		stack.delete(id);
		return false;
	};
	for (const id of graph.keys()) visit(id, new Set());

	const reports: LinkReport[] = [];
	for (const file of files) {
		for (const include of extractIncludes(file)) {
			const source = findSource(files, include.sourcePath);
			const block = source
				? blocksByFile.get(source.id)?.find((entry) => entry.id === include.blockId)
				: undefined;
			const cycle = source ? inCycle.has(source.id) && inCycle.has(file.id) : false;
			reports.push({
				include,
				state: cycle
					? 'cycle'
					: !block
						? 'missing'
						: include.mode === 'frozen'
							? 'frozen'
							: include.hash === block.hash
								? 'current'
								: 'changed',
				sourceBody: block?.body ?? '',
				sourceHash: block?.hash ?? ''
			});
		}
	}
	return reports;
}

export function renderInclude(
	sourcePath: string,
	blockId: string,
	hash: string,
	body: string,
	mode: 'linked' | 'frozen' = 'linked'
): string {
	return `<!-- mdsh-include source="${sourcePath}" block="${blockId}" hash="${hash}" mode="${mode}" -->
<!-- mdsh-snapshot -->
${body}
<!-- /mdsh-snapshot -->
<!-- /mdsh-include -->`;
}

export function insertInclude(
	content: string,
	sourcePath: string,
	blockId: string,
	hash: string,
	body: string
): string {
	const separator = content.endsWith('\n') ? '\n' : '\n\n';
	return `${content}${separator}${renderInclude(sourcePath, blockId, hash, body)}\n`;
}

/** Updates one include snapshot in a consumer file. */
export function updateInclude(content: string, include: LinkedInclude, body: string): string {
	return (
		content.slice(0, include.from) +
		renderInclude(include.sourcePath, include.blockId, contentHash(body.trim()), body, 'linked') +
		content.slice(include.to)
	);
}

/** Freezes the current snapshot. Source changes no longer report as changed. */
export function freezeInclude(content: string, include: LinkedInclude): string {
	return (
		content.slice(0, include.from) +
		renderInclude(include.sourcePath, include.blockId, include.hash, include.body, 'frozen') +
		content.slice(include.to)
	);
}

/** Removes the link and leaves the current snapshot text in place. */
export function detachInclude(content: string, include: LinkedInclude): string {
	return content.slice(0, include.from) + include.body + content.slice(include.to);
}

/** Replaces a block body in its canonical file. */
export function replaceBlockBody(content: string, blockId: string, body: string): string {
	return content.replace(
		new RegExp(
			`(<!--\\s*mdsh-block id="${blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*-->)` +
				`[\\s\\S]*?` +
				`(<!--\\s*\\/mdsh-block\\s*-->)`
		),
		`$1\n${body}\n$2`
	);
}
