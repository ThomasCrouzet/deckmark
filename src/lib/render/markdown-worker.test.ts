import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkdownParserInput, MarkdownParserOutput } from './markdown-parser';

const output: MarkdownParserOutput = {
	source: '',
	html: '<p>ok</p>',
	mermaidCodes: [],
	stages: []
};

class FakeWorker {
	static current: FakeWorker | null = null;
	posted: MarkdownParserInput[] = [];
	onmessage:
		((event: MessageEvent<{ output?: MarkdownParserOutput; error?: string }>) => void) | null =
		null;
	onerror: (() => void) | null = null;
	constructor() {
		FakeWorker.current = this;
	}
	postMessage(input: MarkdownParserInput): void {
		this.posted.push(input);
	}
	terminate(): void {}
	respond(): void {
		this.onmessage?.({ data: { output } } as MessageEvent<{ output: MarkdownParserOutput }>);
	}
}

function input(index: number): MarkdownParserInput {
	return {
		content: `# ${index}`,
		wikiLinks: true,
		headingPermalinks: false,
		codeLabel: 'Code',
		codeLanguageLabel: 'Code {lang}'
	};
}

async function waitForPost(count: number): Promise<FakeWorker> {
	await vi.waitFor(() => expect(FakeWorker.current?.posted.length).toBe(count));
	return FakeWorker.current!;
}

describe('shared Markdown parser admission', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.stubGlobal('Worker', FakeWorker);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		FakeWorker.current = null;
	});

	it('accepts sixteen concurrent jobs without a queue-saturation error', async () => {
		const workerModule = await import('./markdown-worker');
		const jobs = Array.from({ length: 16 }, (_, index) =>
			workerModule.parseMarkdownJob(input(index))
		);
		for (let done = 1; done <= 16; done++) {
			const worker = await waitForPost(done);
			worker.respond();
		}
		await expect(Promise.all(jobs)).resolves.toHaveLength(16);
	});

	it('serves an active slide job before queued background thumbnails', async () => {
		const workerModule = await import('./markdown-worker');
		const first = workerModule.parseMarkdownJob(input(0), undefined, 'background');
		const worker = await waitForPost(1);
		const background = workerModule.parseMarkdownJob(input(1), undefined, 'background');
		const active = workerModule.parseMarkdownJob(input(2), undefined, 'active');
		await new Promise((resolve) => setTimeout(resolve, 0));
		worker.respond();
		await waitForPost(2);
		expect(worker.posted[1]?.content).toBe('# 2');
		worker.respond();
		await waitForPost(3);
		worker.respond();
		await Promise.all([first, background, active]);
	});
});
