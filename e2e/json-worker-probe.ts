import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';

export async function installJsonProbe(page: Page) {
	await page.addInitScript(() => {
		const probe = {
			parses: [] as number[],
			requests: [] as {
				kind: string;
				documentId: string;
				requestId: number;
				revision: number;
				length: number;
				at: number;
			}[],
			replies: [] as {
				kind: string;
				documentId: string;
				requestId: number;
				revision: number;
				at: number;
			}[],
			longTasks: [] as { start: number; duration: number }[],
			hold: false,
			release: [] as (() => void)[]
		};
		Object.assign(window, { jsonProbe: probe });
		const parse = JSON.parse;
		JSON.parse = (text, reviver) => {
			if (typeof text === 'string' && text.length >= 1_000_000) probe.parses.push(text.length);
			return parse(text, reviver);
		};
		if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					probe.longTasks.push({ start: entry.startTime, duration: entry.duration });
				}
			}).observe({ type: 'longtask', buffered: true });
		}
		const NativeWorker = Worker;
		window.Worker = class extends NativeWorker {
			constructor(url: string | URL, options?: WorkerOptions) {
				super(url, options);
				if (options?.name !== 'json-tools') return;
				const post = this.postMessage.bind(this);
				this.postMessage = (data) => {
					probe.requests.push({
						kind: data.kind,
						documentId: data.documentId,
						requestId: data.requestId,
						revision: data.revision,
						length: data.text?.length ?? 0,
						at: performance.now()
					});
					post(data);
				};
				const listen = this.addEventListener.bind(this);
				this.addEventListener = (type, listener, options) => {
					if (type !== 'message' || !listener) return listen(type, listener, options);
					listen(type, (event: MessageEvent) => {
						const deliver = () => {
							probe.replies.push({
								kind: event.data.kind,
								documentId: event.data.documentId,
								requestId: event.data.requestId,
								revision: event.data.revision,
								at: performance.now()
							});
							if (typeof listener === 'function') listener.call(this, event);
							else listener.handleEvent(event);
						};
						if (probe.hold) probe.release.push(deliver);
						else deliver();
					});
				};
			}
		};
	});
}

export interface JsonProbe {
	parses: number[];
	requests: {
		kind: string;
		documentId: string;
		requestId: number;
		revision: number;
		length: number;
		at: number;
	}[];
	replies: { kind: string; documentId: string; requestId: number; revision: number; at: number }[];
	longTasks: { start: number; duration: number }[];
	hold: boolean;
	release: (() => void)[];
}

export async function probeState(page: Page) {
	return page.evaluate(() => {
		const { release, ...state } = (window as unknown as { jsonProbe: JsonProbe }).jsonProbe;
		return { ...state, held: release.length };
	});
}

export async function holdReplies(page: Page, hold: boolean) {
	await page.evaluate((hold) => {
		const probe = (window as unknown as { jsonProbe: JsonProbe }).jsonProbe;
		probe.hold = hold;
		if (!hold) probe.release.splice(0).forEach((release) => release());
	}, hold);
}

export function jsonFixture(bytes: number) {
	const prefix = '{"payload":"';
	const text = prefix + 'x'.repeat(bytes - prefix.length - 2) + '"}';
	return { text, bytes, sha256: jsonFixtureHash(text) };
}

export function jsonFixtureHash(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

export async function jsonWorkerHeap(page: Page) {
	try {
		const session = await page.context().newCDPSession(page);
		try {
			const { targetInfos } = await session.send('Target.getTargets');
			const target = targetInfos.find(
				(entry) => entry.type === 'worker' && entry.url.includes('json-tools.worker')
			);
			if (!target) throw new Error('JSON worker target not found');
			const { sessionId } = await session.send('Target.attachToTarget', {
				targetId: target.targetId,
				flatten: false
			});
			const heap = await new Promise<unknown>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('Worker heap query timed out')), 3000);
				session.on('Target.receivedMessageFromTarget', (event) => {
					if (event.sessionId !== sessionId) return;
					const reply = JSON.parse(event.message);
					if (reply.id !== 314) return;
					clearTimeout(timer);
					if (reply.error) reject(new Error(reply.error.message));
					else resolve(reply.result);
				});
				void session
					.send('Target.sendMessageToTarget', {
						sessionId,
						message: JSON.stringify({ id: 314, method: 'Runtime.getHeapUsage' })
					})
					.catch((error: unknown) => {
						clearTimeout(timer);
						reject(error);
					});
			});
			await session.send('Target.detachFromTarget', { sessionId });
			return { status: 'measured', scope: 'worker V8 heap, not process RSS', heap };
		} finally {
			await session.detach();
		}
	} catch (error) {
		return { status: 'unavailable', reason: String(error) };
	}
}
