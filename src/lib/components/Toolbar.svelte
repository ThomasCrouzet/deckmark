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
		HardDriveDownload,
		Printer,
		Moon,
		Sun,
		Save,
		Copy,
		Link2
	} from '@lucide/svelte';
	import type { EditMode } from '#lib/types.js';
	import type { DocumentKind } from '#lib/document-kind.js';
	import { isDiskLinkingAvailable } from '#lib/disk-sync.js';
	import { keyboardStore } from '#lib/ui/keyboard.svelte.js';
	import { themeStore } from '#lib/ui/theme.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import { offlineState } from '#lib/ui/offline.svelte.js';
	import FileStatusBadge from './FileStatusBadge.svelte';

	interface Props {
		kind?: DocumentKind;
		mode: EditMode;
		sidebarOpen: boolean;
		onToggleSidebar: () => void;
		onSetMode: (mode: EditMode) => void;
		onExport: () => void;
		onExportPDF: () => void;
		onOpenPalette: () => void;
		onSave: () => void;
		onSaveAs: () => void;
		onEditCopy: () => void;
		onEditOriginal: () => void;
		onSaveToDisk: () => void;
		onOpenActions?: () => void;
		focusMode?: boolean;
		onToggleFocus?: () => void;
	}

	let {
		kind = 'note',
		mode,
		sidebarOpen,
		onToggleSidebar,
		onSetMode,
		onExport,
		onExportPDF,
		onOpenPalette,
		onSave,
		onSaveAs,
		onEditCopy,
		onEditOriginal,
		onSaveToDisk,
		onOpenActions,
		focusMode = false,
		onToggleFocus
	}: Props = $props();

	let nameInput = $state<HTMLInputElement | null>(null);
	let modeGroup = $state<HTMLDivElement | null>(null);
	const diskLinkingAvailable = isDiskLinkingAvailable();
	const editModeKey = $derived(
		filesStore.active?.linkedToDisk
			? 'editing.original'
			: filesStore.active?.origin === 'imported'
				? 'editing.copy'
				: 'editing.draft'
	);
	const editModeValue = $derived(
		filesStore.active?.linkedToDisk
			? 'in-place'
			: filesStore.active?.origin === 'imported'
				? 'copy'
				: 'draft'
	);

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
		return name.replace(/\.[a-z0-9]{1,10}$/i, '');
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
	class="mdsh-toolbar flex-shrink-0 border-b border-border bg-bg"
	data-kind={kind}
	aria-label={t('toolbar.toolbarLabel')}
>
	<div class="toolbar-layout">
		<button
			class="mdsh-icon-button flex items-center justify-center rounded p-2.5 sm:p-2 text-fg-muted md:hidden"
			onclick={onToggleSidebar}
			aria-label={t('toolbar.menu')}
			aria-expanded={sidebarOpen}
			aria-controls="files-panel"
		>
			<Menu size={18} />
			<span class="sidebar-label ml-1 text-xs">{t('documents.files')}</span>
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
			<span class="sidebar-label ml-1 text-xs">{t('documents.files')}</span>
		</button>

		<!-- File name -->
		<div class="document-title flex min-w-0 flex-1 items-center gap-1">
			{#if filesStore.active}
				<div class="document-identity">
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
						class="w-full min-w-0 text-ellipsis rounded border border-transparent bg-transparent px-2 py-1 text-sm
				       font-medium text-fg outline-none transition-colors focus:border-border focus:bg-bg-1
				       hover:border-border focus:text-clip"
						class:border-accent={renameSuccess}
						placeholder={t('toolbar.untitled')}
						title={stripExt(filesStore.active.name)}
						spellcheck="false"
						aria-label={t('toolbar.fileNameLabel')}
					/>
					<div class="document-meta">
						<span data-testid="document-kind" class="type-badge"
							>{t(
								kind === 'note'
									? 'documents.note'
									: kind === 'presentation'
										? 'documents.presentation'
										: kind === 'code'
											? 'documents.code'
											: kind === 'image'
												? 'documents.image'
												: 'documents.pdf'
							)}</span
						>
						<span class="title-save" role="status"
							>{filesStore.saveErrorIds.includes(filesStore.active.id)
								? t('statusBar.saveFailed')
								: filesStore.hasPendingSave
									? t('statusBar.saving')
									: t('stats.saved')}</span
						>
						<span
							class="edit-mode-label"
							data-testid="disk-edit-mode"
							data-mode={editModeValue}
							title={t(editModeKey)}
							aria-label={`${t('editing.status')}: ${t(editModeKey)}`}>{t(editModeKey)}</span
						>
						<FileStatusBadge file={filesStore.active} showLabel />
					</div>
				</div>
				<button
					class="secondary-action mdsh-icon-button flex items-center justify-center rounded p-2 text-fg-muted
				       hover:bg-bg-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted"
					onclick={onEditCopy}
					disabled={!filesStore.active}
					title={t('palette.editCopy')}
					aria-label={t('palette.editCopy')}
					data-testid="edit-copy"
				>
					<Copy size={16} />
				</button>
				{#if diskLinkingAvailable || filesStore.active.sourceFileId}
					<button
						class="secondary-action mdsh-icon-button flex items-center justify-center rounded p-2 text-fg-muted
					       hover:bg-bg-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted"
						onclick={onEditOriginal}
						disabled={!filesStore.active}
						title={t('palette.editOriginal')}
						aria-label={t('palette.editOriginal')}
						data-testid="edit-original"
					>
						<Link2 size={16} />
					</button>
				{/if}
			{:else}
				<span class="hidden px-2 text-sm text-fg-dim sm:inline">{t('toolbar.noFileOpen')}</span>
			{/if}
		</div>

		<!-- Mode toggle - radiogroup semantics (3 exclusive modes) with
	     Arrow / Home / End navigation per the ARIA Authoring Practices. -->
		{#if kind === 'note'}<div
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
					<Pencil size={14} /><span class="ml-1">{t('toolbar.modeEdit')}</span>
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
					<Code2 size={14} /><span class="ml-1">{t('toolbar.modeSource')}</span>
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
					<Eye size={14} /><span class="ml-1">{t('toolbar.modeRead')}</span>
				</button>
			</div>{/if}

		<!-- Focus is a reading action: the control exists only while Read is active. -->
		{#if kind === 'note' && mode === 'read' && onToggleFocus}
			<button
				class="focus-action mdsh-icon-button flex items-center justify-center rounded p-2"
				class:text-accent={focusMode}
				class:text-fg-muted={!focusMode}
				onclick={onToggleFocus}
				title={focusMode ? t('palette.disableFocusMode') : t('palette.enableFocusMode')}
				aria-label={focusMode ? t('palette.disableFocusMode') : t('palette.enableFocusMode')}
				aria-pressed={focusMode}
				data-testid="focus-toggle"
			>
				<Eye size={16} /><span class="ml-1 hidden text-xs sm:inline">{t('toolbar.focus')}</span>
			</button>
		{/if}

		<!-- Direct theme action. Settings keeps the full system/light/dark choice;
	     this button stores an explicit light or dark override. -->
		<button
			class="theme-action mdsh-icon-button flex items-center justify-center rounded p-2 text-fg-muted
		       hover:bg-bg-2 hover:text-fg"
			onclick={() => themeStore.set(themeStore.effective === 'dark' ? 'light' : 'dark')}
			title={themeStore.effective === 'dark'
				? t('toolbar.switchToLight')
				: t('toolbar.switchToDark')}
			aria-label={themeStore.effective === 'dark'
				? t('toolbar.switchToLight')
				: t('toolbar.switchToDark')}
			data-testid="theme-toggle"
		>
			{#if themeStore.effective === 'dark'}
				<Sun size={16} />
			{:else}
				<Moon size={16} />
			{/if}
		</button>

		<span class="mdsh-local-indicator" role="status"
			>{t(
				offlineState.status === 'ready'
					? 'pwa.ready'
					: offlineState.status === 'preparing'
						? 'pwa.preparing'
						: 'pwa.unavailable'
			)}</span
		>

		<button
			class="save-action mdsh-icon-button ml-1 hidden items-center justify-center rounded p-2 text-fg-muted sm:flex
		       hover:bg-bg-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted"
			onclick={onSave}
			disabled={!filesStore.active}
			title={`${t('toolbar.save')} (${keyboardStore.label('save') ?? ''})`}
			aria-label={t('toolbar.save')}
			aria-keyshortcuts={keyboardStore.aria('save')}
			data-testid="save-document"
		>
			<Save size={16} />
		</button>

		<button
			class="secondary-action mdsh-icon-button hidden items-center justify-center rounded p-2 text-fg-muted sm:flex
		       hover:bg-bg-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted"
			onclick={onSaveAs}
			disabled={!filesStore.active}
			title={`${t('toolbar.saveAs')} (${keyboardStore.label('save-as') ?? ''})`}
			aria-label={t('toolbar.saveAs')}
			aria-keyshortcuts={keyboardStore.aria('save-as')}
			data-testid="save-as"
		>
			<Download size={16} />
		</button>

		{#if diskLinkingAvailable}
			<button
				class="secondary-action mdsh-icon-button hidden items-center justify-center rounded p-2 text-fg-muted sm:flex
			       hover:bg-bg-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted"
				onclick={onSaveToDisk}
				disabled={!filesStore.active}
				title={t('toolbar.saveToDisk')}
				aria-label={t('toolbar.saveToDisk')}
				data-testid="save-to-disk"
			>
				<HardDriveDownload size={16} />
			</button>
		{/if}

		<!-- §B2.3 - `aria-keyshortcuts` announces the shortcuts to SRs (the `title=`
	     is for the sighted eye). ARIA format: "Control+B Meta+B" - Meta
	     covers macOS, Control the rest. -->
		{#if kind !== 'presentation'}<button
				class="secondary-action mdsh-icon-button hidden items-center justify-center rounded p-2.5 sm:flex sm:p-2 text-fg-muted
		       hover:bg-bg-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted"
				onclick={onExport}
				disabled={!filesStore.active}
				title={`${t('toolbar.export')} (${keyboardStore.label('export-md') ?? ''})`}
				aria-label={t('toolbar.export')}
				aria-keyshortcuts={keyboardStore.aria('export-md')}
			>
				<Download size={16} />
			</button>

			{#if kind === 'note'}
				<button
					class="secondary-action mdsh-icon-button hidden items-center justify-center rounded p-2.5 sm:flex sm:p-2 text-fg-muted
		       hover:bg-bg-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted"
					onclick={onExportPDF}
					disabled={!filesStore.active}
					title={`${t('toolbar.exportPdf')} (${keyboardStore.label('export-pdf') ?? ''})`}
					aria-label={t('toolbar.exportPdf')}
					aria-keyshortcuts={keyboardStore.aria('export-pdf')}
				>
					<Printer size={16} />
				</button>
			{/if}
		{/if}

		{#if onOpenActions}
			<button
				class="actions-trigger mdsh-icon-button flex items-center justify-center gap-1.5 rounded px-2 text-fg-muted"
				onclick={(event) => {
					event.currentTarget.focus({ preventScroll: true });
					onOpenActions?.();
				}}
				data-actions-trigger
				title={t('actions.title')}
				aria-label={t('actions.title')}
				><Ellipsis size={18} /><span class="text-xs font-medium">{t('actions.title')}</span></button
			>
		{/if}
		<button
			class="palette-trigger mdsh-icon-button flex items-center justify-center gap-1.5 rounded px-2 text-fg-muted"
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
	</div>
</header>

<style>
	#app-toolbar {
		container-type: inline-size;
	}
	.toolbar-layout {
		display: flex;
		align-items: center;
		gap: 4px;
		min-height: 51px;
		padding: 4px 8px;
	}
	.document-title {
		flex: 1 1 12rem;
		min-width: 10rem;
	}
	.document-identity {
		position: relative;
		flex: 1;
		min-width: 160px;
	}
	.document-title input {
		display: block;
		width: 100%;
		height: 24px;
		padding: 0 6px;
		font-size: 13px;
		line-height: 22px;
	}
	.document-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 16px;
		padding-inline: 7px;
		white-space: nowrap;
	}
	#app-toolbar button {
		min-width: 36px;
		min-height: 36px;
		height: 36px;
		padding: 6px;
		border-radius: 6px;
		flex-shrink: 0;
	}
	#app-toolbar .mdsh-icon-button > span,
	.edit-mode-label {
		display: none;
	}
	.mdsh-mode-switch {
		flex-shrink: 0;
		margin: 0 6px;
		font-size: 12px;
	}
	#app-toolbar .mdsh-mode-switch button {
		min-height: 32px;
		height: 32px;
		padding-inline: 10px;
	}
	.type-badge {
		flex: none;
		font-size: 10px;
		color: var(--color-fg-dim);
	}
	.title-save {
		flex: none;
		font-size: 10px;
		color: var(--color-fg-muted);
	}
	.document-meta :global(.file-status) {
		border: 0;
		padding: 0;
		font-size: 10px;
	}
	.mdsh-local-indicator {
		display: none;
		flex: none;
		align-items: center;
		gap: 6px;
		color: var(--color-fg-dim);
		padding-inline: 8px;
		font-family: inherit;
		font-size: 10px;
		letter-spacing: 0;
		white-space: nowrap;
	}
	@container (min-width: 1000px) {
		.mdsh-local-indicator {
			display: flex;
		}
	}
	@container (max-width: 999px) {
		#app-toolbar .secondary-action {
			display: none;
		}
	}
	@container (max-width: 719px) {
		.toolbar-layout {
			display: grid;
			grid-template-columns: 44px minmax(0, 1fr) 44px 44px;
			gap: 2px 4px;
			padding: 3px 6px;
		}
		.document-title {
			grid-column: 2;
			grid-row: 1;
			min-width: 0;
		}
		.document-identity {
			min-width: 0;
		}
		.document-title input {
			height: 44px;
			padding-right: 24px;
			font-size: 14px;
		}
		.document-meta {
			position: absolute;
			right: 4px;
			top: 14px;
			padding: 0;
		}
		.document-meta > span {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
		}
		.document-meta :global(.file-status-label) {
			display: none;
		}
		#app-toolbar button,
		#app-toolbar .mdsh-mode-switch button {
			min-width: 44px;
			min-height: 44px;
			height: 44px;
		}
		.actions-trigger {
			grid-column: 3;
			grid-row: 1;
		}
		.palette-trigger {
			grid-column: 4;
			grid-row: 1;
		}
		.mdsh-mode-switch {
			grid-column: 1 / 4;
			grid-row: 2;
			margin: 0;
			padding: 0;
		}
		#app-toolbar .mdsh-mode-switch button {
			flex: 1;
			padding-inline: 5px;
		}
		.mdsh-mode-switch :global(svg) {
			display: none;
		}
		#app-toolbar .mdsh-mode-switch span {
			margin: 0;
		}
		.toolbar-layout:has(.focus-action) .mdsh-mode-switch {
			grid-column-end: 3;
		}
		.focus-action {
			grid-column: 3;
			grid-row: 2;
		}
		.theme-action {
			grid-column: 4;
			grid-row: 2;
		}
		#app-toolbar .save-action,
		#app-toolbar:not([data-kind='note']) .theme-action {
			display: none;
		}
	}
	@media (pointer: coarse) {
		.mdsh-mode-switch {
			padding: 0;
		}
		@container (max-width: 1199px) {
			.mdsh-local-indicator {
				display: none;
			}
		}
		#app-toolbar button,
		#app-toolbar .mdsh-mode-switch button,
		.document-title input {
			min-height: 44px;
			height: 44px;
			min-width: 44px;
		}
		.document-meta {
			position: absolute;
			right: 4px;
			top: 14px;
			padding: 0;
		}
		.document-meta > span {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
		}
		.document-meta :global(.file-status-label) {
			display: none;
		}
		.document-title input {
			padding-right: 24px;
			font-size: 16px;
		}
	}
	@container (max-width: 239px) {
		.toolbar-layout {
			grid-template-columns: 44px minmax(64px, 1fr);
		}
		.actions-trigger,
		.palette-trigger {
			grid-row: 2;
		}
		.actions-trigger {
			grid-column: 1;
		}
		.palette-trigger {
			grid-column: 2;
		}
		.mdsh-mode-switch,
		.toolbar-layout:has(.focus-action) .mdsh-mode-switch {
			grid-row: 3;
			grid-column: 1 / -1;
		}
		#app-toolbar .theme-action,
		#app-toolbar .focus-action {
			display: none;
		}
	}
</style>
