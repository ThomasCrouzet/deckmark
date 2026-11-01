import { recordSourceFidelityPath, type SourceFidelityPath } from './source-fidelity-diagnostics';

interface MarkdownNode {
	type: string;
	value?: string | undefined;
	children?: MarkdownNode[] | undefined;
	position?:
		{ start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined;
}

interface Patch {
	start: number;
	end: number;
	value: string;
}

type Parse = (markdown: string) => MarkdownNode;

function start(node: MarkdownNode): number {
	return node.position?.start.offset ?? 0;
}

function end(node: MarkdownNode): number {
	return node.position?.end.offset ?? 0;
}

function properties(node: MarkdownNode): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(node)
				.filter(([key]) => !['position', 'children'].includes(key))
				.map(([key, value]) => [
					key,
					key === 'value' && typeof value === 'string' ? value.replaceAll('\r\n', '\n') : value
				])
		)
	);
}

function equal(a: MarkdownNode, b: MarkdownNode): boolean {
	return (
		properties(a) === properties(b) &&
		(a.children?.length ?? 0) === (b.children?.length ?? 0) &&
		(a.children ?? []).every((child, index) => equal(child, b.children![index]!))
	);
}

function apply(source: string, patches: Patch[]): string {
	let result = source;
	for (const patch of patches.toSorted((a, b) => b.start - a.start)) {
		result = result.slice(0, patch.start) + patch.value + result.slice(patch.end);
	}
	return result;
}

function changeRange(
	before: string,
	after: string
): { from: number; oldTo: number; newTo: number } {
	let from = 0;
	while (from < before.length && from < after.length && before[from] === after[from]) from++;
	let suffix = 0;
	while (
		suffix < before.length - from &&
		suffix < after.length - from &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	)
		suffix++;
	return { from, oldTo: before.length - suffix, newTo: after.length - suffix };
}

interface TextChange {
	from: number;
	oldTo: number;
	newFrom: number;
	newTo: number;
}

/** Keep unchanged text between separate edits in the same Markdown leaf. */
function textChanges(before: string, after: string): TextChange[] {
	const range = changeRange(before, after);
	const tokenize = (value: string) =>
		[...value.matchAll(/\s+|[\p{L}\p{N}_]+|[^\s]/gu)].map((match) => ({
			value: match[0],
			end: range.from + match.index + match[0].length
		}));
	const oldTokens = tokenize(before.slice(range.from, range.oldTo));
	const newTokens = tokenize(after.slice(range.from, range.newTo));
	const width = newTokens.length + 1;
	if ((oldTokens.length + 1) * width > 300_000) return [{ ...range, newFrom: range.from }];
	const matrix = new Uint32Array((oldTokens.length + 1) * width);
	for (let a = oldTokens.length - 1; a >= 0; a--) {
		for (let b = newTokens.length - 1; b >= 0; b--) {
			matrix[a * width + b] =
				oldTokens[a]!.value === newTokens[b]!.value
					? matrix[(a + 1) * width + b + 1]! + 1
					: Math.max(matrix[(a + 1) * width + b]!, matrix[a * width + b + 1]!);
		}
	}
	const changes: TextChange[] = [];
	let a = 0;
	let b = 0;
	let oldAt = range.from;
	let newAt = range.from;
	let pending: TextChange | null = null;
	const flush = () => {
		if (pending) changes.push({ ...pending, oldTo: oldAt, newTo: newAt });
		pending = null;
	};
	while (a < oldTokens.length || b < newTokens.length) {
		if (
			a < oldTokens.length &&
			b < newTokens.length &&
			oldTokens[a]!.value === newTokens[b]!.value
		) {
			flush();
			oldAt = oldTokens[a++]!.end;
			newAt = newTokens[b++]!.end;
		} else {
			pending ??= { from: oldAt, oldTo: oldAt, newFrom: newAt, newTo: newAt };
			if (
				b < newTokens.length &&
				(a === oldTokens.length || matrix[a * width + b + 1]! >= matrix[(a + 1) * width + b]!)
			)
				newAt = newTokens[b++]!.end;
			else oldAt = oldTokens[a++]!.end;
		}
	}
	flush();
	return changes;
}

/** Map decoded text boundaries to source offsets. */
function textRange(
	raw: string,
	value: string,
	from: number,
	to: number,
	code = false
): { from: number; to: number } | null {
	if (raw === value) return { from, to };
	let rawFrom = from === value.length ? raw.length : -1;
	let rawTo = to === value.length ? raw.length : -1;
	let cursor = 0;
	let decoder: HTMLTextAreaElement | undefined;
	const pattern = code
		? /\r\n|[\s\S]/g
		: /\\[!-/:-@[-`{-~]|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|\r\n|[\s\S]/gi;
	for (const unit of raw.matchAll(pattern)) {
		let text = unit[0];
		if (!code && text.startsWith('\\') && text.length === 2) text = text.slice(1);
		else if (text === '\r\n') text = '\n';
		else if (
			!code &&
			text.startsWith('&') &&
			text.endsWith(';') &&
			typeof document !== 'undefined'
		) {
			decoder ??= document.createElement('textarea');
			decoder.innerHTML = text;
			text = decoder.value;
		}
		for (let index = 0; index < text.length; index++) {
			if (text[index] !== value[cursor]) {
				// A text span can include its parent markers and indentation.
				if (/[\s>]/.test(text[index]!)) continue;
				return null;
			}
			if (cursor === from) rawFrom = unit.index;
			if (cursor === to) rawTo = unit.index;
			cursor++;
		}
	}
	return cursor === value.length && rawFrom >= 0 && rawTo >= 0
		? { from: rawFrom, to: rawTo }
		: null;
}

/** Keep original syntax outside the nodes that a visual edit changes. */
export class SourceFidelity {
	private original: MarkdownNode;
	private baseline: MarkdownNode;
	private cachedMarkdown: string;
	private cachedSource: string;
	private mappedOriginals: MarkdownNode[] | null = null;

	constructor(
		private source: string,
		private markdown: string,
		private parse: Parse,
		private normalize: (markdown: string) => string
	) {
		this.original = parse(source);
		this.baseline = parse(markdown);
		this.cachedMarkdown = markdown;
		this.cachedSource = source;
	}

	restore(markdown: string): string {
		if (markdown === this.cachedMarkdown) return this.cachedSource;
		if (markdown === this.markdown) return this.source;
		const next = this.parse(markdown);
		const before = this.baseline.children ?? [];
		let originals = this.mappedOriginals;
		if (!originals) {
			originals = (this.original.children ?? []).filter((node) => node.type !== 'definition');
			if (originals.length !== before.length) originals = this.alignBlocks(originals, before);
			this.mappedOriginals = originals;
		}
		const after = next.children ?? [];
		let result = markdown;
		let path: SourceFidelityPath = 'fullSerializer';
		if (originals.length === before.length) {
			const patches: Patch[] = [];
			let prefix = 0;
			while (
				prefix < before.length &&
				prefix < after.length &&
				equal(before[prefix]!, after[prefix]!)
			)
				prefix++;
			let suffix = 0;
			while (
				suffix < before.length - prefix &&
				suffix < after.length - prefix &&
				equal(before[before.length - 1 - suffix]!, after[after.length - 1 - suffix]!)
			)
				suffix++;
			const oldCount = before.length - prefix - suffix;
			const newCount = after.length - prefix - suffix;
			if (oldCount === newCount) {
				for (let index = prefix; index < before.length - suffix; index++) {
					this.patchNode(originals[index]!, before[index]!, after[index]!, markdown, patches);
				}
			} else {
				const from = oldCount
					? start(originals[prefix]!)
					: prefix < originals.length
						? start(originals[prefix]!)
						: this.source.length;
				const to = oldCount ? end(originals[prefix + oldCount - 1]!) : from;
				let value = newCount
					? markdown.slice(start(after[prefix]!), end(after[prefix + newCount - 1]!))
					: '';
				// Definitions have no visual node. Keep those inside a changed range.
				const definitions = (this.original.children ?? []).filter(
					(node) => node.type === 'definition' && start(node) >= from && end(node) <= to
				);
				for (const node of definitions) value += `\n\n${this.source.slice(start(node), end(node))}`;
				if (!oldCount && newCount && originals.length > 0)
					value = prefix < originals.length ? `${value}\n\n` : `\n\n${value}`;
				patches.push({ start: from, end: to, value: this.lineEndings(value) });
			}
			const candidate = apply(this.source, patches);
			// Reject a source patch if Markdown syntax changes its meaning.
			const target = this.parse(this.normalize(markdown));
			const matches = (value: string) => {
				try {
					return equal(this.parse(this.normalize(value)), target);
				} catch {
					return false;
				}
			};
			if (matches(candidate)) {
				result = candidate;
				path = 'fastPath';
			} else if (oldCount === newCount) {
				const blocks: Patch[] = [];
				for (let index = prefix; index < before.length - suffix; index++) {
					if (equal(before[index]!, after[index]!)) continue;
					blocks.push({
						start: start(originals[index]!),
						end: end(originals[index]!),
						value: this.lineEndings(markdown.slice(start(after[index]!), end(after[index]!)))
					});
				}
				const fallback = apply(this.source, blocks);
				if (matches(fallback)) {
					result = fallback;
					path = 'blockFallback';
				}
			}
		}
		this.cachedMarkdown = markdown;
		this.cachedSource = result;
		recordSourceFidelityPath(path);
		return result;
	}

	private alignBlocks(originals: MarkdownNode[], before: MarkdownNode[]): MarkdownNode[] {
		const definitions = (this.original.children ?? [])
			.filter((node) => node.type === 'definition')
			.map((node) => this.source.slice(start(node), end(node)))
			.join('\n\n');
		const mapped: MarkdownNode[] = [];
		let cursor = 0;
		for (const node of before) {
			const target = this.parse(this.normalize(this.markdown.slice(start(node), end(node))));
			let found = false;
			while (cursor < originals.length) {
				const original = originals[cursor++]!;
				const raw = this.source.slice(start(original), end(original));
				if (!equal(this.parse(this.normalize(`${raw}\n\n${definitions}`)), target)) continue;
				mapped.push(original);
				found = true;
				break;
			}
			if (!found) return [];
		}
		return mapped;
	}

	private lineEndings(value: string): string {
		return this.source.includes('\r\n') ? value.replace(/\r?\n/g, '\r\n') : value;
	}

	private patchNode(
		original: MarkdownNode,
		before: MarkdownNode,
		after: MarkdownNode,
		markdown: string,
		patches: Patch[]
	): void {
		if (equal(before, after)) return;
		const originalChildren = (original.children ?? []).filter((node) => node.type !== 'definition');
		const beforeChildren = before.children ?? [];
		const afterChildren = after.children ?? [];
		if (
			properties(before) === properties(after) &&
			originalChildren.length === beforeChildren.length &&
			beforeChildren.length > 0 &&
			originalChildren.every((node) => node.position)
		) {
			let prefix = 0;
			while (
				prefix < beforeChildren.length &&
				prefix < afterChildren.length &&
				equal(beforeChildren[prefix]!, afterChildren[prefix]!)
			)
				prefix++;
			let suffix = 0;
			while (
				suffix < beforeChildren.length - prefix &&
				suffix < afterChildren.length - prefix &&
				equal(
					beforeChildren[beforeChildren.length - 1 - suffix]!,
					afterChildren[afterChildren.length - 1 - suffix]!
				)
			)
				suffix++;
			const oldCount = beforeChildren.length - prefix - suffix;
			const newCount = afterChildren.length - prefix - suffix;
			if (oldCount === newCount) {
				for (let index = prefix; index < beforeChildren.length - suffix; index++) {
					this.patchNode(
						originalChildren[index]!,
						beforeChildren[index]!,
						afterChildren[index]!,
						markdown,
						patches
					);
				}
				return;
			}
			if (oldCount > 0 && newCount > 0) {
				patches.push({
					start: start(originalChildren[prefix]!),
					end: end(originalChildren[prefix + oldCount - 1]!),
					value: this.lineEndings(
						markdown.slice(
							start(afterChildren[prefix]!),
							end(afterChildren[prefix + newCount - 1]!)
						)
					)
				});
				return;
			}
		}
		if (
			original.type === before.type &&
			before.type === after.type &&
			['inlineCode', 'code'].includes(before.type) &&
			original.value?.replaceAll('\r\n', '\n') === before.value?.replaceAll('\r\n', '\n')
		) {
			const raw = this.source.slice(start(original), end(original));
			const oldValue = (before.value ?? '').replaceAll('\r\n', '\n');
			const newValue = (after.value ?? '').replaceAll('\r\n', '\n');
			const range = changeRange(oldValue, newValue);
			let offset = 0;
			let limit = raw.length;
			const fence =
				original.type === 'code' ? /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/.exec(raw) : null;
			const closing = fence ? /(?:\r?\n)[> \t]*(`{3,}|~{3,})[ \t]*$/.exec(raw) : null;
			if (fence) {
				offset = fence[0].length;
				if (closing && closing[1]![0] === fence[1]![0] && closing[1]!.length >= fence[1]!.length)
					limit = Math.max(offset, closing.index);
			} else if (original.type === 'inlineCode') {
				offset = /^`+/.exec(raw)?.[0].length ?? 0;
				limit -= offset;
			}
			const content = raw.slice(offset, limit);
			const mapped = textRange(content, oldValue, range.from, range.oldTo, true);
			if (mapped) {
				let value = newValue.slice(range.from, range.newTo);
				if (fence && !content && value) {
					if (!fence[0].endsWith('\n')) value = `\n${value}`;
					if (closing) value += '\n';
				}
				patches.push({
					start: start(original) + offset + mapped.from,
					end: start(original) + offset + mapped.to,
					value: this.lineEndings(value)
				});
				return;
			}
		}
		if (
			original.type === 'text' &&
			before.type === 'text' &&
			after.type === 'text' &&
			original.value?.replaceAll('\r\n', '\n') === before.value?.replaceAll('\r\n', '\n')
		) {
			const oldValue = (before.value ?? '').replaceAll('\r\n', '\n');
			const newValue = (after.value ?? '').replaceAll('\r\n', '\n');
			const raw = this.source.slice(start(original), end(original));
			const nextRaw = markdown.slice(start(after), end(after));
			const changes: Patch[] = [];
			let mapped = true;
			for (const range of textChanges(oldValue, newValue)) {
				const oldOffsets = textRange(raw, oldValue, range.from, range.oldTo);
				const newOffsets = textRange(nextRaw, newValue, range.newFrom, range.newTo);
				if (!oldOffsets || !newOffsets) {
					mapped = false;
					break;
				}
				changes.push({
					start: start(original) + oldOffsets.from,
					end: start(original) + oldOffsets.to,
					value: this.lineEndings(nextRaw.slice(newOffsets.from, newOffsets.to))
				});
			}
			if (mapped) {
				patches.push(...changes);
				return;
			}
		}
		patches.push({
			start: start(original),
			end: end(original),
			value: this.lineEndings(markdown.slice(start(after), end(after)))
		});
	}
}
