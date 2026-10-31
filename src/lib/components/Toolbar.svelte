<script lang="ts">
	import { filesStore } from '#lib/files.svelte.js';
	import {
		Menu,
		Download,
		Eye,
		Pencil,
		Code2,
		Keyboard,
		Ellipsis,
		HardDrive,
		HardDriveDownload,
		Printer,
		Presentation
	} from '@lucide/svelte';
	import type { EditMode } from '#lib/types.js';
	import { isDiskLinkingAvailable } from '#lib/disk-sync.js';
	import { keyboardStore } from '#lib/ui/keyboard.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import { offlineState } from '#lib/ui/offline.svelte.js';

	interface Props {
		mode: EditMode;
		sidebarOpen: boolean;
		onToggleSidebar: () => void;
		onSetMode: (mode: EditMode) => void;
		onExport: () => void;
		onExportPDF: () => void;
		onOpenPalette: () => void;
		onSaveToDisk: () => void;
		onOpenActions?: () => void;
		onOpenPresentation?: () => void;
	}

	let {
		mode,
		sidebarOpen,
		onToggleSidebar,
		onSetMode,
		onExport,
		onExportPDF,
		onOpenPalette,
		onSaveToDisk,
		onOpenActions,
		onOpenPresentation
	}: Props = $props();

	let nameInput = $state<HTMLInputElement | null>(null);
	let modeGroup = $state<HTMLDivElement | null>(null);
	const diskLinkingAvailable = isDiskLinkingAvailable();

	// §B1.7 / B1.8 / B3.5 - Rename input:
	//   - `renameDraft` allows canceling with Esc by reverting to the pre-edit state.
	//   - `renameSuccess` flashes 800 ms after blur to confirm acknowledgment
	//     (silent UX otherwise: no feedback that the name was actually saved).
	let renameSnapshot: { id: string; name: string } | null = null;
	let renameBusy = $state(false);
	let renameSuccess = $state(false);
	let renameSuccessTimer: ReturnType<typeof setTimeout> | null = null;

	function handleRenameFocus() {
		// Snapshot of the current name to allow canceling via Esc.
		const active = filesStore.active;
		renameSnapshot = active ? { id: active.id, name: stripExt(active.name) } : null;
	}

	async function handleRenameBlur(event: FocusEvent) {
		const input = event.currentTarget as HTMLInputElement;
		const snapshot = renameSnapshot;
		renameSnapshot = null;
		if (!snapshot || input.value === snapshot.name) return;
		renameBusy = true;
		const renamed = await filesStore.rename(snapshot.id, input.value);
		renameBusy = false;
		if (filesStore.active?.id !== snapshot.id) return;
		input.value = stripExt(filesStore.active.name);
		if (renamed) {
			renameSuccess = true;
			if (renameSuccessTimer) clearTimeout(renameSuccessTimer);
			renameSuccessTimer = setTimeout(() => {
				renameSuccess = false;
				renameSuccessTimer = null;
			}, 800);
		}
	}

	function stripExt(name: string) {
		return name.replace(/\.(md|markdown|mdx|txt)$/i, '');
	}

	function handleNameKey(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			(e.currentTarget as HTMLInputElement).blur();
		} else if (e.key === 'Escape') {
			// §B1.8 - Esc cancels the current edit: restores the pre-focus name
			// then blurs. Without it, the user had to retype the old name.
			e.preventDefault();
			const input = e.currentTarget as HTMLInputElement;
			if (renameSnapshot !== null) {
				input.value = renameSnapshot.name;
			}
			renameSnapshot = null; // avoids the success flash on blur
			input.blur();
		}
	}

	// Arrow keyboard navigation within the mode radiogroup (ARIA Authoring
	// Practices: Tab enters/exits, Arrow moves within the group).
	const MODE_ORDER: readonly EditMode[] = ['wysiwyg', 'source', 'read'];

	function handleModeKey(e: KeyboardEvent) {
		const idx = MODE_ORDER.indexOf(mode);
		let next: number;
		if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
			next = (idx + 1) % MODE_ORDER.length;
		} else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
			next = (idx - 1 + MODE_ORDER.length) % MODE_ORDER.length;
		} else if (e.key === 'Home') {
			next = 0;
		} else if (e.key === 'End') {
			next = MODE_ORDER.length - 1;
		} else {
			return;
		}
		e.preventDefault();
		// invariant: next is computed via modulo on MODE_ORDER.length → always within bounds.
		const nextMode = MODE_ORDER[next]!;
		onSetMode(nextMode);
		// Move focus to the activated radio (ARIA radiogroup pattern).
		const btn = modeGroup?.querySelector<HTMLButtonElement>(`button[data-mode="${nextMode}"]`);
		btn?.focus();
	}
</script>

<header
	id="app-toolbar"
	class="mdsh-toolbar flex min-h-12 flex-shrink-0 items-center gap-1 border-b border-border bg-bg px-2 md:px-3"
	aria-label={t('toolbar.toolbarLabel')}
>
	<button
		class="mdsh-icon-button flex items-center justify-center rounded p-2.5 sm:p-2 text-fg-muted md:hidden"
		onclick={onToggleSidebar}
		aria-label={t('toolbar.menu')}
		aria-expanded={sidebarOpen}
		aria-controls="files-panel"
	>
		<Menu size={18} />
	</button>

	<button
		class="mdsh-icon-button hidden items-center justify-center rounded p-2 text-fg-muted md:flex"
		onclick={onToggleSidebar}
		aria-label={t('toolbar.togglePanel')}
		aria-keyshortcuts={keyboardStore.aria('sidebar')}
		aria-expanded={sidebarOpen}
		aria-controls="files-panel"
		title={`${t('toolbar.panel')} (${keyboardStore.label('sidebar') ?? ''})`}
	>
		<Menu size={16} />
	</button>

	<!-- File name -->
	<div class="flex min-w-0 max-w-28 flex-1 items-center gap-1 sm:max-w-none">
		{#if filesStore.active}
			<!-- §B1.7 - Visible focus border to signal that the input is editable.
			     §B3.5 - Accent success flash 800 ms after blur if rename was effective. -->
			<input
				bind:this={nameInput}
				type="text"
				value={stripExt(filesStore.active.name)}
				disabled={renameBusy}
				onfocus={handleRenameFocus}
				onblur={handleRenameBlur}
				onkeydown={handleNameKey}
				class="w-full min-w-0 rounded border border-transparent bg-transparent px-2 py-1 text-sm
				       font-medium text-fg outline-none transition-colors focus:border-border focus:bg-bg-1
				       hover:border-border"
				class:border-accent={renameSuccess}
				placeholder={t('toolbar.untitled')}
				spellcheck="false"
				aria-label={t('toolbar.fileNameLabel')}
			/>
			{#if filesStore.active.linkedToDisk}
				<span
					class="flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5
					       text-[10px] font-medium text-accent"
					title={t('toolbar.linkedToDisk')}
				>
					<HardDrive size={10} />
					<span class="hidden sm:inline">{t('toolbar.linked')}</span>
				</span>
			{/if}
			{#if filesStore.active.dirty}
				<span
					class="hidden text-[10px] text-fg-dim sm:inline"
					title={t('toolbar.notExported')}
					aria-label={t('toolbar.unexportedChanges')}
					role="status"
				>
					<span aria-hidden="true">●</span>
				</span>
			{/if}
		{:else}
			<span class="hidden px-2 text-sm text-fg-dim sm:inline">{t('toolbar.noFileOpen')}</span>
		{/if}
	</div>

	<!-- Mode toggle - radiogroup semantics (3 exclusive modes) with
	     Arrow / Home / End navigation per the ARIA Authoring Practices. -->
	<div
		bind:this={modeGroup}
		class="mdsh-mode-switch ml-auto flex items-center border border-border bg-bg-1 p-0.5 text-fg-muted min-[520px]:ml-1"
		role="radiogroup"
		aria-label={t('toolbar.editMode')}
		tabindex="-1"
		onkeydown={handleModeKey}
	>
		<button
			class="flex items-center justify-center rounded px-2 py-1 transition"
			class:bg-bg-3={mode === 'wysiwyg'}
			class:text-fg={mode === 'wysiwyg'}
			onclick={() => onSetMode('wysiwyg')}
			title={`${t('toolbar.wysiwygEdit')} (${keyboardStore.label('mode-wysiwyg') ?? ''})`}
			aria-label={t('toolbar.wysiwygMode')}
			aria-keyshortcuts={keyboardStore.aria('mode-wysiwyg')}
			role="radio"
			aria-checked={mode === 'wysiwyg'}
			tabindex={mode === 'wysiwyg' ? 0 : -1}
			data-mode="wysiwyg"
		>
			<Pencil size={14} /><span class="ml-1 hidden lg:inline">{t('toolbar.modeEdit')}</span>
		</button>
		<button
			class="flex items-center justify-center rounded px-2 py-1 transition"
			class:bg-bg-3={mode === 'source'}
			class:text-fg={mode === 'source'}
			onclick={() => onSetMode('source')}
			title={`${t('toolbar.sourceMarkdown')} (${keyboardStore.label('mode-source') ?? ''})`}
			aria-label={t('toolbar.sourceMode')}
			aria-keyshortcuts={keyboardStore.aria('mode-source')}
			role="radio"
			aria-checked={mode === 'source'}
			tabindex={mode === 'source' ? 0 : -1}
			data-mode="source"
		>
			<Code2 size={14} /><span class="ml-1 hidden lg:inline">{t('toolbar.modeSource')}</span>
		</button>
		<button
			class="flex items-center justify-center rounded px-2 py-1 transition"
			class:bg-bg-3={mode === 'read'}
			class:text-fg={mode === 'read'}
			onclick={() => onSetMode('read')}
			title={`${t('toolbar.reading')} (${keyboardStore.label('mode-read') ?? ''})`}
			aria-label={t('toolbar.readingMode')}
			aria-keyshortcuts={keyboardStore.aria('mode-read')}
			role="radio"
			aria-checked={mode === 'read'}
			tabindex={mode === 'read' ? 0 : -1}
			data-mode="read"
		>
			<Eye size={14} /><span class="ml-1 hidden lg:inline">{t('toolbar.modeRead')}</span>
		</button>
	</div>

	{#if onOpenPresentation}
		<button
			class="mdsh-icon-button flex items-center justify-center rounded p-2 text-fg-muted"
			onclick={(event) => {
				event.currentTarget.focus({ preventScroll: true });
				onOpenPresentation?.();
			}}
			data-testid="slides-open"
			aria-label={t('slides.open')}
			title={t('slides.open')}
		>
			<Presentation size={17} />
		</button>
	{/if}

	<span class="mdsh-local-indicator" role="status"
		>{t(
			offlineState.status === 'ready'
				? 'pwa.ready'
				: offlineState.status === 'preparing'
					? 'pwa.preparing'
					: 'pwa.unavailable'
		)}</span
	>

	{#if diskLinkingAvailable}
		<button
			class="mdsh-icon-button ml-1 hidden items-center justify-center rounded p-2 text-fg-muted sm:flex
			       hover:bg-bg-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted"
			onclick={onSaveToDisk}
			disabled={!filesStore.active}
			title={`${t('toolbar.saveToDisk')} (${keyboardStore.label('save-disk') ?? ''})`}
			aria-label={t('toolbar.saveToDisk')}
			aria-keyshortcuts={keyboardStore.aria('save-disk')}
		>
			<HardDriveDownload size={16} />
		</button>
	{/if}

	<!-- §B2.3 - `aria-keyshortcuts` announces the shortcuts to SRs (the `title=`
	     is for the sighted eye). ARIA format: "Control+B Meta+B" - Meta
	     covers macOS, Control the rest. -->
	<button
		class="mdsh-icon-button hidden items-center justify-center rounded p-2.5 sm:flex sm:p-2 text-fg-muted
		       hover:bg-bg-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted"
		onclick={onExport}
		disabled={!filesStore.active}
		title={`${t('toolbar.export')} (${keyboardStore.label('export-md') ?? ''})`}
		aria-label={t('toolbar.export')}
		aria-keyshortcuts={keyboardStore.aria('export-md')}
	>
		<Download size={16} />
	</button>

	<button
		class="mdsh-icon-button hidden items-center justify-center rounded p-2.5 sm:flex sm:p-2 text-fg-muted
		       hover:bg-bg-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted"
		onclick={onExportPDF}
		disabled={!filesStore.active}
		title={`${t('toolbar.exportPdf')} (${keyboardStore.label('export-pdf') ?? ''})`}
		aria-label={t('toolbar.exportPdf')}
		aria-keyshortcuts={keyboardStore.aria('export-pdf')}
	>
		<Printer size={16} />
	</button>

	{#if onOpenActions}
		<button
			class="mdsh-icon-button flex min-h-10 items-center justify-center gap-1.5 rounded px-2 text-fg-muted"
			onclick={(event) => {
				event.currentTarget.focus({ preventScroll: true });
				onOpenActions?.();
			}}
			data-actions-trigger
			aria-label={t('actions.title')}
			><Ellipsis size={18} /><span class="text-xs font-medium">{t('actions.title')}</span></button
		>
	{/if}
	<button
		class="mdsh-icon-button flex min-h-10 items-center justify-center gap-1.5 rounded px-2 text-fg-muted"
		onclick={(event) => {
			event.currentTarget.focus({ preventScroll: true });
			onOpenPalette();
		}}
		title={`${t('toolbar.commandPalette')} (${keyboardStore.label('palette') ?? ''})`}
		aria-label={t('toolbar.commandPalette')}
		aria-keyshortcuts={keyboardStore.aria('palette')}
	>
		<Keyboard size={18} />
		<span class="hidden xl:inline text-xs font-medium">{t('actions.commands')}</span>
	</button>
</header>
