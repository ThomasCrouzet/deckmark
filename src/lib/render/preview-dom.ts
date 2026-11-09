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

/**
 * A cheap bucket key. Equality still uses the native `isEqualNode` comparison,
 * so a key collision never reuses a different block.
 */
function nodeKey(node: Node): string {
	if (!(node instanceof Element)) return `#${node.nodeType}`;
	return `${node.nodeName}|${node.getAttribute('id') ?? ''}|${node.getAttribute('class') ?? ''}`;
}

// A small lookahead keeps one changed block from poisoning the shared key
// bucket. It never scans the whole bucket, so reorder work stays bounded.
const LOOKAHEAD = 4;

function reconcile(article: HTMLElement, html: string): void {
	const template = document.createElement('template');
	// Only complete sanitized renderer output enters this action.
	template.innerHTML = html;
	if (!article.hasChildNodes()) {
		article.append(template.content);
		return;
	}
	const reusable = new Map<string, Node[]>();
	for (const node of article.childNodes) {
		const key = nodeKey(node);
		const bucket = reusable.get(key);
		if (bucket) bucket.push(node);
		else reusable.set(key, [node]);
	}
	let cursor = article.firstChild;
	let misses = 0;
	for (const fresh of Array.from(template.content.childNodes)) {
		const bucket = reusable.get(nodeKey(fresh));
		// Find the first equal candidate within a bounded window. Skipped
		// candidates were removed from the document; later fresh blocks still
		// reach their own old nodes instead of the same stale bucket head.
		let match = -1;
		if (bucket) {
			const limit = Math.min(bucket.length, LOOKAHEAD);
			for (let index = 0; index < limit; index += 1) {
				if (bucket[index]!.isEqualNode(fresh)) {
					match = index;
					break;
				}
			}
		}
		if (match < 0) {
			// The block is new or changed. Insert a fresh node and keep the old
			// heads for the following fresh blocks.
			if (++misses > 32) {
				// Reordering or identity churn makes node-by-node reuse slower than
				// one native replacement. Keep a bounded reconciliation cost. Some
				// fresh nodes already moved into the article, so parse the source
				// again instead of replacing with the remaining fragment.
				const replacement = document.createElement('template');
				replacement.innerHTML = html;
				article.replaceChildren(replacement.content);
				return;
			}
			if (cursor) article.insertBefore(fresh, cursor);
			else article.append(fresh);
			continue;
		}
		if (match > 0) {
			misses += match;
			bucket!.splice(0, match);
		}
		const node = bucket!.shift()!;
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
