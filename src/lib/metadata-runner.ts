import MetadataWorker from './metadata.worker?worker&inline';
import { deriveMetadata } from './metadata-derive';
import type { MetadataRequest, MetadataResponse } from './metadata.worker';
import { reportWarning } from './report';

const META_METRICS = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';

export class MetadataRunner {
	private worker: Worker | null = null;
	private workerUnavailable = false;
	private deadline: ReturnType<typeof setTimeout> | undefined;
	private recovery: ReturnType<typeof setTimeout> | undefined;
	private current: {
		request: MetadataRequest;
		resolve: (response: MetadataResponse | null) => void;
	} | null = null;

	run(request: MetadataRequest): Promise<MetadataResponse | null> {
		return new Promise((resolve) => {
			this.current = { request, resolve };
			if (!this.worker && !this.workerUnavailable && typeof Worker !== 'undefined') {
				try {
					this.worker = new MetadataWorker({ name: 'metadata' });
					this.worker.onmessage = (event: MessageEvent<MetadataResponse>) =>
						this.finish(event.data);
					this.worker.onerror = (event) => {
						event.preventDefault();
						this.failWorker();
					};
					this.worker.onmessageerror = () => this.failWorker();
				} catch {
					this.workerUnavailable = true;
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
		current.resolve(response);
	}

	private failWorker(): void {
		reportWarning('metadata worker unavailable');
		this.worker?.terminate();
		this.worker = null;
		this.workerUnavailable = true;
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
