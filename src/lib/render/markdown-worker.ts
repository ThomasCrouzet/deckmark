import { abortable, checkAborted } from '../abort';
import { t } from '../i18n';
import type { MarkdownParserInput, MarkdownParserOutput } from './markdown-parser';

export type ParsePriority = 'active' | 'background';

interface Job {
	input: MarkdownParserInput;
	signal: AbortSignal | undefined;
	resolve: (output: MarkdownParserOutput) => void;
	reject: (error: unknown) => void;
	cleanup: () => void;
	bytes: number;
	priority: ParsePriority;
}

interface AdmissionWaiter {
	bytes: number;
	priority: ParsePriority;
	signal: AbortSignal | undefined;
	resolve: () => void;
	reject: (error: unknown) => void;
	onAbort: () => void;
}

const MAX_QUEUED_JOBS = 64;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;

let worker: Worker | null = null;
let active: Job | null = null;
const queue: Job[] = [];
let queuedBytes = 0;
const admissions: AdmissionWaiter[] = [];
let reservedJobs = 0;
let reservedBytes = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function hasCapacity(bytes: number): boolean {
	if (queue.length + reservedJobs >= MAX_QUEUED_JOBS) return false;
	if (!active && queue.length === 0) return true;
	return queuedBytes + reservedBytes + bytes <= MAX_QUEUED_BYTES;
}

function enqueue(job: Job): void {
	queuedBytes += job.bytes;
	if (job.priority === 'background') {
		queue.push(job);
		return;
	}
	// Active-slide work goes ahead of background thumbnails and exports.
	const firstBackground = queue.findIndex((entry) => entry.priority === 'background');
	if (firstBackground < 0) queue.push(job);
	else queue.splice(firstBackground, 0, job);
}

function drainAdmissions(): void {
	for (;;) {
		let chosen = -1;
		for (let index = 0; index < admissions.length; index++) {
			const waiter = admissions[index]!;
			if (!hasCapacity(waiter.bytes)) continue;
			if (
				chosen < 0 ||
				(admissions[chosen]!.priority === 'background' && waiter.priority === 'active')
			)
				chosen = index;
			if (waiter.priority === 'active') break;
		}
		if (chosen < 0) return;
		const [waiter] = admissions.splice(chosen, 1);
		if (!waiter) return;
		waiter.signal?.removeEventListener('abort', waiter.onAbort);
		reservedJobs += 1;
		reservedBytes += waiter.bytes;
		waiter.resolve();
	}
}

function admit(bytes: number, priority: ParsePriority, signal?: AbortSignal): Promise<void> {
	if (hasCapacity(bytes)) {
		reservedJobs += 1;
		reservedBytes += bytes;
		return Promise.resolve();
	}
	return new Promise<void>((resolve, reject) => {
		const waiter: AdmissionWaiter = {
			bytes,
			priority,
			signal,
			resolve,
			reject,
			onAbort: () => {
				const index = admissions.indexOf(waiter);
				if (index >= 0) admissions.splice(index, 1);
				reject(new DOMException('Operation cancelled', 'AbortError'));
			}
		};
		if (priority === 'active') {
			const firstBackground = admissions.findIndex((entry) => entry.priority === 'background');
			if (firstBackground < 0) admissions.push(waiter);
			else admissions.splice(firstBackground, 0, waiter);
		} else admissions.push(waiter);
		signal?.addEventListener('abort', waiter.onAbort, { once: true });
	});
}

function stopWorker(): void {
	worker?.terminate();
	worker = null;
	clearTimeout(idleTimer);
}

function pump(): void {
	if (active) return;
	const job = queue.shift();
	if (!job) {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(stopWorker, 30_000);
		return;
	}
	queuedBytes -= job.bytes;
	active = job;
	drainAdmissions();
	try {
		checkAborted(job.signal);
		worker ??= new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' });
		worker.onmessage = (event: MessageEvent<{ output?: MarkdownParserOutput; error?: string }>) => {
			if (active !== job) return;
			if (event.data.output) job.resolve(event.data.output);
			else job.reject(new Error(event.data.error ?? t('read.renderError')));
			finish(job);
		};
		worker.onerror = () => {
			if (active !== job) return;
			job.reject(new Error(t('read.renderError')));
			stopWorker();
			finish(job);
		};
		worker.postMessage(job.input);
	} catch (error) {
		job.reject(error);
		stopWorker();
		finish(job);
	}
}

function finish(job: Job): void {
	job.cleanup();
	if (active === job) {
		if (worker) {
			worker.onmessage = null;
			worker.onerror = null;
		}
		active = null;
	}
	drainAdmissions();
	queueMicrotask(pump);
}

export async function parseMarkdownJob(
	input: MarkdownParserInput,
	signal?: AbortSignal,
	priority: ParsePriority = 'background'
): Promise<MarkdownParserOutput> {
	checkAborted(signal);
	if (typeof Worker === 'undefined') {
		const { parseMarkdownSource } = await abortable(import('./markdown-parser'), signal);
		checkAborted(signal);
		return parseMarkdownSource(input);
	}
	// Bound waiting source copies independently of the disposable output caches.
	// A full parser waits for capacity instead of reporting a rendering error.
	const bytes = input.content.length * 2;
	await admit(bytes, priority, signal);
	if (signal?.aborted) {
		reservedJobs -= 1;
		reservedBytes -= bytes;
		throw new DOMException('Operation cancelled', 'AbortError');
	}
	reservedJobs -= 1;
	reservedBytes -= bytes;
	clearTimeout(idleTimer);
	return new Promise((resolve, reject) => {
		const job: Job = {
			input,
			signal,
			resolve,
			reject,
			bytes,
			priority,
			cleanup: () => signal?.removeEventListener('abort', cancel)
		};
		const cancel = () => {
			const index = queue.indexOf(job);
			if (index >= 0) {
				queue.splice(index, 1);
				queuedBytes -= bytes;
			}
			if (active === job) {
				stopWorker();
				active = null;
			}
			job.cleanup();
			reject(new DOMException('Operation cancelled', 'AbortError'));
			drainAdmissions();
			queueMicrotask(pump);
		};
		signal?.addEventListener('abort', cancel, { once: true });
		enqueue(job);
		pump();
	});
}
