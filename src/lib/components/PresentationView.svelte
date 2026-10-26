<script lang="ts">
	// §2.10 - Presentation mode: full-screen slides from the active file's
	// markdown (split on `---`, cf. lib/slides). Navigation with arrows /
	// space / Esc. Reuses the lazy-loaded rendering pipeline (marked + KaTeX +
	// Mermaid + DOMPurify) - no external presentation library.

	import { browser } from '$app/env';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { t } from '#lib/i18n/index.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { splitSlides } from '#lib/slides.js';
	import { reportError } from '#lib/report.js';
	import { mermaidThemeFromDataTheme } from '#lib/theme.js';
	import { themeStore } from '#lib/ui/theme.svelte.js';
	import { ChevronLeft, ChevronRight, X } from '@lucide/svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	let index = $state(0);
	let html = $state('');
	let container: HTMLDivElement | null = $state(null);

	const slides = $derived(open ? splitSlides(filesStore.active?.content ?? '') : []);

	$effect(() => {
		if (open) {
			index = 0;
			container?.focus();
		}
	});

	// Keeps the index within bounds when the content changes.
	$effect(() => {
		if (index > slides.length - 1) index = Math.max(0, slides.length - 1);
	});

	// Renders the current slide (lazy renderMarkdown). The Mermaid theme follows the UI theme.
	$effect(() => {
		if (!open || !browser) return;
		const md = slides[index];
		if (md === undefined) {
			html = '';
			return;
		}
		const mermaidTheme = mermaidThemeFromDataTheme(themeStore.effective);
		let cancelled = false;
		void import('#lib/render/markdown.js')
			.then(({ renderMarkdown }) => renderMarkdown(md, { mermaidTheme, showFrontmatter: false }))
			.then((out) => {
				if (!cancelled) html = out;
			})
			.catch((err) => reportError('presentation render', err));
		return () => {
			cancelled = true;
		};
	});

	function next() {
		if (index < slides.length - 1) index += 1;
	}
	function prev() {
		if (index > 0) index -= 1;
	}

	function handleKey(e: KeyboardEvent) {
		switch (e.key) {
			case 'ArrowRight':
			case 'PageDown':
			case ' ':
				e.preventDefault();
				next();
				break;
			case 'ArrowLeft':
			case 'PageUp':
				e.preventDefault();
				prev();
				break;
			case 'Home':
				e.preventDefault();
				index = 0;
				break;
			case 'End':
				e.preventDefault();
				index = Math.max(0, slides.length - 1);
				break;
			case 'Escape':
				e.preventDefault();
				onClose();
				break;
		}
	}
</script>

{#if open}
	<div
		bind:this={container}
		class="fixed inset-0 z-[80] flex flex-col bg-bg text-fg"
		role="dialog"
		aria-modal="true"
		aria-label={t('presentation.dialogAria')}
		tabindex="-1"
		onkeydown={handleKey}
		use:focusTrap
	>
		<!-- Minimal control bar -->
		<div class="flex items-center justify-between px-4 py-2 text-xs text-fg-dim">
			<span>{slides.length > 0 ? `${index + 1} / ${slides.length}` : '-'}</span>
			<button
				class="rounded p-1 transition hover:bg-bg-2 hover:text-fg"
				onclick={onClose}
				aria-label={t('presentation.quitAria')}
			>
				<X size={16} />
			</button>
		</div>

		<!-- Slide -->
		<div class="flex min-h-0 flex-1 items-center justify-center overflow-auto px-8 py-4">
			{#if slides.length === 0}
				<p class="text-sm text-fg-dim">
					{t('presentation.emptyBefore')}
					<code>---</code>{t('presentation.emptyAfter')}
				</p>
			{:else}
				<!-- eslint-disable-next-line svelte/no-at-html-tags - HTML already sanitized by DOMPurify (renderMarkdown) -->
				<article class="mdsh-preview mdsh-slide w-full max-w-3xl">{@html html}</article>
			{/if}
		</div>

		<!-- Navigation -->
		{#if slides.length > 1}
			<div class="flex items-center justify-center gap-4 px-4 py-3">
				<button
					class="rounded-md border border-border p-2 text-fg-muted transition hover:bg-bg-2 hover:text-fg disabled:opacity-30"
					onclick={prev}
					disabled={index === 0}
					aria-label={t('presentation.prevAria')}
				>
					<ChevronLeft size={18} />
				</button>
				<button
					class="rounded-md border border-border p-2 text-fg-muted transition hover:bg-bg-2 hover:text-fg disabled:opacity-30"
					onclick={next}
					disabled={index === slides.length - 1}
					aria-label={t('presentation.nextAria')}
				>
					<ChevronRight size={18} />
				</button>
			</div>
		{/if}
	</div>
{/if}
