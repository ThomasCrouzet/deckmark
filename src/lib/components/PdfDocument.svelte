<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Download, ExternalLink, FileText } from '@lucide/svelte';
	import type { FileItem } from '#lib/types.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import { planBinaryView, type BinaryViewSnapshot } from '#lib/services/binary-view-plan.js';
	import { createBinaryRenderGate, createObjectUrlSlot } from '#lib/services/binary-view-render.js';

	let { file }: { file: FileItem } = $props();
	let url = $state('');
	let blocked = $state(false);
	let failed = $state(false);
	let replacing = $state(false);
	let payload: BinaryViewSnapshot | null = null;
	const decodeGate = createBinaryRenderGate();
	const urlSlot = createObjectUrlSlot();

	$effect(() => {
		const plan = planBinaryView(payload, { data: file.data, mime: file.mime });
		payload = plan.snapshot;
		if (plan.empty) {
			decodeGate.invalidate();
			urlSlot.clear();
			url = '';
			blocked = false;
			failed = true;
			replacing = false;
			return;
		}
		if (!plan.decode) return;
		const token = decodeGate.begin();
		replacing = true;
		blocked = false;
		failed = false;
		const data = plan.snapshot.data!;
		const mime = plan.snapshot.mime ?? undefined;
		void import('#lib/data-url.js')
			.then(({ decodeBinaryDataUrl }) =>
				decodeBinaryDataUrl(data, { expectedKind: 'pdf', expectedMime: mime })
			)
			.then((blob) => {
				if (!decodeGate.isCurrent(token)) return;
				const next = URL.createObjectURL(blob);
				urlSlot.replace(next);
				url = next;
				replacing = false;
			})
			.catch(() => {
				if (!decodeGate.isCurrent(token)) return;
				urlSlot.clear();
				url = '';
				failed = true;
				replacing = false;
			});
	});

	onDestroy(() => {
		decodeGate.invalidate();
		urlSlot.clear();
	});

	function open() {
		if (url && !replacing) window.open(url, '_blank', 'noopener');
	}
</script>

<div class="pdf-document" data-testid="pdf-document">
	<div class="pdf-toolbar">
		<span class="pdf-kind"><FileText size={14} aria-hidden="true" />{t('documents.pdf')}</span>
		<span class="pdf-meta">{file.name}</span>
		<button type="button" onclick={open} disabled={!url || replacing}>
			<ExternalLink size={14} aria-hidden="true" />
			{t('documents.openPdf')}
		</button>
		<button type="button" onclick={() => filesStore.export(file.id)}>
			<Download size={14} aria-hidden="true" />
			{t('toolbar.export')}
		</button>
	</div>
	<div class="pdf-viewport">
		{#if replacing}
			<p class="pdf-status" role="status" data-testid="pdf-replacing">
				{t('documents.pdfReplacing')}
			</p>
		{/if}
		{#if !file.data || failed}
			<p role="alert">{t('documents.pdfUnavailable')}</p>
		{:else if url}
			<iframe
				src={url}
				title={file.name}
				data-testid="pdf-frame"
				onload={() => (blocked = false)}
				onerror={() => (blocked = true)}
			></iframe>
			{#if blocked}
				<p role="status">{t('documents.pdfFallback')}</p>
			{/if}
		{/if}
	</div>
</div>

<style>
	.pdf-document {
		display: flex;
		height: 100%;
		min-height: 0;
		flex-direction: column;
	}
	.pdf-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-1);
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.pdf-kind {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--color-fg);
		font-weight: 500;
	}
	.pdf-meta {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 10px;
	}
	.pdf-toolbar button {
		display: inline-flex;
		min-height: 32px;
		align-items: center;
		gap: 4px;
		padding: 3px 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
	}
	.pdf-viewport {
		display: flex;
		min-height: 0;
		flex: 1;
		flex-direction: column;
		background: var(--color-bg);
	}
	.pdf-status {
		margin: 0;
		padding: 6px 10px;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-1);
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	iframe {
		width: 100%;
		height: 100%;
		border: 0;
		flex: 1;
	}
</style>
