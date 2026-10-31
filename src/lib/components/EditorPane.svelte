<script lang="ts">
	// §P3.2 - Main editing pane: 3-mode switch + resize handle + drag overlay + TOC.
	//
	// Receives as props the active file's data, the current mode, the editorWidth
	// and modals instances (for the lazy-load TOC), and the callbacks to surface
	// the refs (sourceEditorRef, articleRef) and events up to the page.
	//
	// The resize handle is managed here: `bind:this={resizeHandleEl}` + a local
	// `$effect` that syncs to editorWidth.setResizeHandle. This avoids leaving in
	// +page.svelte an `$effect` whose only purpose is a bind:this of an element
	// belonging to this component.
	//
	// Load optional editor views when the selected mode needs them.
	import SourceEditor from '#lib/components/SourceEditor.svelte';
	import Welcome from '#lib/components/Welcome.svelte';
	import { Upload } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import type { EditMode, FileItem } from '#lib/types.js';
	import type { createEditorWidth } from '#lib/ui/editor-width.svelte.js';
	import type { createModals } from '#lib/ui/modals.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import { readPreference, writePreference } from '#lib/preferences.js';
	import { isPresentation } from '#lib/presentation/detect.js';

	interface Props {
		libraryCount?: number;
		documentTool?: 'find' | 'outline' | null;
		onCloseTool?: () => void;
		activeFile: FileItem | null;
		mode: EditMode;
		editorWidth: ReturnType<typeof createEditorWidth>;
		modals: ReturnType<typeof createModals>;
		dragOver: boolean;
		tocEmpty: boolean;
		tocVisible: boolean;
		focusMode: boolean;
		/** Reference to the `<article>` rendered by ReadView, for the TOC scrollspy. */
		articleRef: HTMLElement | null;
		// Callbacks to surface the refs up to +page.svelte
		onSourceEditorRef: (ref: SourceEditor | null) => void;
		onArticleRef: (el: HTMLElement | null) => void;
		onTocEmpty: (empty: boolean) => void;
		// Action callbacks
		onEditorChange: (markdown: string) => void;
		// §C1 - Flush of the last WYSIWYG keystroke to a specific file
		// (the old tab) before the editor remounts.
		onEditorFlush: (fileId: string, markdown: string) => void;
		onNew: () => void;
		onImport: () => void;
		onDemo: () => void;
	}

	let {
		libraryCount = 0,
		documentTool = null,
		onCloseTool = () => {},
		activeFile,
		mode,
		editorWidth,
		modals,
		dragOver,
		tocEmpty,
		tocVisible,
		focusMode,
		onSourceEditorRef,
		onArticleRef,
		onTocEmpty,
		onEditorChange,
		onEditorFlush,
		onNew,
		onImport,
		onDemo
	}: Props = $props();

	// Local reference to the resize handle. bind:this only accepts
	// identifiers - we go through a local variable + $effect.
	let resizeHandleEl = $state<HTMLDivElement | null>(null);
	$effect(() => {
		editorWidth.setResizeHandle(resizeHandleEl);
	});

	// Local reference to the SourceEditor. bind:this does not accept a lambda
	// (error "bind_invalid_expression") - local variable + $effect to
	// surface the ref up to +page.svelte via onSourceEditorRef.
	let sourceEditorEl = $state<SourceEditor | null>(null);
	let contentRoot = $state<HTMLDivElement | null>(null);
	let sourceLine = $state(1);
	let splitView = $state(false);
	const SPLIT_VIEW_KEY = 'mdsh:split-view';

	function toggleSplitView(): void {
		splitView = !splitView;
		writePreference(SPLIT_VIEW_KEY, splitView ? '1' : '0');
	}

	onMount(() => {
		splitView = readPreference(SPLIT_VIEW_KEY) === '1';
	});
	function closeTool() {
		onCloseTool();
		requestAnimationFrame(() =>
			contentRoot
				?.querySelector<HTMLElement>('.cm-content, .ProseMirror, .mdsh-preview')
				?.focus({ preventScroll: true })
		);
	}
	$effect(() => {
		onSourceEditorRef(sourceEditorEl);
	});
</script>

<div class="mdsh-content-col relative flex min-h-0 min-w-0 flex-1 flex-col">
	{#if activeFile && documentTool}
		{#await import('./DocumentNavigator.svelte') then module}
			<module.default
				kind={documentTool}
				content={activeFile.content}
				{mode}
				container={contentRoot}
				onLine={(line) => sourceEditorEl?.goToLine(line)}
				onClose={closeTool}
			/>
		{:catch}<p class="p-2 text-sm text-danger">
				{t('source.loadErrorTitle')}
				<button class="underline" onclick={onCloseTool}>{t('settings.close')}</button>
			</p>{/await}
	{/if}
	<div bind:this={contentRoot} class="relative min-h-0 flex-1">
		{#if activeFile}
			{#if modals.presentationOpen}
				<div class="h-full"></div>
			{:else if mode === 'source'}
				{#key activeFile.id}
					<div class="mdsh-source-mode">
						<div class="mdsh-split-controls">
							<button
								type="button"
								class:active={splitView}
								aria-pressed={splitView}
								aria-controls={splitView ? 'mdsh-split-editor' : undefined}
								data-testid="split-view-toggle"
								onclick={toggleSplitView}
							>
								{t(splitView ? 'splitView.hide' : 'splitView.show')}
							</button>
						</div>
						<div id="mdsh-split-editor" class="mdsh-source-workspace">
							{#if splitView}
								{#await import('./SplitEditor.svelte') then module}
									<module.default
										fileId={activeFile.id}
										content={activeFile.content}
										onChange={onEditorChange}
										onCursorLine={(line) => (sourceLine = line)}
										onSourceEditorRef={(ref) => (sourceEditorEl = ref)}
										{onArticleRef}
									/>
								{:catch}<p role="alert" class="p-4 text-danger">
										{t('source.loadErrorTitle')}
									</p>{/await}
							{:else}
								<SourceEditor
									bind:this={sourceEditorEl}
									fileId={activeFile.id}
									content={activeFile.content}
									onChange={onEditorChange}
									onCursorLine={(line) => (sourceLine = line)}
								/>
							{/if}
						</div>
					</div>
				{/key}
			{:else if isPresentation(activeFile.content)}
				{#await import('#lib/presentation/entry.js') then module}
					<module.PresentationDocument
						fileId={activeFile.id}
						content={activeFile.content}
						onEdit={modals.openSlideEditor}
					/>
				{:catch}<p role="alert" class="p-4 text-danger">{t('slides.renderFailed')}</p>{/await}
			{:else if mode === 'read'}
				{#await import('./ReadView.svelte') then module}
					<module.default fileId={activeFile.id} content={activeFile.content} {onArticleRef} />
				{:catch}<p role="alert" class="p-4 text-danger">{t('source.loadErrorTitle')}</p>{/await}
			{:else}
				{#await import('./Editor.svelte') then module}
					<module.default
						fileId={activeFile.id}
						content={activeFile.content}
						onChange={onEditorChange}
						onFlush={onEditorFlush}
					/>
				{:catch}<p role="alert" class="p-4 text-danger">{t('editor.loadErrorTitle')}</p>{/await}
			{/if}

			<!-- Resize handle (desktop only); role presentation because
		     mouse dragging is a convenience, keyboard presets go through the palette (⌘⇧P). -->
			{#if mode !== 'source' || !splitView}
				<div
					bind:this={resizeHandleEl}
					class="resize-handle"
					class:resizing={editorWidth.resizing}
					onpointerdown={editorWidth.startResize}
					onpointermove={editorWidth.onResize}
					onpointerup={editorWidth.stopResize}
					onpointercancel={editorWidth.stopResize}
					onlostpointercapture={editorWidth.stopResize}
					ondblclick={editorWidth.resetEditorWidth}
					role="presentation"
					aria-hidden="true"
					title={t('editorPane.resizeHandle', { width: editorWidth.editorMaxWidth })}
				></div>
			{/if}
		{:else}
			<Welcome
				{onNew}
				{onImport}
				{onDemo}
				onLibrary={modals.openLibrary}
				documentCount={libraryCount}
			/>
		{/if}

		{#if dragOver}
			<div
				class="pointer-events-none absolute inset-3 z-20 flex items-center justify-center
			       rounded-lg border-2 border-dashed border-accent bg-bg/80 backdrop-blur-sm"
			>
				<div class="flex flex-col items-center gap-2 text-accent">
					<Upload size={32} />
					<p class="text-sm font-medium">{t('editorPane.dropFiles')}</p>
				</div>
			</div>
		{/if}
	</div>
</div>

<!-- Keep one lazy TOC instance while headings appear or disappear. -->
{#if tocVisible && activeFile && !focusMode}
	<aside class="mdsh-toc-col" class:toc-empty={tocEmpty}>
		{#await modals.loadToc() then Toc}
			<Toc
				container={contentRoot}
				content={activeFile.content}
				{mode}
				{sourceLine}
				onLine={(line) => sourceEditorEl?.goToLine(line)}
				onEmpty={onTocEmpty}
			/>
		{/await}
	</aside>
{/if}

<style>
	.mdsh-source-mode {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.mdsh-split-controls {
		display: flex;
		flex: none;
		justify-content: flex-end;
		padding: 0.35rem 0.65rem;
		border-bottom: 1px solid var(--color-border);
		background: color-mix(in oklab, var(--color-bg-1) 78%, transparent);
	}
	.mdsh-split-controls button {
		padding: 0.3rem 0.7rem;
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg-muted);
		font: 500 12px/1.4 var(--font-mono);
		cursor: pointer;
	}
	.mdsh-split-controls button:hover,
	.mdsh-split-controls button.active {
		border-color: var(--color-accent);
		color: var(--color-fg);
	}
	.mdsh-split-controls button:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.mdsh-source-workspace {
		min-width: 0;
		min-height: 0;
		flex: 1;
	}

	/* Keep a 24px clear strip inside both the preset edge and the pane edge.
	   Source scrolls at the preset edge. Edit and Read scroll at the pane edge.
	   Overlay scrollbars need this space even when their layout width is zero. */
	.resize-handle {
		--scrollbar-clearance: 24px;
		position: absolute;
		top: 0;
		bottom: 0;
		width: 14px;
		left: min(
			calc(50% + var(--editor-max-width, 820px) / 2 - 14px - var(--scrollbar-clearance)),
			calc(100% - 14px - var(--scrollbar-clearance))
		);
		cursor: col-resize;
		touch-action: none;
		z-index: 10;
		background: transparent;
		transition: background 0.15s ease;
	}
	.resize-handle::after {
		content: '';
		position: absolute;
		top: 50%;
		left: 50%;
		width: 3px;
		height: 56px;
		background: var(--color-border-strong);
		transform: translate(-50%, -50%);
		opacity: 0.55;
		transition:
			opacity 0.18s ease,
			background 0.18s ease,
			width 0.15s ease,
			height 0.15s ease;
		border-radius: 2px;
	}
	.resize-handle:hover::after {
		opacity: 1;
		background: var(--color-accent);
		height: 72px;
	}
	.resize-handle.resizing::after,
	.resize-handle:active::after {
		opacity: 1;
		background: var(--color-accent);
		width: 4px;
		height: 88px;
	}
	/* Hide on mobile: no fine pointer, not really useful */
	@media (max-width: 767px), (pointer: coarse) {
		.resize-handle {
			display: none;
		}
	}

	/* ============================================================================
	   Table of contents - fixed right column in all modes (desktop >= 1024 px).
	   On mobile, collapse the column and give all available width to the text.
	   ============================================================================ */
	.mdsh-toc-col {
		flex: 0 0 220px;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		background: color-mix(in oklab, var(--color-bg-1) 56%, transparent);
	}
	.mdsh-toc-col.toc-empty {
		display: none;
	}
	@media (max-width: 1023px) {
		.mdsh-toc-col {
			display: none;
		}
	}
</style>
