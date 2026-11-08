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
		resolve: (response: MetadataResponse | null) => void;
	} | null = null;

	run(request: MetadataRequest): Promise<MetadataResponse | null> {
		return new Promise((resolve) => {
			this.current = { request, resolve };
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
					this.worker.postMessage(request);
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
		this.current = null;
		this.failures = 0;
		this.retryAt = 0;
		current.resolve(response);
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
			if (META_METRICS) performance.mark('meta-index-parse');
			this.finish({ ...request, values: deriveMetadata(request.source), incremental: false });
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
