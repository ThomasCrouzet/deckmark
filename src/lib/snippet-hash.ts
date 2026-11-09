/** Stable, noncryptographic key for snippet duplicate candidate lookup. */
export function hashSnippetCode(code: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < code.length; index++) {
		hash ^= code.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}
