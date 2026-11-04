// Main-thread bridge to the documentation check worker. Cancellation ends the
// worker, so a large project cannot keep the editor busy after the user cancels.

import { runDocsCheck, type DocsCheckInput, type DocsCheckReport } from './docs-check';
import type { DocsCheckWorkerRequest, DocsCheckWorkerResponse } from './workers/docs-check.worker';

export interface DocsCheckRun {
	promise: Promise<DocsCheckReport | null>;
	/** Stops the scan. The promise resolves with null. */
	cancel: () => void;
}

interface WorkerHost {
	postMessage: (message: DocsCheckWorkerRequest) => void;
	addEventListener: (type: 'message' | 'error', listener: (event: Event) => void) => void;
	removeEventListener: (type: 'message' | 'error', listener: (event: Event) => void) => void;
	terminate: () => void;
}

export interface DocsCheckRunnerOptions {
	createWorker?: () => WorkerHost;
}

let nextRunId = 1;

function runOnMainThread(input: DocsCheckInput): Promise<DocsCheckReport | null> {
	return runDocsCheck(input).catch(() => null);
}

/** Starts a cancellable scan. A missing worker falls back to the main thread. */
export function runDocsCheckAsync(
	input: DocsCheckInput,
	options: DocsCheckRunnerOptions = {}
): DocsCheckRun {
	let worker: WorkerHost | null = null;
	let canceled = false;
	let finish: (report: DocsCheckReport | null) => void = () => {};
	const id = nextRunId++;
	const promise = new Promise<DocsCheckReport | null>((resolve) => {
		finish = resolve;
		const settle = (report: DocsCheckReport | null): void => {
			if (canceled) return;
			canceled = true;
			worker?.removeEventListener('message', onMessage);
			worker?.removeEventListener('error', onError);
			worker?.terminate();
			worker = null;
			resolve(report);
		};
		const onMessage = (event: Event): void => {
			const data = (event as MessageEvent<DocsCheckWorkerResponse>).data;
			if (data.id !== id) return;
			settle(data.report ?? null);
		};
		const onError = (): void => {
			worker?.removeEventListener('message', onMessage);
			worker?.removeEventListener('error', onError);
			worker?.terminate();
			worker = null;
			if (canceled) return;
			void runOnMainThread(input).then((report) => {
				canceled = true;
				resolve(report);
			});
		};

		try {
			worker = options.createWorker
				? options.createWorker()
				: typeof Worker === 'undefined'
					? null
					: new Worker(new URL('./workers/docs-check.worker.ts', import.meta.url), {
							type: 'module'
						});
		} catch {
			worker = null;
		}
		if (!worker) {
			void runOnMainThread(input).then((report) => {
				canceled = true;
				resolve(report);
			});
			return;
		}
		worker.addEventListener('message', onMessage);
		worker.addEventListener('error', onError);
		worker.postMessage({ id, input });
	});

	return {
		promise,
		cancel: () => {
			canceled = true;
			worker?.terminate();
			worker = null;
			finish(null);
		}
	};
}
