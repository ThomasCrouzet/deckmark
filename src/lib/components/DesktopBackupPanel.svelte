<script lang="ts">
	// Desktop Complete automatic backup controls. SettingsPanel loads this panel
	// only in the desktop edition, so the Web build never imports the scheduler.

	import { onMount } from 'svelte';
	import { t, i18n } from '#lib/i18n/index.js';
	import type { MessageKey } from '#lib/i18n/index.js';
	import { parseBackupWithReport } from '#lib/services/backup.js';
	import type { BackupFile } from '#lib/services/backup.js';
	import {
		chooseBackupFolder,
		disableDesktopBackup,
		enableDesktopBackup,
		getDesktopBackupState,
		listBackupSnapshots,
		readBackupSnapshot,
		setBackupIntervalHours,
		setBackupRetention,
		subscribeDesktopBackup,
		writeBackupNow,
		type BackupEntry
	} from '#lib/desktop-backup.js';
	import { formatStorageBytes } from '#lib/storage.js';
	import { notify } from '#lib/notify.svelte.js';
	import { reportError } from '#lib/report.js';

	interface Props {
		onRestore: (text: string) => Promise<void>;
	}

	interface Preview {
		path: string;
		fileName: string;
		text: string;
		backup: BackupFile;
	}

	let { onRestore }: Props = $props();

	let backupState = $state(getDesktopBackupState());
	let snapshots = $state<BackupEntry[]>([]);
	let preview = $state<Preview | null>(null);
	let busy = $state(false);
	let listBusy = $state(false);
	let errorText = $state('');

	function formatDate(value: number): string {
		return new Intl.DateTimeFormat(i18n.locale, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(value);
	}

	function describeError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function showError(error: unknown, fallbackKey: MessageKey): void {
		errorText = `${t(fallbackKey)} ${describeError(error)}`;
		reportError('desktop backup', error);
	}

	async function refreshSnapshots(): Promise<void> {
		if (!backupState.root) {
			snapshots = [];
			return;
		}
		listBusy = true;
		try {
			snapshots = await listBackupSnapshots();
			errorText = '';
		} catch (error) {
			showError(error, 'settings.desktopBackupReadFailed');
		} finally {
			listBusy = false;
		}
	}

	async function chooseFolder(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			const selected = await chooseBackupFolder(t('settings.desktopBackupChooseTitle'));
			if (selected) {
				preview = null;
				await refreshSnapshots();
			}
		} catch (error) {
			showError(error, 'settings.desktopBackupFailed');
		} finally {
			busy = false;
		}
	}

	async function toggleSchedule(): Promise<void> {
		if (busy) return;
		errorText = '';
		try {
			if (backupState.enabled) {
				disableDesktopBackup();
				return;
			}
			if (!backupState.root) {
				const selected = await chooseBackupFolder(t('settings.desktopBackupChooseTitle'));
				if (!selected) return;
			}
			enableDesktopBackup();
			await refreshSnapshots();
		} catch (error) {
			showError(error, 'settings.desktopBackupFolderRequired');
		}
	}

	async function backupNow(): Promise<void> {
		if (busy) return;
		busy = true;
		errorText = '';
		try {
			if (!backupState.root) throw new Error(t('settings.desktopBackupFolderRequired'));
			await writeBackupNow();
			notify.success(t('settings.desktopBackupSaved'));
			preview = null;
			await refreshSnapshots();
		} catch (error) {
			showError(error, 'settings.desktopBackupFailed');
		} finally {
			busy = false;
		}
	}

	async function previewSnapshot(entry: BackupEntry): Promise<void> {
		if (busy) return;
		busy = true;
		errorText = '';
		try {
			const text = await readBackupSnapshot(entry.fileName);
			const { backup } = parseBackupWithReport(text);
			preview = { path: entry.path, fileName: entry.fileName, text, backup };
		} catch (error) {
			preview = null;
			showError(error, 'settings.desktopBackupReadFailed');
		} finally {
			busy = false;
		}
	}

	async function restorePreview(): Promise<void> {
		if (!preview || busy) return;
		busy = true;
		errorText = '';
		try {
			await onRestore(preview.text);
			preview = null;
		} catch (error) {
			showError(error, 'settings.desktopBackupRestoreFailed');
		} finally {
			busy = false;
		}
	}

	function changeInterval(event: Event): void {
		setBackupIntervalHours(Number((event.currentTarget as HTMLInputElement).value));
	}

	function changeRetention(event: Event): void {
		setBackupRetention(Number((event.currentTarget as HTMLInputElement).value));
	}

	onMount(() => {
		const unsubscribe = subscribeDesktopBackup(() => {
			backupState = getDesktopBackupState();
		});
		void refreshSnapshots();
		return unsubscribe;
	});
</script>

<section
	class="rounded-md border border-border bg-bg px-3 py-3"
	aria-labelledby="desktop-backup-title"
	data-testid="desktop-backup-panel"
>
	<h3
		id="desktop-backup-title"
		class="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-dim"
	>
		{t('settings.desktopBackupTitle')}
	</h3>
	<p class="mb-3 text-xs text-fg-muted">{t('settings.desktopBackupScope')}</p>

	<div class="mb-3 flex flex-wrap gap-2">
		<button
			class="rounded border border-border px-3 py-1.5 text-xs"
			class:bg-bg-3={backupState.enabled}
			aria-pressed={backupState.enabled}
			disabled={busy}
			onclick={() => void toggleSchedule()}
		>
			{backupState.enabled ? t('settings.desktopBackupDisable') : t('settings.desktopBackupEnable')}
		</button>
		<button
			class="rounded border border-border px-3 py-1.5 text-xs"
			disabled={busy}
			onclick={() => void chooseFolder()}
		>
			{t('settings.desktopBackupChooseFolder')}
		</button>
		<button
			class="rounded border border-border px-3 py-1.5 text-xs"
			disabled={busy || !backupState.root}
			onclick={() => void backupNow()}
		>
			{t('settings.desktopBackupNow')}
		</button>
	</div>

	<dl class="mb-3 space-y-1 text-xs">
		<div class="flex flex-wrap gap-2">
			<dt class="font-medium text-fg">{t('settings.desktopBackupFolder')}</dt>
			<dd class="min-w-0 break-all text-fg-muted">
				{backupState.root ?? t('settings.desktopBackupNoFolder')}
			</dd>
		</div>
		<div class="flex flex-wrap gap-2">
			<dt class="font-medium text-fg">{t('settings.desktopBackupLast')}</dt>
			<dd class="text-fg-muted">
				{backupState.lastSuccessAt
					? formatDate(backupState.lastSuccessAt)
					: t('settings.desktopBackupNever')}
			</dd>
		</div>
		<div class="flex flex-wrap gap-2">
			<dt class="font-medium text-fg">{t('settings.desktopBackupNext')}</dt>
			<dd class="text-fg-muted">
				{#if backupState.enabled && backupState.nextRunAt}
					{formatDate(backupState.nextRunAt)}
				{:else}
					{t('settings.desktopBackupOff')}
				{/if}
			</dd>
		</div>
	</dl>

	<div class="mb-3 flex flex-wrap gap-4">
		<label class="text-xs text-fg-muted">
			<span class="block font-medium text-fg">{t('settings.desktopBackupInterval')}</span>
			<input
				type="number"
				min="1"
				max="168"
				step="1"
				class="mt-1 w-24 rounded border border-border bg-bg-2 px-2 py-1 text-sm text-fg"
				value={backupState.intervalHours}
				disabled={busy}
				onchange={changeInterval}
			/>
		</label>
		<label class="text-xs text-fg-muted">
			<span class="block font-medium text-fg">{t('settings.desktopBackupRetention')}</span>
			<input
				type="number"
				min="1"
				max="50"
				step="1"
				class="mt-1 w-24 rounded border border-border bg-bg-2 px-2 py-1 text-sm text-fg"
				value={backupState.retention}
				disabled={busy}
				onchange={changeRetention}
			/>
		</label>
	</div>
	<p class="mb-1 text-xs text-fg-muted">{t('settings.desktopBackupKeepHint')}</p>
	<p class="mb-3 text-xs text-fg-muted">{t('settings.desktopBackupFolderHint')}</p>

	{#if errorText}
		<p class="mb-3 break-words text-xs text-danger" role="alert">{errorText}</p>
	{/if}

	<div class="border-t border-border pt-3">
		<div class="mb-2 flex items-center justify-between gap-2">
			<h4 class="text-xs font-semibold text-fg">{t('settings.desktopBackupList')}</h4>
			<button
				class="rounded border border-border px-2 py-1 text-xs"
				disabled={listBusy || busy || !backupState.root}
				onclick={() => void refreshSnapshots()}
			>
				{t('settings.desktopBackupRefresh')}
			</button>
		</div>
		{#if listBusy}
			<p class="text-xs text-fg-muted">{t('settings.desktopBackupLoading')}</p>
		{:else if snapshots.length === 0}
			<p class="text-xs text-fg-muted">{t('settings.desktopBackupEmpty')}</p>
		{:else}
			<ul class="space-y-1 text-xs">
				{#each snapshots as entry (entry.path)}
					<li class="flex flex-wrap items-center gap-2 border-t border-border py-1.5">
						<span class="min-w-0 flex-1 break-all font-mono text-fg">{entry.fileName}</span>
						<span class="text-fg-dim">{formatStorageBytes(entry.size)}</span>
						<span class="text-fg-dim">{formatDate(entry.modifiedMs)}</span>
						<button
							class="rounded border border-border px-2 py-1"
							disabled={busy}
							onclick={() => void previewSnapshot(entry)}
						>
							{t('settings.desktopBackupPreview')}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	{#if preview}
		<div
			class="mt-3 rounded border border-border bg-bg-2 px-3 py-2"
			aria-live="polite"
			data-testid="desktop-backup-preview"
		>
			<p class="mb-1 break-all text-xs font-medium text-fg">{preview.fileName}</p>
			<p class="mb-1 text-xs text-fg-muted">
				{t('settings.desktopBackupPreviewSummary', {
					date: formatDate(preview.backup.exportedAt),
					drafts: preview.backup.drafts.length,
					workspaces: preview.backup.workspaces.length,
					templates: preview.backup.templates.length,
					snippets: preview.backup.snippets?.length ?? 0,
					projects: preview.backup.projects?.length ?? 0,
					assets: preview.backup.projectAssets?.length ?? 0
				})}
			</p>
			<p class="mb-2 text-xs text-fg-dim">{t('settings.desktopBackupPreviewHint')}</p>
			<button
				class="rounded border border-border px-3 py-1.5 text-xs"
				disabled={busy}
				onclick={() => void restorePreview()}
			>
				{t('settings.desktopBackupRestore')}
			</button>
		</div>
	{/if}
</section>
