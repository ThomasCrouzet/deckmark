import type { DocStats } from './stats-count';
export {
	computeStats,
	computeSelectionStats,
	type DocStats,
	type SelectionStats
} from './stats-count';

// Cache bookkeeping must not become an effect dependency.
export function createStatsCache() {
	const cached = new Map<string, { content: string; stats: DocStats }>();
	let cachedChars = 0;
	return {
		get(id: string | null, content: string): DocStats | null {
			if (!id) return null;
			const hit = cached.get(id);
			if (!hit || hit.content !== content) return null;
			cached.delete(id);
			cached.set(id, hit);
			return hit.stats;
		},
		set(id: string | null, content: string, value: DocStats): void {
			if (!id) return;
			cachedChars -= cached.get(id)?.content.length ?? 0;
			cached.delete(id);
			if (content.length > 10_000_000) return;
			cached.set(id, { content, stats: value });
			cachedChars += content.length;
			while (cached.size > 8 || cachedChars > 10_000_000) {
				const oldest = cached.keys().next().value;
				if (oldest === undefined) break;
				cachedChars -= cached.get(oldest)!.content.length;
				cached.delete(oldest);
			}
		},
		clear(): void {
			cached.clear();
			cachedChars = 0;
		}
	};
}
