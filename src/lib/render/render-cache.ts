export class RenderCache {
	private entries = new Map<string, { value: string; bytes: number }>();
	private bytes = 0;
	hits = 0;
	misses = 0;

	constructor(
		private readonly maxBytes: number,
		private readonly maxEntries: number
	) {}

	get(key: string): string | undefined {
		const entry = this.entries.get(key);
		if (!entry) {
			this.misses++;
			return undefined;
		}
		this.hits++;
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}

	set(key: string, value: string): void {
		const previous = this.entries.get(key);
		if (previous) {
			this.entries.delete(key);
			this.bytes -= previous.bytes;
		}
		// Include both UTF-16 strings and a conservative fixed entry allowance.
		const bytes = 2 * (key.length + value.length) + 128;
		if (bytes > this.maxBytes) return;
		while (this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.bytes -= this.entries.get(oldest)!.bytes;
			this.entries.delete(oldest);
		}
		this.entries.set(key, { value, bytes });
		this.bytes += bytes;
	}

	usage(): { bytes: number; entries: number; maxBytes: number; maxEntries: number } {
		return {
			bytes: this.bytes,
			entries: this.entries.size,
			maxBytes: this.maxBytes,
			maxEntries: this.maxEntries
		};
	}
}
