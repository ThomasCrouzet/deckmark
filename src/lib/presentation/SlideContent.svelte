<script lang="ts">
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
	}

	let { slide, deck, fileId, hideTextId }: Props = $props();
	let renderedContent = $state(new Map<string, string>());
	let renderFailed = $state(false);
	let renderGeneration = 0;

	$effect(() => {
		const elements = slide.elements.map((element) => ({
			element,
			key: `${element.id}\u0000${element.type}\u0000${element.content}`
		}));
		const activeFileId = fileId;
		const hiddenId = hideTextId;
		const generation = ++renderGeneration;
		void Promise.all(
			elements.map(async ({ element, key }) => ({
				key,
				html: await renderPresentationElementContentCached(element, {
					...(activeFileId ? { fileId: activeFileId } : {}),
					...(hiddenId ? { hideTextId: hiddenId } : {})
				})
			}))
		)
			.then((entries) => {
				if (generation !== renderGeneration) return;
				renderedContent = new Map(entries.map(({ key, html }) => [key, html]));
				renderFailed = false;
			})
			.catch((error) => {
				if (generation !== renderGeneration) return;
				renderedContent = new Map();
				renderFailed = true;
				reportError('presentation slide render', error);
			});
	});

	function contentFor(element: PresentationSlide['elements'][number]): string {
		const key = `${element.id}\u0000${element.type}\u0000${element.content}`;
		return renderedContent.get(key) ?? '';
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
