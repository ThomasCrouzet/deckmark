import { computeSelectionStats, computeStats, createStatsCache } from './stats';
import type { DocStats } from './stats-count';

export type StatsRuntime = ReturnType<typeof createStatsRuntime>;

export function createStatsRuntime(
	onStats: (id: string | null, content: string, stats: DocStats) => void
) {
	const cached = createStatsCache();
	let activeId: string | null = null;
	let activeContent = '';
	let disposed = false;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let workerTimer: ReturnType<typeof setTimeout> | null = null;
	let worker: Worker | null = null;
	let workerBusy = false;
	let workerUnavailable = false;
	let workerFailures = 0;
	let workerRetryAt = 0;
	let sequence = 0;

	function cancelPending() {
		sequence += 1;
		if (debounceTimer) clearTimeout(debounceTimer);
		if (workerTimer) clearTimeout(workerTimer);
		debounceTimer = null;
		workerTimer = null;
		if (workerBusy) {
			worker?.terminate();
			worker = null;
			workerBusy = false;
		}
	}

	function publish(id: string | null, content: string, stats: DocStats) {
		cached.set(id, content, stats);
		onStats(id, content, stats);
	}

	function measure(id: string, content: string, token: number) {
		const current = () =>
			!disposed && token === sequence && activeId === id && activeContent === content;
		if (!current()) return;
		if (
			content.length < 256 * 1024 ||
			(workerUnavailable && Date.now() < workerRetryAt) ||
			typeof Worker === 'undefined'
		) {
			publish(id, content, computeStats(content));
			return;
		}
		const fallback = () => {
			if (!current()) return;
			worker?.terminate();
			worker = null;
			workerBusy = false;
			workerUnavailable = true;
			workerFailures += 1;
			workerRetryAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(workerFailures, 6));
			if (workerTimer) clearTimeout(workerTimer);
			workerTimer = null;
			if (current()) publish(id, content, computeStats(content));
		};
		try {
			worker ??= new Worker(new URL('./workers/stats.worker.ts', import.meta.url), {
				type: 'module'
			});
			workerBusy = true;
			worker.onmessage = (event: MessageEvent<{ token: number; stats: DocStats }>) => {
				if (!current() || event.data.token !== token) return;
				if (workerTimer) clearTimeout(workerTimer);
				workerTimer = null;
				workerBusy = false;
				workerUnavailable = false;
				workerFailures = 0;
				workerRetryAt = 0;
				worker!.onmessage = null;
				worker!.onerror = null;
				worker!.onmessageerror = null;
				publish(id, content, event.data.stats);
			};
			worker.onerror = fallback;
			worker.onmessageerror = fallback;
			workerTimer = setTimeout(fallback, 5000);
			worker.postMessage({ token, text: content });
		} catch {
			fallback();
		}
	}

	return {
		setDocument(id: string | null, content: string): void {
			if (disposed) return;
			cancelPending();
			const switched = id !== activeId;
			activeId = id;
			activeContent = content;
			const hit = cached.get(id, content);
			if (hit) {
				onStats(id, content, hit);
				return;
			}
			if (switched || !id) {
				publish(id, content, computeStats(content));
				return;
			}
			const token = sequence;
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				measure(id, content, token);
			}, 200);
		},
		selection: computeSelectionStats,
		dispose(): void {
			disposed = true;
			cancelPending();
			worker?.terminate();
			worker = null;
			cached.clear();
			activeId = null;
			activeContent = '';
		}
	};
}
