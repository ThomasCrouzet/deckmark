<script lang="ts">
	// Read view: full HTML rendering via our renderer (same output as the PDF).
	// Supports: GFM, KaTeX, highlight.js, Mermaid diagrams.
	//
	// The renderer is dynamically imported - loads only when the user
	// enters read mode (or triggers a PDF/HTML export elsewhere).

	import '../render/preview.css';
	import { filesStore } from '#lib/files.svelte.js';
	import { decodeWikiTarget } from '#lib/wiki-links.js';
	import { t, type MessageKey } from '#lib/i18n/index.js';
	import { mermaidThemeFromDataTheme } from '#lib/theme.js';
	import { themeStore } from '#lib/ui/theme.svelte.js';
	import { notify } from '#lib/notify.svelte.js';
	import { reportError } from '#lib/report.js';
	import { editorStateCache } from '#lib/editor-state.js';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { createRenderInstanceId, nextRenderGeneration } from '../render/render-identity';
	import { mountPreview, type PreviewMount } from '../render/preview-dom';

	interface Props {
		fileId: string;
		content: string;
		/** Callback invoked when the rendered `<article>` is mounted/unmounted.
		 *  Lets a consumer (e.g. TOC) target this container without
		 *  digging through the DOM itself. */
		onArticleRef?: (el: HTMLElement | null) => void;
		onRendered?: (article: HTMLElement, content: string, generation: number) => void;
	}

	let { fileId, content, onArticleRef, onRendered }: Props = $props();
	let articleEl: HTMLElement | null = $state(null);
	let readScroller: HTMLDivElement | null = $state(null);
	let positionFileId: string | null = null;

	interface InkPoint {
		x: number;
		y: number;
	}
	interface InkStroke {
		tool: 'pen' | 'highlighter' | 'eraser';
		color: string;
		size: number;
		points: InkPoint[];
	}
	let annotate = $state(false);
	let hasInk = $state(false);
	let tool = $state<'pen' | 'highlighter' | 'eraser'>('pen');
	let color = $state('#f5c542');
	let inkSize = $state(3);
	let canvas = $state<HTMLCanvasElement | null>(null);
	let strokes: InkStroke[] = [];
	let current: InkStroke | null = null;
	let drawing = false;
	let cleanupInk: (() => void) | null = null;
	const ANNOTATION_COLORS = ['#f5c542', '#ff6b6b', '#4dabf7', '#51cf66'];
	const ANNOTATION_LABELS: MessageKey[] = [
		'annotations.colorYellow',
		'annotations.colorRed',
		'annotations.colorBlue',
		'annotations.colorGreen'
	];

	function redrawInk() {
		const element = canvas;
		if (!element) return;
		const context = element.getContext('2d');
		if (!context) return;
		const ratio = window.devicePixelRatio || 1;
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, element.width / ratio, element.height / ratio);
		for (const stroke of strokes) {
			drawStroke(context, stroke);
		}
	}

	function drawStroke(context: CanvasRenderingContext2D, stroke: InkStroke) {
		if (stroke.points.length === 0) return;
		context.save();
		context.lineCap = 'round';
		context.lineJoin = 'round';
		context.lineWidth =
			stroke.tool === 'highlighter'
				? stroke.size * 4
				: stroke.tool === 'eraser'
					? stroke.size * 5
					: stroke.size;
		context.strokeStyle = stroke.color;
		context.globalAlpha = stroke.tool === 'highlighter' ? 0.35 : 1;
		context.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
		context.beginPath();
		const [first, ...rest] = stroke.points;
		context.moveTo(first!.x, first!.y);
		for (const point of rest) context.lineTo(point.x, point.y);
		if (stroke.points.length === 1) context.lineTo(first!.x + 0.1, first!.y + 0.1);
		context.stroke();
		context.restore();
	}

	function pointFrom(event: PointerEvent): InkPoint {
		const rect = canvas!.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	function startInk(event: PointerEvent) {
		if (!annotate || !canvas) return;
		event.preventDefault();
		canvas.setPointerCapture(event.pointerId);
		drawing = true;
		hasInk = true;
		current = {
			tool,
			color,
			size: inkSize,
			points: [pointFrom(event)]
		};
		const context = canvas.getContext('2d');
		if (context) drawStroke(context, current);
	}

	function moveInk(event: PointerEvent) {
		if (!drawing || !current || !canvas) return;
		event.preventDefault();
		const point = pointFrom(event);
		const previous = current.points[current.points.length - 1]!;
		current.points.push(point);
		const context = canvas.getContext('2d');
		if (!context) return;
		const ratio = window.devicePixelRatio || 1;
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.save();
		context.lineCap = 'round';
		context.lineJoin = 'round';
		context.lineWidth =
			current.tool === 'highlighter'
				? current.size * 4
				: current.tool === 'eraser'
					? current.size * 5
					: current.size;
		context.strokeStyle = current.color;
		context.globalAlpha = current.tool === 'highlighter' ? 0.35 : 1;
		context.globalCompositeOperation =
			current.tool === 'eraser' ? 'destination-out' : 'source-over';
		context.beginPath();
		context.moveTo(previous.x, previous.y);
		context.lineTo(point.x, point.y);
		context.stroke();
		context.restore();
	}

	function endInk(event: PointerEvent) {
		if (!drawing) return;
		drawing = false;
		if (current) strokes.push(current);
		current = null;
		canvas?.releasePointerCapture(event.pointerId);
	}

	function clearInk() {
		strokes = [];
		current = null;
		hasInk = false;
		redrawInk();
	}

	function fitInkCanvas() {
		const element = canvas;
		const scroller = readScroller;
		if (!element || !scroller) return;
		const ratio = window.devicePixelRatio || 1;
		const width = Math.max(scroller.scrollWidth, scroller.clientWidth);
		const height = Math.max(scroller.scrollHeight, scroller.clientHeight);
		if (
			element.width !== Math.round(width * ratio) ||
			element.height !== Math.round(height * ratio)
		) {
			element.width = Math.round(width * ratio);
			element.height = Math.round(height * ratio);
			element.style.width = `${width}px`;
			element.style.height = `${height}px`;
			redrawInk();
		}
	}

	onMount(() => {
		const resize = new ResizeObserver(() => fitInkCanvas());
		if (readScroller) resize.observe(readScroller);
		const observer = new MutationObserver(() => fitInkCanvas());
		if (readScroller) observer.observe(readScroller, { childList: true, subtree: true });
		window.addEventListener('resize', fitInkCanvas);
		cleanupInk = () => {
			resize.disconnect();
			observer.disconnect();
			window.removeEventListener('resize', fitInkCanvas);
		};
		return () => {
			cleanupInk?.();
			cleanupInk = null;
		};
	});

	$effect(() => {
		void fileId;
		untrack(clearInk);
	});

	$effect(() => {
		if (readScroller && canvas) tick().then(fitInkCanvas);
	});

	function saveReadPosition(id: string): void {
		if (!readScroller) return;
		editorStateCache.setPosition(id, 'read', {
			anchor: 0,
			head: 0,
			scrollTop: readScroller.scrollTop
		});
	}

	function restoreReadPosition(id: string): void {
		const position = editorStateCache.getPosition(id, 'read');
		if (!position) return;
		void tick().then(() => {
			requestAnimationFrame(() => {
				if (readScroller && fileId === id) readScroller.scrollTop = position.scrollTop;
			});
		});
	}

	/**
	 * §5.2 - Shares click and keyboard handling. Finds the parent `a.wiki-link`
	 * and reads its encoded target from `data-mdsh-wiki`.
	 * Blocks the logical href, which has no DOM target. The store opens an existing
	 * file or creates a missing one, as in Obsidian.
	 * Returns true when it opens a link. One article-level listener handles all
	 * rendered links and continues to work after DOM rebuilds.
	 */
	function openWikiLinkFromEvent(e: Event): boolean {
		if (htmlFileId !== fileId) {
			e.preventDefault();
			return true;
		}
		const target = e.target as HTMLElement | null;
		const projectLink = target?.closest<HTMLAnchorElement>('a[href]:not(.wiki-link)');
		const destination = projectLink?.getAttribute('href');
		const file = filesStore.library.find((file) => file.id === fileId);
		if (file?.projectId && destination && !/^(?:#|[a-z][a-z\d+.-]*:|\/\/)/i.test(destination)) {
			e.preventDefault();
			void filesStore.openProjectLink(fileId, destination);
			return true;
		}
		const link = target?.closest<HTMLAnchorElement>('a.wiki-link');
		if (!link) return false;
		const encoded = link.getAttribute('data-mdsh-wiki');
		if (!encoded) return false;
		const wikiTarget = decodeWikiTarget(encoded);
		// Prevent the logical href from adding an unused browser history entry.
		// Apply this to Cmd/Ctrl-click too; internal mdsh links have no alternate behavior.
		e.preventDefault();
		filesStore.openWikiLink(wikiTarget, fileId);
		return true;
	}

	function handleWikiLinkClick(e: MouseEvent) {
		openWikiLinkFromEvent(e);
	}

	/**
	 * §a11y (WCAG 2.1.1) - keyboard activation of wiki-links in read mode.
	 * Handle Enter and Space through the same path as a click. This opens the
	 * target file instead of the logical `#mdsh-wiki-…` anchor after Tab.
	 * The `a.wiki-link` guard prevents interference with other input in the article.
	 */
	function handleWikiLinkKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
		openWikiLinkFromEvent(e);
	}

	// Notifies the parent on every reference change (mount, unmount,
	// switch between error state and article).
	$effect(() => {
		onArticleRef?.(articleEl);
	});

	// Save before a file change removes the article and resets the scroll position.
	$effect.pre(() => {
		const id = fileId;
		const scroller = readScroller;
		if (!scroller) return;
		if (positionFileId && positionFileId !== id) saveReadPosition(positionFileId);
		positionFileId = id;
		restoreReadPosition(id);
	});

	let html = $state('');
	let previewMount = $state<PreviewMount | null>(null);
	const instanceId = createRenderInstanceId();
	let renderController: AbortController | null = null;
	// Keep the HTML owner while a same-file refresh is pending.
	let htmlFileId = $state<string | null>(null);
	let renderedFileId = $state<string | null>(null);

	$effect(() => {
		const anchor = filesStore.projectAnchor;
		void html;
		if (!anchor || anchor.id !== fileId || renderedFileId !== fileId) return;
		void tick().then(() =>
			requestAnimationFrame(() => {
				if (filesStore.projectAnchor !== anchor || anchor.id !== fileId) return;
				articleEl
					?.querySelector(`#${CSS.escape(anchor.fragment)}`)
					?.scrollIntoView({ block: 'start' });
				filesStore.projectAnchor = null;
			})
		);
	});
	// §B3.1 - `loading` is now gated by a 200 ms timer. Before: a "Rendering…"
	// flash on every switch (~50 ms typical). The pattern mirrors
	// `spinner.svelte.ts`: we only show the spinner if the render takes > 200 ms,
	// enough to avoid disrupting a fast workflow.
	let loading = $state(false);
	let err = $state<string | null>(null);
	let hasBlockedRemoteImages = $state(false);
	let mediaBusy = $state(false);
	let retryVersion = $state(0);
	let renderSeq = 0;

	async function doRender(md: string, fid: string, projectId?: string, relativePath?: string) {
		renderController?.abort();
		const controller = new AbortController();
		renderController = controller;
		const seq = ++renderSeq;
		const member = filesStore.library.find((file) => file.id === fid);
		const theme = themeStore.effective;
		const isCurrent = () =>
			!!member &&
			!controller.signal.aborted &&
			seq === renderSeq &&
			fid === fileId &&
			content === md &&
			themeStore.effective === theme &&
			filesStore.library.find((file) => file.id === fid) === member &&
			member.projectId === projectId &&
			member.relativePath === relativePath;
		if (!member) {
			htmlFileId = null;
			previewMount = null;
			loading = false;
			return;
		}
		renderedFileId = null;
		err = null;
		const loadingTimer = setTimeout(() => {
			if (seq === renderSeq) loading = true;
		}, 200);
		try {
			const { renderMarkdown } = await import('../render/markdown');
			if (!isCurrent()) return;
			// Mermaid palette follows the live UI theme (same rule as presentation mode).
			const mermaidTheme = mermaidThemeFromDataTheme(
				document.documentElement.getAttribute('data-theme')
			);
			const out = await renderMarkdown(md, {
				fileId: fid,
				projectContext: projectId && relativePath ? { projectId, relativePath } : null,
				signal: controller.signal,
				instanceId,
				mermaidTheme,
				headingPermalinks: true,
				allowRemoteImages: false
			});
			if (!isCurrent()) return;
			html = out;
			previewMount = {
				fileId: fid,
				content: md,
				html: out,
				generation: nextRenderGeneration(),
				isCurrent,
				onRendered: (article, source, generation) => {
					if (!isCurrent()) return;
					renderedFileId = fid;
					hasBlockedRemoteImages = out.includes('data-mdsh-remote-');
					if (filesStore.projectAnchor?.id !== fid) restoreReadPosition(fid);
					onRendered?.(article, source, generation);
				}
			};
			htmlFileId = fid;
		} catch (e) {
			if (!isCurrent()) return;
			err = e instanceof Error ? e.message : String(e);
		} finally {
			clearTimeout(loadingTimer);
			if (seq === renderSeq) loading = false;
		}
	}

	async function incorporateImages(options: { files?: readonly File[]; allowNetwork?: boolean }) {
		if (mediaBusy) return;
		const snapshot = content;
		const id = fileId;
		mediaBusy = true;
		try {
			const { incorporateDocumentImages } = await import('../render/document-media');
			const result = await incorporateDocumentImages(snapshot, options);
			const current = filesStore.files.find((file) => file.id === id);
			if (!current || current.content !== snapshot) {
				notify.error(t('read.imageContentChanged'));
				return;
			}
			if (result.embedded > 0) {
				filesStore.updateContent(id, result.markdown);
				notify.success(t('read.imagesEmbedded', { n: result.embedded }));
			}
			if (result.issues.length > 0) {
				notify.error(
					t('export.mediaFailed', {
						n: result.issues.length,
						sources: result.issues
							.map((issue) => issue.source)
							.slice(0, 3)
							.join(', ')
					})
				);
			}
		} catch (error) {
			reportError('document image import', error, {
				notifyUser: t('imageDrop.unreadable', { n: 1 })
			});
		} finally {
			mediaBusy = false;
		}
	}

	function chooseImageFiles(directory: boolean) {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.accept = 'image/*';
		if (directory) input.setAttribute('webkitdirectory', '');
		input.onchange = () => {
			const selected = Array.from(input.files ?? []);
			if (selected.length > 0) void incorporateImages({ files: selected });
		};
		input.click();
	}

	// Re-render when content, file, or UI theme changes (Mermaid palette).
	$effect(() => {
		const c = content;
		const f = fileId;
		const member = filesStore.library.find((file) => file.id === f);
		const projectId = member?.projectId;
		const relativePath = member?.relativePath;
		void retryVersion;
		// Subscribe to theme pref so light/dark toggles re-run Mermaid.
		void themeStore.effective;
		void doRender(c, f, projectId, relativePath);
		return () => renderController?.abort();
	});

	onDestroy(() => {
		renderController?.abort();
		renderSeq++;
		if (positionFileId) saveReadPosition(positionFileId);
	});
</script>

<svelte:window onpagehide={() => positionFileId && saveReadPosition(positionFileId)} />

<div class="mdsh-read-wrapper">
	<!-- The focusable scroller lets keyboard users scroll rendered documents. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="mdsh-read"
		bind:this={readScroller}
		role="region"
		tabindex="0"
		aria-label={t('toolbar.readingMode')}
	>
		{#if err}
			<div class="mdsh-read-error" role="alert">
				<strong>{t('read.renderError')}</strong>
				<pre>{err}</pre>
				<button type="button" onclick={() => retryVersion++}>{t('source.retry')}</button>
			</div>
		{:else if htmlFileId === fileId && previewMount}
			{#if hasBlockedRemoteImages}
				<div class="mdsh-remote-images-notice" role="status">
					<span>{t('read.remoteImagesBlocked')}</span>
					<button
						type="button"
						disabled={mediaBusy}
						onclick={() => void incorporateImages({ allowNetwork: true })}
					>
						{t('read.loadRemoteImages')}
					</button>
					<button type="button" disabled={mediaBusy} onclick={() => chooseImageFiles(false)}>
						{t('read.importImageFiles')}
					</button>
					<button type="button" disabled={mediaBusy} onclick={() => chooseImageFiles(true)}>
						{t('read.importImageFolder')}
					</button>
				</div>
			{/if}
			<!-- Delegated onclick + onkeydown: capture the activation of child
			     `.wiki-link` elements - the article itself is not interactive,
			     it is the internal <a> elements (keyboard-focusable) that are. The
			     delegation to the parent avoids N listeners on links regenerated on
			     every render. The keydown makes wiki-links activable with the
			     keyboard (Enter/Space) - otherwise Tab+Enter followed the dummy
			     anchor instead of opening the target file (WCAG 2.1.1). -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<article
				tabindex="-1"
				class="mdsh-preview"
				bind:this={articleEl}
				use:mountPreview={previewMount}
				aria-busy={loading}
				onclick={handleWikiLinkClick}
				onkeydown={handleWikiLinkKeydown}
			></article>
			{#if annotate || hasInk}
				<canvas
					bind:this={canvas}
					class="annotation-canvas"
					class:drawing={annotate}
					aria-hidden="true"
					data-testid="annotation-canvas"
					onpointerdown={startInk}
					onpointermove={moveInk}
					onpointerup={endInk}
					onpointercancel={endInk}
				></canvas>
			{/if}
		{/if}
	</div>
	<div class="annotation-bar" role="toolbar" aria-label={t('annotations.toolbar')}>
		<button
			type="button"
			aria-pressed={annotate}
			onclick={() => {
				annotate = !annotate;
				if (annotate) tick().then(fitInkCanvas);
			}}
			data-testid="annotation-toggle">{t('annotations.toggle')}</button
		>
		{#if annotate}
			<button
				type="button"
				aria-pressed={tool === 'pen'}
				onclick={() => (tool = 'pen')}
				data-testid="annotation-pen">{t('annotations.pen')}</button
			>
			<button
				type="button"
				aria-pressed={tool === 'highlighter'}
				onclick={() => (tool = 'highlighter')}
				data-testid="annotation-highlighter">{t('annotations.highlighter')}</button
			>
			<button
				type="button"
				aria-pressed={tool === 'eraser'}
				onclick={() => (tool = 'eraser')}
				data-testid="annotation-eraser">{t('annotations.eraser')}</button
			>
			{#each ANNOTATION_COLORS as swatch, index (swatch)}
				<button
					type="button"
					class="annotation-color"
					class:active={color === swatch}
					style:background={swatch}
					aria-label={t(ANNOTATION_LABELS[index]!)}
					onclick={() => (color = swatch)}
					data-testid={`annotation-color-${index}`}
				></button>
			{/each}
			<label class="annotation-size">
				<span>{t('annotations.size')}</span>
				<input type="range" min="1" max="10" bind:value={inkSize} />
			</label>
			<button type="button" onclick={clearInk} data-testid="annotation-clear"
				>{t('annotations.clear')}</button
			>
		{/if}
	</div>
	{#if loading && !err}
		<div class="mdsh-read-loading" role="status" aria-live="polite">{t('read.rendering')}</div>
	{/if}
</div>

<style>
	.mdsh-read-wrapper {
		position: relative;
		height: 100%;
		width: 100%;
	}
	.mdsh-read {
		position: relative;
		height: 100%;
		width: 100%;
		overflow-y: auto;
	}
	.annotation-canvas {
		position: absolute;
		top: 0;
		left: 0;
		z-index: 5;
		pointer-events: none;
	}
	.annotation-canvas.drawing {
		pointer-events: auto;
		touch-action: none;
		cursor: crosshair;
	}
	.annotation-bar {
		position: absolute;
		top: 0.5rem;
		right: 0.75rem;
		z-index: 6;
		display: flex;
		flex-wrap: wrap;
		max-width: min(92vw, 520px);
		align-items: center;
		gap: 4px;
		padding: 4px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: color-mix(in oklab, var(--color-bg-1) 92%, transparent);
		box-shadow: var(--shadow-lg);
	}
	.annotation-bar button {
		min-height: 30px;
		padding: 2px 7px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		font-size: 11px;
	}
	.annotation-bar button[aria-pressed='true'] {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}
	.annotation-color {
		width: 24px;
		padding: 0;
		border-color: var(--color-border-strong);
	}
	.annotation-color.active {
		outline: 2px solid var(--color-fg);
		outline-offset: 1px;
	}
	.annotation-size {
		display: flex;
		align-items: center;
		gap: 3px;
		font-size: 10px;
		color: var(--color-fg-muted);
	}
	.annotation-size input {
		width: 60px;
	}
	@media print {
		.annotation-bar,
		.annotation-canvas {
			display: none !important;
		}
	}
	.mdsh-read:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}
	.mdsh-read-loading {
		position: absolute;
		top: 0.6rem;
		right: 0.9rem;
		padding: 0.2rem 0.6rem;
		font-size: 11px;
		color: var(--color-fg-dim);
		background: var(--color-bg-1);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		opacity: 0.85;
		pointer-events: none;
	}
	.mdsh-remote-images-notice {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		max-width: 720px;
		margin: 0.75rem auto 0;
		padding: 0.65rem 0.8rem;
		color: var(--color-fg-dim);
		background: var(--color-bg-1);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		font-size: 12px;
	}
	.mdsh-remote-images-notice button {
		flex: none;
		padding: 0.35rem 0.55rem;
		color: var(--color-fg);
		background: var(--color-bg-2);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-xs);
		cursor: pointer;
	}
	.mdsh-read-error {
		max-width: 720px;
		margin: 2rem auto;
		padding: 1rem 1.2rem;
		color: var(--color-danger);
		background: rgba(255, 80, 80, 0.08);
		border: 1px solid rgba(255, 80, 80, 0.25);
		border-radius: var(--radius-md);
		font-family: var(--font-mono);
		font-size: 13px;
	}
	.mdsh-read-error pre {
		margin: 0.6em 0 0;
		white-space: pre-wrap;
	}
</style>
