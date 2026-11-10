import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresentationElement } from './model';

const mocks = vi.hoisted(() => ({
	projectImageSource: vi.fn(),
	epoch: 1
}));

vi.mock('../project-media', () => ({
	projectImageSource: mocks.projectImageSource,
	projectMediaEpoch: () => mocks.epoch
}));

import { presentationContentCacheStats, renderPresentationElementContentCached } from './render';

const context = { projectId: 'project', relativePath: 'notes/slide.md' };

function imageElement(source: string): PresentationElement {
	return {
		id: `image-${source}`,
		type: 'image',
		content: source,
		x: 0,
		y: 0,
		width: 100,
		height: 50,
		rotation: 0
	} as PresentationElement;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function settle(): Promise<void> {
	for (let index = 0; index < 4; index++) await Promise.resolve();
}

beforeEach(() => {
	mocks.projectImageSource.mockReset();
	mocks.epoch = 1;
});

describe('presentation content cancellation ownership', () => {
	it('does not share a cancellable render with an unsignaled caller', async () => {
		const firstRender = deferred<string>();
		const secondRender = deferred<string>();
		mocks.projectImageSource
			.mockReturnValueOnce(firstRender.promise)
			.mockReturnValueOnce(secondRender.promise);
		const controller = new AbortController();
		const element = imageElement('assets/first.png');

		const first = renderPresentationElementContentCached(element, {
			projectContext: context,
			signal: controller.signal
		});
		const firstAssertion = expect(first).rejects.toMatchObject({ name: 'AbortError' });
		const second = renderPresentationElementContentCached(element, {
			projectContext: context
		});
		await settle();
		expect(mocks.projectImageSource).toHaveBeenCalledTimes(2);

		controller.abort();
		firstRender.reject(new DOMException('Operation cancelled', 'AbortError'));
		await firstAssertion;

		secondRender.resolve('data:image/png;base64,second');
		await expect(second).resolves.toContain('data:image/png;base64,second');
		await settle();
		expect(presentationContentCacheStats().inFlight).toBe(0);
	});

	it('does not let a signaled caller join an unsignaled render', async () => {
		const firstRender = deferred<string>();
		const secondRender = deferred<string>();
		mocks.projectImageSource
			.mockReturnValueOnce(firstRender.promise)
			.mockReturnValueOnce(secondRender.promise);
		const controller = new AbortController();
		const element = imageElement('assets/second.png');

		const first = renderPresentationElementContentCached(element, {
			projectContext: context
		});
		const second = renderPresentationElementContentCached(element, {
			projectContext: context,
			signal: controller.signal
		});
		const secondAssertion = expect(second).rejects.toMatchObject({ name: 'AbortError' });
		await settle();
		expect(mocks.projectImageSource).toHaveBeenCalledTimes(2);

		controller.abort();
		firstRender.resolve('data:image/png;base64,export');
		secondRender.reject(new DOMException('Operation cancelled', 'AbortError'));
		await expect(first).resolves.toContain('data:image/png;base64,export');
		await secondAssertion;
	});

	it('keeps two signaled callers on their own controllers', async () => {
		const leftRender = deferred<string>();
		const rightRender = deferred<string>();
		mocks.projectImageSource
			.mockReturnValueOnce(leftRender.promise)
			.mockReturnValueOnce(rightRender.promise);
		const left = new AbortController();
		const right = new AbortController();
		const element = imageElement('assets/third.png');

		const leftResult = renderPresentationElementContentCached(element, {
			projectContext: context,
			signal: left.signal
		});
		const leftAssertion = expect(leftResult).rejects.toMatchObject({ name: 'AbortError' });
		const rightResult = renderPresentationElementContentCached(element, {
			projectContext: context,
			signal: right.signal
		});
		await settle();
		expect(mocks.projectImageSource).toHaveBeenCalledTimes(2);

		left.abort();
		leftRender.reject(new DOMException('Operation cancelled', 'AbortError'));
		rightRender.resolve('data:image/png;base64,right');

		await leftAssertion;
		await expect(rightResult).resolves.toContain('data:image/png;base64,right');
	});

	it('reuses completed HTML after an unsignaled render', async () => {
		mocks.projectImageSource.mockResolvedValue('data:image/png;base64,cached');
		const element = imageElement('assets/fourth.png');
		await expect(
			renderPresentationElementContentCached(element, { projectContext: context })
		).resolves.toContain('data:image/png;base64,cached');
		await expect(
			renderPresentationElementContentCached(element, { projectContext: context })
		).resolves.toContain('data:image/png;base64,cached');
		expect(mocks.projectImageSource).toHaveBeenCalledTimes(1);
	});

	it('does not reuse completed HTML from an older media epoch', async () => {
		mocks.projectImageSource.mockResolvedValue('data:image/png;base64,old');
		const element = imageElement('assets/replaced.png');
		await expect(
			renderPresentationElementContentCached(element, { projectContext: context })
		).resolves.toContain('data:image/png;base64,old');

		// The native refresh replaces the bytes on the same asset path.
		mocks.epoch = 2;
		mocks.projectImageSource.mockResolvedValue('data:image/png;base64,new');
		await expect(
			renderPresentationElementContentCached(element, { projectContext: context })
		).resolves.toContain('data:image/png;base64,new');
		await expect(
			renderPresentationElementContentCached(element, { projectContext: context })
		).resolves.toContain('data:image/png;base64,new');
		expect(mocks.projectImageSource).toHaveBeenCalledTimes(2);
	});

	it('fences an in-flight render that crosses a media epoch', async () => {
		const firstRender = deferred<string>();
		const secondRender = deferred<string>();
		mocks.projectImageSource
			.mockReturnValueOnce(firstRender.promise)
			.mockReturnValueOnce(secondRender.promise);
		const element = imageElement('assets/crossing.png');

		const pending = renderPresentationElementContentCached(element, {
			projectContext: context
		});
		await settle();
		expect(mocks.projectImageSource).toHaveBeenCalledTimes(1);

		mocks.epoch = 2;
		firstRender.resolve('data:image/png;base64,old');
		await settle();
		expect(mocks.projectImageSource).toHaveBeenCalledTimes(2);
		secondRender.resolve('data:image/png;base64,new');

		await expect(pending).resolves.toContain('data:image/png;base64,new');
		// The old result never entered the new epoch cache.
		await expect(
			renderPresentationElementContentCached(element, { projectContext: context })
		).resolves.toContain('data:image/png;base64,new');
		expect(mocks.projectImageSource).toHaveBeenCalledTimes(2);
	});
});
