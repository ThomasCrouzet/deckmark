<script lang="ts">
	import { ArrowDown, ArrowUp } from '@lucide/svelte';
	import { onDestroy } from 'svelte';
	import type { EditMode } from '#lib/types.js';
	import { t } from '#lib/i18n/index.js';

	interface Props {
		contentRoot: HTMLElement | null;
		mode: EditMode;
		activeId: string | null;
	}

	let { contentRoot, mode, activeId }: Props = $props();
	let scrollable = $state(false);
	let canUp = $state(false);
	let canDown = $state(false);

	// Resolve the live scroller at call time. A stale element from another
	// mode or file can therefore never receive the scroll.
	function scroller(): HTMLElement | null {
		const root = contentRoot;
		if (!root) return null;
		if (mode === 'read') return root.querySelector<HTMLElement>('.mdsh-read');
		if (mode === 'source') return root.querySelector<HTMLElement>('.cm-scroller');
		return root.querySelector<HTMLElement>('.mdsh-editor');
	}

	function update() {
		const element = scroller();
		if (!element) {
			scrollable = false;
			canUp = false;
			canDown = false;
			return;
		}
		scrollable = element.scrollHeight > element.clientHeight + 24;
		canUp = element.scrollTop > 1;
		canDown = element.scrollTop + element.clientHeight < element.scrollHeight - 2;
	}

	function go(edge: 'top' | 'bottom') {
		const element = scroller();
		if (!element) return;
		const reduced =
			typeof window.matchMedia === 'function' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		element.scrollTo({
			top: edge === 'top' ? 0 : element.scrollHeight,
			behavior: reduced ? 'auto' : 'smooth'
		});
	}

	let bound: HTMLElement | null = null;
	let unbind: (() => void) | null = null;
	let scheduled = 0;
	let bindFrame = 0;

	/** Coalesces content mutations into one geometry read per frame. */
	function scheduleUpdate(): void {
		if (scheduled) return;
		scheduled = requestAnimationFrame(() => {
			scheduled = 0;
			update();
		});
	}

	/** Coalesces root mutations into one scroller-identity check per frame. */
	function scheduleBind(): void {
		if (bindFrame) return;
		bindFrame = requestAnimationFrame(() => {
			bindFrame = 0;
			bind();
		});
	}

	function bind() {
		const element = scroller();
		if (element === bound) {
			// A content mutation did not replace the live scroller. Defer the
			// scrollHeight/clientHeight read to the coalesced update instead of
			// forcing layout in the mutation task.
			scheduleUpdate();
			return;
		}
		unbind?.();
		unbind = null;
		bound = element;
		if (!element) {
			update();
			return;
		}
		update();
		element.addEventListener('scroll', update, { passive: true });
		const observer = new ResizeObserver(scheduleUpdate);
		observer.observe(element);
		const mutations = new MutationObserver(scheduleUpdate);
		mutations.observe(element, { childList: true, subtree: true, characterData: true });
		unbind = () => {
			element.removeEventListener('scroll', update);
			observer.disconnect();
			mutations.disconnect();
		};
	}

	$effect(() => {
		void mode;
		void activeId;
		void contentRoot;
		const root = contentRoot;
		if (!root) return;
		// Edit, Source and Read mount their scroll container lazily. Observe the
		// content root so a late mount still binds, and a file switch rebinds.
		scheduleBind();
		const rootObserver = new MutationObserver(scheduleBind);
		rootObserver.observe(root, { childList: true, subtree: true });
		return () => {
			rootObserver.disconnect();
			if (scheduled) cancelAnimationFrame(scheduled);
			scheduled = 0;
			if (bindFrame) cancelAnimationFrame(bindFrame);
			bindFrame = 0;
			unbind?.();
			unbind = null;
			bound = null;
		};
	});

	function onKeydown(event: KeyboardEvent) {
		if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		if (event.key === 'Home' || event.key === 'End') {
			event.preventDefault();
			go(event.key === 'Home' ? 'top' : 'bottom');
		}
	}

	if (typeof window !== 'undefined') window.addEventListener('keydown', onKeydown);
	onDestroy(() => window.removeEventListener('keydown', onKeydown));
</script>

{#if scrollable}
	<div class="mdsh-scroll-nav" role="group" aria-label={t('scroll.navigation')}>
		<button
			type="button"
			onclick={() => go('top')}
			disabled={!canUp}
			aria-label={t('scroll.toTop')}
			aria-keyshortcuts="Alt+Home"
			title={`${t('scroll.toTop')} (Alt+Home)`}
			data-testid="scroll-top"
		>
			<ArrowUp size={16} aria-hidden="true" />
		</button>
		<button
			type="button"
			onclick={() => go('bottom')}
			disabled={!canDown}
			aria-label={t('scroll.toBottom')}
			aria-keyshortcuts="Alt+End"
			title={`${t('scroll.toBottom')} (Alt+End)`}
			data-testid="scroll-bottom"
		>
			<ArrowDown size={16} aria-hidden="true" />
		</button>
	</div>
{/if}

<style>
	.mdsh-scroll-nav {
		position: absolute;
		/* Clear the native scrollbar gutter so the thumb stays draggable. */
		right: max(3rem, env(safe-area-inset-right));
		bottom: max(0.5rem, env(safe-area-inset-bottom));
		z-index: 15;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.mdsh-scroll-nav button {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: color-mix(in oklab, var(--color-bg-1) 88%, transparent);
		color: var(--color-fg-muted);
		box-shadow: 0 2px 6px rgb(0 0 0 / 0.18);
		backdrop-filter: blur(4px);
		cursor: pointer;
	}
	.mdsh-scroll-nav button:hover:not(:disabled) {
		color: var(--color-fg);
		border-color: var(--color-border-strong);
	}
	.mdsh-scroll-nav button:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.mdsh-scroll-nav button:disabled {
		opacity: 0.35;
		cursor: default;
	}
	@media (pointer: coarse) {
		.mdsh-scroll-nav button {
			width: 2.75rem;
			height: 2.75rem;
		}
	}
</style>
