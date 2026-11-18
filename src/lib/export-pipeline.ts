// Bounded export pipeline: shared batch policy, main-thread yields and the
// local measurement probe.
//
// The policy applies to local collection and encoding work. It does not change
// a portable format. Each stage reads or serializes a bounded window, then
// yields. A caller can stop the operation through an AbortSignal at every
// yield point.
//
// The probe is a diagnostic. It records counters for local evidence; it is not
// a heap measurement and it does not replace a native or physical-device run.

export const EXPORT_BATCH_POLICY = {
	/** Rows read and normalized before a yield. */
	maxRows: 32,
	/** One raw project asset row is converted and released at a time. */
	maxAssetRows: 1,
	/** Serialized JSON characters kept in one output chunk. */
	maxChunkChars: 512 * 1024,
	/** Text characters validated before an early yield inside one batch. */
	maxTextChars: 1024 * 1024
} as const;

export type ExportPhase = 'collect' | 'encode' | 'compress' | 'encrypt' | 'write';

export interface ExportProgress {
	phase: ExportPhase;
	completed: number;
	total: number;
	/** Whole percent of the complete operation, from 0 to 100. */
	percent: number;
}

export type ExportProgressReporter = (progress: ExportProgress) => void;

export interface ExportPipelineSnapshot {
	kind: string;
	completed: boolean;
	cancelled: boolean;
	batches: number;
	yields: number;
	rows: number;
	maxBatchRows: number;
	maxLiveAssetBytes: number;
	serializedChars: number;
	maxChunkChars: number;
	joinedCopyChars: number;
	maxPercent: number;
	progressEvents: number;
	timings: Record<string, number>;
}

interface MainScheduler {
	yield?: () => Promise<void>;
}

function instrumentedDelay(): number {
	const value = (globalThis as { __MDSH_EXPORT_PIPELINE_DELAY_MS__?: unknown })
		.__MDSH_EXPORT_PIPELINE_DELAY_MS__;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
	return Math.min(500, Math.round(value));
}

/**
 * Gives the browser one turn to process input, paint and other tasks. The
 * scheduler API yields without a timer clamp where the engine provides it.
 * The instrumented delay makes the yield points observable in a local profile.
 */
export async function yieldToMainThread(): Promise<void> {
	const scheduler = (globalThis as { scheduler?: MainScheduler }).scheduler;
	if (scheduler && typeof scheduler.yield === 'function') {
		await scheduler.yield();
	} else {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	const delay = instrumentedDelay();
	if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

const published: ExportPipelineSnapshot[] = [];
const MAX_PUBLISHED = 20;
let probeInstalled = false;

function installProbe(): void {
	if (probeInstalled || typeof window === 'undefined') return;
	probeInstalled = true;
	const host = window as unknown as {
		__MDSH_EXPORT_PIPELINE__?: {
			runs(): ExportPipelineSnapshot[];
			reset(): void;
		};
	};
	host.__MDSH_EXPORT_PIPELINE__ = {
		runs: () => published.map((snapshot) => ({ ...snapshot, timings: { ...snapshot.timings } })),
		reset: () => {
			published.length = 0;
		}
	};
}

/** Counters for one operation. One run covers collection, encoding and output. */
export class ExportPipelineRun {
	private readonly kind: string;
	private readonly startedAt = performance.now();
	private batches = 0;
	private yields = 0;
	private rows = 0;
	private maxBatchRows = 0;
	private maxLiveAssetBytes = 0;
	private serializedChars = 0;
	private maxChunkChars = 0;
	private joinedCopyChars = 0;
	private maxPercent = 0;
	private progressEvents = 0;
	private readonly timings: Record<string, number> = {};
	private phaseStartedAt: number | null = null;
	private phaseName: string | null = null;
	private finished = false;

	constructor(kind: string) {
		this.kind = kind;
		installProbe();
	}

	beginPhase(name: string): void {
		if (this.phaseName && this.phaseStartedAt !== null) this.endPhase();
		this.phaseName = name;
		this.phaseStartedAt = performance.now();
	}

	endPhase(): void {
		if (!this.phaseName || this.phaseStartedAt === null) return;
		this.timings[this.phaseName] =
			(this.timings[this.phaseName] ?? 0) + (performance.now() - this.phaseStartedAt);
		this.phaseName = null;
		this.phaseStartedAt = null;
	}

	noteBatch(rows: number, liveAssetBytes = 0): void {
		this.batches++;
		this.rows += rows;
		if (rows > this.maxBatchRows) this.maxBatchRows = rows;
		if (liveAssetBytes > this.maxLiveAssetBytes) this.maxLiveAssetBytes = liveAssetBytes;
	}

	noteYield(): void {
		this.yields++;
	}

	noteChunk(chars: number): void {
		this.serializedChars += chars;
		if (chars > this.maxChunkChars) this.maxChunkChars = chars;
	}

	noteJoinedCopy(chars: number): void {
		if (chars > this.joinedCopyChars) this.joinedCopyChars = chars;
	}

	noteProgress(percent: number): void {
		const bounded = Math.min(100, Math.max(0, Math.round(percent)));
		this.progressEvents++;
		if (bounded > this.maxPercent) this.maxPercent = bounded;
	}

	finish(outcome: 'completed' | 'cancelled' | 'failed'): void {
		if (this.finished) return;
		this.finished = true;
		this.endPhase();
		this.timings.total = performance.now() - this.startedAt;
		const snapshot: ExportPipelineSnapshot = {
			kind: this.kind,
			completed: outcome === 'completed',
			cancelled: outcome === 'cancelled',
			batches: this.batches,
			yields: this.yields,
			rows: this.rows,
			maxBatchRows: this.maxBatchRows,
			maxLiveAssetBytes: this.maxLiveAssetBytes,
			serializedChars: this.serializedChars,
			maxChunkChars: this.maxChunkChars,
			joinedCopyChars: this.joinedCopyChars,
			maxPercent: this.maxPercent,
			progressEvents: this.progressEvents,
			timings: { ...this.timings }
		};
		published.push(snapshot);
		if (published.length > MAX_PUBLISHED) published.shift();
	}
}

/**
 * Reads exact rows in bounded key pages.
 *
 * The caller captures the key order once. A page then reads its rows by key, so
 * a concurrent insert or delete cannot shift a later page. A signal stops the
 * read at a page boundary.
 */
export async function readKeyBatches<T>(
	keys: readonly string[],
	read: (keys: string[]) => Promise<Array<T | undefined>>,
	options: {
		limit: number;
		signal?: AbortSignal | undefined;
		run: ExportPipelineRun;
		onBatch: (rows: T[], requested: number) => void | Promise<void>;
		/** Raw bytes held by one page, for the asset live-bytes counter. */
		liveBytes?: ((rows: T[]) => number) | undefined;
	}
): Promise<void> {
	for (let offset = 0; offset < keys.length; offset += options.limit) {
		if (options.signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
		const page = keys.slice(offset, offset + options.limit);
		const rows = (await read(page)).filter((row): row is T => row !== undefined);
		options.run.noteBatch(page.length, options.liveBytes?.(rows) ?? 0);
		await options.onBatch(rows, page.length);
		if (offset + options.limit < keys.length) {
			options.run.noteYield();
			await yieldToMainThread();
		}
	}
}
