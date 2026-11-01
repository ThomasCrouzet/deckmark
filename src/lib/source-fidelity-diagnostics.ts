export type SourceFidelityPath = 'fastPath' | 'blockFallback' | 'fullSerializer';

export type SourceFidelityCounts = Record<SourceFidelityPath, number>;

/** Send local test evidence only in an instrumented build. */
export function recordSourceFidelityPath(path: SourceFidelityPath): void {
	if (import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1' && typeof window !== 'undefined') {
		window.dispatchEvent(new CustomEvent('deckmark:source-fidelity', { detail: path }));
	}
}
