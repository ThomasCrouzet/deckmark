<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import ReadView from '#lib/components/ReadView.svelte';
	import SourceEditor from '#lib/components/SourceEditor.svelte';
	import { documentHeadings } from '#lib/document-navigation.js';
	import { readPreference, writePreference } from '#lib/preferences.js';
	import { t } from '#lib/i18n/index.js';

	interface Props {
		fileId: string;
		content: string;
		onChange: (markdown: string) => void;
		onCursorLine: (line: number) => void;
		onSourceEditorRef: (ref: SourceEditor | null) => void;
		onArticleRef: (el: HTMLElement | null) => void;
	}

	let { fileId, content, onChange, onCursorLine, onSourceEditorRef, onArticleRef }: Props =
		$props();

	const RATIO_KEY = 'mdsh:split-ratio';
	const MIN_RATIO = 25;
	const MAX_RATIO = 75;
	const RENDER_DELAY_MS = 350;
	const RENDER_MAX_WAIT_MS = 1200;

	let root = $state<HTMLDivElement | null>(null);
	let previewPane = $state<HTMLElement | null>(null);
	let sourceEditor = $state<SourceEditor | null>(null);
	let previewArticle = $state<HTMLElement | null>(null);
	let ratio = $state(50);
	let narrow = $state(false);
	let previewContent = $state(untrack(() => content));
	let previewFileId = untrack(() => fileId);
	let renderTimer: ReturnType<typeof setTimeout> | null = null;
	let maxRenderTimer: ReturnType<typeof setTimeout> | null = null;
	let previewScrollFrame = 0;
	let suppressPreviewScrollUntil = 0;
	let suppressSourceScrollUntil = 0;
	let lastPreviewSection = -1;
	let lastSourceSection = -1;
	let currentSourceLine = 1;

	function clampRatio(value: number): number {
		return Math.round(Math.min(MAX_RATIO, Math.max(MIN_RATIO, value)));
	}

	function saveRatio(): void {
		writePreference(RATIO_KEY, String(ratio));
	}

	function applyRatio(value: number, persist = true): void {
		ratio = clampRatio(value);
		if (persist) saveRatio();
	}

	function commitPreview(): void {
		if (renderTimer) clearTimeout(renderTimer);
		if (maxRenderTimer) clearTimeout(maxRenderTimer);
		renderTimer = null;
		maxRenderTimer = null;
		lastPreviewSection = -1;
		previewContent = content;
	}

	function schedulePreview(nextFileId: string, nextContent: string): void {
		if (nextFileId !== previewFileId) {
			previewFileId = nextFileId;
			previewContent = nextContent;
			if (renderTimer) clearTimeout(renderTimer);
			if (maxRenderTimer) clearTimeout(maxRenderTimer);
			renderTimer = null;
			maxRenderTimer = null;
			return;
		}
		if (nextContent === previewContent) return;
		if (renderTimer) clearTimeout(renderTimer);
		renderTimer = setTimeout(commitPreview, RENDER_DELAY_MS);
		maxRenderTimer ??= setTimeout(commitPreview, RENDER_MAX_WAIT_MS);
	}

	function sectionIndexForLine(markdown: string, line: number): number {
		return documentHeadings(markdown).findLastIndex((heading) => heading.line <= line);
	}

	function renderedHeadings(): HTMLElement[] {
		return previewArticle
			? Array.from(previewArticle.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
			: [];
	}

	function syncPreviewToSourceLine(line: number): void {
		if (performance.now() < suppressSourceScrollUntil) return;
		const index = sectionIndexForLine(previewContent, line);
		if (index < 0 || index === lastPreviewSection) return;
		const target = renderedHeadings()[index];
		if (!target) return;
		lastPreviewSection = index;
		suppressPreviewScrollUntil = performance.now() + 400;
		target.scrollIntoView({ block: 'start' });
	}

	function handleSourceCursor(line: number): void {
		currentSourceLine = line;
		onCursorLine(line);
		syncPreviewToSourceLine(line);
	}

	function handleSourceViewport(line: number): void {
		currentSourceLine = line;
		syncPreviewToSourceLine(line);
	}

	function handlePreviewScroll(event: Event): void {
		if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('mdsh-read')) {
			return;
		}
		if (performance.now() < suppressPreviewScrollUntil || previewScrollFrame) return;
		const scroller = event.target;
		previewScrollFrame = requestAnimationFrame(() => {
			previewScrollFrame = 0;
			const top = scroller.getBoundingClientRect().top + 48;
			const headings = renderedHeadings();
			let index = headings.findLastIndex((heading) => heading.getBoundingClientRect().top <= top);
			if (index < 0 && headings.length > 0) index = 0;
			if (index < 0 || index === lastSourceSection) return;
			const sourceHeading = documentHeadings(previewContent)[index];
			if (!sourceHeading) return;
			lastSourceSection = index;
			suppressSourceScrollUntil = performance.now() + 400;
			sourceEditor?.scrollToLine(sourceHeading.line);
		});
	}

	function updateRatioFromPointer(event: PointerEvent): void {
		if (!root) return;
		const bounds = root.getBoundingClientRect();
		const fraction = narrow
			? (event.clientY - bounds.top) / bounds.height
			: (event.clientX - bounds.left) / bounds.width;
		applyRatio(fraction * 100, false);
	}

	function startResize(event: PointerEvent): void {
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		updateRatioFromPointer(event);
	}

	function stopResize(event: PointerEvent): void {
		const target = event.currentTarget as HTMLElement;
		if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
		saveRatio();
	}

	function resizeWithKeyboard(event: KeyboardEvent): void {
		const decrease = narrow ? event.key === 'ArrowUp' : event.key === 'ArrowLeft';
		const increase = narrow ? event.key === 'ArrowDown' : event.key === 'ArrowRight';
		if (decrease || increase) {
			event.preventDefault();
			applyRatio(ratio + (increase ? 5 : -5));
			return;
		}
		if (event.key === 'Home' || event.key === 'End') {
			event.preventDefault();
			applyRatio(event.key === 'Home' ? MIN_RATIO : MAX_RATIO);
		}
	}

	function captureArticle(el: HTMLElement | null): void {
		previewArticle = el;
		onArticleRef(el);
	}

	$effect(() => {
		onSourceEditorRef(sourceEditor);
	});

	$effect(() => {
		schedulePreview(fileId, content);
	});

	onMount(() => {
		const stored = readPreference(RATIO_KEY);
		const storedRatio = stored === null ? Number.NaN : Number(stored);
		if (Number.isFinite(storedRatio)) applyRatio(storedRatio, false);
		const media = window.matchMedia('(max-width: 767px)');
		const updateLayout = () => (narrow = media.matches);
		updateLayout();
		media.addEventListener('change', updateLayout);
		root?.addEventListener('scroll', handlePreviewScroll, true);
		const previewObserver = new MutationObserver(() => {
			lastPreviewSection = -1;
			syncPreviewToSourceLine(currentSourceLine);
		});
		if (previewPane) previewObserver.observe(previewPane, { childList: true, subtree: true });
		return () => {
			media.removeEventListener('change', updateLayout);
			root?.removeEventListener('scroll', handlePreviewScroll, true);
			previewObserver.disconnect();
		};
	});

	onDestroy(() => {
		if (renderTimer) clearTimeout(renderTimer);
		if (maxRenderTimer) clearTimeout(maxRenderTimer);
		if (previewScrollFrame) cancelAnimationFrame(previewScrollFrame);
		onSourceEditorRef(null);
		onArticleRef(null);
	});
</script>

<div
	bind:this={root}
	class="mdsh-split-view"
	class:narrow
	style:--source-size={`${ratio}%`}
	data-testid="split-view"
>
	<section class="mdsh-split-pane mdsh-split-source" aria-label={t('splitView.sourcePane')}>
		<SourceEditor
			bind:this={sourceEditor}
			{fileId}
			{content}
			fillContainer
			{onChange}
			onCursorLine={handleSourceCursor}
			onViewportLine={handleSourceViewport}
		/>
	</section>
	<!-- The focusable separator follows the WAI-ARIA Window Splitter keyboard pattern. -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="mdsh-split-separator"
		role="separator"
		tabindex="0"
		aria-label={t('splitView.resize')}
		aria-orientation={narrow ? 'horizontal' : 'vertical'}
		aria-valuemin={MIN_RATIO}
		aria-valuemax={MAX_RATIO}
		aria-valuenow={ratio}
		aria-valuetext={t('splitView.resizeValue', { value: ratio })}
		onpointerdown={startResize}
		onpointermove={(event) => {
			if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) {
				updateRatioFromPointer(event);
			}
		}}
		onpointerup={stopResize}
		onpointercancel={stopResize}
		onkeydown={resizeWithKeyboard}
	></div>
	<section
		bind:this={previewPane}
		class="mdsh-split-pane mdsh-split-preview"
		aria-label={t('splitView.previewPane')}
	>
		{#key fileId}
			<ReadView {fileId} content={previewContent} onArticleRef={captureArticle} />
		{/key}
	</section>
</div>

<style>
	.mdsh-split-view {
		display: grid;
		grid-template-columns: minmax(0, var(--source-size)) 12px minmax(0, 1fr);
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
	}
	.mdsh-split-pane {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
	.mdsh-split-source {
		background: color-mix(in oklab, var(--color-bg) 97%, var(--color-bg-1));
	}
	.mdsh-split-preview {
		border-left: 1px solid var(--color-border);
	}
	.mdsh-split-separator {
		position: relative;
		z-index: 2;
		cursor: col-resize;
		touch-action: none;
		background: var(--color-bg-1);
		border-inline: 1px solid var(--color-border);
	}
	.mdsh-split-separator::after {
		content: '';
		position: absolute;
		top: 50%;
		left: 50%;
		width: 3px;
		height: 48px;
		border-radius: 2px;
		background: var(--color-border-strong);
		transform: translate(-50%, -50%);
	}
	.mdsh-split-separator:hover::after,
	.mdsh-split-separator:focus-visible::after {
		background: var(--color-accent);
	}
	.mdsh-split-separator:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}
	.mdsh-split-view.narrow {
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: minmax(0, var(--source-size)) 12px minmax(0, 1fr);
	}
	.narrow .mdsh-split-preview {
		border-top: 1px solid var(--color-border);
		border-left: 0;
	}
	.narrow .mdsh-split-separator {
		cursor: row-resize;
		border-block: 1px solid var(--color-border);
		border-inline: 0;
	}
	.narrow .mdsh-split-separator::after {
		width: 48px;
		height: 3px;
	}
</style>
