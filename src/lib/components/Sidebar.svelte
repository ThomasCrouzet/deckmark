<script lang="ts">
	import { tick, onMount } from 'svelte';
	import { browser } from '$app/env';
	import { filesStore } from '#lib/files.svelte.js';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import {
		FilePlus,
		Upload,
		X,
		Circle,
		GripVertical,
		CornerDownLeft,
		Tag,
		Archive,
		CircleX,
		AlertTriangle
	} from '@lucide/svelte';
	import { keyboardStore } from '#lib/ui/keyboard.svelte.js';
	import { spinnerStore } from '#lib/spinner.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import BrandLogo from './BrandLogo.svelte';
	import TrashPanel from './TrashPanel.svelte';
	import { ArrowUp, ArrowDown } from '@lucide/svelte';

	interface Props {
		open: boolean;
		focusMode?: boolean;
		onClose: () => void;
		onNew: () => void;
		onImport: () => Promise<void> | void;
		onOpenLibrary?: () => void;
		onOpenProjects?: () => void;
	}

	let {
		open,
		focusMode = false,
		onClose,
		onNew,
		onImport,
		onOpenLibrary,
		onOpenProjects
	}: Props = $props();

	let draggingId = $state<string | null>(null);
	let dragOverId = $state<string | null>(null);
	let fileList = $state<HTMLUListElement | null>(null);
	let closeButton = $state<HTMLButtonElement | null>(null);
	let libraryButton = $state<HTMLButtonElement | null>(null);

	// Tag filter: null = "all files". Auto-reset if the tag
	// disappears from the corpus (file deleted / modified without the tag).
	let activeTag = $state<string | null>(null);

	// §A4.2 - Conditional virtualization of the file list. When
	// the corpus exceeds VIRTUALIZATION_THRESHOLD, we only render the visible
	// window + an overscan to absorb smooth scrolling. Below it, the
	// behavior stays identical to before (full render) - zero
	// regression for the common case. ITEM_HEIGHT_PX is approximate but
	// stable because a tab's height depends on neither the label nor the badge:
	// `py-2` + `text-sm` → ~36 px in practice.
	const VIRTUALIZATION_THRESHOLD = 80;
	const ITEM_HEIGHT_PX = 36;
	const OVERSCAN = 10;
	let scrollContainer = $state<HTMLDivElement | null>(null);
	let scrollTop = $state(0);
	let containerHeight = $state(600);

	// §5.1 - List of unique tags computed from the store. Recomputed on every
	// corpus change via $derived (runes reactivity).
	const tags = $derived(
		[...new Set(filesStore.files.flatMap((file) => filesStore.getTags(file.id)))].sort((a, b) =>
			a.localeCompare(b)
		)
	);

	// Auto-reset the filter if the active tag no longer exists in the corpus.
	$effect(() => {
		if (activeTag && !tags.includes(activeTag)) {
			activeTag = null;
		}
	});

	// Filtered file list: if a tag is active, keep only the
	// files that contain it. Otherwise, all files.
	const filteredFiles = $derived(
		activeTag === null
			? filesStore.files
			: filesStore.files.filter((f) => filesStore.getTags(f.id).includes(activeTag!))
	);

	// Bounds of the virtualized window. Below the threshold, we render everything.
	const useVirtualization = $derived(filteredFiles.length > VIRTUALIZATION_THRESHOLD);
	const visibleStart = $derived(
		useVirtualization ? Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT_PX) - OVERSCAN) : 0
	);
	const visibleEnd = $derived(
		useVirtualization
			? Math.min(
					filteredFiles.length,
					Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT_PX) + OVERSCAN
				)
			: filteredFiles.length
	);
	const visibleFiles = $derived(filteredFiles.slice(visibleStart, visibleEnd));
	const topSpacerHeight = $derived(useVirtualization ? visibleStart * ITEM_HEIGHT_PX : 0);
	const bottomSpacerHeight = $derived(
		useVirtualization ? (filteredFiles.length - visibleEnd) * ITEM_HEIGHT_PX : 0
	);

	function handleListScroll(e: Event) {
		const el = e.currentTarget as HTMLDivElement;
		scrollTop = el.scrollTop;
	}

	// Observe the container height to correctly compute the visible
	// window (and recompute it if the user resizes their window).
	$effect(() => {
		if (!scrollContainer) return;
		containerHeight = scrollContainer.clientHeight;
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => {
			if (scrollContainer) containerHeight = scrollContainer.clientHeight;
		});
		ro.observe(scrollContainer);
		return () => ro.disconnect();
	});

	// §5.2 - Backlinks of the active file (files that point to it via
	// `[[...]]`). Recomputed on every active file or content change.
	const backlinks = $derived(filesStore.activeId ? filesStore.backlinks(filesStore.activeId) : []);

	// §6.5 - Multi-selection: remembers the last clicked id (without modifying
	// activeId) to enable Finder/VSCode-style Shift+click ranges.
	let lastClickedId = $state<string | null>(null);

	function handleSelect(e: MouseEvent, id: string) {
		// Shift+click: range from the last anchor. Does not open the file
		// (consistent with Finder), keeps focus inside the sidebar.
		if (e.shiftKey && lastClickedId) {
			filesStore.selectionRange(lastClickedId, id);
			return;
		}
		// Cmd/Ctrl+click: toggle the id in the selection. Does NOT close the mobile
		// sidebar and does not change activeId - the user composes their selection.
		if (e.metaKey || e.ctrlKey) {
			filesStore.selectionToggle(id);
			lastClickedId = id;
			return;
		}
		// Normal click: reset selection + activate the file.
		filesStore.selectionClear();
		filesStore.setActive(id);
		lastClickedId = id;
		if (window.innerWidth < 768) onClose();
	}

	// Variant used by the Backlinks panel and other simple internal
	// clicks - no Shift/Cmd to handle, "open the file" behavior.
	function selectFile(id: string) {
		filesStore.selectionClear();
		filesStore.openDocument(id);
		lastClickedId = id;
		if (window.innerWidth < 768) onClose();
	}

	function moveFile(id: string, direction: number) {
		const index = filesStore.files.findIndex((file) => file.id === id);
		const target = filesStore.files[index + direction];
		if (target) filesStore.reorder(id, target.id);
	}
	async function deleteFile(id: string) {
		if (
			await promptStore.confirm({
				title: t('sidebar.deleteConfirm'),
				message: t('sidebar.deleteMessage'),
				danger: true
			})
		)
			filesStore.delete(id);
	}
	function handleClose(id: string) {
		filesStore.close(id);
	}

	function onDragStart(e: DragEvent, id: string) {
		draggingId = id;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', id);
		}
	}

	function onDragOver(e: DragEvent, id: string) {
		if (!draggingId || draggingId === id) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dragOverId = id;
	}

	function onDrop(e: DragEvent, id: string) {
		e.preventDefault();
		if (draggingId && draggingId !== id) {
			filesStore.reorder(draggingId, id);
		}
		draggingId = null;
		dragOverId = null;
	}

	function onDragEnd() {
		draggingId = null;
		dragOverId = null;
	}

	// Keyboard alternative to drag & drop (WCAG 2.1.1 Keyboard):
	//   Alt+ArrowUp   → move the file up
	//   Alt+ArrowDown → move the file down
	// Focus stays on the button after the move to chain several
	// moves in a row.
	async function handleFileKey(e: KeyboardEvent, id: string) {
		if (e.key === ' ' && !e.altKey) {
			e.preventDefault();
			if (e.shiftKey && lastClickedId) filesStore.selectionRange(lastClickedId, id);
			else {
				filesStore.selectionToggle(id);
				lastClickedId = id;
			}
			return;
		}
		if (!e.altKey) return;
		if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
		const dir = e.key === 'ArrowUp' ? -1 : 1;
		const idx = filesStore.files.findIndex((f) => f.id === id);
		if (idx === -1) return;
		const targetIdx = idx + dir;
		if (targetIdx < 0 || targetIdx >= filesStore.files.length) return;
		e.preventDefault();
		// invariant: targetIdx is within bounds after the guard above.
		const targetId = filesStore.files[targetIdx]!.id;
		filesStore.reorder(id, targetId);
		await tick();
		fileList?.querySelector<HTMLButtonElement>(`button[data-file-id="${id}"]`)?.focus();
	}

	function selectTag(tag: string | null) {
		activeTag = tag;
	}

	// §B1.11 - Sidebar in mobile drawer mode: focus-trap when open on a
	// small screen. On desktop (md:) it is always visible and part of
	// the linear navigation - no trap. `isMobile` is derived from the window
	// width, recomputed on resize (rAF-throttled to avoid thrash).
	let isMobile = $state(false);
	onMount(() => {
		if (!browser) return;
		let raf = 0;
		const update = () => {
			const nextMobile = window.innerWidth < 768;
			const focusWasInDrawer = isMobile && !nextMobile && document.activeElement === closeButton;
			isMobile = nextMobile;
			if (focusWasInDrawer)
				void tick().then(() => {
					const toggles = document.querySelectorAll<HTMLButtonElement>(
						'#app-toolbar button[aria-controls="files-panel"]'
					);
					Array.from(toggles)
						.find((button) => button.getClientRects().length > 0)
						?.focus();
				});
		};
		update();
		const onResize = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				update();
			});
		};
		window.addEventListener('resize', onResize);
		return () => {
			window.removeEventListener('resize', onResize);
			if (raf) cancelAnimationFrame(raf);
		};
	});
	const trapActive = $derived(isMobile && open && !focusMode);
	$effect(() => {
		if (trapActive) tick().then(() => closeButton?.focus());
	});

	function handleNewFromSidebar(): void {
		onNew();
		if (isMobile) onClose();
	}

	async function handleImportFromSidebar(): Promise<void> {
		await onImport();
	}

	// §a11y - Escape closes the mobile drawer. Previously the overlay carried an
	// onkeydown Escape but, not being focusable (tabindex=-1), it never received
	// the event. Since focus is trapped in the aside (focusTrap), we listen at
	// the window level as long as the mobile overlay is open.
	$effect(() => {
		if (!trapActive) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

<!-- Mobile overlay - real <button>: click to close, natively operable via
     keyboard (Escape is handled at the window level, cf. effect above). -->
{#if open}
	<button
		type="button"
		class="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden"
		onclick={onClose}
		aria-label={t('sidebar.closePanel')}
	></button>
{/if}

<aside
	id="files-panel"
	class="mdsh-sidebar fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-bg-1
	       transform transition-transform duration-200 ease-out
	       md:static md:w-60 md:translate-x-0"
	class:-translate-x-full={!open}
	class:translate-x-0={open}
	aria-label={t('sidebar.filesPanel')}
	inert={!open || focusMode}
	aria-hidden={!open || focusMode ? 'true' : undefined}
	use:focusTrap={{ active: trapActive, restoreOnDeactivate: true }}
>
	<!-- Header -->
	<div
		class="mdsh-sidebar-head flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4"
	>
		<div class="mdsh-sidebar-brand">
			<BrandLogo />
			<span class="mdsh-sidebar-label">{t('brand.localWorkspace')}</span>
		</div>
		<button
			bind:this={closeButton}
			class="shrink-0 text-fg-subtle hover:text-fg md:hidden"
			onclick={onClose}
			aria-label={t('sidebar.closePanel')}
		>
			<X size={16} />
		</button>
	</div>

	{#if onOpenLibrary}
		<button
			class="mx-2 mt-2 rounded border border-border px-3 py-2 text-left text-sm text-fg-muted hover:bg-bg-2"
			data-testid="projects-open"
			onclick={() => {
				if (isMobile) onClose();
				onOpenProjects?.();
			}}>{t('projects.open')}</button
		>
		<button
			bind:this={libraryButton}
			class="m-2 rounded border border-border px-3 py-2 text-left text-sm text-fg-muted hover:bg-bg-2"
			onclick={(event) => {
				event.currentTarget.focus({ preventScroll: true });
				if (isMobile) onClose();
				onOpenLibrary?.();
			}}>{t('library.title')} ({filesStore.library.length})</button
		>
	{/if}
	<!-- §5.1 - Tag filter (chips). Visible only if at least 1 tag
	     in the corpus. The "All" button resets the filter. -->
	{#if tags.length > 0}
		<div
			class="flex flex-wrap gap-1 border-b border-border px-2 py-2"
			role="group"
			aria-label={t('sidebar.tagFilters')}
		>
			<button
				type="button"
				class="mdsh-tag px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors"
				class:bg-accent={activeTag === null}
				class:text-bg={activeTag === null}
				class:bg-bg-2={activeTag !== null}
				class:text-fg-muted={activeTag !== null}
				onclick={() => selectTag(null)}
				aria-pressed={activeTag === null}
			>
				{t('sidebar.allTags')}
			</button>
			{#each tags as tag (tag)}
				<button
					type="button"
					class="mdsh-tag flex items-center gap-1 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors"
					class:bg-accent={activeTag === tag}
					class:text-bg={activeTag === tag}
					class:bg-bg-2={activeTag !== tag}
					class:text-fg-muted={activeTag !== tag}
					class:hover:bg-bg-3={activeTag !== tag}
					onclick={() => selectTag(tag)}
					aria-pressed={activeTag === tag}
					aria-label={t('sidebar.filterByTag', { tag })}
				>
					<Tag size={10} aria-hidden="true" />
					<span>{tag}</span>
				</button>
			{/each}
		</div>
	{/if}

	<!-- §6.5 - Bulk actions bar: visible as soon as 2+ files are selected.
	     Allows exporting to ZIP, closing in batch, or clearing the selection. -->
	{#if filesStore.selectedIds.size >= 2}
		<div
			class="flex items-center justify-between gap-2 border-b border-border bg-bg-2 px-3 py-2 text-xs"
			role="group"
			aria-label={t('sidebar.selectionActions')}
		>
			<span class="text-fg">{t('sidebar.selectedCount', { n: filesStore.selectedIds.size })}</span>
			<div class="flex gap-1">
				<button
					type="button"
					class="rounded p-1 text-fg-muted transition hover:bg-bg-3 hover:text-fg
					       disabled:cursor-not-allowed disabled:opacity-50"
					onclick={() => void filesStore.exportSelectedZip()}
					disabled={spinnerStore.visible}
					aria-label={t('sidebar.exportSelectionZip')}
					title={t('sidebar.exportZip')}
				>
					<Archive size={12} />
				</button>
				<button
					type="button"
					class="rounded p-1 text-fg-muted transition hover:bg-bg-3 hover:text-fg"
					onclick={() => filesStore.closeSelected()}
					aria-label={t('sidebar.closeSelection')}
					title={t('sidebar.close')}
				>
					<X size={12} />
				</button>
				<button
					type="button"
					class="rounded p-1 text-fg-muted transition hover:bg-bg-3 hover:text-fg"
					onclick={() => filesStore.selectionClear()}
					aria-label={t('sidebar.deselectAll')}
					title={t('sidebar.deselect')}
				>
					<CircleX size={12} />
				</button>
			</div>
		</div>
	{/if}

	<!-- File list -->
	<div bind:this={scrollContainer} class="flex-1 overflow-y-auto py-1" onscroll={handleListScroll}>
		{#if filesStore.files.length === 0}
			<div class="px-4 py-8 text-center text-xs text-fg-subtle">
				{t('sidebar.noFileOpen')}<br />
				<span class="text-fg-dim">{t('sidebar.createOrImportHint')}</span>
			</div>
		{:else if filteredFiles.length === 0}
			<div class="px-4 py-8 text-center text-xs text-fg-subtle">
				{t('sidebar.noFileWithTag')} <span class="font-mono">{activeTag}</span>.
			</div>
		{:else}
			{#if topSpacerHeight > 0}
				<div style:height={`${topSpacerHeight}px`} aria-hidden="true"></div>
			{/if}
			<ul bind:this={fileList} class="flex flex-col" aria-label={t('sidebar.openFilesReorderHint')}>
				{#each visibleFiles as file, fileIndex (file.id)}
					{@const isActive = file.id === filesStore.activeId}
					{@const dirtyHint = file.dirty ? t('sidebar.unexportedChangesHint') : ''}
					{@const label = filesStore.displayTitle(file.id)}
					{@const isSelected = filesStore.selectedIds.has(file.id)}
					<li
						aria-posinset={visibleStart + fileIndex + 1}
						aria-setsize={filteredFiles.length}
						class="mdsh-file-row group relative flex items-stretch transition-colors
						       before:pointer-events-none before:absolute before:left-0 before:top-0 before:bottom-0
						       before:w-0.5 before:bg-accent before:opacity-0 before:transition-opacity"
						class:bg-bg-2={isActive || dragOverId === file.id}
						class:opacity-50={draggingId === file.id}
						class:before:opacity-100={isActive}
						draggable="true"
						ondragstart={(e) => onDragStart(e, file.id)}
						ondragover={(e) => onDragOver(e, file.id)}
						ondrop={(e) => onDrop(e, file.id)}
						ondragend={onDragEnd}
						ondragleave={() => (dragOverId = null)}
					>
						<span
							class="flex w-4 flex-shrink-0 cursor-grab items-center justify-center text-fg-dim
							       opacity-0 transition group-hover:opacity-100 active:cursor-grabbing"
							aria-hidden="true"
						>
							<GripVertical size={12} />
						</span>
						<button
							class="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left text-sm
							       transition-colors hover:bg-bg-2"
							class:bg-bg-3={isSelected}
							class:text-fg={isActive || isSelected}
							class:text-fg-muted={!isActive && !isSelected}
							onclick={(e) => handleSelect(e, file.id)}
							onkeydown={(e) => handleFileKey(e, file.id)}
							data-file-id={file.id}
							aria-label={`${label}${dirtyHint}${file.relativePath ? ` (${file.relativePath})` : ''}${isSelected ? t('sidebar.selectedSuffix') : ''}${file.brokenLink ? '. ' + t('sidebar.brokenDiskLink') : ''}`}
							aria-pressed={isSelected}
							aria-current={isActive ? 'true' : undefined}
						>
							<span class="flex-shrink-0" aria-hidden="true">
								{#if file.dirty}
									<Circle size={8} class="fill-accent text-accent" />
								{:else}
									<Circle size={8} class="text-fg-dim" />
								{/if}
							</span>
							<span class="min-w-0 flex-1">
								<span class="block truncate">{label}</span>
								{#if file.relativePath}<span class="block truncate text-xs text-fg-dim"
										>{file.relativePath}</span
									>{/if}
							</span>
							{#if file.brokenLink}
								<!-- §6.9 - "Broken disk link" badge: visually warns that the
								     FSA handle no longer resolves. Relinking action via DiskLinksPanel
								     or ⌘⇧S (which sets a new handle). -->
								<span
									class="flex-shrink-0 text-warning"
									title={t('sidebar.brokenDiskLinkHint')}
									aria-label={t('sidebar.brokenDiskLink')}
								>
									<AlertTriangle size={10} />
								</span>
							{/if}
							{#if file.dirty}
								<span class="sr-only">{t('sidebar.notExported')}</span>
							{/if}
						</button>
						<button
							class="flex flex-shrink-0 items-center rounded p-1 text-fg-dim opacity-0 transition
							       hover:bg-bg-3 hover:text-fg group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 mr-2 my-1"
							onclick={() => handleClose(file.id)}
							aria-label={t('sidebar.closeFile', { label })}
							title={t('sidebar.closeWithShortcut', {
								shortcut: keyboardStore.label('close-file') ?? ''
							})}
						>
							<X size={12} />
						</button>
					</li>
				{/each}
			</ul>
			{#if bottomSpacerHeight > 0}
				<div style:height={`${bottomSpacerHeight}px`} aria-hidden="true"></div>
			{/if}
		{/if}
	</div>

	{#if filesStore.active}
		<details class="border-t border-border px-3 py-2 text-xs">
			<summary class="cursor-pointer text-fg">{t('sidebar.fileActions')}</summary>
			<div class="flex flex-wrap gap-2 pt-2">
				<button
					class="rounded border border-border p-2"
					disabled={filesStore.files[0]?.id === filesStore.activeId}
					onclick={() => moveFile(filesStore.activeId!, -1)}
					aria-label={t('sidebar.moveUp')}><ArrowUp size={16} /></button
				>
				<button
					class="rounded border border-border p-2"
					disabled={filesStore.files.at(-1)?.id === filesStore.activeId}
					onclick={() => moveFile(filesStore.activeId!, 1)}
					aria-label={t('sidebar.moveDown')}><ArrowDown size={16} /></button
				>
				<button
					class="rounded border border-border p-2 text-danger"
					onclick={() => void deleteFile(filesStore.activeId!)}>{t('palette.deleteFile')}</button
				>
			</div>
		</details>
	{/if}
	{#if filesStore.closedFiles.length > 0}
		<details class="max-h-48 overflow-y-auto border-t border-border px-3 py-2 text-xs">
			<summary class="cursor-pointer text-fg"
				>{t('sidebar.closedFiles')} ({filesStore.closedFiles.length})</summary
			>
			{#each filesStore.closedFiles as file (file.id)}
				<button
					class="block w-full truncate py-2 text-left"
					onclick={() => {
						filesStore.reopen(file.id);
						if (isMobile) onClose();
					}}>{file.name}</button
				>
			{/each}
		</details>
	{/if}
	{#if filesStore.trash.length > 0}
		<TrashPanel onEmpty={() => (libraryButton ?? closeButton)?.focus()} />
	{/if}

	<!-- §5.2 - Backlinks: files pointing to the active file via [[...]].
	     Shown only if at least one backlink exists, to avoid cluttering
	     the UI when the corpus does not use wiki-links. -->
	{#if backlinks.length > 0}
		<nav class="border-t border-border px-2 py-2" aria-label={t('sidebar.backlinks')}>
			<div
				class="flex items-center gap-1 px-2 pb-1 text-[11px] uppercase tracking-wide text-fg-dim"
			>
				<CornerDownLeft size={11} aria-hidden="true" />
				<span>{t('sidebar.backlinksCount', { n: backlinks.length })}</span>
			</div>
			<ul class="flex flex-col">
				{#each backlinks as bf (bf.id)}
					<li>
						<button
							type="button"
							class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs
							       text-fg-muted transition-colors hover:bg-bg-2 hover:text-fg"
							onclick={() => selectFile(bf.id)}
							aria-label={t('sidebar.openFile', { title: filesStore.displayTitle(bf.id) })}
						>
							<span class="truncate">{filesStore.displayTitle(bf.id)}</span>
						</button>
					</li>
				{/each}
			</ul>
		</nav>
	{/if}

	<!-- Bottom actions -->
	<div class="border-t border-border px-2 py-2">
		<button
			class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-fg
			       transition-colors hover:bg-bg-2 hover:text-fg"
			onclick={handleNewFromSidebar}
			aria-label={t('sidebar.newFileWithShortcut', { shortcut: keyboardStore.label('new') ?? '' })}
		>
			<FilePlus size={14} />
			<span>{t('sidebar.newFile')}</span>
			<kbd class="ml-auto text-[10px] text-fg-dim" aria-hidden="true"
				>{keyboardStore.label('new') ?? ''}</kbd
			>
		</button>
		<button
			class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-fg
			       transition-colors hover:bg-bg-2 hover:text-fg"
			onclick={() => void handleImportFromSidebar()}
			aria-label={t('sidebar.importFileWithShortcut', {
				shortcut: keyboardStore.label('import') ?? ''
			})}
		>
			<Upload size={14} />
			<span>{t('sidebar.importMd')}</span>
			<kbd class="ml-auto text-[10px] text-fg-dim" aria-hidden="true"
				>{keyboardStore.label('import') ?? ''}</kbd
			>
		</button>
	</div>
</aside>

<style>
	.mdsh-sidebar {
		box-shadow: 16px 0 48px rgba(0, 0, 0, 0.12);
	}
	@media (min-width: 768px) {
		.mdsh-sidebar[inert] {
			display: none;
		}
	}
	.mdsh-sidebar-head {
		position: relative;
		background: color-mix(in oklab, var(--color-bg-1) 94%, var(--color-accent));
	}
	.mdsh-sidebar-head::after {
		content: '';
		position: absolute;
		left: 0;
		bottom: -1px;
		width: 72px;
		height: 1px;
		background: var(--color-accent);
	}
	.mdsh-sidebar-brand {
		display: flex;
		min-width: 0;
		width: 7rem;
		flex-direction: column;
		gap: 0.125rem;
	}
	.mdsh-sidebar-label {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		line-height: 1.2;
		letter-spacing: 0.04em;
		color: var(--color-fg-muted);
	}
	.mdsh-tag {
		border: 1px solid var(--color-border);
		border-radius: 0;
	}
	.mdsh-file-row[class*='bg-bg-2'] {
		clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%);
	}
</style>
