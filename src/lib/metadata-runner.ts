import { deriveMetadata } from './metadata-derive';
import type { MetadataRequest, MetadataResponse } from './metadata.worker';
import { reportWarning } from './report';

const META_METRICS = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';

export class MetadataRunner {
	private worker: Worker | null = null;
	private failures = 0;
	private retryAt = 0;
	private deadline: ReturnType<typeof setTimeout> | undefined;
	private recovery: ReturnType<typeof setTimeout> | undefined;
	private current: {
		request: MetadataRequest;
		startedAt: number;
		resolve: (response: MetadataResponse | null) => void;
	} | null = null;

	run(request: MetadataRequest): Promise<MetadataResponse | null> {
		return new Promise((resolve) => {
			this.current = { request, startedAt: META_METRICS ? performance.now() : 0, resolve };
			if (!this.worker && typeof Worker !== 'undefined' && Date.now() >= this.retryAt) {
				try {
					this.worker = new Worker(new URL('./metadata.worker.ts', import.meta.url), {
						type: 'module',
						name: 'metadata'
					});
					this.worker.onmessage = (event: MessageEvent<MetadataResponse>) =>
						this.finish(event.data);
					this.worker.onerror = (event) => {
						event.preventDefault();
						this.failWorker();
					};
					this.worker.onmessageerror = () => this.failWorker();
				} catch {
					this.retryAt = Date.now() + this.backoff();
				}
			}
			if (this.worker) {
				try {
					this.deadline = setTimeout(() => this.failWorker(), 10_000);
					const started = META_METRICS ? performance.now() : 0;
					this.worker.postMessage(request);
					if (META_METRICS) {
						try {
							performance.measure('mdsh:metadata-transfer', {
								start: started,
								end: performance.now(),
								detail: {
									id: request.id,
									kind: request.kind,
									sourceBytes: request.kind === 'full' ? request.source.content.length : 0,
									editBytes:
										request.kind === 'delta'
											? request.edits.reduce((total, edit) => total + edit.insert.length, 0)
											: 0
								}
							});
						} catch {
							// Diagnostics must not change the metadata result.
						}
					}
					return;
				} catch {
					this.failWorker();
					return;
				}
			}
			this.recover();
		});
	}

	private backoff(): number {
		return Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 6));
	}

	private finish(response: MetadataResponse): void {
		const current = this.current;
		if (
			!current ||
			current.request.id !== response.id ||
			current.request.revision !== response.revision
		)
			return;
		clearTimeout(this.deadline);
		const startedAt = current.startedAt;
		this.current = null;
		if (response.mode !== 'rejected') {
			this.failures = 0;
			this.retryAt = 0;
		}
		current.resolve(response);
		if (META_METRICS) {
			try {
				performance.measure('mdsh:metadata-job', {
					start: startedAt,
					end: performance.now(),
					detail: {
						id: response.id,
						revision: response.revision,
						mode: response.mode,
						workerMs: response.workerMs,
						incremental: response.incremental
					}
				});
			} catch {
				// Diagnostics must not change the metadata result.
			}
		}
	}

	private failWorker(): void {
		reportWarning('metadata worker unavailable');
		this.worker?.terminate();
		this.worker = null;
		this.failures += 1;
		// A transient Worker failure must not disable the Worker for the whole
		// session. The next request retries after a bounded backoff.
		this.retryAt = Date.now() + this.backoff();
		clearTimeout(this.deadline);
		this.recover();
	}

	private recover(): void {
		// Keep worker recovery outside the input task and process only one file.
		this.recovery = setTimeout(() => {
			const request = this.current?.request;
			if (!request) return;
			if (request.kind === 'delta') {
				// A delta needs the Worker baseline. Ask the caller for one full
				// snapshot instead of deriving from a partial request.
				this.finish({
					id: request.id,
					revision: request.revision,
					documentRevision: -1,
					incremental: false,
					mode: 'rejected',
					workerMs: 0
				});
				return;
			}
			if (META_METRICS) performance.mark('meta-index-parse');
			this.finish({
				id: request.id,
				revision: request.revision,
				documentRevision: request.documentRevision,
				values: deriveMetadata(request.source),
				incremental: false,
				mode: 'fallback',
				workerMs: 0
			});
		}, 0);
	}

	dispose(): void {
		clearTimeout(this.deadline);
		clearTimeout(this.recovery);
		this.worker?.terminate();
		this.worker = null;
		this.current?.resolve(null);
		this.current = null;
	}
}
