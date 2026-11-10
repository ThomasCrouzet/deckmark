import { contentHash } from './ai/patches';
import { documentKindForFile } from './document-kind';
import type { FileItem } from './types';

export interface LinkedBlock {
	fileId: string;
	path: string;
	id: string;
	/** Stable selection identity. It includes the occurrence of a repeated block ID. */
	key: string;
	occurrence: number;
	body: string;
	hash: string;
	from: number;
	to: number;
}

/** Selects one exact block, including repeated IDs in the same source file. */
export function linkedBlockKey(fileId: string, id: string, occurrence: number): string {
	return `${fileId}\u0000${id}\u0000${occurrence}`;
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

export type LinkState = 'current' | 'changed' | 'missing' | 'frozen' | 'cycle' | 'ambiguous';

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
	const occurrences = new Map<string, number>();
	for (const match of file.content.matchAll(BLOCK)) {
		const body = match[2] ?? '';
		const id = match[1]!;
		const occurrence = occurrences.get(id) ?? 0;
		occurrences.set(id, occurrence + 1);
		blocks.push({
			fileId: file.id,
			path: pathOf(file),
			id,
			key: linkedBlockKey(file.id, id, occurrence),
			occurrence,
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

/** One-pass index that keeps the original first-match precedence. */
function sourceIndex(files: readonly FileItem[]): Map<string, FileItem> {
	const index = new Map<string, FileItem>();
	for (const file of files) {
		for (const key of [pathOf(file), file.name, file.name.replace(/\.[^.]+$/, '')]) {
			if (!index.has(key)) index.set(key, file);
		}
	}
	return index;
}

/** Iterative Tarjan SCC. The call stack stays bounded for deep chains. */
function stronglyConnectedComponents(graph: Map<string, string[]>): {
	component: Map<string, number>;
	selfLoop: Set<string>;
} {
	const indices = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const component = new Map<string, number>();
	const selfLoop = new Set<string>();
	let counter = 0;
	let components = 0;
	for (const start of graph.keys()) {
		if (indices.has(start)) continue;
		const frames: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
		indices.set(start, counter);
		low.set(start, counter++);
		stack.push(start);
		onStack.add(start);
		while (frames.length > 0) {
			const frame = frames.at(-1)!;
			const edges = graph.get(frame.id) ?? [];
			if (frame.next < edges.length) {
				const next = edges[frame.next++]!;
				if (next === frame.id) selfLoop.add(frame.id);
				if (!indices.has(next)) {
					indices.set(next, counter);
					low.set(next, counter++);
					stack.push(next);
					onStack.add(next);
					frames.push({ id: next, next: 0 });
				} else if (onStack.has(next)) {
					low.set(frame.id, Math.min(low.get(frame.id)!, indices.get(next)!));
				}
				continue;
			}
			frames.pop();
			const parent = frames.at(-1);
			if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
			if (low.get(frame.id) === indices.get(frame.id)) {
				let member: string;
				do {
					member = stack.pop()!;
					onStack.delete(member);
					component.set(member, components);
				} while (member !== frame.id);
				components++;
			}
		}
	}
	return { component, selfLoop };
}

/** Resolves every include without changing any file. */
export function buildLinkReport(files: readonly FileItem[]): LinkReport[] {
	const blocksByFile = new Map<string, Map<string, LinkedBlock[]>>();
	for (const file of files) {
		const blocks = new Map<string, LinkedBlock[]>();
		for (const block of extractBlocks(file)) {
			const matches = blocks.get(block.id);
			if (matches) matches.push(block);
			else blocks.set(block.id, [block]);
		}
		blocksByFile.set(file.id, blocks);
	}
	const sources = sourceIndex(files);
	const graph = new Map<string, string[]>();
	for (const file of files) {
		graph.set(
			file.id,
			extractIncludes(file).flatMap((include) => {
				const id = sources.get(include.sourcePath)?.id;
				return id ? [id] : [];
			})
		);
	}
	const { component, selfLoop } = stronglyConnectedComponents(graph);

	const reports: LinkReport[] = [];
	for (const file of files) {
		for (const include of extractIncludes(file)) {
			const source = sources.get(include.sourcePath);
			const matches = source ? (blocksByFile.get(source.id)?.get(include.blockId) ?? []) : [];
			const block = matches.length === 1 ? matches[0] : undefined;
			const ambiguous = matches.length > 1;
			const cycle =
				source !== undefined &&
				component.get(source.id) === component.get(file.id) &&
				(source.id !== file.id || selfLoop.has(file.id));
			reports.push({
				include,
				state: cycle
					? 'cycle'
					: ambiguous
						? 'ambiguous'
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
