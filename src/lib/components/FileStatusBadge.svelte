<script lang="ts">
	import { AlertTriangle, Clipboard, Database, HardDrive } from '@lucide/svelte';
	import type { FileItem } from '#lib/types.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { diskConflictStore } from '#lib/disk-conflict.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import { resolveStorageStatus, type StorageOrigin } from '#lib/storage-status.js';

	let { file, showLabel = false }: { file: FileItem; showLabel?: boolean } = $props();

	const status = $derived(
		resolveStorageStatus({
			origin: file.origin,
			linkedToDisk: file.linkedToDisk,
			brokenLink: file.brokenLink,
			dirty: file.dirty,
			saveError: filesStore.hasSaveError(file.id),
			conflict: diskConflictStore.pending?.fileId === file.id
		})
	);
	const originKey = $derived(
		status.origin === 'disk'
			? 'storage.originDisk'
			: status.origin === 'temporary'
				? 'storage.originTemporary'
				: status.origin === 'broken'
					? 'storage.originBroken'
					: 'storage.originDraft'
	);
	const syncKey = $derived(
		status.sync === 'pending'
			? 'storage.syncPending'
			: status.sync === 'error'
				? 'storage.syncError'
				: status.sync === 'conflict'
					? 'storage.syncConflict'
					: status.sync === 'broken'
						? 'storage.syncBroken'
						: 'storage.syncSaved'
	);
	const hintKey = $derived(
		status.sync === 'conflict'
			? 'storage.hintConflict'
			: status.sync === 'error'
				? 'storage.hintError'
				: status.origin === 'broken'
					? 'storage.hintBroken'
					: status.origin === 'temporary'
						? 'storage.hintTemporary'
						: status.origin === 'disk'
							? 'storage.hintDisk'
							: 'storage.hintDraft'
	);
	const label = $derived(`${t(originKey)}. ${t(syncKey)}. ${t(hintKey)}`);
	const icons: Record<StorageOrigin, typeof Database> = {
		draft: Database,
		temporary: Clipboard,
		disk: HardDrive,
		broken: AlertTriangle
	};
	const Icon = $derived(icons[status.origin]);
	const alarming = $derived(
		status.sync === 'error' || status.sync === 'conflict' || status.origin === 'broken'
	);
</script>

<span
	class="file-status"
	class:alarming
	class:active={status.sync === 'pending'}
	class:labelled={showLabel}
	role="img"
	aria-label={label}
	title={label}
	data-origin={status.origin}
	data-sync={status.sync}
	data-testid={`storage-status-${file.id}`}
>
	<Icon size={showLabel ? 12 : 10} aria-hidden="true" />
	{#if showLabel}<span class="file-status-label">{t(originKey)}</span>{/if}
	{#if status.sync !== 'saved'}
		<span class="file-status-dot" aria-hidden="true"></span>
	{/if}
</span>

<style>
	.file-status {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 3px;
		color: var(--color-fg-dim);
	}
	.file-status.active {
		color: var(--color-accent);
	}
	.file-status.alarming {
		color: var(--color-danger);
	}
	.file-status.labelled {
		gap: 4px;
		padding: 1px 5px;
		border: 1px solid currentColor;
		border-radius: var(--radius-xs);
		font-size: 10px;
		line-height: 1.6;
	}
	.file-status-dot {
		width: 5px;
		height: 5px;
		border-radius: 999px;
		background: currentColor;
	}
</style>
