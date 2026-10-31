<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	import { parsePresentation } from './model';
	import SlideContent from './SlideContent.svelte';
	let { fileId, content, onEdit }: { fileId: string; content: string; onEdit: () => void } =
		$props();
	let width = $state(800);
	const deck = $derived.by(() => {
		try {
			return parsePresentation(content);
		} catch {
			return null;
		}
	});
	const scale = $derived(deck ? Math.min(1, Math.max(1, width - 48) / deck.width) : 1);
</script>

<div class="presentation-document" bind:clientWidth={width}>
	<div class="document-controls"><button onclick={onEdit}>{t('slides.title')}</button></div>
	{#if deck}
		{#each deck.slides as slide (slide.id)}
			<div
				class="preview-frame"
				style:width={`${deck.width * scale}px`}
				style:height={`${deck.height * scale}px`}
			>
				<div class="preview-slide" style:transform={`scale(${scale})`}>
					<SlideContent {slide} {deck} {fileId} />
				</div>
			</div>
		{/each}
	{:else}<p role="alert">{t('slides.invalidSource')}</p>{/if}
</div>

<style>
	.presentation-document {
		height: 100%;
		overflow: auto;
		padding: 16px 24px;
		background: var(--color-bg-2);
	}
	.document-controls {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 16px;
	}
	button {
		border: 1px solid var(--color-border);
		border-radius: 6px;
		padding: 8px 12px;
		background: var(--color-bg-1);
		color: var(--color-fg);
		font-size: 13px;
		cursor: pointer;
	}
	button:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.preview-frame {
		margin: 0 auto 24px;
		overflow: hidden;
		box-shadow: 0 2px 10px #0002;
	}
	.preview-slide {
		transform-origin: top left;
	}
</style>
