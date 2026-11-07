export interface RenderStageSample {
	stage: string;
	durationMs: number;
	thread: 'main' | 'worker';
	cacheHits?: number;
	cacheMisses?: number;
	cache?: { bytes: number; entries: number; maxBytes: number; maxEntries: number };
}

export function recordRenderStage(sample: RenderStageSample, fileId?: string): void {
	if (import.meta.env.VITE_SOURCE_FIDELITY_METRICS !== '1') return;
	performance.measure(`mdsh:render:${sample.stage}`, {
		start: performance.now() - sample.durationMs,
		end: performance.now(),
		detail: { ...sample, fileId, timing: 'duration-summary-at-coordinator' }
	});
}
