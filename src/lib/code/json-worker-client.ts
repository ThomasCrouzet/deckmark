import type { JsonWorkerReply, JsonWorkerRequest } from './json-worker-protocol.js';

type Job = { request: JsonWorkerRequest; resolve: (reply: JsonWorkerReply | null) => void };

export class JsonWorkerClient {
	private worker: Worker | null = null;
	private active: Job | null = null;
	private pending: Job | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private documentId = '';
	private revision = 0;
	private requestId = 0;
	private disposed = false;

	setRevision(documentId: string, revision: number): void {
		this.documentId = documentId;
		this.revision = revision;
		this.pending?.resolve(null);
		this.pending = null;
		if (this.active && this.active.request.kind !== 'analyze') this.cancel();
	}

	request(
		input:
			| { kind: 'analyze'; text: string; includeValue: boolean }
			| {
					kind: 'format' | 'minify';
					text: string;
					options: import('./json-tools.js').JsonFormatOptions;
			  }
	): Promise<JsonWorkerReply | null> {
		if (this.disposed) return Promise.resolve(null);
		if (input.kind !== 'analyze' && this.active) this.cancel();
		const request = {
			...input,
			documentId: this.documentId,
			revision: this.revision,
			requestId: ++this.requestId
		};
		return new Promise((resolve) => {
			const job = { request, resolve };
			if (this.active) {
				this.pending?.resolve(null);
				this.pending = job;
			} else this.start(job);
		});
	}

	private start(job: Job): void {
		this.active = job;
		try {
			if (!this.worker) {
				const worker = new Worker(new URL('../workers/json-tools.worker.ts', import.meta.url), {
					type: 'module',
					name: 'json-tools'
				});
				this.worker = worker;
				worker.addEventListener('message', (event: MessageEvent<JsonWorkerReply>) => {
					if (worker !== this.worker) return;
					const reply = event.data;
					const request = this.active?.request;
					if (
						!request ||
						reply.requestId !== request.requestId ||
						reply.documentId !== request.documentId ||
						reply.revision !== request.revision
					)
						return;
					this.finish(reply);
				});
				const failed = () => {
					if (worker === this.worker) this.fail();
				};
				worker.addEventListener('error', failed);
				worker.addEventListener('messageerror', failed);
			}
			this.timer = setTimeout(() => this.fail(), job.request.kind === 'analyze' ? 30_000 : 120_000);
			this.worker.postMessage(job.request);
		} catch {
			this.fail();
		}
	}

	private finish(reply: JsonWorkerReply): void {
		clearTimeout(this.timer);
		const job = this.active;
		this.active = null;
		job?.resolve(
			!this.disposed && reply.documentId === this.documentId && reply.revision === this.revision
				? reply
				: null
		);
		const next = this.pending;
		this.pending = null;
		if (next) this.start(next);
	}

	private fail(): void {
		this.worker?.terminate();
		this.worker = null;
		if (this.active) this.finish({ ...this.active.request, kind: 'error' });
	}

	cancel(): void {
		clearTimeout(this.timer);
		this.worker?.terminate();
		this.worker = null;
		this.active?.resolve(null);
		this.pending?.resolve(null);
		this.active = this.pending = null;
	}

	dispose(): void {
		this.disposed = true;
		this.cancel();
	}
}
