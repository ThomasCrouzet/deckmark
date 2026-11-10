<script lang="ts">
	import { onMount } from 'svelte';
	import { X } from '@lucide/svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { db } from '#lib/db.js';
	import {
		compatibleRows,
		featureModel,
		indexFiles,
		search,
		SEMANTIC_MODELS,
		type Embedder,
		type SemanticHit,
		type SemanticModelId,
		cachedCooccurrenceEmbedder
	} from '#lib/semantic-search.js';
	import { LatestOnly } from '#lib/semantic-search-query.js';
	import { contentHash } from '#lib/ai/patches.js';
	import { t } from '#lib/i18n/index.js';
	import type { FileItem } from '#lib/types.js';

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
	let modelId = $state<SemanticModelId>('feature-hash-v1');
	let incompatibleRows = $state(0);
	let staleRows = $state(0);

	/** Latest query and latest count read. An older read cannot publish. */
	const searchJob = new LatestOnly();
	const countJob = new LatestOnly();
	let trainedEmbedder: { key: string; embedder: Embedder } | null = null;
	// Hashes keyed by content identity, so repeated queries do not rescan every
	// loaded body while an exact content check stays available.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- Non-reactive query cache.
	const contentHashes = new Map<string, { content: string; hash: string }>();

	onMount(() => {
		enabled = localStorage.getItem(KEY) === '1';
		const savedModel = localStorage.getItem('mdsh:semantic-model');
		modelId = savedModel === 'cooccurrence-v1' ? 'cooccurrence-v1' : 'feature-hash-v1';
		projectId = filesStore.active?.projectId ?? null;
		if (enabled) void loadCount();
	});

	$effect(() => {
		// A closed panel must not publish a late read when it opens again.
		if (!open) {
			searchJob.invalidate();
			countJob.invalidate();
		}
	});

	function inScope(file: FileItem, scope: string | null): boolean {
		return scope ? file.projectId === scope : !file.projectId;
	}

	function scopeFiles(scope: string | null): FileItem[] {
		return filesStore.library.filter((file) => inScope(file, scope));
	}

	function fileHash(file: FileItem): string {
		const cached = contentHashes.get(file.id);
		if (cached && cached.content === file.content) return cached.hash;
		const hash = contentHash(file.content);
		contentHashes.set(file.id, { content: file.content, hash });
		return hash;
	}

	/**
	 * Cheap scope revision. A document edit or cross-tab reload changes
	 * `updatedAt`, so an in-flight query can detect that its snapshot is old
	 * without hashing every body on each keystroke.
	 */
	function scopeSignature(scope: string | null): string {
		return `${scope ?? 'library'}|${scopeFiles(scope)
			.map((file) => `${file.id}:${file.updatedAt}`)
			.join(',')}`;
	}

	async function scopeRows(scope: string | null) {
		if (scope) return db.semanticIndex.where('projectId').equals(scope).toArray();
		const all = await db.semanticIndex.toArray();
		return all.filter((row) => row.projectId === null);
	}

	async function hydrate(files: readonly FileItem[]): Promise<void> {
		await filesStore.ensureContent(
			files.filter((file) => file.contentDeferred).map((file) => file.id)
		);
	}

	async function resolveEmbedder(
		scope: string | null,
		signature: string,
		model: SemanticModelId
	): Promise<Embedder> {
		if (model === 'feature-hash-v1') return featureModel;
		const key = `${model}|${signature}`;
		if (trainedEmbedder?.key === key) return trainedEmbedder.embedder;
		const files = scopeFiles(scope);
		await hydrate(files);
		const corpusKey = `${scope ?? 'library'}|${files
			.map((file) => `${file.id}:${contentHash(file.content)}`)
			.join(',')}`;
		const trained = cachedCooccurrenceEmbedder(
			corpusKey,
			files.map((file) => file.content)
		);
		trainedEmbedder = { key, embedder: trained };
		return trained;
	}

	function isCurrentSource(
		row: { draftId: string; contentHash: string; updatedAt: number },
		file: FileItem | undefined,
		scope: string | null
	): boolean {
		if (!file || !inScope(file, scope)) return false;
		// A loaded body gives an exact byte comparison. A deferred body is in
		// storage: its write time must not be later than the index row.
		if (!file.contentDeferred) return fileHash(file) === row.contentHash;
		return file.updatedAt <= row.updatedAt;
	}

	async function loadCount() {
		const token = countJob.begin();
		const scope = projectId;
		const rows = await scopeRows(scope);
		if (!countJob.isCurrent(token) || scope !== projectId) return;
		count = rows.length;
	}

	function setEnabled(value: boolean) {
		enabled = value;
		localStorage.setItem(KEY, value ? '1' : '0');
		searchJob.invalidate();
		countJob.invalidate();
		if (!value) {
			results = [];
			count = 0;
			staleRows = 0;
			incompatibleRows = 0;
		} else {
			void loadCount();
		}
	}

	function changeScope() {
		searchJob.invalidate();
		countJob.invalidate();
		results = [];
		staleRows = 0;
		incompatibleRows = 0;
		// Retain the saved trained model if the scope corpus did not change.
		void loadCount();
		if (query.trim()) void runSearch();
	}

	function changeModel() {
		localStorage.setItem('mdsh:semantic-model', modelId);
		searchJob.invalidate();
		staleRows = 0;
		incompatibleRows = 0;
		void runSearch();
	}

	async function buildIndex() {
		if (!enabled || indexing) return;
		const scope = projectId;
		const model = modelId;
		const signature = scopeSignature(scope);
		indexing = true;
		// A search that started before the rebuild must not republish.
		searchJob.invalidate();
		countJob.invalidate();
		try {
			const files = scopeFiles(scope);
			await hydrate(files);
			const embedder = await resolveEmbedder(scope, signature, model);
			const existing = await scopeRows(scope);
			const rows = indexFiles(files, existing, scope, embedder);
			await db.transaction('rw', db.semanticIndex, async () => {
				if (scope) await db.semanticIndex.where('projectId').equals(scope).delete();
				else await db.semanticIndex.filter((row) => row.projectId === null).delete();
				if (rows.length) await db.semanticIndex.bulkPut($state.snapshot(rows));
			});
			searchJob.invalidate();
			countJob.invalidate();
			if (scope === projectId) {
				count = rows.length;
				staleRows = 0;
				incompatibleRows = 0;
				if (query.trim()) void runSearch();
			}
		} finally {
			indexing = false;
		}
	}

	async function runSearch() {
		if (!enabled) return;
		const token = searchJob.begin();
		const scope = projectId;
		const text = query;
		const model = modelId;
		const signature = scopeSignature(scope);
		const embedder = await resolveEmbedder(scope, signature, model);
		if (!searchJob.isCurrent(token)) return;
		if (
			scope !== projectId ||
			text !== query ||
			model !== modelId ||
			signature !== scopeSignature(projectId)
		)
			return;
		const rows = await scopeRows(scope);
		if (!searchJob.isCurrent(token)) return;
		if (
			scope !== projectId ||
			text !== query ||
			model !== modelId ||
			signature !== scopeSignature(projectId)
		)
			return;
		const files = new Map(scopeFiles(scope).map((file) => [file.id, file]));
		const compatible = compatibleRows(rows, embedder, (row) =>
			isCurrentSource(row, files.get(row.draftId), scope)
		);
		incompatibleRows = compatible.incompatible;
		staleRows = compatible.stale;
		results = search(compatible.rows, text, embedder);
	}

	async function clearIndex() {
		if (!enabled) return;
		// Pending reads may still return rows that this action deletes.
		searchJob.invalidate();
		countJob.invalidate();
		await db.semanticIndex.clear();
		results = [];
		count = 0;
		staleRows = 0;
		incompatibleRows = 0;
		// A query started during the delete read the old rows.
		searchJob.invalidate();
		countJob.invalidate();
		void loadCount();
		if (query.trim()) void runSearch();
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
						<select bind:value={projectId} onchange={changeScope} data-testid="semantic-scope">
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
						<span>{t('semantic.model')}</span>
						<select bind:value={modelId} onchange={changeModel} data-testid="semantic-model">
							{#each SEMANTIC_MODELS as model (model.id)}
								<option value={model.id}>{model.name} · {model.dims}</option>
							{/each}
						</select>
					</label>
					<p class="note">
						{SEMANTIC_MODELS.find((model) => model.id === modelId)?.description}
					</p>
					{#if incompatibleRows > 0}
						<p class="note" role="status">{t('semantic.rebuild')}</p>
					{:else if staleRows > 0}
						<p class="note" role="status">{t('semantic.stale')}</p>
					{/if}
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
