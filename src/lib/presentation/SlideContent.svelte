<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { t } from '#lib/i18n/index.js';
	import { reportError } from '#lib/report.js';
	import type { PresentationDeck, PresentationSlide } from './model';
	import {
		presentationElementAppearance,
		presentationElementClass,
		presentationElementStyle,
		renderPresentationConnector,
		renderPresentationElementContentCached
	} from './render';

	interface Props {
		slide: PresentationSlide;
		deck: PresentationDeck;
		fileId?: string;
		hideTextId?: string;
		priority?: 'active' | 'background';
	}

	const RENDER_LIMIT = 4;
	let activeRenders = 0;
	const waitingRenders: Array<() => void> = [];

	/** Returns a cancel function that releases a task which has not started. */
	function scheduleRender(task: () => Promise<void>): () => void {
		let cancelled = false;
		const run = () => {
			if (cancelled) return;
			activeRenders += 1;
			void task().finally(() => {
				activeRenders -= 1;
				waitingRenders.shift()?.();
			});
		};
		if (activeRenders < RENDER_LIMIT) run();
		else waitingRenders.push(run);
		return () => {
			cancelled = true;
			const index = waitingRenders.indexOf(run);
			if (index >= 0) waitingRenders.splice(index, 1);
		};
	}

	interface RenderedElement {
		key: string;
		html: string;
	}

	let { slide, deck, fileId, hideTextId, priority = 'background' }: Props = $props();
	let renderedContent = new SvelteMap<string, RenderedElement>();
	let failedElements = new SvelteSet<string>();
	let renderFailed = $derived(failedElements.size > 0);
	const renderTokens = new SvelteMap<string, symbol>();
	const cancelRuns = new SvelteMap<string, () => void>();

	function contentKey(
		element: PresentationSlide['elements'][number],
		activeFileId: string | undefined,
		hiddenId: string | undefined
	): string {
		const hidden = element.id === hiddenId ? 'hidden' : 'shown';
		return `${element.id}\u0000${element.type}\u0000${hidden}\u0000${activeFileId ?? ''}\u0000${element.content}`;
	}

	$effect(() => {
		const elements = slide.elements;
		const activeFileId = fileId;
		const hiddenId = hideTextId;
		const controller = new AbortController();
		const liveIds = new SvelteSet<string>();
		for (const element of elements) {
			liveIds.add(element.id);
			if (element.type === 'line' || element.type === 'arrow') {
				untrack(() => {
					renderedContent.delete(element.id);
					failedElements.delete(element.id);
				});
				renderTokens.delete(element.id);
				cancelRuns.get(element.id)?.();
				cancelRuns.delete(element.id);
				continue;
			}
			const key = contentKey(element, activeFileId, hiddenId);
			const current = untrack(() => renderedContent.get(element.id));
			if (current?.key === key) continue;
			const token = Symbol(key);
			renderTokens.set(element.id, token);
			untrack(() => {
				renderedContent.delete(element.id);
				failedElements.delete(element.id);
			});
			cancelRuns.get(element.id)?.();
			cancelRuns.set(
				element.id,
				scheduleRender(async () => {
					if (renderTokens.get(element.id) !== token) return;
					try {
						const html = await renderPresentationElementContentCached(element, {
							...(activeFileId ? { fileId: activeFileId } : {}),
							...(hiddenId ? { hideTextId: hiddenId } : {}),
							priority,
							signal: controller.signal
						});
						if (renderTokens.get(element.id) !== token) return;
						renderedContent.set(element.id, { key, html });
					} catch (error) {
						if (controller.signal.aborted || renderTokens.get(element.id) !== token) return;
						failedElements.add(element.id);
						reportError('presentation slide render', error);
					}
				})
			);
		}
		for (const id of untrack(() => Array.from(renderedContent.keys()))) {
			if (!liveIds.has(id)) {
				renderedContent.delete(id);
				renderTokens.delete(id);
				failedElements.delete(id);
				cancelRuns.get(id)?.();
				cancelRuns.delete(id);
			}
		}
		return () => {
			controller.abort();
			for (const cancel of cancelRuns.values()) cancel();
			cancelRuns.clear();
		};
	});

	function contentFor(element: PresentationSlide['elements'][number]): string {
		return renderedContent.get(element.id)?.html ?? '';
	}
</script>

<div
	class="mdsh-slide"
	data-slide-id={slide.id}
	style:width={`${deck.width}px`}
	style:height={`${deck.height}px`}
	style:--slide-background={slide.background}
>
	{#if renderFailed}
		<p class="mdsh-slide-render-error" role="alert">{t('slides.renderFailed')}</p>
	{/if}
	{#each slide.elements as element (element.id)}
		<div
			class={presentationElementClass(element)}
			data-element-id={element.id}
			style={`${presentationElementStyle(element, slide)};${presentationElementAppearance(element)}`}
		>
			{#if element.type === 'line' || element.type === 'arrow'}
				<!-- eslint-disable-next-line svelte/no-at-html-tags - Renderer creates this SVG from validated geometry. -->
				{@html renderPresentationConnector(element, slide)}
			{:else}
				<!-- eslint-disable-next-line svelte/no-at-html-tags - Markdown and image HTML use the shared sanitizer and media policy. -->
				<div class="mdsh-slide-element-content">{@html contentFor(element)}</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.mdsh-slide {
		position: relative;
		box-sizing: border-box;
		overflow: hidden;
		background: var(--slide-background, #fff);
		font-family:
			Bahnschrift,
			'DIN Alternate',
			'Arial Narrow',
			'Aptos',
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			ui-sans-serif,
			system-ui,
			sans-serif;
		isolation: isolate;
	}

	.mdsh-slide-render-error {
		position: absolute;
		z-index: 1000;
		inset: 24px;
		margin: 0;
		padding: 16px;
		border: 2px solid #b91c1c;
		background: #fef2f2;
		color: #7f1d1d;
		font-size: 24px;
	}

	.mdsh-slide-element {
		position: absolute;
		box-sizing: border-box;
		transform-origin: center;
		color: var(--element-color, #0f172a);
		font-size: var(--element-font-size, 24px);
		text-align: var(--element-text-align, left);
	}

	.mdsh-slide-element-content {
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		overflow: hidden;
	}

	.mdsh-slide-element-rich .mdsh-slide-element-content {
		padding: 8px;
	}

	.mdsh-slide-element-rich {
		line-height: 1.3;
	}

	.mdsh-slide-element-image :global(img) {
		display: block;
		width: 100%;
		height: 100%;
		margin: 0;
		object-fit: contain;
	}

	.mdsh-slide-element-rectangle,
	.mdsh-slide-element-rounded-rectangle,
	.mdsh-slide-element-ellipse {
		background: var(--element-fill, transparent);
		border: var(--element-stroke-width, 0) solid var(--element-stroke, transparent);
	}

	.mdsh-slide-element-rounded-rectangle {
		border-radius: 24px;
	}

	.mdsh-slide-element-ellipse {
		border-radius: 50%;
	}

	.mdsh-slide-element-line,
	.mdsh-slide-element-arrow {
		overflow: visible;
	}

	:global(.mdsh-slide-connector) {
		display: block;
		width: 100%;
		height: 100%;
		overflow: visible;
	}

	.mdsh-slide-element-rich :global(:first-child) {
		margin-top: 0;
	}

	.mdsh-slide-element-rich :global(:last-child) {
		margin-bottom: 0;
	}

	.mdsh-slide-element-rich :global(h1),
	.mdsh-slide-element-rich :global(h2),
	.mdsh-slide-element-rich :global(h3),
	.mdsh-slide-element-rich :global(h4),
	.mdsh-slide-element-rich :global(h5),
	.mdsh-slide-element-rich :global(h6) {
		margin: 0 0 0.35em;
		font: inherit;
		line-height: 1.15;
		font-weight: 700;
	}

	.mdsh-slide-element-rich :global(h1) {
		font-size: 2em;
	}
	.mdsh-slide-element-rich :global(h2) {
		font-size: 1.55em;
	}
	.mdsh-slide-element-rich :global(h3) {
		font-size: 1.3em;
	}
	.mdsh-slide-element-rich :global(h4) {
		font-size: 1.12em;
	}
	.mdsh-slide-element-rich :global(h5),
	.mdsh-slide-element-rich :global(h6) {
		font-size: 1em;
	}
	.mdsh-slide-element-rich :global(p) {
		margin: 0 0 0.55em;
	}
	.mdsh-slide-element-rich :global(ul),
	.mdsh-slide-element-rich :global(ol) {
		margin: 0 0 0.55em;
		padding-left: 1.35em;
	}
	.mdsh-slide-element-rich :global(ul) {
		list-style: disc;
	}
	.mdsh-slide-element-rich :global(ol) {
		list-style: decimal;
	}
	.mdsh-slide-element-rich :global(li.task-list-item) {
		list-style: none;
	}
	.mdsh-slide-element-rich :global(a) {
		color: inherit;
		text-decoration: underline;
	}
	.mdsh-slide-element-rich :global(hr) {
		margin: 0.55em 0;
		border: 0;
		border-top: 1px solid currentColor;
	}
	.mdsh-slide-element-rich :global(blockquote) {
		margin: 0.5em 0;
		padding-left: 0.7em;
		border-left: 0.12em solid currentColor;
	}
	.mdsh-slide-element-rich :global(pre) {
		margin: 0.45em 0;
		padding: 0.45em;
		overflow: hidden;
		white-space: pre-wrap;
		background: rgba(15, 23, 42, 0.08);
	}
	.mdsh-slide-element-rich :global(code) {
		font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace;
		font-size: 0.85em;
	}
	.mdsh-slide-element-rich :global(.hljs) {
		color: #24292f;
	}
	.mdsh-slide-element-rich :global(.hljs-keyword),
	.mdsh-slide-element-rich :global(.hljs-selector-tag) {
		color: #cf222e;
	}
	.mdsh-slide-element-rich :global(.hljs-string),
	.mdsh-slide-element-rich :global(.hljs-attr) {
		color: #0a3069;
	}
	.mdsh-slide-element-rich :global(.hljs-title),
	.mdsh-slide-element-rich :global(.hljs-number) {
		color: #8250df;
	}
	.mdsh-slide-element-rich :global(.hljs-comment) {
		color: #6e7781;
	}
	.mdsh-slide-element-rich :global(table) {
		width: 100%;
		border-collapse: collapse;
	}
	.mdsh-slide-element-rich :global(th),
	.mdsh-slide-element-rich :global(td) {
		padding: 0.25em 0.4em;
		border: 1px solid currentColor;
	}
	.mdsh-slide-element-rich :global(.mermaid-block),
	.mdsh-slide-element-rich :global(.math-block) {
		max-width: 100%;
		overflow: hidden;
	}
	.mdsh-slide-element-rich :global(svg) {
		max-width: 100%;
		max-height: 100%;
	}
</style>
