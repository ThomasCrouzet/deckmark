import { describe, expect, it, vi } from 'vitest';
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

	it('reuses later paragraphs when the first paragraph changes', () => {
		if (typeof globalThis.requestAnimationFrame !== 'function') {
			globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
				setTimeout(() => callback(0), 0)) as unknown as typeof requestAnimationFrame;
			globalThis.cancelAnimationFrame = ((id: number) =>
				clearTimeout(id)) as unknown as typeof cancelAnimationFrame;
		}
		const article = document.createElement('article');
		const paragraphs = Array.from({ length: 200 }, (_, index) => `<p>Paragraph ${index}</p>`).join(
			''
		);
		const preview = mountPreview(article, mount(article, paragraphs, 1));
		const second = article.querySelectorAll('p')[1];
		const last = article.querySelectorAll('p')[199];
		const spy = vi.spyOn(article, 'replaceChildren');
		preview.update(
			mount(article, `<p>Changed first</p>${paragraphs.replace('<p>Paragraph 0</p>', '')}`, 2)
		);
		expect(spy).not.toHaveBeenCalled();
		expect(article.querySelectorAll('p')[0]?.textContent).toBe('Changed first');
		expect(article.querySelectorAll('p')[1]).toBe(second);
		expect(article.querySelectorAll('p')[199]).toBe(last);
		spy.mockRestore();
		preview.destroy();
	});

	it('reuses the second paragraph after the first one is removed', () => {
		if (typeof globalThis.requestAnimationFrame !== 'function') {
			globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
				setTimeout(() => callback(0), 0)) as unknown as typeof requestAnimationFrame;
			globalThis.cancelAnimationFrame = ((id: number) =>
				clearTimeout(id)) as unknown as typeof cancelAnimationFrame;
		}
		const article = document.createElement('article');
		const paragraphs = Array.from({ length: 80 }, (_, index) => `<p>Paragraph ${index}</p>`).join(
			''
		);
		const preview = mountPreview(article, mount(article, paragraphs, 1));
		const second = article.querySelectorAll('p')[1];
		const spy = vi.spyOn(article, 'replaceChildren');
		preview.update(mount(article, paragraphs.replace('<p>Paragraph 0</p>', ''), 2));
		expect(spy).not.toHaveBeenCalled();
		expect(article.querySelectorAll('p')[0]).toBe(second);
		expect(article.querySelectorAll('p')).toHaveLength(79);
		spy.mockRestore();
		preview.destroy();
	});

	it('keeps a bounded full replacement for a reordered tree', () => {
		if (typeof globalThis.requestAnimationFrame !== 'function') {
			globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
				setTimeout(() => callback(0), 0)) as unknown as typeof requestAnimationFrame;
			globalThis.cancelAnimationFrame = ((id: number) =>
				clearTimeout(id)) as unknown as typeof cancelAnimationFrame;
		}
		const article = document.createElement('article');
		const order = Array.from({ length: 60 }, (_, index) => `<p>Paragraph ${index}</p>`);
		const preview = mountPreview(article, mount(article, order.join(''), 1));
		const spy = vi.spyOn(article, 'replaceChildren');
		preview.update(mount(article, [...order].reverse().join(''), 2));
		expect(spy).toHaveBeenCalledOnce();
		expect(article.querySelectorAll('p')[0]?.textContent).toBe('Paragraph 59');
		expect(article.querySelectorAll('p')[59]?.textContent).toBe('Paragraph 0');
		spy.mockRestore();
		preview.destroy();
	});
});
