import { describe, expect, it, vi } from 'vitest';

const renderMermaidSvg = vi.fn();
vi.mock('./render/sanitize-html', () => ({
	renderMermaidSvg: (...args: unknown[]) => renderMermaidSvg(...args),
	sanitizeMermaidPreviewHtml: async (html: string) => html
}));

import { renderMermaidPreview } from './milkdown-mermaid-preview';

describe('WYSIWYG Mermaid preview cancellation', () => {
	it('aborts the previous block render before it starts SVG work', async () => {
		const signals: AbortSignal[] = [];
		renderMermaidSvg.mockImplementation(
			(_id: string, code: string, _theme: string, signal: AbortSignal) => {
				signals.push(signal);
				return new Promise<string>((resolve, reject) => {
					const timer = setTimeout(() => resolve(`<svg><text>${code}</text></svg>`), 30);
					signal.addEventListener(
						'abort',
						() => {
							clearTimeout(timer);
							reject(new DOMException('Operation cancelled', 'AbortError'));
						},
						{ once: true }
					);
				});
			}
		);
		const previews: string[] = [];
		const apply = (value: null | string | HTMLElement) => {
			if (typeof value === 'string') previews.push(value);
		};
		renderMermaidPreview('mermaid', 'graph LR\nA-->B', apply);
		renderMermaidPreview('mermaid', 'graph LR\nA-->C', apply);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(signals).toHaveLength(2);
		expect(signals[0]!.aborted).toBe(true);
		expect(signals[1]!.aborted).toBe(false);
		expect(previews.some((value) => value.includes('A--&gt;C') || value.includes('A-->C'))).toBe(
			true
		);
		expect(previews.some((value) => value.includes('A-->B'))).toBe(false);
	});
});
