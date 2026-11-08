import { abortable, checkAborted } from '../abort';
import { t } from '../i18n';
import type { MarkdownParserInput, MarkdownParserOutput } from './markdown-parser';

interface Job {
	input: MarkdownParserInput;
	signal: AbortSignal | undefined;
	resolve: (output: MarkdownParserOutput) => void;
	reject: (error: unknown) => void;
	cleanup: () => void;
	bytes: number;
}

let worker: Worker | null = null;
let active: Job | null = null;
const queue: Job[] = [];
let queuedBytes = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

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
	queueMicrotask(pump);
}

export async function parseMarkdownJob(
	input: MarkdownParserInput,
	signal?: AbortSignal
): Promise<MarkdownParserOutput> {
	checkAborted(signal);
	if (typeof Worker === 'undefined') {
		const { parseMarkdownSource } = await abortable(import('./markdown-parser'), signal);
		checkAborted(signal);
		return parseMarkdownSource(input);
	}
	// Bound waiting source copies independently of the disposable output caches.
	const bytes = input.content.length * 2;
	if (queue.length >= 8 || (active && queuedBytes + bytes > 16 * 1024 * 1024)) {
		throw new Error(t('read.renderError'));
	}
	clearTimeout(idleTimer);
	return new Promise((resolve, reject) => {
		const job: Job = {
			input,
			signal,
			resolve,
			reject,
			bytes,
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
			queueMicrotask(pump);
		};
		signal?.addEventListener('abort', cancel, { once: true });
		queue.push(job);
		queuedBytes += bytes;
		pump();
	});
}
