import { nextRenderGeneration } from './render-identity';
import { recordRenderStage } from './render-stages';

export interface PreviewMount {
	fileId: string;
	content: string;
	html: string;
	generation: number;
	isCurrent: () => boolean;
	onRendered: (article: HTMLElement, content: string, generation: number) => void;
}

export interface RenderLayoutIdentity {
	readonly fileId: string;
	readonly renderGeneration: number;
	readonly layoutGeneration: number;
	readonly reason: 'render' | 'resize' | 'media' | 'detach';
}

function nodeKey(node: Node): string {
	return node instanceof Element ? node.outerHTML : `${node.nodeType}:${node.nodeValue}`;
}

function reconcile(article: HTMLElement, html: string): void {
	const template = document.createElement('template');
	// Only complete sanitized renderer output enters this action.
	template.innerHTML = html;
	if (!article.hasChildNodes()) {
		article.append(template.content);
		return;
	}
	const reusable = new Map<string, { nodes: Node[]; next: number }>();
	for (const node of article.childNodes) {
		const key = nodeKey(node);
		const bucket = reusable.get(key) ?? { nodes: [], next: 0 };
		bucket.nodes.push(node);
		reusable.set(key, bucket);
	}
	let cursor = article.firstChild;
	for (const fresh of Array.from(template.content.childNodes)) {
		const bucket = reusable.get(nodeKey(fresh));
		const node = bucket?.nodes[bucket.next++] ?? fresh;
		if (node === cursor) cursor = cursor.nextSibling;
		else article.insertBefore(node, cursor);
	}
	while (cursor) {
		const next = cursor.nextSibling;
		cursor.remove();
		cursor = next;
	}
}

export function mountPreview(article: HTMLElement, initial: PreviewMount) {
	let mounted = initial;
	let generation = 0;
	let frame = 0;
	let disposed = false;
	let pendingReason: 'resize' | 'media' = 'resize';

	function emit(reason: RenderLayoutIdentity['reason']): void {
		const layoutGeneration = nextRenderGeneration();
		article.dataset.renderGeneration = String(generation);
		article.dataset.layoutGeneration = String(layoutGeneration);
		article.dispatchEvent(
			new CustomEvent<RenderLayoutIdentity>('mdsh:render-layout', {
				bubbles: true,
				detail: { fileId: mounted.fileId, renderGeneration: generation, layoutGeneration, reason }
			})
		);
	}

	function invalidate(reason: 'resize' | 'media' = 'resize'): void {
		if (disposed) return;
		if (reason === 'media') pendingReason = reason;
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			if (!disposed && generation) emit(pendingReason);
			pendingReason = 'resize';
		});
	}

	function update(next: PreviewMount): void {
		if (disposed || generation === next.generation || !next.isCurrent()) return;
		const start = performance.now();
		if (generation && next.fileId !== mounted.fileId) article.replaceChildren();
		reconcile(article, next.html);
		mounted = next;
		generation = next.generation;
		recordRenderStage(
			{ stage: 'dom', durationMs: performance.now() - start, thread: 'main' },
			next.fileId
		);
		emit('render');
		if (next.isCurrent()) next.onRendered(article, next.content, generation);
	}

	const resize =
		typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => invalidate());
	resize?.observe(article);
	if (article.parentElement) resize?.observe(article.parentElement);
	const changes = new MutationObserver(() => invalidate());
	changes.observe(article, {
		childList: true,
		subtree: true,
		characterData: true,
		attributes: true,
		attributeFilter: ['class', 'style', 'hidden', 'width', 'height']
	});
	const theme = new MutationObserver(() => invalidate());
	theme.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['data-theme', 'class', 'style']
	});
	const media = () => invalidate('media');
	const layout = () => invalidate();
	article.addEventListener('load', media, true);
	article.addEventListener('loadedmetadata', media, true);
	window.addEventListener('resize', layout);
	document.fonts?.addEventListener('loadingdone', layout);
	void document.fonts?.ready.then(() => invalidate());
	update(initial);
	return {
		update,
		destroy() {
			disposed = true;
			if (generation) emit('detach');
			cancelAnimationFrame(frame);
			resize?.disconnect();
			changes.disconnect();
			theme.disconnect();
			article.removeEventListener('load', media, true);
			article.removeEventListener('loadedmetadata', media, true);
			window.removeEventListener('resize', layout);
			document.fonts?.removeEventListener('loadingdone', layout);
		}
	};
}
