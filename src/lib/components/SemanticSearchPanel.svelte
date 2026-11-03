<script lang="ts">
	import { onMount } from 'svelte';
	import { X } from '@lucide/svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { db } from '#lib/db.js';
	import { indexFiles, search, type SemanticHit } from '#lib/semantic-search.js';
	import { t } from '#lib/i18n/index.js';

	let {
		open,
		onClose,
		onOpenHit
	}: {
		open: boolean;
		onClose: () => void;
		onOpenHit?: (draftId: string, line: number) => void;
	} = $props();

	const KEY = 'mdsh:semantic-enabled';
	let enabled = $state(false);
	let indexing = $state(false);
	let query = $state('');
	let results = $state<SemanticHit[]>([]);
	let count = $state(0);
	let projectId = $state<string | null>(null);

	onMount(() => {
		enabled = localStorage.getItem(KEY) === '1';
		projectId = filesStore.active?.projectId ?? null;
		if (enabled) void loadCount();
	});

	async function loadCount() {
		const rows = await scopeRows();
		count = rows.length;
	}

	async function scopeRows() {
		const all = await db.semanticIndex.toArray();
		return all.filter((row) => (projectId ? row.projectId === projectId : row.projectId === null));
	}

	function setEnabled(value: boolean) {
		enabled = value;
		localStorage.setItem(KEY, value ? '1' : '0');
		if (!value) {
			results = [];
			count = 0;
		} else {
			void loadCount();
		}
	}

	async function buildIndex() {
		if (!enabled || indexing) return;
		indexing = true;
		try {
			const files = filesStore.library.filter((file) =>
				projectId ? file.projectId === projectId : !file.projectId
			);
			const existing = await scopeRows();
			const rows = indexFiles(files, existing, projectId);
			await db.transaction('rw', db.semanticIndex, async () => {
				if (projectId) await db.semanticIndex.where('projectId').equals(projectId).delete();
				else await db.semanticIndex.filter((row) => row.projectId === null).delete();
				if (rows.length) await db.semanticIndex.bulkPut($state.snapshot(rows));
			});
			count = rows.length;
		} finally {
			indexing = false;
		}
	}

	async function runSearch() {
		if (!enabled) return;
		results = search(await scopeRows(), query);
	}

	async function clearIndex() {
		await db.semanticIndex.clear();
		count = 0;
		results = [];
	}

	function openHit(hit: SemanticHit) {
		onOpenHit?.(hit.draftId, hit.line);
		onClose();
	}
</script>

{#if open}
	<div class="semantic-backdrop">
		<div
			class="semantic-panel"
			role="dialog"
			aria-modal="true"
			aria-labelledby="semantic-title"
			tabindex="-1"
			use:focusTrap
			onkeydown={(event) => {
				if (event.key === 'Escape') onClose();
			}}
			data-testid="semantic-panel"
		>
			<header>
				<h2 id="semantic-title">{t('semantic.title')}</h2>
				<button type="button" onclick={onClose} aria-label={t('settings.close')}
					><X size={16} /></button
				>
			</header>
			<div class="semantic-body">
				<label class="toggle">
					<input
						type="checkbox"
						checked={enabled}
						onchange={(event) => setEnabled(event.currentTarget.checked)}
						data-testid="semantic-enabled"
					/>
					<span>{t('semantic.enable')}</span>
				</label>
				<p class="note">{t('semantic.note')}</p>
				{#if enabled}
					<label>
						<span>{t('semantic.scope')}</span>
						<select
							bind:value={projectId}
							onchange={() => void loadCount()}
							data-testid="semantic-scope"
						>
							<option value={null}>{t('semantic.library')}</option>
							{#if filesStore.active?.projectId}
								<option value={filesStore.active.projectId}>{t('semantic.project')}</option>
							{/if}
						</select>
					</label>
					<div class="actions">
						<button
							type="button"
							disabled={indexing}
							onclick={() => void buildIndex()}
							data-testid="semantic-index"
						>
							{t('semantic.build')}
						</button>
						<button type="button" onclick={() => void clearIndex()} data-testid="semantic-clear">
							{t('semantic.clear')}
						</button>
						<span role="status">{t('semantic.count', { n: count })}</span>
					</div>
					<label>
						<span>{t('semantic.query')}</span>
						<input
							type="search"
							bind:value={query}
							oninput={() => void runSearch()}
							data-testid="semantic-query"
						/>
					</label>
					<ul class="results" aria-label={t('semantic.results')}>
						{#each results as hit (hit.draftId)}
							<li>
								<button type="button" onclick={() => openHit(hit)} data-testid="semantic-hit">
									<strong>{hit.path}</strong>
									<span>{t('semantic.line', { line: hit.line, score: hit.score.toFixed(2) })}</span>
									<small>{hit.text}</small>
								</button>
							</li>
						{:else}
							<li class="note">{query ? t('semantic.noResults') : t('semantic.prompt')}</li>
						{/each}
					</ul>
					<p class="note">{t('semantic.offline')}</p>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.semantic-backdrop {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: grid;
		place-items: center;
		padding: 16px;
		background: rgb(0 0 0 / 0.55);
	}
	.semantic-panel {
		display: flex;
		max-height: calc(100dvh - 32px);
		width: min(100%, 680px);
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
	header button {
		min-width: 36px;
		min-height: 36px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--color-fg);
	}
	.semantic-body {
		display: flex;
		min-height: 0;
		flex-direction: column;
		gap: 8px;
		overflow-y: auto;
		padding: 12px 16px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	label.toggle {
		flex-direction: row;
		align-items: center;
		gap: 6px;
	}
	label input[type='search'],
	label select {
		min-height: 34px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		padding: 2px 6px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		font-size: 11px;
	}
	.actions button {
		min-height: 32px;
		padding: 3px 9px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
	}
	.results {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.results button {
		display: flex;
		width: 100%;
		flex-direction: column;
		gap: 2px;
		padding: 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		text-align: left;
		font-size: 11px;
	}
	.results small {
		color: var(--color-fg-muted);
		white-space: pre-wrap;
	}
	.note {
		margin: 0;
		font-size: 11px;
		color: var(--color-fg-muted);
	}
</style>
