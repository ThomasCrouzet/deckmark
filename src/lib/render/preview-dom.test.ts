import { describe, expect, it } from 'vitest';
import { mountPreview, type PreviewMount } from './preview-dom';

function mount(article: HTMLElement, html: string, generation: number) {
	return {
		fileId: 'f',
		content: '',
		html,
		generation,
		isCurrent: () => true,
		onRendered: () => {}
	} satisfies PreviewMount;
}

describe('preview DOM reconciliation', () => {
	it('keeps unchanged blocks and replaces changed blocks', () => {
		if (typeof globalThis.requestAnimationFrame !== 'function') {
			globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
				setTimeout(() => callback(0), 0)) as unknown as typeof requestAnimationFrame;
			globalThis.cancelAnimationFrame = ((id: number) =>
				clearTimeout(id)) as unknown as typeof cancelAnimationFrame;
		}
		const article = document.createElement('article');
		const preview = mountPreview(
			article,
			mount(article, '<p>first</p><pre><code>stable</code></pre>', 1)
		);
		const first = article.querySelector('p');
		const code = article.querySelector('pre');
		preview.update(mount(article, '<p>changed</p><pre><code>stable</code></pre>', 2));
		expect(article.querySelector('p')?.textContent).toBe('changed');
		expect(article.querySelector('p')).not.toBe(first);
		expect(article.querySelector('pre')).toBe(code);
		preview.update(mount(article, '<p>changed</p>', 3));
		expect(article.querySelector('pre')).toBeNull();
		preview.destroy();
	});
});
