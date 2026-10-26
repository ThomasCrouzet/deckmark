<script lang="ts">
	// Read view: full HTML rendering via our renderer (same output as the PDF).
	// Supports: GFM, KaTeX, highlight.js, Mermaid diagrams.
	//
	// The renderer is dynamically imported - loads only when the user
	// enters read mode (or triggers a PDF/HTML export elsewhere).

	import '../render/preview.css';
	import { filesStore } from '#lib/files.svelte.js';
	import { decodeWikiTarget } from '#lib/wiki-links.js';
	import { t } from '#lib/i18n/index.js';
	import { mermaidThemeFromDataTheme } from '#lib/theme.js';
	import { themeStore } from '#lib/ui/theme.svelte.js';
	import { notify } from '#lib/notify.svelte.js';
	import { reportError } from '#lib/report.js';
	import { editorStateCache } from '#lib/editor-state.js';
	import { onDestroy, tick } from 'svelte';

	interface Props {
		fileId: string;
		content: string;
		/** Callback invoked when the rendered `<article>` is mounted/unmounted.
		 *  Lets a consumer (e.g. TOC) target this container without
		 *  digging through the DOM itself. */
		onArticleRef?: (el: HTMLElement | null) => void;
	}

	let { fileId, content, onArticleRef }: Props = $props();
	let articleEl: HTMLElement | null = $state(null);
	let readScroller: HTMLDivElement | null = $state(null);
	let positionFileId: string | null = null;

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

	$effect(() => {
		const id = fileId;
		const scroller = readScroller;
		if (!scroller) return;
		if (positionFileId && positionFileId !== id) saveReadPosition(positionFileId);
		positionFileId = id;
		restoreReadPosition(id);
	});

	let html = $state('');
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

	async function doRender(md: string, fid: string) {
		const seq = ++renderSeq;
		renderedFileId = null;
		err = null;
		const loadingTimer = setTimeout(() => {
			if (seq === renderSeq) loading = true;
		}, 200);
		try {
			const { renderMarkdown } = await import('../render/markdown');
			// Mermaid palette follows the live UI theme (same rule as presentation mode).
			const mermaidTheme = mermaidThemeFromDataTheme(
				document.documentElement.getAttribute('data-theme')
			);
			const out = await renderMarkdown(md, {
				fileId: fid,
				mermaidTheme,
				headingPermalinks: true,
				allowRemoteImages: false
			});
			if (seq !== renderSeq) return; // a more recent render has started
			if (fid !== fileId) return; // the file changed in the meantime
			html = out;
			renderedFileId = fid;
			hasBlockedRemoteImages = out.includes('data-mdsh-remote-');
			if (filesStore.projectAnchor?.id !== fid) restoreReadPosition(fid);
		} catch (e) {
			if (seq !== renderSeq) return;
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
		void retryVersion;
		// Subscribe to theme pref so light/dark toggles re-run Mermaid.
		void themeStore.effective;
		void doRender(c, f);
	});

	onDestroy(() => {
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
		{:else}
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
				aria-busy={loading}
				onclick={handleWikiLinkClick}
				onkeydown={handleWikiLinkKeydown}
			>
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				{@html html}
			</article>
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
		height: 100%;
		width: 100%;
		overflow-y: auto;
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
