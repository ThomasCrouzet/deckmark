<script lang="ts">
	import { onMount } from 'svelte';
	import SlideContent from './SlideContent.svelte';
	import type { PresentationDeck, PresentationSlide } from './model';
	let {
		deck,
		slide,
		fileId
	}: { deck: PresentationDeck; slide: PresentationSlide; fileId: string } = $props();
	let element = $state<HTMLDivElement | null>(null);
	let width = $state(130);
	let visible = $state(false);
	onMount(() => {
		if (!element || typeof IntersectionObserver === 'undefined') {
			visible = true;
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					visible = true;
					observer.disconnect();
				}
			},
			{ rootMargin: '160px' }
		);
		observer.observe(element);
		return () => observer.disconnect();
	});
</script>

<div
	class="thumbnail"
	bind:this={element}
	bind:clientWidth={width}
	style:aspect-ratio={deck.width / deck.height}
	style:background={slide.background}
	aria-hidden="true"
	inert
>
	{#if visible}<div class="content" style:transform={`scale(${width / deck.width})`}>
			<SlideContent {deck} {slide} {fileId} />
		</div>{/if}
</div>

<style>
	.thumbnail {
		width: 100%;
		overflow: hidden;
		position: relative;
		pointer-events: none;
	}
	.content {
		position: absolute;
		left: 0;
		top: 0;
		transform-origin: top left;
	}
</style>
