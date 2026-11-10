<script lang="ts">
	import { onMount } from 'svelte';
	import { X } from '@lucide/svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { documentKindForFile } from '#lib/document-kind.js';
	import {
		buildLinkReport,
		currentLinkReport,
		detachInclude,
		extractBlocks,
		freezeInclude,
		insertInclude,
		updateInclude,
		type LinkedBlock,
		type LinkReport
	} from '#lib/linked-blocks.js';
	import { notify } from '#lib/notify.svelte.js';
	import { t } from '#lib/i18n/index.js';

	let { open, onClose }: { open: boolean; onClose: () => void } = $props();

	let blocks = $state<LinkedBlock[]>([]);
	let reports = $state<LinkReport[]>([]);
	let sourceKey = $state('');
	const active = $derived(filesStore.active);
	const activePath = $derived(active ? (active.relativePath ?? active.name) : '');

	onMount(refresh);

	async function refresh() {
		const needed = filesStore.library
			.filter(
				(file) =>
					file.contentDeferred &&
					documentKindForFile(file) === 'note' &&
					(file.derivedMetadata?.hasBlocks ||
						file.derivedMetadata?.hasIncludes ||
						!file.derivedMetadata)
			)
			.map((file) => file.id);
		await filesStore.ensureContent(needed);
		blocks = filesStore.library.flatMap((file) => extractBlocks(file));
		reports = buildLinkReport(filesStore.library);
		if (!blocks.some((block) => block.key === sourceKey))
			sourceKey = sourceKey ? '' : (blocks[0]?.key ?? '');
	}

	function insert() {
		if (!active || !sourceKey) return;
		const block = blocks.find((entry) => entry.key === sourceKey);
		if (!block || block.fileId === active.id) return;
		filesStore.updateContent(
			active.id,
			insertInclude(active.content, block.path, block.id, block.hash, block.body)
		);
		void refresh();
	}

	function current(report: LinkReport): LinkReport | null {
		const next = currentLinkReport(filesStore.library, report.include.fileId, report.include);
		if (!next) {
			notify.error(t('blocks.stale'));
			void refresh();
		}
		return next;
	}

	function apply(report: LinkReport, content: string | null): void {
		if (!content) {
			notify.error(t('blocks.stale'));
			void refresh();
			return;
		}
		filesStore.updateContent(report.include.fileId, content);
		void refresh();
	}

	function update(report: LinkReport) {
		const next = current(report);
		if (!next) return;
		if (next.state === 'missing' || next.state === 'cycle' || next.state === 'ambiguous') {
			notify.error(t('blocks.stale'));
			return;
		}
		const file = filesStore.library.find((entry) => entry.id === next.include.fileId);
		if (!file) return;
		apply(next, updateInclude(file.content, next.include, next.sourceBody));
	}

	function freeze(report: LinkReport) {
		const next = current(report);
		if (!next) return;
		const file = filesStore.library.find((entry) => entry.id === next.include.fileId);
		if (!file) return;
		apply(next, freezeInclude(file.content, next.include));
	}

	function detach(report: LinkReport) {
		const next = current(report);
		if (!next) return;
		const file = filesStore.library.find((entry) => entry.id === next.include.fileId);
		if (!file) return;
		apply(next, detachInclude(file.content, next.include));
	}

	function stateLabel(state: LinkReport['state']): string {
		return t(`blocks.state_${state}` as 'blocks.state_current');
	}
</script>

{#if open}
	<div class="blocks-backdrop">
		<div
			class="blocks-panel"
			role="dialog"
			aria-modal="true"
			aria-labelledby="blocks-title"
			tabindex="-1"
			use:focusTrap
			onkeydown={(event) => {
				if (event.key === 'Escape') onClose();
			}}
			data-testid="linked-blocks-panel"
		>
			<header>
				<h2 id="blocks-title">{t('blocks.title')}</h2>
				<button type="button" onclick={onClose} aria-label={t('settings.close')}
					><X size={16} /></button
				>
			</header>
			<div class="blocks-body">
				<section class="insert">
					<h3>{t('blocks.insert')}</h3>
					<p>{t('blocks.insertHelp')}</p>
					<div class="insert-row">
						<select
							bind:value={sourceKey}
							aria-label={t('blocks.source')}
							data-testid="blocks-source"
						>
							{#each blocks as block (block.key)}
								<option value={block.key}>{block.path} · {block.id}</option>
							{/each}
						</select>
						<button
							type="button"
							disabled={!active ||
								!sourceKey ||
								blocks.find((block) => block.key === sourceKey)?.fileId === active?.id}
							onclick={insert}
							data-testid="blocks-insert">{t('blocks.insertAction')}</button
						>
					</div>
					{#if active}<p class="note">{t('blocks.activeTarget', { path: activePath })}</p>{/if}
				</section>
				<section>
					<h3>{t('blocks.links')}</h3>
					{#each reports as report (report.include.fileId + report.include.from)}
						<article class="link" data-state={report.state} data-testid={`link-${report.state}`}>
							<header>
								<strong>{report.include.sourcePath} · {report.include.blockId}</strong>
								<em>{stateLabel(report.state)}</em>
							</header>
							<p class="path">{report.include.path}</p>
							<pre>{report.include.body}</pre>
							<div class="actions">
								<button
									type="button"
									disabled={report.state === 'missing' ||
										report.state === 'cycle' ||
										report.state === 'ambiguous'}
									onclick={() => update(report)}>{t('blocks.update')}</button
								>
								<button type="button" onclick={() => freeze(report)}>{t('blocks.freeze')}</button>
								<button type="button" onclick={() => detach(report)}>{t('blocks.detach')}</button>
							</div>
						</article>
					{:else}
						<p class="note">{t('blocks.empty')}</p>
					{/each}
				</section>
				<p class="note">{t('blocks.portable')}</p>
			</div>
		</div>
	</div>
{/if}

<style>
	.blocks-backdrop {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: grid;
		place-items: center;
		padding: 16px;
		background: rgb(0 0 0 / 0.55);
	}
	.blocks-panel {
		display: flex;
		max-height: calc(100dvh - 32px);
		width: min(100%, 760px);
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-bg-1);
		color: var(--color-fg);
		box-shadow: var(--shadow-lg);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--color-border);
	}
	h2 {
		margin: 0;
		font-size: 15px;
	}
	h3 {
		margin: 12px 0 4px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-fg-dim);
	}
	header button {
		min-width: 36px;
		min-height: 36px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--color-fg);
	}
	.blocks-body {
		min-height: 0;
		flex: 1;
		overflow-y: auto;
		padding: 0 16px 16px;
	}
	.insert-row {
		display: flex;
		gap: 6px;
	}
	.insert-row select {
		min-width: 0;
		flex: 1;
		min-height: 34px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
	}
	.insert-row button,
	.actions button {
		min-height: 34px;
		padding: 3px 9px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		font-size: 11px;
	}
	.link {
		margin: 8px 0;
		padding: 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
	}
	.link[data-state='changed'],
	.link[data-state='missing'],
	.link[data-state='cycle'] {
		border-color: var(--color-warning, #d19a66);
	}
	.link header {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding: 0;
		border: 0;
		font-size: 11px;
	}
	.link em {
		font-style: normal;
		color: var(--color-fg-muted);
	}
	.link pre {
		max-height: 120px;
		overflow: auto;
		white-space: pre-wrap;
		font-size: 11px;
	}
	.path,
	.note {
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
</style>
