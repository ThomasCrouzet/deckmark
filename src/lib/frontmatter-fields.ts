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
