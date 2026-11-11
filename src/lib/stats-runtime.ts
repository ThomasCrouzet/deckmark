import { computeSelectionStats, computeStats, createStatsCache } from './stats';
import type { DocStats, SelectionStats } from './stats-count';

export type StatsRuntime = ReturnType<typeof createStatsRuntime>;

const WORKER_THRESHOLD = 256 * 1024;
const SELECTION_THRESHOLD = 64 * 1024;
const SELECTION_TIMEOUT = 5000;
const WORKER_TIMEOUT = 5000;

type SelectionPending = {
	token: number;
	text: string;
	resolve: (value: SelectionStats | null) => void;
	timer: ReturnType<typeof setTimeout>;
};

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
	let selectionWorker: Worker | null = null;
	let selectionSequence = 0;
	let selectionPending: SelectionPending | null = null;

	function dropSelection(): void {
		const pending = selectionPending;
		selectionPending = null;
		if (!pending) return;
		clearTimeout(pending.timer);
		// A superseded selection result must not replace the current counters.
		pending.resolve(null);
	}

	function stopSelection(): void {
		dropSelection();
		selectionWorker?.terminate();
		selectionWorker = null;
	}

	function failSelection(): void {
		const pending = selectionPending;
		selectionWorker?.terminate();
		selectionWorker = null;
		selectionPending = null;
		if (!pending) return;
		clearTimeout(pending.timer);
		pending.resolve(computeSelectionStats(pending.text));
	}

	function ensureSelectionWorker(): Worker | null {
		if (selectionWorker) return selectionWorker;
		try {
			const worker = new Worker(new URL('./workers/stats.worker.ts', import.meta.url), {
				type: 'module'
			});
			worker.onmessage = (event: MessageEvent<{ token: number; selection?: SelectionStats }>) => {
				const pending = selectionPending;
				if (!pending || event.data.token !== pending.token || !event.data.selection) return;
				selectionPending = null;
				clearTimeout(pending.timer);
				pending.resolve(event.data.selection);
			};
			worker.onerror = failSelection;
			worker.onmessageerror = failSelection;
			selectionWorker = worker;
			return worker;
		} catch {
			return null;
		}
	}

	function selection(text: string): Promise<SelectionStats | null> {
		dropSelection();
		if (text.length < SELECTION_THRESHOLD || typeof Worker === 'undefined')
			return Promise.resolve(computeSelectionStats(text));
		const worker = ensureSelectionWorker();
		if (!worker) return Promise.resolve(computeSelectionStats(text));
		selectionSequence += 1;
		const token = selectionSequence;
		return new Promise<SelectionStats | null>((resolve) => {
			const pending: SelectionPending = {
				token,
				text,
				resolve,
				timer: setTimeout(failSelection, SELECTION_TIMEOUT)
			};
			selectionPending = pending;
			try {
				worker.postMessage({ token, text, mode: 'selection' });
			} catch {
				failSelection();
			}
		});
	}

	function resetWorker(): void {
		worker?.terminate();
		worker = null;
		workerBusy = false;
	}

	function cancelPending() {
		sequence += 1;
		if (debounceTimer) clearTimeout(debounceTimer);
		if (workerTimer) clearTimeout(workerTimer);
		debounceTimer = null;
		workerTimer = null;
		if (workerBusy) resetWorker();
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
			content.length < WORKER_THRESHOLD ||
			(workerUnavailable && Date.now() < workerRetryAt) ||
			typeof Worker === 'undefined'
		) {
			publish(id, content, computeStats(content));
			return;
		}
		const fallback = () => {
			if (!current()) return;
			resetWorker();
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
			workerTimer = setTimeout(fallback, WORKER_TIMEOUT);
			worker.postMessage({ token, text: content });
		} catch {
			fallback();
		}
	}

	return {
		setDocument(id: string | null, content: string): void {
			if (disposed) return;
			const switched = id !== activeId;
			cancelPending();
			if (switched) {
				// Release the previous file's Worker baseline and selection text.
				stopSelection();
				resetWorker();
			}
			activeId = id;
			activeContent = content;
			const hit = cached.get(id, content);
			if (hit) {
				onStats(id, content, hit);
				return;
			}
			// A short document keeps the synchronous fast path.
			if (!id || content.length < WORKER_THRESHOLD) {
				publish(id, content, computeStats(content));
				return;
			}
			const token = sequence;
			// The first activation and a file switch must not count in the UI task.
			if (switched) {
				measure(id, content, token);
				return;
			}
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				measure(id, content, token);
			}, 200);
		},
		selection,
		dispose(): void {
			disposed = true;
			cancelPending();
			stopSelection();
			resetWorker();
			cached.clear();
			activeId = null;
			activeContent = '';
		}
	};
}
