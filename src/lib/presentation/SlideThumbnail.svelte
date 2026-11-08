<script lang="ts">
	import { onMount } from 'svelte';
	import SlideContent from './SlideContent.svelte';
	import type { PresentationDeck, PresentationSlide } from './model';
	let {
		deck,
		slide,
		fileId,
		pinned = false
	}: {
		deck: PresentationDeck;
		slide: PresentationSlide;
		fileId: string;
		pinned?: boolean;
	} = $props();
	let element = $state<HTMLDivElement | null>(null);
	let width = $state(130);
	let inRange = $state(false);
	let focused = $state(false);
	const mounted = $derived(inRange || focused || pinned);
	onMount(() => {
		if (!element) return;
		const button = element.closest('button');
		const onFocusIn = () => {
			focused = true;
		};
		const onFocusOut = (event: FocusEvent) => {
			if (!button?.contains(event.relatedTarget as Node | null)) focused = false;
		};
		button?.addEventListener('focusin', onFocusIn);
		button?.addEventListener('focusout', onFocusOut);
		if (typeof IntersectionObserver === 'undefined') {
			inRange = true;
			return () => {
				button?.removeEventListener('focusin', onFocusIn);
				button?.removeEventListener('focusout', onFocusOut);
			};
		}
		const observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[entries.length - 1];
				if (entry) inRange = entry.isIntersecting;
			},
			{ rootMargin: '160px 0px' }
		);
		observer.observe(element);
		return () => {
			observer.disconnect();
			button?.removeEventListener('focusin', onFocusIn);
			button?.removeEventListener('focusout', onFocusOut);
		};
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
	{#if mounted}<div class="content" style:transform={`scale(${width / deck.width})`}>
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
