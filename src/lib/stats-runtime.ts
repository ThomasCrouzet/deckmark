import { computeSelectionStats, computeStats, createStatsCache } from './stats';
import { applyEditSpans, validEditSpans, type DocumentEditSpan } from './edit-spans';
import type { ChangeSet } from '@codemirror/state';
import type { SourceEdit } from './source-edit';
import type {
	DocStats,
	SelectionStats,
	StatsPatch,
	StatsPatchSpan,
	StatsRequest,
	StatsResponse
} from './stats-count';

export type StatsRuntime = ReturnType<typeof createStatsRuntime>;

const METRICS = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';

const WORKER_THRESHOLD = 256 * 1024;
const SELECTION_THRESHOLD = 64 * 1024;
const SELECTION_TIMEOUT = 5000;
const WORKER_TIMEOUT = 5000;
// A bigger replacement sends the full text. The Worker keeps the baseline, so
// an ordinary edit transfers only its changed span.
const MAX_PATCH = 256 * 1024;

type PatchSpan = StatsPatchSpan;

function diffPatch(base: string, next: string): PatchSpan | null {
	const limit = Math.min(base.length, next.length);
	let start = 0;
	while (start < limit && base.charCodeAt(start) === next.charCodeAt(start)) start += 1;
	let baseEnd = base.length;
	let nextEnd = next.length;
	while (
		baseEnd > start &&
		nextEnd > start &&
		base.charCodeAt(baseEnd - 1) === next.charCodeAt(nextEnd - 1)
	) {
		baseEnd -= 1;
		nextEnd -= 1;
	}
	const remove = baseEnd - start;
	if (remove + (nextEnd - start) > MAX_PATCH) return null;
	return { start, remove, insert: next.slice(start, nextEnd) };
}

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
	// The source that the Worker holds. A patch is valid only for this text and
	// this job token.
	let workerBase: string | null = null;
	let workerBaseToken = 0;
	let workerStats: DocStats | null = null;
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
			worker.onmessage = (event: MessageEvent<StatsResponse>) => {
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
				worker.postMessage({ token, text, mode: 'selection' } satisfies StatsRequest);
			} catch {
				failSelection();
			}
		});
	}

	function resetWorker(): void {
		worker?.terminate();
		worker = null;
		workerBusy = false;
		workerBase = null;
		workerBaseToken = 0;
		workerStats = null;
	}

	function recordCount(detail: Record<string, unknown>): void {
		if (!METRICS) return;
		try {
			const at = performance.now();
			performance.measure('mdsh:stats-count', { start: at, end: at, detail });
		} catch {
			// Diagnostics must not change the counters.
		}
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

	function spansOf(
		content: string,
		edit: SourceEdit | null | undefined,
		changes: ChangeSet | null | undefined
	): readonly DocumentEditSpan[] | null {
		if (edit && edit.space === 'portable-source' && edit.kind !== 'full')
			return [
				{
					from: edit.previous.from,
					to: edit.previous.to,
					insert: content.slice(edit.next.from, edit.next.to)
				}
			];
		if (!changes) return null;
		const spans: DocumentEditSpan[] = [];
		changes.iterChanges((from, to, _fromB, _toB, inserted) =>
			spans.push({ from, to, insert: inserted.toString() })
		);
		return spans.length ? spans : null;
	}

	function measure(
		id: string,
		content: string,
		token: number,
		spans: readonly DocumentEditSpan[] | null
	) {
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
		if (workerBase === content && workerStats) {
			publish(id, content, workerStats);
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
			// Reuse the accepted span when the Worker holds the exact base
			// revision. The runtime never compares the strings in that case.
			// Accept the ledger record only when it reproduces the published
			// text from the Worker baseline. A stale record keeps the diff.
			const accepted =
				spans &&
				workerBase !== null &&
				validEditSpans(workerBase.length, spans) &&
				applyEditSpans(workerBase, spans) === content
					? spans
					: null;
			let patch: StatsPatch | null = null;
			let transport: 'span' | 'diff' | 'text' = 'text';
			let reason: string;
			if (accepted) {
				patch = {
					baseRevision: workerBaseToken,
					spans: accepted.map((span) => ({
						start: span.from,
						remove: span.to - span.from,
						insert: span.insert
					}))
				};
				transport = 'span';
				reason = 'accepted-span';
			} else if (workerBase !== null) {
				const diff = diffPatch(workerBase, content);
				if (diff) {
					patch = { baseRevision: workerBaseToken, spans: [diff] };
					transport = 'diff';
					reason = spans ? 'stale-span' : 'no-accepted-edit';
				} else {
					reason = 'replacement-too-large';
				}
			} else {
				reason = 'no-baseline';
			}
			const request: StatsRequest = patch ? { token, patch } : { token, text: content };
			const requestSpans = patch?.spans.length ?? 0;
			const requestBytes = patch?.spans.reduce((total, span) => total + span.insert.length, 0) ?? 0;
			workerBusy = true;
			worker.onmessage = (event: MessageEvent<StatsResponse>) => {
				const data = event.data;
				if (!current() || data.token !== token) return;
				if (data.needFull) {
					workerBase = null;
					workerBaseToken = 0;
					workerStats = null;
					worker!.postMessage({ token, text: content } satisfies StatsRequest);
					return;
				}
				if (!data.stats) return;
				if (workerTimer) clearTimeout(workerTimer);
				workerTimer = null;
				workerBusy = false;
				workerUnavailable = false;
				workerFailures = 0;
				workerRetryAt = 0;
				workerBase = content;
				workerBaseToken = token;
				workerStats = data.stats;
				recordCount({
					source: data.count === 'incremental' ? 'span' : transport === 'text' ? 'full' : 'diff',
					transport,
					reason: data.reason ?? reason,
					spans: requestSpans,
					deltaBytes: requestBytes,
					count: data.count ?? 'full'
				});
				worker!.onmessage = null;
				worker!.onerror = null;
				worker!.onmessageerror = null;
				publish(id, content, data.stats);
			};
			worker.onerror = fallback;
			worker.onmessageerror = fallback;
			workerTimer = setTimeout(fallback, WORKER_TIMEOUT);
			worker.postMessage(request);
		} catch {
			fallback();
		}
	}

	return {
		setDocument(
			id: string | null,
			content: string,
			edit?: SourceEdit | null,
			changes?: ChangeSet | null
		): void {
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
			const accepted = spansOf(content, edit, changes);
			const hit = cached.get(id, content);
			if (hit) {
				onStats(id, content, hit);
				return;
			}
			// A short document keeps the synchronous fast path.
			if (!id || content.length < WORKER_THRESHOLD) {
				if (id && METRICS)
					recordCount({ source: 'full', transport: 'text', reason: 'small-document', spans: 0 });
				publish(id, content, computeStats(content));
				return;
			}
			const token = sequence;
			// The first activation and a file switch must not count in the UI task.
			if (switched) {
				measure(id, content, token, accepted);
				return;
			}
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				measure(id, content, token, accepted);
			}, 200);
		},
		selection,
		/** Drops a pending selection result without publishing it. */
		cancelSelection(): void {
			dropSelection();
		},
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
