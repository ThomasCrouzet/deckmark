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

export { getTags, getTitle, stripFrontmatter } from './frontmatter-fields';

export interface ParsedFrontmatter {
	/** Normalized YAML data (flat object). */
	data: Record<string, unknown>;
	/** Markdown without the front-matter block. */
	content: string;
	/** Raw source prefix with the byte order mark and front matter, if present. */
	raw: string;
	/** YAML failure detail. The content stays usable when this field is present. */
	error?: string;
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
		if (typeof window !== 'undefined') {
			try {
				const { reportWarning } = await import('./report');
				reportWarning('invalid YAML front-matter, ignored', msg);
			} catch {
				// eslint-disable-next-line no-console -- Keep parsing available if the warning module fails.
				console.warn('[mdsh] invalid YAML front-matter, ignored :', msg);
			}
		}
		return { data: {}, content: md, raw: '', error: msg };
	}
}
