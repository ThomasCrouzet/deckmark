<script lang="ts">
	// §2.2 - Centralized settings panel.
	//
	// Groups in a single discoverable place the previously scattered preferences
	// (theme, editor width, focus/typewriter/TOC modes) + backup
	// management (§1.1). Lazy-loaded modal (cf. ui/modals), focus-trap, dark/light.
	//
	// The preference stores (theme/editorWidth/prefs) are injected as props
	// (runes factories from the parent). Backup directly calls the `backup`
	// service + reloads the stores - pattern identical to the other panels.

	import { tick } from 'svelte';
	import { browser } from '$app/env';
	import { t, i18n, LOCALES, LOCALE_LABELS } from '#lib/i18n/index.js';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { coreCommands } from '#lib/ui/commands.js';
	import { keyboardStore, type ShortcutError } from '#lib/ui/keyboard.svelte.js';
	import { formatKbd, isMac } from '#lib/platform.js';
	import { isDesktop } from '#lib/desktop.js';
	import { EDITOR, IMPORT_LIMITS } from '#lib/config.js';
	import { PRINT_PAGE, PRINT_TEXT_WIDTH_MM } from '#lib/render/print-geometry.js';
	import { readUtf8File } from '#lib/import-limits.js';
	import { notify } from '#lib/notify.svelte.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { workspaceStore } from '#lib/workspaces.svelte.js';
	import { templatesStore } from '#lib/templates.svelte.js';
	import {
		downloadBackup,
		restoreFromText,
		isEncryptedBackup,
		inspectBackupText,
		serializeBackup
	} from '#lib/services/backup.js';
	import { version } from '../../../package.json';
	import { offlineState } from '#lib/ui/offline.svelte.js';
	import type { TemplateRow } from '#lib/db.js';
	import { reportError } from '#lib/report.js';
	import { spinnerStore } from '#lib/spinner.svelte.js';
	import { themeStore } from '#lib/ui/theme.svelte.js';
	import {
		formatStorageBytes,
		getStorageHealth,
		recordBackupReminderShown,
		recordExternalBackupFailure,
		recordExternalBackupSuccess,
		type StorageHealth
	} from '#lib/storage.js';
	import type { createEditorWidth, EditorWidth } from '#lib/ui/editor-width.svelte.js';
	import type { createUiPrefs } from '#lib/ui/prefs.svelte.js';
	import type { ThemePref } from '#lib/theme.js';
	import { Settings, X, Download, Upload, Check, Lock } from '@lucide/svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
		editorWidth: ReturnType<typeof createEditorWidth>;
		prefs: ReturnType<typeof createUiPrefs>;
	}

	let { open, onClose, editorWidth, prefs }: Props = $props();

	let closeButton: HTMLButtonElement | null = $state(null);
	let importInput: HTMLInputElement | null = $state(null);
	let shortcutFeedback = $state('');
	function showShortcutResult(error: ShortcutError | null): void {
		shortcutFeedback = t(
			error === 'invalid'
				? 'settings.shortcutInvalid'
				: error === 'reserved'
					? 'settings.shortcutReserved'
					: error === 'duplicate'
						? 'settings.shortcutDuplicate'
						: error === 'storage'
							? 'settings.shortcutStorage'
							: 'settings.shortcutSaved'
		);
	}
	function captureShortcut(event: KeyboardEvent, id: string): void {
		if (event.key === 'Tab' || event.key === 'Escape' || event.isComposing) return;
		if (['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return;
		event.preventDefault();
		event.stopPropagation();

		if (
			!(event.ctrlKey || event.metaKey) ||
			(event.ctrlKey && event.metaKey) ||
			event.altKey ||
			event.repeat
		) {
			showShortcutResult('invalid');
			return;
		}
		showShortcutResult(
			keyboardStore.set(id, { key: event.key.toLowerCase(), shift: event.shiftKey })
		);
	}
	let storageHealth: StorageHealth | null = $state(null);
	let backupBusy = $state(false);
	let verifyOnly = false;
	let editingTemplate = $state<string | null>(null);
	let templateName = $state('');
	let templateContent = $state('');
	let templateBusy = $state(false);
	let templateSummary = $state<HTMLElement | null>(null);
	let templateNameInput = $state<HTMLInputElement | null>(null);
	function finishTemplateEdit() {
		editingTemplate = null;
		void tick().then(() => templateSummary?.focus());
	}
	function editTemplate(template: TemplateRow) {
		editingTemplate = template.id;
		templateName = template.name;
		templateContent = template.content;
		void tick().then(() => templateNameInput?.focus());
	}
	async function saveTemplate() {
		if (!editingTemplate || templateBusy) return;
		templateBusy = true;
		try {
			if (await templatesStore.update(editingTemplate, templateName, templateContent))
				finishTemplateEdit();
		} finally {
			templateBusy = false;
		}
	}
	async function deleteTemplate(id: string) {
		if (await promptStore.confirm({ title: t('templates.deleteConfirm'), danger: true })) {
			await templatesStore.delete(id);
			await tick();
			templateSummary?.focus();
		}
	}
	async function runBackupAction(action: () => Promise<void>) {
		if (backupBusy) return;
		backupBusy = true;
		try {
			await action();
		} finally {
			backupBusy = false;
		}
	}
	function chooseBackup(verify: boolean) {
		if (backupBusy) return;
		verifyOnly = verify;
		importInput?.click();
	}

	async function refreshStorageHealth(): Promise<void> {
		storageHealth = await getStorageHealth();
		if (storageHealth.backupReminderDue) recordBackupReminderShown();
	}

	function formatBackupDate(value: number): string {
		return new Intl.DateTimeFormat(i18n.locale, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(value);
	}

	$effect(() => {
		if (!open || !browser) return;
		tick().then(() => closeButton?.focus());
		void refreshStorageHealth();
		void templatesStore
			.load()
			.catch((error) =>
				reportError('load templates', error, { notifyUser: t('storage.loadFailed') })
			);
	});

	const themeOptions: { value: ThemePref; label: string }[] = $derived([
		{ value: 'system', label: t('settings.themeSystem') },
		{ value: 'light', label: t('settings.themeLight') },
		{ value: 'dark', label: t('settings.themeDark') }
	]);

	const widthPresets: { key: string; label: string; value: EditorWidth }[] = $derived([
		{ key: 'prose', label: t('settings.widthProse'), value: EDITOR.widthPresets.prose },
		{ key: 'narrow', label: t('settings.widthNarrow'), value: EDITOR.widthPresets.narrow },
		{ key: 'pdf', label: t('settings.widthPdf'), value: EDITOR.widthPresets.pdf },
		{ key: 'medium', label: t('settings.widthMedium'), value: EDITOR.widthPresets.medium },
		{ key: 'wide', label: t('settings.widthWide'), value: EDITOR.widthPresets.wide },
		{ key: 'full', label: t('settings.widthFull'), value: EDITOR.widthPresets.full }
	]);

	const pdfWidthHelp = $derived(
		t('settings.widthPdfHelp', {
			width: PRINT_TEXT_WIDTH_MM,
			margin: PRINT_PAGE.marginInlineMm
		})
	);

	const writingShortcuts = $derived([
		{
			id: 'bold',
			label: t('editor.bold'),
			context: t('settings.shortcutEditMode'),
			shortcuts: [formatKbd('⌘B')]
		},
		{
			id: 'italic',
			label: t('editor.italic'),
			context: t('settings.shortcutEditMode'),
			shortcuts: [formatKbd('⌘I')]
		},
		{
			id: 'inline-code',
			label: t('settings.shortcutInlineCode'),
			context: t('settings.shortcutEditMode'),
			shortcuts: [formatKbd('⌘E')]
		},
		{
			id: 'strikethrough',
			label: t('editor.strikethrough'),
			context: t('settings.shortcutEditMode'),
			shortcuts: [formatKbd('⌘⌥X')]
		},
		{
			id: 'paragraph',
			label: t('settings.shortcutParagraph'),
			context: t('settings.shortcutEditMode'),
			shortcuts: [formatKbd('⌘⌥0')]
		},
		...Array.from({ length: 6 }, (_, index) => ({
			id: `heading-${index + 1}`,
			label: t('editor.heading', { n: index + 1 }),
			context: t('settings.shortcutEditMode'),
			shortcuts: [formatKbd(`⌘⌥${index + 1}`)]
		})),
		{
			id: 'blockquote',
			label: t('editor.quote'),
			context: t('settings.shortcutEditMode'),
			shortcuts: [formatKbd('⌘⇧B')]
		},
		{
			id: 'code-block',
			label: t('settings.shortcutCodeBlock'),
			context: t('settings.shortcutEditMode'),
			shortcuts: [formatKbd('⌘⌥C')]
		},
		{
			id: 'hard-break',
			label: t('settings.shortcutHardBreak'),
			context: t('settings.shortcutEditMode'),
			shortcuts: [formatKbd('⇧Enter')]
		},
		{
			id: 'bullet-list',
			label: t('editor.bulletList'),
			context: t('settings.shortcutEditMode'),
			shortcuts: [formatKbd('⌘⌥8')]
		},
		{
			id: 'ordered-list',
			label: t('editor.orderedList'),
			context: t('settings.shortcutEditMode'),
			shortcuts: [formatKbd('⌘⌥7')]
		},
		{
			id: 'insert-indentation',
			label: t('settings.shortcutInsertIndentation'),
			context: t('settings.shortcutEditMode'),
			shortcuts: ['Tab']
		},
		{
			id: 'new-list-item',
			label: t('settings.shortcutNewListItem'),
			context: t('settings.shortcutEditListContext'),
			shortcuts: ['Enter']
		},
		{
			id: 'indent-list-item',
			label: t('settings.shortcutIndentListItem'),
			context: t('settings.shortcutEditListContext'),
			shortcuts: ['Tab', formatKbd('⌘]')]
		},
		{
			id: 'outdent-list-item',
			label: t('settings.shortcutOutdentListItem'),
			context: t('settings.shortcutEditListContext'),
			shortcuts: [formatKbd('⇧Tab'), formatKbd('⌘[')]
		},
		{
			id: 'next-table-cell',
			label: t('settings.shortcutNextTableCell'),
			context: t('settings.shortcutEditTableContext'),
			shortcuts: ['Tab', formatKbd('⌘]')]
		},
		{
			id: 'previous-table-cell',
			label: t('settings.shortcutPreviousTableCell'),
			context: t('settings.shortcutEditTableContext'),
			shortcuts: [formatKbd('⇧Tab'), formatKbd('⌘[')]
		},
		{
			id: 'exit-table',
			label: t('settings.shortcutExitTable'),
			context: t('settings.shortcutEditTableContext'),
			shortcuts: ['Enter', formatKbd('⌘Enter')]
		},
		{
			id: 'indent-selection',
			label: t('settings.shortcutIndentSelection'),
			context: t('settings.shortcutSourceMode'),
			shortcuts: ['Tab']
		},
		{
			id: 'outdent-selection',
			label: t('settings.shortcutOutdentSelection'),
			context: t('settings.shortcutSourceMode'),
			shortcuts: [formatKbd('⇧Tab')]
		},
		{
			id: 'move-line-up',
			label: t('settings.shortcutMoveLineUp'),
			context: t('settings.shortcutSourceMode'),
			shortcuts: [formatKbd('⌥↑')]
		},
		{
			id: 'move-line-down',
			label: t('settings.shortcutMoveLineDown'),
			context: t('settings.shortcutSourceMode'),
			shortcuts: [formatKbd('⌥↓')]
		},
		{
			id: 'copy-line-up',
			label: t('settings.shortcutCopyLineUp'),
			context: t('settings.shortcutSourceMode'),
			shortcuts: [formatKbd('⇧⌥↑')]
		},
		{
			id: 'copy-line-down',
			label: t('settings.shortcutCopyLineDown'),
			context: t('settings.shortcutSourceMode'),
			shortcuts: [formatKbd('⇧⌥↓')]
		},
		{
			id: 'go-to-line',
			label: t('source.cmGoToLine'),
			context: t('settings.shortcutSourceMode'),
			shortcuts: [formatKbd('⌘⌥G')]
		},
		{
			id: 'select-next-occurrence',
			label: t('settings.shortcutSelectNextOccurrence'),
			context: t('settings.shortcutSourceMode'),
			shortcuts: [formatKbd('⌘D')]
		},
		{
			id: 'undo',
			label: t('desktopMenu.undo'),
			context: t('settings.shortcutEditAndSourceModes'),
			shortcuts: [formatKbd('⌘Z')]
		},
		{
			id: 'redo',
			label: t('desktopMenu.redo'),
			context: t('settings.shortcutEditAndSourceModes'),
			shortcuts: [formatKbd(isMac() ? '⌘⇧Z' : '⌘Y')]
		}
	]);

	async function handleExportBackup(): Promise<void> {
		try {
			// Flush unflushed keystrokes before reading Dexie - backup is
			// IDB-sourced and would otherwise omit the last debounce window.
			await filesStore.flushPendingAwait();
			const ok = await downloadBackup();
			// Desktop dialog cancel returns false - do not claim success.
			if (ok) {
				recordExternalBackupSuccess();
				await refreshStorageHealth();
				notify.success(t('settings.backupExported'));
			}
		} catch (err) {
			recordExternalBackupFailure();
			await refreshStorageHealth();
			reportError('backup export', err, { notifyUser: t('settings.backupExportFailed') });
		}
	}

	// §2.8 - Encrypted export: asks for a passphrase, the file is unreadable
	// without it (AES-GCM). Forgotten passphrase = unrecoverable backup.
	async function handleExportEncrypted(): Promise<void> {
		const passphrase = await promptStore.prompt({
			title: t('settings.encryptBackupTitle'),
			message: t('settings.encryptBackupMessage'),
			placeholder: t('settings.passphrase'),
			inputType: 'password'
		});
		if (passphrase === null) return;
		if (!passphrase) {
			notify.error(t('settings.passphraseEmpty'));
			return;
		}
		const confirmation = await promptStore.prompt({
			title: t('settings.confirmPassphrase'),
			placeholder: t('settings.passphrase'),
			inputType: 'password'
		});
		if (confirmation === null) return;
		if (confirmation !== passphrase) {
			notify.error(t('settings.passphraseMismatch'));
			return;
		}
		try {
			await filesStore.flushPendingAwait();
			const ok = await downloadBackup(passphrase);
			if (ok) {
				recordExternalBackupSuccess();
				await refreshStorageHealth();
				notify.success(t('settings.encryptedBackupExported'));
			}
		} catch (err) {
			recordExternalBackupFailure();
			await refreshStorageHealth();
			reportError('encrypted backup export', err, {
				notifyUser: t('settings.encryptedExportFailed')
			});
		}
	}

	async function handleImportFile(e: Event): Promise<void> {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // allows re-importing the same file afterward
		if (!file) return;
		if (file.size > IMPORT_LIMITS.maxBatchBytes) {
			notify.error(t('backup.tooLarge'));
			return;
		}

		// Reading the file can also fail (file became unreadable
		// between selection and reading): we route it to notify instead of
		// letting a silent rejection slip through.
		let text: string;
		try {
			text = await readUtf8File(file, IMPORT_LIMITS.maxBatchBytes);
		} catch (err) {
			reportError('backup read', err, {
				notifyUser: t('settings.backupReadFailed')
			});
			return;
		}

		// §2.8 - Encrypted backup: ask for the passphrase first.
		let passphrase: string | undefined;
		if (isEncryptedBackup(text)) {
			const pass = await promptStore.prompt({
				title: t('settings.encryptedBackupTitle'),
				message: t('settings.encryptedBackupPrompt'),
				placeholder: t('settings.passphrase'),
				inputType: 'password'
			});
			if (pass === null) return;
			passphrase = pass;
		}

		let summary: string;
		try {
			const { backup } = await inspectBackupText(text, passphrase);
			summary = t('settings.backupProjectSummary', {
				date: formatBackupDate(backup.exportedAt),
				drafts: backup.drafts.length,
				workspaces: backup.workspaces.length,
				templates: backup.templates.length,
				projects: backup.projects?.length ?? 0,
				assets: backup.projectAssets?.length ?? 0
			});
			text = serializeBackup(backup);
			passphrase = undefined;
		} catch (error) {
			reportError('backup inspection', error, {
				notifyUser: error instanceof Error ? error.message : t('settings.restoreFailed')
			});
			return;
		}
		if (verifyOnly) {
			await promptStore.confirm({
				title: t('settings.backupValid'),
				message: summary,
				confirmLabel: t('settings.close')
			});
			return;
		}
		// The file picker precedes the mode choice: we ask afterward.
		// Replacement, merge, and cancellation are separate decisions.
		const restoreChoice = await promptStore.choose({
			title: t('settings.restoreBackupTitle'),
			message: `${summary}\n\n${t('settings.restoreBackupMessage')}`,
			confirmLabel: t('settings.replace'),
			alternateLabel: t('settings.merge'),
			cancelLabel: t('prompt.cancel'),
			danger: true
		});
		if (restoreChoice === null) return;
		const replace = restoreChoice === 'primary';

		const dismiss = spinnerStore.show(t('settings.restoringBackup'));
		try {
			// The restore service saves pending edits before it changes persisted drafts.
			const counts = await restoreFromText(text, replace ? 'replace' : 'merge', passphrase);
			await Promise.all([filesStore.reload(), workspaceStore.reload(), templatesStore.reload()]);
			// Partial restore: warn if corrupted entries were
			// skipped, so as not to imply a complete recovery.
			const skippedSuffix =
				counts.skipped > 0 ? t('settings.restoreSkippedSuffix', { n: counts.skipped }) : '';
			const unchanged =
				counts.unchanged.drafts +
				counts.unchanged.workspaces +
				counts.unchanged.templates +
				(counts.unchanged.projects ?? 0) +
				(counts.unchanged.projectAssets ?? 0);
			const unchangedSuffix =
				unchanged > 0 ? t('settings.restoreUnchangedSuffix', { n: unchanged }) : '';
			notify.success(
				t('settings.backupProjectRestored', {
					drafts: counts.drafts,
					workspaces: counts.workspaces,
					projects: counts.projects,
					assets: counts.projectAssets
				}) +
					skippedSuffix +
					unchangedSuffix
			);
		} catch (err) {
			reportError('backup restore', err, {
				notifyUser:
					err instanceof Error && (err.name === 'BackupParseError' || err.name === 'DecryptError')
						? err.message
						: t('settings.restoreFailed')
			});
		} finally {
			dismiss();
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pb-4 backdrop-blur-sm
		       pt-[max(env(safe-area-inset-top),10vh)]"
		style:padding-left="max(env(safe-area-inset-left), 1rem)"
		style:padding-right="max(env(safe-area-inset-right), 1rem)"
		onclick={(e) => {
			if (e.target === e.currentTarget) onClose();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') onClose();
		}}
		role="dialog"
		aria-modal="true"
		aria-labelledby="settings-title"
		inert={promptStore.open}
		aria-hidden={promptStore.open ? 'true' : undefined}
		tabindex="-1"
		use:focusTrap
	>
		<div
			class="mdsh-dialog-panel flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border
			       bg-bg-1 shadow-2xl animate-fade-in"
		>
			<header class="flex items-center gap-2 border-b border-border px-4 py-2.5">
				<Settings size={16} class="text-fg-dim" aria-hidden="true" />
				<h2 id="settings-title" class="flex-1 text-sm font-medium text-fg">
					{t('settings.title')}
				</h2>
				<button
					bind:this={closeButton}
					class="rounded p-1 text-fg-dim transition hover:bg-bg-2 hover:text-fg"
					onclick={onClose}
					aria-label={t('settings.close')}
				>
					<X size={14} />
				</button>
			</header>

			<div class="flex-1 overflow-y-auto px-4 py-3">
				<!-- Appearance: theme -->
				<section class="mb-5">
					<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-dim">
						{t('settings.appearance')}
					</h3>
					<div class="flex items-center justify-between gap-3">
						<span class="text-sm text-fg-muted">{t('settings.theme')}</span>
						<div
							class="flex gap-1 rounded-md border border-border p-0.5"
							role="group"
							aria-label={t('settings.themeChoice')}
						>
							{#each themeOptions as opt (opt.value)}
								<button
									class="rounded px-2.5 py-1 text-xs transition"
									class:bg-bg-3={themeStore.pref === opt.value}
									class:text-fg={themeStore.pref === opt.value}
									class:text-fg-dim={themeStore.pref !== opt.value}
									aria-pressed={themeStore.pref === opt.value}
									onclick={() => themeStore.set(opt.value)}
								>
									{opt.label}
								</button>
							{/each}
						</div>
					</div>
					<div class="mt-3 flex items-center justify-between gap-3">
						<span class="text-sm text-fg-muted">{t('settings.language')}</span>
						<div
							class="flex gap-1 rounded-md border border-border p-0.5"
							role="group"
							aria-label={t('settings.language')}
						>
							{#each LOCALES as loc (loc)}
								<button
									class="rounded px-2.5 py-1 text-xs transition"
									class:bg-bg-3={i18n.locale === loc}
									class:text-fg={i18n.locale === loc}
									class:text-fg-dim={i18n.locale !== loc}
									aria-pressed={i18n.locale === loc}
									onclick={() => i18n.set(loc)}
								>
									{LOCALE_LABELS[loc]}
								</button>
							{/each}
						</div>
					</div>
				</section>

				<!-- Editor: width -->
				<section class="mb-5">
					<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-dim">
						{t('settings.editor')}
					</h3>
					<div class="flex items-center justify-between gap-3">
						<span class="text-sm text-fg-muted">{t('settings.width')}</span>
						<div
							class="flex flex-wrap justify-end gap-1 rounded-md border border-border p-0.5"
							role="group"
							aria-label={t('settings.editorWidth')}
						>
							{#each widthPresets as preset (preset.key)}
								<button
									class="rounded px-2.5 py-1 text-xs transition"
									class:bg-bg-3={editorWidth.isActiveWidth(preset.value)}
									class:text-fg={editorWidth.isActiveWidth(preset.value)}
									class:text-fg-dim={!editorWidth.isActiveWidth(preset.value)}
									aria-pressed={editorWidth.isActiveWidth(preset.value)}
									aria-describedby={preset.key === 'pdf' ? 'editor-width-pdf-help' : undefined}
									onclick={() => editorWidth.setEditorWidth(preset.value)}
								>
									{preset.label}
								</button>
							{/each}
						</div>
					</div>
					<p id="editor-width-pdf-help" class="mt-2 text-xs text-fg-muted">{pdfWidthHelp}</p>
				</section>

				<details class="mb-5 rounded border border-border p-3 text-sm">
					<summary class="cursor-pointer">{t('settings.shortcuts')}</summary>
					<section class="mt-3" aria-labelledby="writing-shortcuts-title">
						<h4 id="writing-shortcuts-title" class="text-xs font-semibold text-fg">
							{t('settings.writingShortcuts')}
						</h4>
						<p class="my-2 text-xs text-fg-muted">{t('settings.writingShortcutsHelp')}</p>
						<dl class="space-y-2 text-xs">
							{#each writingShortcuts as shortcut (shortcut.id)}
								<div
									class="flex flex-wrap items-center justify-between gap-2"
									data-writing-shortcut={shortcut.id}
								>
									<dt>{shortcut.label}</dt>
									<dd class="flex items-center gap-2">
										<span class="text-fg-muted">{shortcut.context}</span>
										{#each shortcut.shortcuts as binding (binding)}
											<kbd
												class="min-w-20 rounded border border-border bg-bg px-2 py-1 text-center"
											>
												{binding}
											</kbd>
										{/each}
									</dd>
								</div>
							{/each}
						</dl>
					</section>

					<section
						class="mt-4 border-t border-border pt-3"
						aria-labelledby="application-shortcuts-title"
					>
						<h4 id="application-shortcuts-title" class="text-xs font-semibold text-fg">
							{t('settings.applicationShortcuts')}
						</h4>
						<p class="my-2 text-xs text-fg-muted">
							{t(isDesktop() ? 'settings.shortcutsDesktop' : 'settings.shortcutsWeb')}
						</p>
						<p class="my-2 text-xs text-fg-muted">{t('settings.shortcutInstructions')}</p>
						<p class="my-2 text-xs text-fg-muted">{t('settings.fileNavigation')}</p>
						<p class="my-2 text-xs text-accent" role="status">{shortcutFeedback}</p>
						<button
							class="mb-2 rounded border border-border px-2 py-1 text-xs"
							onclick={() => showShortcutResult(keyboardStore.reset())}
							>{t('settings.shortcutReset')}</button
						>
						<dl class="space-y-2 text-xs">
							{#each coreCommands as command (command.id)}
								<div class="flex flex-wrap items-center justify-between gap-2">
									<dt>{t(command.label)}</dt>
									<dd class="flex items-center gap-1">
										<input
											class="w-28 rounded border border-border bg-bg px-2 py-1"
											readonly
											value={keyboardStore.label(command.id) ?? t('settings.shortcutDisabled')}
											aria-label={t('settings.shortcutFor', { command: t(command.label) })}
											data-shortcut-capture
											onkeydown={(event) => captureShortcut(event, command.id)}
										/><button
											class="p-1 underline"
											onclick={() => showShortcutResult(keyboardStore.set(command.id, null))}
											aria-label={t('settings.disableShortcutFor', { command: t(command.label) })}
											>{t('settings.shortcutDisable')}</button
										>
									</dd>
								</div>
							{/each}
						</dl>
					</section>
				</details>

				<!-- Display: toggles -->
				<section class="mb-5">
					<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-dim">
						{t('settings.display')}
					</h3>
					<div class="flex flex-col gap-1.5">
						{@render toggleRow(t('settings.focusMode'), prefs.focusMode, prefs.toggleFocusMode)}
						{@render toggleRow(
							t('settings.typewriterMode'),
							prefs.typewriterMode,
							prefs.toggleTypewriterMode
						)}
						{@render toggleRow(t('settings.tableOfContents'), prefs.tocVisible, prefs.toggleToc)}
					</div>
				</section>

				<details class="mb-5 rounded border border-border p-3 text-sm">
					<summary bind:this={templateSummary} class="cursor-pointer"
						>{t('templates.manage')}</summary
					>
					<p class="my-2 text-xs text-fg-muted">{t('templates.help')}</p>
					{#if editingTemplate}
						<label class="my-2 block text-xs"
							>{t('templates.name')}<input
								bind:value={templateName}
								bind:this={templateNameInput}
								disabled={templateBusy}
								class="mt-1 w-full rounded border border-border bg-bg p-2 text-sm"
							/></label
						>
						<label class="my-2 block text-xs"
							>{t('templates.content')}<textarea
								bind:value={templateContent}
								disabled={templateBusy}
								rows="8"
								class="mt-1 w-full rounded border border-border bg-bg p-2 font-mono text-xs"
							></textarea></label
						>
						<div class="flex gap-2">
							<button
								class="rounded border border-border px-3 py-2"
								disabled={templateBusy || !templateName.trim()}
								onclick={() => void saveTemplate()}>{t('templates.save')}</button
							><button class="px-3 py-2" disabled={templateBusy} onclick={finishTemplateEdit}
								>{t('prompt.cancel')}</button
							>
						</div>
					{:else}
						{#each templatesStore.userTemplates as template (template.id)}
							<div class="flex flex-wrap items-center gap-2 border-t border-border py-2">
								<span class="min-w-0 flex-1 break-words">{template.name}</span><button
									class="rounded border border-border px-2 py-1"
									onclick={() => editTemplate(template)}>{t('templates.edit')}</button
								><button
									class="rounded border border-border px-2 py-1 text-danger"
									onclick={() => void deleteTemplate(template.id)}>{t('templates.delete')}</button
								>
							</div>
						{:else}<p class="text-xs text-fg-muted">{t('templates.none')}</p>{/each}
					{/if}
				</details>

				<!-- Data: backup / restore -->
				<section>
					<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-dim">
						{t('settings.data')}
					</h3>
					<p class="mb-2 text-xs text-fg-dim">
						{t('settings.backupProjectScope')}
					</p>
					<div class="mb-3 rounded-md border border-border bg-bg px-3 py-2" aria-live="polite">
						<h4 class="mb-1 text-xs font-medium text-fg">{t('settings.storageHealth')}</h4>
						{#if storageHealth}
							<ul class="space-y-0.5 text-xs text-fg-dim">
								<li>
									{storageHealth.persistence === 'persistent'
										? t('settings.storagePersistent')
										: storageHealth.persistence === 'best-effort'
											? t('settings.storageBestEffort')
											: t('settings.storageUnavailable')}
								</li>
								<li>
									{storageHealth.usage !== null && storageHealth.quota !== null
										? t('settings.storageUsage', {
												usage: formatStorageBytes(storageHealth.usage),
												quota: formatStorageBytes(storageHealth.quota)
											})
										: t('settings.storageUsageUnavailable')}
								</li>
								{#if storageHealth.projectAssetCount !== null && storageHealth.projectAssetBytes !== null}
									<li>
										{t('settings.projectAssetUsage', {
											count: storageHealth.projectAssetCount,
											usage: formatStorageBytes(storageHealth.projectAssetBytes)
										})}
									</li>
								{/if}
								<li>
									{storageHealth.lastExternalBackupAt
										? t('settings.lastBackup', {
												date: formatBackupDate(storageHealth.lastExternalBackupAt)
											})
										: t('settings.noBackup')}
								</li>
							</ul>
							{#if storageHealth.lastBackupErrorAt}
								<p class="mt-1 text-xs text-danger" role="alert">
									{t('settings.backupHealthError')}
								</p>
							{/if}
							{#if storageHealth.backupReminderDue}
								<p class="mt-1 text-xs text-fg-muted">{t('settings.backupReminder')}</p>
							{/if}
						{:else}
							<p class="text-xs text-fg-dim">{t('settings.storageUnavailable')}</p>
						{/if}
					</div>
					<div class="flex flex-wrap gap-2">
						<button
							class="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-2 hover:text-fg"
							aria-disabled={backupBusy}
							onclick={() => void runBackupAction(handleExportBackup)}
						>
							<Download size={13} aria-hidden="true" />
							<span>{t('settings.exportBackup')}</span>
						</button>
						<button
							class="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-2 hover:text-fg"
							aria-disabled={backupBusy}
							onclick={() => void runBackupAction(handleExportEncrypted)}
						>
							<Lock size={13} aria-hidden="true" />
							<span>{t('settings.exportEncrypted')}</span>
						</button>
						<button
							class="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-2 hover:text-fg"
							aria-disabled={backupBusy}
							onclick={() => chooseBackup(false)}
						>
							<Upload size={13} aria-hidden="true" />
							<span>{t('settings.importBackup')}</span>
						</button>
						<button
							class="rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-2"
							aria-disabled={backupBusy}
							onclick={() => chooseBackup(true)}>{t('settings.verifyBackup')}</button
						>
					</div>
					<p class="mt-2 text-xs text-fg-muted">{t('settings.backupDownloadHint')}</p>
				</section>
				<section class="mt-5 border-t border-border pt-3 text-xs text-fg-muted">
					<h3 class="mb-2 font-medium text-fg">{t('settings.about')}</h3>
					<p>{t('brand.name')} {version} · {isDesktop() ? 'Desktop Beta' : 'PWA'}</p>
					<p class="mt-1" role="status">
						{t(
							offlineState.status === 'ready'
								? 'pwa.ready'
								: offlineState.status === 'preparing'
									? 'pwa.preparing'
									: 'pwa.unavailable'
						)}
					</p>
					<p class="mt-1">{t('welcome.privacy')}</p>
					<a
						class="mt-2 inline-block underline"
						href="https://github.com/ThomasCrouzet/deckmark/blob/main/docs/USER_GUIDE.md"
						target="_blank"
						rel="noopener noreferrer">{t('settings.userGuide')}</a
					>
				</section>
			</div>
		</div>
	</div>

	<input
		bind:this={importInput}
		type="file"
		accept="application/json,.json"
		class="hidden"
		onchange={(event) => void runBackupAction(() => handleImportFile(event))}
	/>
{/if}

{#snippet toggleRow(label: string, active: boolean, onToggle: () => void)}
	<button
		class="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-fg-muted transition hover:bg-bg-2"
		aria-pressed={active}
		onclick={onToggle}
	>
		<span>{label}</span>
		<span
			class="flex h-5 w-9 items-center rounded-full border px-0.5 transition"
			class:border-accent={active}
			class:bg-accent={active}
			class:border-border={!active}
			aria-hidden="true"
		>
			<span
				class="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-bg transition"
				class:translate-x-4={active}
			>
				{#if active}<Check size={9} class="text-accent" />{/if}
			</span>
		</span>
	</button>
{/snippet}
