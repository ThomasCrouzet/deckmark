/**
 * Allocates heading identifiers in document order with the same suffix
 * sequence as the renderer always used. Each base keeps a suffix cursor, so
 * repeated headings do not probe the same candidates for each occurrence.
 */
export class HeadingIdAllocator {
	private readonly used = new Set<string>();
	private readonly nextSuffix = new Map<string, number>();

	allocate(base: string): string {
		if (!this.used.has(base)) {
			this.used.add(base);
			return base;
		}
		let suffix = this.nextSuffix.get(base) ?? 2;
		let candidate = `${base}-${suffix}`;
		while (this.used.has(candidate)) candidate = `${base}-${++suffix}`;
		this.nextSuffix.set(base, suffix + 1);
		this.used.add(candidate);
		return candidate;
	}
}
