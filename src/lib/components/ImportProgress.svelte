<script lang="ts">
	import { filesStore } from '#lib/files.svelte.js';
	import { t, type MessageKey } from '#lib/i18n/index.js';
	import { formatStorageBytes } from '#lib/storage.js';
	let { blocked = false }: { blocked?: boolean } = $props();
	let dismissed = $state(false);
	$effect(() => {
		const completed = filesStore.lastImportReport;
		if (!completed) return;
		dismissed = false;
		if (!completed.failed && !completed.skipped && !completed.cancelled) {
			const timer = setTimeout(() => (dismissed = true), 6000);
			return () => clearTimeout(timer);
		}
	});
	const report = $derived(
		filesStore.importProgress ?? (!dismissed ? filesStore.lastImportReport : null)
	);
	const reasons: Record<string, MessageKey> = {
		'file-size': 'import.fileSize',
		'batch-size': 'import.batchSize',
		'file-count': 'import.fileCount',
		encoding: 'import.encoding',
		binary: 'import.binary',
		read: 'import.read',
		depth: 'import.depth'
	};
</script>

{#if report}
	<section
		class="fixed bottom-8 right-3 z-40 max-h-[50dvh] w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded border border-border bg-bg-1 p-3 text-xs text-fg shadow-lg"
		aria-label={t('import.title')}
		inert={blocked}
		aria-hidden={blocked ? 'true' : undefined}
	>
		<div role="status" aria-live="polite">
			<p class="font-medium">
				{t(
					filesStore.importProgress
						? 'import.running'
						: report.cancelled
							? 'import.cancelled'
							: 'import.complete'
				)}
			</p>
			<p class="mt-1">
				{t('import.summary', {
					processed: report.processed,
					imported: report.imported,
					skipped: report.skipped,
					failed: report.failed
				})}
			</p>
			<p class="mt-1 text-fg-muted">{formatStorageBytes(report.bytes)}</p>
		</div>
		{#if report.issues.length > 0}
			<details class="mt-2">
				<summary class="cursor-pointer">{t('import.details')}</summary>
				<ul class="mt-1 space-y-1">
					{#each report.issues as issue, index (index)}
						<li class="break-words">{issue.name}: {t(reasons[issue.reason] ?? 'import.read')}</li>
					{/each}
				</ul>
			</details>
		{/if}
		{#if filesStore.importProgress}
			<button
				class="mt-2 min-h-10 rounded border border-border px-3"
				onclick={() => filesStore.cancelImport()}>{t('import.cancel')}</button
			>
		{:else}
			<button
				class="mt-2 min-h-10 rounded border border-border px-3"
				onclick={() => (dismissed = true)}>{t('import.dismiss')}</button
			>
		{/if}
	</section>
{/if}
