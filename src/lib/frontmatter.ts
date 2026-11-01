// YAML front-matter - optional parsing of a `---` ... `---` block at the top of
// a markdown file. The metadata (title, tags, author, date, etc.) is used for:
//   - the window title (`document.title`), taking priority over the filename
//   - the sidebar tab label (taking priority over the filename)
//   - the tag filter in the sidebar
//   - a discreet metadata zone at the top of the PDF / preview
//
// js-yaml is lazy-loaded: the fast regex-based parsing lets us skip the import
// when the markdown contains no front-matter (the common case).
// (gray-matter depends on Node's `Buffer` - incompatible with the browser
// without a polyfill.)

import { reportWarning } from './report';

export interface ParsedFrontmatter {
	/** Normalized YAML data (flat object). */
	data: Record<string, unknown>;
	/** Markdown without the front-matter block. */
	content: string;
	/** Raw source prefix with the byte order mark and front matter, if present. */
	raw: string;
}

/**
 * Fast detection of a possible front-matter block without loading gray-matter.
 * The pattern: `---\n` at the top, followed by YAML content, then `---\n` (or EOF).
 * No strict YAML validation - we delegate that to gray-matter if present.
 */
function hasFrontmatterMarker(md: string): boolean {
	// Avoids false positives on hr (`---` alone). We require a newline after
	// `---` and then the presence of a second `---` further down.
	return /^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(md);
}

/**
 * Parses the front-matter of a markdown document. Returns empty `data` + the
 * markdown intact if no block is detected or if the YAML is invalid (fail-soft).
 *
 * Async because js-yaml is lazy-loaded. The caller must therefore be async too
 * (renderer, dynamic getTitle, etc.) - or use `stripFrontmatter` to retrieve
 * just the raw block without the dependency.
 */
export async function parseFrontmatter(md: string): Promise<ParsedFrontmatter> {
	const prefix = md.startsWith('\uFEFF') ? '\uFEFF' : '';
	const body = md.slice(prefix.length);
	if (!hasFrontmatterMarker(body)) {
		return { data: {}, content: body, raw: prefix };
	}

	// Extracts the raw YAML block without loading js-yaml - we avoid importing
	// the lib if the regex fails further down (badly closed front-matter, etc.).
	const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
	if (!match) return { data: {}, content: body, raw: prefix };
	// invariant: group 1 and index 0 are guaranteed non-undefined after the
	// `!match` check above (regex with a single mandatory capture group).
	const yamlText = match[1]!;
	const raw = prefix + match[0]!;
	const content = md.slice(raw.length);

	try {
		// js-yaml is ESM-only, ~26 KB gzipped. Lazy via dynamic import → stays out
		// of the initial bundle, lands in the chunk that requests the parsing.
		const yaml = await import('js-yaml');
		// DEFAULT_SCHEMA: parses ISO dates into Date, handles standard YAML tags.
		// Consistent with what gray-matter did (which used js-yaml by default
		// under the hood before its merge with Buffer).
		const parsed = yaml.load(yamlText, { schema: yaml.DEFAULT_SCHEMA });
		return {
			data:
				parsed && typeof parsed === 'object' && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>)
					: {},
			content,
			raw
		};
	} catch (err) {
		// Broken YAML: discreet log + fallback to intact markdown (no UI crash).
		// We log just the message (not the stack) so as not to pollute the console.
		const msg = err instanceof Error ? err.message : String(err);
		reportWarning('invalid YAML front-matter, ignored', msg);
		return { data: {}, content: md, raw: '' };
	}
}

/**
 * Synchronous variant that extracts just the raw block + the content without
 * parsing the YAML. Useful for critical paths where we don't want to load
 * gray-matter (e.g. extracting the title for the sidebar label).
 *
 * Always returns `data: {}` - the caller must use `parseFrontmatter` for the
 * real metadata.
 */
export function stripFrontmatter(md: string): { content: string; raw: string } {
	const prefix = md.startsWith('\uFEFF') ? '\uFEFF' : '';
	const body = md.slice(prefix.length);
	const match = /^(---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/.exec(body);
	if (!match) return { content: body, raw: prefix };
	// invariant: match[0] and match[1] are guaranteed after the `!match` check
	// (regex with a single capture group spanning the whole match).
	return { content: body.slice(match[0]!.length), raw: prefix + match[1]! };
}

/**
 * Retrieves the priority title:
 *   1. `data.title` (front-matter)
 *   2. first `# heading` of the markdown content (without the `#`)
 *   3. provided fallback (typically the filename without extension)
 *
 * `content` must be the markdown WITHOUT the front-matter (cf. `stripFrontmatter`
 * or `parseFrontmatter().content`).
 */
export function getTitle(data: Record<string, unknown>, content: string, fallback: string): string {
	if (typeof data.title === 'string' && data.title.trim()) {
		return data.title.trim();
	}
	const h1 = /^[ \t]*#[ \t]+(.+?)[ \t]*$/m.exec(content);
	// invariant: h1[1] is guaranteed non-undefined if `h1` is non-null
	// (group 1 is mandatory in the `.+?` regex).
	if (h1 && h1[1]!.trim()) {
		return h1[1]!.trim();
	}
	return fallback;
}

/**
 * Converts `data.tags` to an array of strings:
 *   - YAML array: `tags: [a, b]` → `['a', 'b']`
 *   - inline CSV: `tags: a, b, c` → `['a', 'b', 'c']`
 *   - single string: `tags: foo` → `['foo']`
 *   - other / absent: `[]`
 *
 * Trims values, removes duplicates and empty values, and preserves case.
 * Tags are opaque user strings.
 */
export function getTags(data: Record<string, unknown>): string[] {
	const raw = data.tags;
	let list: unknown[];
	if (Array.isArray(raw)) {
		list = raw;
	} else if (typeof raw === 'string') {
		list = raw.split(',');
	} else {
		return [];
	}
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of list) {
		if (typeof item !== 'string' && typeof item !== 'number') continue;
		// Removes any surrounding quotes: MetaIndex's fast regex parser
		// (front-matter not run through js-yaml) lets `tags: "a, b"` produce items
		// `"a` / `b"` - without this the tag chips would keep them.
		const tag = String(item)
			.trim()
			.replace(/^['"]|['"]$/g, '')
			.trim();
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		out.push(tag);
	}
	return out;
}
