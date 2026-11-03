// Byte-preserving front matter property edits. Only the edited value range
// changes; comments, ordering, indentation and unrelated keys stay intact.

export type FrontmatterValue = string | string[] | number | boolean | null;

export interface FrontmatterProperty {
	key: string;
	value: FrontmatterValue;
	kind: 'string' | 'tags' | 'number' | 'boolean' | 'date' | 'other';
	raw: string;
}

interface LineRange {
	key: string;
	start: number;
	end: number;
	valueStart: number;
	valueEnd: number;
	inline: string;
	block: boolean;
}

interface Block {
	prefix: string;
	open: string;
	yaml: string;
	close: string;
	content: string;
	eol: string;
}

function blockOf(markdown: string): Block | null {
	const prefix = markdown.startsWith('\uFEFF') ? '\uFEFF' : '';
	const body = markdown.slice(prefix.length);
	const match = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(body);
	if (!match) return null;
	return {
		prefix,
		open: match[1]!,
		yaml: match[2]!,
		close: match[3]!,
		content: body.slice(match[0].length),
		eol: body.includes('\r\n') ? '\r\n' : '\n'
	};
}

function keyRanges(yaml: string): LineRange[] {
	const ranges: LineRange[] = [];
	const lines = yaml.split(/\r?\n/);
	let offset = 0;
	let current: LineRange | null = null;
	for (const line of lines) {
		const match = /^([A-Za-z0-9_.-]+)[ \t]*:([ \t]*)(.*)$/.exec(line);
		if (match) {
			if (current) {
				current.end = offset;
				if (current.valueEnd === 0) current.valueEnd = offset;
			}
			const key = match[1]!;
			const afterColon = match[2]!.length;
			const inline = match[3] ?? '';
			const valueStart = offset + key.length + 1 + afterColon;
			current = {
				key,
				start: offset,
				end: yaml.length,
				valueStart,
				valueEnd: valueStart + inline.length,
				inline,
				block: inline.trim() === ''
			};
			ranges.push(current);
		} else if (current && current.inline.trim() === '') {
			current.block = true;
		}
		offset += line.length + (yaml[offset + line.length] === '\r' ? 2 : 1);
	}
	return ranges;
}

function unquote(raw: string): string {
	const trimmed = raw.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function classify(key: string, raw: string): FrontmatterProperty['kind'] {
	if (key === 'tags' || key === 'aliases') return 'tags';
	if (/^(true|false)$/i.test(raw.trim())) return 'boolean';
	if (/^-?\d+(?:\.\d+)?$/.test(raw.trim())) return 'number';
	if (/^\d{4}-\d{2}-\d{2}/.test(unquote(raw))) return 'date';
	if (/^\[[\s\S]*\]$/.test(raw.trim())) return 'tags';
	return raw.trim() === '' ? 'other' : 'string';
}

function valueOf(kind: FrontmatterProperty['kind'], raw: string): FrontmatterValue {
	const text = unquote(raw);
	if (kind === 'tags') {
		const inner = raw.trim().startsWith('[') ? raw.trim().slice(1, -1) : text;
		return inner
			.split(',')
			.map((item) => unquote(item).trim())
			.filter(Boolean);
	}
	if (kind === 'boolean') return text.toLowerCase() === 'true';
	if (kind === 'number') return Number(text);
	return text;
}

/** Returns top-level front matter properties without changing the source. */
export function readFrontmatterProperties(markdown: string): FrontmatterProperty[] {
	const block = blockOf(markdown);
	if (!block) return [];
	return keyRanges(block.yaml).map((range) => {
		const raw = block.yaml.slice(range.valueStart, range.valueEnd);
		const kind = classify(range.key, raw);
		return { key: range.key, kind, raw, value: valueOf(kind, raw) };
	});
}

function quote(value: string): string {
	return /^[^\s#:[\]{},&*!|>'"%@`-].*$/.test(value) && !/:\s|\s#/.test(value)
		? value
		: `'${value.replaceAll("'", "''")}'`;
}

function renderValue(
	value: FrontmatterValue,
	previous: Pick<LineRange, 'inline' | 'block'> | undefined,
	eol: string
): string {
	if (value === null) return '';
	if (Array.isArray(value)) {
		const items = value.map((item) => quote(String(item)));
		if (previous?.inline.trim().startsWith('[')) return `[${items.join(', ')}]`;
		if (previous?.block) return `${eol}${items.map((item) => `  - ${item}`).join(eol)}`;
		return `[${items.join(', ')}]`;
	}
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
	return quote(value);
}

/** Applies one property. A null or empty string removes the key. */
export function setFrontmatterProperty(
	markdown: string,
	key: string,
	value: FrontmatterValue
): string {
	if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error('Invalid front matter key');
	const normalized = Array.isArray(value)
		? value.map((item) => item.trim()).filter(Boolean)
		: typeof value === 'string'
			? value.trim()
			: value;
	const remove =
		normalized === null ||
		normalized === '' ||
		(Array.isArray(normalized) && normalized.length === 0);
	const block = blockOf(markdown);
	if (!block) {
		if (remove) return markdown;
		const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
		return `---${eol}${key}: ${renderValue(normalized, undefined, eol)}${eol}---${eol}${eol}${markdown}`;
	}
	const ranges = keyRanges(block.yaml);
	const range = ranges.find((entry) => entry.key === key);
	if (remove) {
		if (!range) return markdown;
		const before = block.yaml.slice(0, range.start);
		const after = block.yaml.slice(range.end);
		const yaml = (before + after).replace(/\r?\n$/, '');
		return `${block.prefix}${block.open}${yaml}${block.close}${block.content}`;
	}
	const rendered = renderValue(normalized, range, block.eol);
	if (!range) {
		const yaml = `${block.yaml}${block.yaml ? block.eol : ''}${key}: ${rendered}`;
		return `${block.prefix}${block.open}${yaml}${block.close}${block.content}`;
	}
	if (range.block && !rendered.startsWith(block.eol)) {
		// The old value used following lines. Replace the whole block.
		const yaml =
			block.yaml.slice(0, range.start) + `${key}: ${rendered}` + block.yaml.slice(range.end);
		return `${block.prefix}${block.open}${yaml}${block.close}${block.content}`;
	}
	const yaml = block.yaml.slice(0, range.valueStart) + rendered + block.yaml.slice(range.valueEnd);
	return `${block.prefix}${block.open}${yaml}${block.close}${block.content}`;
}

/** Applies several properties in order. */
export function updateFrontmatter(
	markdown: string,
	changes: ReadonlyArray<{ key: string; value: FrontmatterValue }>
): string {
	return changes.reduce(
		(next, change) => setFrontmatterProperty(next, change.key, change.value),
		markdown
	);
}
