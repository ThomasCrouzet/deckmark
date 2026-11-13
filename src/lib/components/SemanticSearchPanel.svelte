<script lang="ts">
	import { onMount } from 'svelte';
	import { X } from '@lucide/svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { db } from '#lib/db.js';
	import {
		clearScope,
		compatibleRows,
		corpusRevision,
		featureModel,
		indexFiles,
		revisionHash,
		scopeKey,
		scopedRows,
		search,
		SEMANTIC_MODELS,
		type Embedder,
		type SemanticHit,
		type SemanticModelId,
		cachedCooccurrenceEmbedder
	} from '#lib/semantic-search.js';
	import { LatestOnly } from '#lib/semantic-search-query.js';
	import { readPreference, writePreference } from '#lib/misc-2.js';
	import { reportError } from '#lib/report.js';
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
	let clearFailed = $state(false);
	let preferenceWarning = $state(false);
	let countError = $state(false);
	let indexError = $state(false);
	let searchError = $state(false);

	/** Latest query and latest count read. An older read cannot publish. */
	const searchJob = new LatestOnly();
	const countJob = new LatestOnly();
	const indexJob = new LatestOnly();
	let trainedEmbedder: { key: string; embedder: Embedder } | null = null;
	// Wide source revisions keyed by content identity, so repeated queries do
	// not rescan every loaded body.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- Non-reactive query cache.
	const contentRevisions = new Map<string, { content: string; revision: string }>();

	onMount(() => {
		enabled = readPreference(KEY) === '1';
		const savedModel = readPreference('mdsh:semantic-model');
		modelId = savedModel === 'cooccurrence-v1' ? 'cooccurrence-v1' : 'feature-hash-v1';
		projectId = filesStore.active?.projectId ?? null;
		if (enabled) void loadCount();
	});

	$effect(() => {
		// A closed panel must not publish a late read when it opens again.
		if (!open) {
			searchJob.invalidate();
			countJob.invalidate();
			indexJob.invalidate();
			countError = false;
			indexError = false;
			searchError = false;
		}
	});

	function inScope(file: FileItem, scope: string | null): boolean {
		return scope ? file.projectId === scope : !file.projectId;
	}

	function scopeFiles(scope: string | null): FileItem[] {
		return filesStore.library.filter((file) => inScope(file, scope));
	}

	function fileRevision(file: FileItem): string {
		const cached = contentRevisions.get(file.id);
		if (cached && cached.content === file.content) return cached.revision;
		const revision = revisionHash(file.content);
		contentRevisions.set(file.id, { content: file.content, revision });
		return revision;
	}

	/**
	 * Cheap scope revision. A document edit or cross-tab reload changes
	 * `updatedAt`, so an in-flight query can detect that its snapshot is old
	 * without hashing every body on each keystroke.
	 */
	function scopeSignature(scope: string | null): string {
		return `${scopeKey(scope)}|${scopeFiles(scope)
			.map((file) => `${file.id}:${file.updatedAt}`)
			.join(',')}`;
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
		const corpusKey = corpusRevision(scopeKey(scope), files);
		const trained = cachedCooccurrenceEmbedder(
			corpusKey,
			files.map((file) => file.content)
		);
		trainedEmbedder = { key, embedder: trained };
		return trained;
	}

	function isCurrentSource(
		row: { draftId: string; sourceRevision?: string; updatedAt: number },
		file: FileItem | undefined,
		scope: string | null
	): boolean {
		if (!file || !inScope(file, scope)) return false;
		// Rows written before the wide revision existed cannot prove reuse.
		if (!row.sourceRevision) return false;
		// A loaded body gives the exact wide source revision. A deferred body is
		// in storage: its write time must not be later than the index row.
		if (!file.contentDeferred) return fileRevision(file) === row.sourceRevision;
		return file.updatedAt <= row.updatedAt;
	}

	async function loadCount() {
		const token = countJob.begin();
		const scope = projectId;
		try {
			const rows = await scopedRows(db.semanticIndex, scope);
			if (!countJob.isCurrent(token) || scope !== projectId) return;
			count = rows.length;
			countError = false;
		} catch (failure) {
			// A superseded read must not publish its failure.
			if (!countJob.isCurrent(token) || scope !== projectId) return;
			countError = true;
			reportError('semantic index count', failure);
		}
	}

	function setEnabled(value: boolean) {
		enabled = value;
		preferenceWarning = !writePreference(KEY, value ? '1' : '0');
		searchJob.invalidate();
		countJob.invalidate();
		indexJob.invalidate();
		clearFailed = false;
		countError = false;
		indexError = false;
		searchError = false;
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
		indexJob.invalidate();
		results = [];
		staleRows = 0;
		incompatibleRows = 0;
		clearFailed = false;
		countError = false;
		indexError = false;
		searchError = false;
		// Retain the saved trained model if the scope corpus did not change.
		void loadCount();
		if (query.trim()) void runSearch();
	}

	function changeModel() {
		preferenceWarning = !writePreference('mdsh:semantic-model', modelId);
		searchJob.invalidate();
		indexJob.invalidate();
		staleRows = 0;
		incompatibleRows = 0;
		indexError = false;
		searchError = false;
		void runSearch();
	}

	async function buildIndex() {
		if (!enabled || indexing) return;
		const token = indexJob.begin();
		const scope = projectId;
		const model = modelId;
		const signature = scopeSignature(scope);
		const current = () =>
			indexJob.isCurrent(token) &&
			enabled &&
			open &&
			scope === projectId &&
			model === modelId &&
			signature === scopeSignature(scope);
		indexing = true;
		indexError = false;
		// A search that started before the rebuild must not republish.
		searchJob.invalidate();
		countJob.invalidate();
		try {
			const files = scopeFiles(scope);
			await hydrate(files);
			if (!current()) return;
			const embedder = await resolveEmbedder(scope, signature, model);
			if (!current()) return;
			const existing = await scopedRows(db.semanticIndex, scope);
			if (!current()) return;
			const rows = indexFiles(files, existing, scope, embedder);
			await db.transaction('rw', db.semanticIndex, async () => {
				if (!current()) throw new Error('Semantic index build superseded');
				await clearScope(db.semanticIndex, scope);
				if (!current()) throw new Error('Semantic index build superseded');
				if (rows.length) await db.semanticIndex.bulkPut($state.snapshot(rows));
				if (!current()) throw new Error('Semantic index build superseded');
			});
			if (!current()) return;
			searchJob.invalidate();
			countJob.invalidate();
			if (scope === projectId) {
				count = rows.length;
				staleRows = 0;
				incompatibleRows = 0;
				searchError = false;
				if (query.trim()) void runSearch();
			}
		} catch (failure) {
			// The transaction rolls back the clear, so committed rows survive.
			if (current()) {
				indexError = true;
				reportError('semantic index build', failure);
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
		try {
			const embedder = await resolveEmbedder(scope, signature, model);
			if (!searchJob.isCurrent(token)) return;
			if (
				scope !== projectId ||
				text !== query ||
				model !== modelId ||
				signature !== scopeSignature(projectId)
			)
				return;
			const rows = await scopedRows(db.semanticIndex, scope);
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
			searchError = false;
		} catch (failure) {
			// Keep the last usable results. Publish the failure only when this
			// query is still the current one.
			if (!searchJob.isCurrent(token)) return;
			if (
				scope !== projectId ||
				text !== query ||
				model !== modelId ||
				signature !== scopeSignature(projectId)
			)
				return;
			searchError = true;
			reportError('semantic search', failure);
		}
	}

	async function clearIndex() {
		if (!enabled || indexing) return;
		const scope = projectId;
		clearFailed = false;
		// Pending reads may still return rows that this action deletes.
		searchJob.invalidate();
		countJob.invalidate();
		try {
			await clearScope(db.semanticIndex, scope);
		} catch {
			if (scope === projectId) clearFailed = true;
			return;
		}
		if (scope === projectId) {
			results = [];
			count = 0;
			staleRows = 0;
			incompatibleRows = 0;
			searchError = false;
		}
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
				{#if preferenceWarning}
					<p class="note" role="status" data-testid="semantic-preference-note">
						{t('semantic.preferenceNote')}
					</p>
				{/if}
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
						<button
							type="button"
							disabled={indexing}
							onclick={() => void clearIndex()}
							data-testid="semantic-clear"
						>
							{t('semantic.clear')}
						</button>
						<span role="status">{t('semantic.count', { n: count })}</span>
					</div>
					{#if clearFailed}
						<p class="note" role="alert">{t('semantic.clearError')}</p>
					{/if}
					{#if countError}
						<div class="note error" data-testid="semantic-count-error" role="alert">
							<span>{t('semantic.countError')}</span>
							<button
								type="button"
								data-testid="semantic-count-retry"
								onclick={() => void loadCount()}
							>
								{t('semantic.countRetry')}
							</button>
						</div>
					{/if}
					{#if indexError}
						<p class="note error" role="alert" data-testid="semantic-index-error">
							{t('semantic.indexError')}
						</p>
					{/if}
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
					{#if searchError}
						<p class="note error" role="alert" data-testid="semantic-search-error">
							{t('semantic.searchError')}
						</p>
					{/if}
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
	.note.error {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		color: var(--color-danger);
	}
	.note.error button {
		min-height: 28px;
		padding: 2px 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
	}
</style>
