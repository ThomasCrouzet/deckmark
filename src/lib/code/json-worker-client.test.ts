import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonWorkerClient } from './json-worker-client';
import type { JsonWorkerReply, JsonWorkerRequest } from './json-worker-protocol';

class FakeWorker extends EventTarget {
	static instances: FakeWorker[] = [];
	posted: JsonWorkerRequest[] = [];
	terminated = false;

	constructor() {
		super();
		FakeWorker.instances.push(this);
	}

	postMessage(request: JsonWorkerRequest): void {
		this.posted.push(request);
	}

	terminate(): void {
		this.terminated = true;
	}

	reply(reply: JsonWorkerReply): void {
		this.dispatchEvent(new MessageEvent('message', { data: reply }));
	}
}

function analyze(text: string) {
	return { kind: 'analyze' as const, text, includeValue: false };
}

function analysisFor(request: JsonWorkerRequest, valid = true): JsonWorkerReply {
	return {
		documentId: request.documentId,
		revision: request.revision,
		requestId: request.requestId,
		kind: 'analysis',
		analysis: { valid, duplicateKeys: [] },
		schemaIssues: []
	};
}

afterEach(() => {
	FakeWorker.instances = [];
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('JSON worker analysis scheduling', () => {
	it('cancels a superseded active analysis before the current request', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const client = new JsonWorkerClient();
		client.setRevision('a', 1);
		const superseded = client.request(analyze('{"a":'));
		const firstWorker = FakeWorker.instances[0]!;
		expect(firstWorker.posted).toHaveLength(1);

		client.setRevision('a', 2);
		const current = client.request(analyze('{"a":1}'));
		expect(firstWorker.terminated).toBe(true);
		expect(FakeWorker.instances).toHaveLength(2);
		const secondWorker = FakeWorker.instances[1]!;
		expect(secondWorker.posted).toHaveLength(1);
		expect(secondWorker.posted[0]).toMatchObject({ documentId: 'a', revision: 2 });

		// An old worker reply must not replace the current editor state.
		firstWorker.reply(analysisFor(firstWorker.posted[0]!, false));
		secondWorker.reply(analysisFor(secondWorker.posted[0]!));
		await expect(superseded).resolves.toBeNull();
		await expect(current).resolves.toMatchObject({ kind: 'analysis', revision: 2 });
	});

	it('cancels an active analysis when the document identity changes', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const client = new JsonWorkerClient();
		client.setRevision('a', 1);
		const first = client.request(analyze('{"a":1}'));
		const firstWorker = FakeWorker.instances[0]!;

		client.setRevision('b', 1);
		const second = client.request(analyze('{"b":2}'));
		const secondWorker = FakeWorker.instances[1]!;
		expect(firstWorker.terminated).toBe(true);
		expect(secondWorker.posted[0]).toMatchObject({ documentId: 'b', revision: 1 });

		secondWorker.reply(analysisFor(secondWorker.posted[0]!));
		await expect(first).resolves.toBeNull();
		await expect(second).resolves.toMatchObject({ documentId: 'b' });
	});

	it('cancels each superseded analysis during an edit burst', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const client = new JsonWorkerClient();
		client.setRevision('a', 1);
		const first = client.request(analyze('{"a":1}'));
		client.setRevision('a', 2);
		const second = client.request(analyze('{"a":2}'));
		client.setRevision('a', 3);
		const third = client.request(analyze('{"a":3}'));

		await expect(first).resolves.toBeNull();
		await expect(second).resolves.toBeNull();
		expect(FakeWorker.instances[0]!.terminated).toBe(true);
		expect(FakeWorker.instances[1]!.terminated).toBe(true);
		expect(FakeWorker.instances[1]!.posted[0]).toMatchObject({ revision: 2 });
		const currentWorker = FakeWorker.instances[2]!;
		expect(currentWorker.posted[0]).toMatchObject({ revision: 3 });
		currentWorker.reply(analysisFor(currentWorker.posted[0]!));
		await expect(third).resolves.toMatchObject({ revision: 3 });
	});

	it('keeps only the latest pending request for the same revision', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const client = new JsonWorkerClient();
		client.setRevision('a', 1);
		const active = client.request(analyze('{"a":1}'));
		const worker = FakeWorker.instances[0]!;
		const replaced = client.request(analyze('{"a":1}'));
		const latest = client.request(analyze('{"a":1}'));

		await expect(replaced).resolves.toBeNull();
		worker.reply(analysisFor(worker.posted[0]!));
		await expect(active).resolves.toMatchObject({ kind: 'analysis' });
		expect(worker.posted).toHaveLength(2);
		worker.reply(analysisFor(worker.posted[1]!));
		await expect(latest).resolves.toMatchObject({ kind: 'analysis' });
	});

	it('still cancels an active analysis for a formatting action', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const client = new JsonWorkerClient();
		client.setRevision('a', 1);
		const analysis = client.request(analyze('{"a":1}'));
		const worker = FakeWorker.instances[0]!;
		const formatted = client.request({
			kind: 'format',
			text: '{"a":1}',
			options: { indent: '  ', eol: '\n' }
		});
		expect(worker.terminated).toBe(true);
		const currentWorker = FakeWorker.instances[1]!;
		expect(currentWorker.posted[0]).toMatchObject({ kind: 'format' });
		currentWorker.reply({
			documentId: 'a',
			revision: 1,
			requestId: currentWorker.posted[0]!.requestId,
			kind: 'action',
			result: { ok: true, text: '{\n  "a": 1\n}' }
		});
		await expect(analysis).resolves.toBeNull();
		await expect(formatted).resolves.toMatchObject({ kind: 'action' });
	});

	it('terminates a timed out analysis and accepts the next request', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('Worker', FakeWorker);
		const client = new JsonWorkerClient();
		client.setRevision('a', 1);
		const timedOut = client.request(analyze('{"a":1}'));
		const worker = FakeWorker.instances[0]!;
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(timedOut).resolves.toMatchObject({ kind: 'error' });
		expect(worker.terminated).toBe(true);

		const retry = client.request(analyze('{"a":2}'));
		const retryWorker = FakeWorker.instances[1]!;
		retryWorker.reply(analysisFor(retryWorker.posted[0]!));
		await expect(retry).resolves.toMatchObject({ kind: 'analysis' });
	});

	it('reports a worker creation failure without an unhandled rejection', async () => {
		vi.stubGlobal(
			'Worker',
			class {
				constructor() {
					throw new Error('Worker blocked');
				}
			}
		);
		const client = new JsonWorkerClient();
		client.setRevision('a', 1);
		await expect(client.request(analyze('{"a":1}'))).resolves.toMatchObject({ kind: 'error' });
	});

	it('resolves an in-flight request on dispose and terminates the worker', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const client = new JsonWorkerClient();
		client.setRevision('a', 1);
		const inFlight = client.request(analyze('{"a":1}'));
		const worker = FakeWorker.instances[0]!;
		client.dispose();
		await expect(inFlight).resolves.toBeNull();
		expect(worker.terminated).toBe(true);
	});
});
