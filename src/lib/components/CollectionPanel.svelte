<script lang="ts">
	import { onMount } from 'svelte';
	import { X } from '@lucide/svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { filesStore } from '#lib/files.svelte.js';
	import {
		buildCollection,
		collectionColumns,
		filterRows,
		groupRows,
		readCollectionViews,
		saveCollectionViews,
		sortRows,
		type CollectionRow,
		type CollectionView
	} from '#lib/collection.js';
	import { t } from '#lib/i18n/index.js';

	let { open, onClose }: { open: boolean; onClose: () => void } = $props();

	let rows = $state<CollectionRow[]>([]);
	let loading = $state(true);
	let query = $state('');
	let sortKey = $state('title');
	let sortDirection = $state<'asc' | 'desc'>('asc');
	let groupKey = $state('');
	let mode = $state<'table' | 'board'>('table');
	let viewName = $state('');
	let views = $state<CollectionView[]>([]);
	let selectedView = $state('');

	const columns = $derived(collectionColumns(rows));
	const filtered = $derived(filterRows(rows, query));
	const PAGE_ROWS = 300;
	let visibleCount = $state(PAGE_ROWS);
	const sorted = $derived(sortRows(filtered, sortKey, sortDirection));
	const visibleRows = $derived(sorted.slice(0, visibleCount));
	const groups = $derived(groupRows(visibleRows, groupKey));
	const hasMore = $derived(visibleCount < sorted.length);

	$effect(() => {
		void query;
		void sortKey;
		void sortDirection;
		void groupKey;
		visibleCount = PAGE_ROWS;
	});

	let loadJob = 0;
	onMount(() => {
		views = readCollectionViews();
		const job = ++loadJob;
		void (async () => {
			try {
				await filesStore.ensureLibraryContent();
				if (job !== loadJob) return;
				const value = await buildCollection(filesStore.library);
				if (job !== loadJob) return;
				rows = value;
			} catch {
				if (job === loadJob) rows = [];
			} finally {
				if (job === loadJob) loading = false;
			}
		})();
		return () => {
			loadJob += 1;
		};
	});

	function openRow(row: CollectionRow) {
		filesStore.openDocument(row.id);
		onClose();
	}

	function cell(row: CollectionRow, key: string): string {
		if (key === 'title') return row.title;
		if (key === 'updatedAt') return new Date(row.updatedAt).toLocaleString();
		const value = row.values[key];
		if (value === undefined) return '';
		return Array.isArray(value) ? value.join(', ') : String(value);
	}

	function saveView() {
		if (!viewName.trim()) return;
		const view: CollectionView = {
			id: crypto.randomUUID(),
			name: viewName.trim(),
			filter: query,
			sortKey,
			sortDirection,
			groupKey,
			mode
		};
		views = [...views, view];
		saveCollectionViews(views);
		selectedView = view.id;
		viewName = '';
	}

	function applyView(id: string) {
		const view = views.find((entry) => entry.id === id);
		if (!view) return;
		query = view.filter;
		sortKey = view.sortKey;
		sortDirection = view.sortDirection;
		groupKey = view.groupKey;
		mode = view.mode;
	}

	function deleteView(id: string) {
		views = views.filter((entry) => entry.id !== id);
		saveCollectionViews(views);
		if (selectedView === id) selectedView = '';
	}
</script>

{#if open}
	<div class="collection-backdrop">
		<div
			class="collection-panel"
			role="dialog"
			aria-modal="true"
			aria-labelledby="collection-title"
			tabindex="-1"
			use:focusTrap
			onkeydown={(event) => {
				if (event.key === 'Escape') onClose();
			}}
			data-testid="collection-panel"
		>
			<header>
				<h2 id="collection-title">{t('collection.title')}</h2>
				<button type="button" onclick={onClose} aria-label={t('settings.close')}
					><X size={16} /></button
				>
			</header>
			<div class="collection-controls">
				<input
					type="search"
					bind:value={query}
					placeholder={t('collection.filter')}
					aria-label={t('collection.filter')}
					data-testid="collection-filter"
				/>
				<label>
					<span>{t('collection.sort')}</span>
					<select bind:value={sortKey} data-testid="collection-sort">
						<option value="title">{t('collection.titleColumn')}</option>
						<option value="updatedAt">{t('collection.updated')}</option>
						{#each columns as column (column)}<option value={column}>{column}</option>{/each}
					</select>
				</label>
				<button
					type="button"
					onclick={() => (sortDirection = sortDirection === 'asc' ? 'desc' : 'asc')}
					data-testid="collection-direction"
				>
					{sortDirection === 'asc' ? 'A-Z' : 'Z-A'}
				</button>
				<label>
					<span>{t('collection.group')}</span>
					<select bind:value={groupKey} data-testid="collection-group">
						<option value="">{t('collection.none')}</option>
						{#each columns as column (column)}<option value={column}>{column}</option>{/each}
					</select>
				</label>
				<div role="group" aria-label={t('collection.mode')}>
					<button type="button" aria-pressed={mode === 'table'} onclick={() => (mode = 'table')}>
						{t('collection.table')}
					</button>
					<button type="button" aria-pressed={mode === 'board'} onclick={() => (mode = 'board')}>
						{t('collection.board')}
					</button>
				</div>
			</div>
			<div class="collection-views">
				<select
					bind:value={selectedView}
					aria-label={t('collection.savedViews')}
					onchange={(event) => applyView(event.currentTarget.value)}
					data-testid="collection-views"
				>
					<option value="">{t('collection.savedViews')}</option>
					{#each views as view (view.id)}<option value={view.id}>{view.name}</option>{/each}
				</select>
				<input type="text" bind:value={viewName} placeholder={t('collection.viewName')} />
				<button type="button" onclick={saveView} data-testid="collection-save-view">
					{t('collection.saveView')}
				</button>
				{#if selectedView}
					<button type="button" onclick={() => deleteView(selectedView)}>
						{t('collection.deleteView')}
					</button>
				{/if}
			</div>
			<div class="collection-body">
				{#if loading}
					<p role="status">{t('collection.loading')}</p>
				{:else if sorted.length === 0}
					<p>{t('collection.empty')}</p>
				{:else if mode === 'table'}
					<div class="table-scroll">
						<table data-testid="collection-table">
							<thead>
								<tr>
									<th scope="col">{t('collection.titleColumn')}</th>
									{#each columns as column (column)}<th scope="col">{column}</th>{/each}
								</tr>
							</thead>
							<tbody>
								{#each visibleRows as row (row.id)}
									<tr>
										<th scope="row">
											<button type="button" onclick={() => openRow(row)}>{row.title}</button>
										</th>
										{#each columns as column (column)}<td>{cell(row, column)}</td>{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if hasMore}
						<button
							type="button"
							class="mx-auto my-3 block rounded border border-border px-3 py-1.5 text-xs text-fg-muted"
							onclick={() => (visibleCount += PAGE_ROWS)}
						>
							{t('library.loadMore', { n: Math.min(PAGE_ROWS, sorted.length - visibleCount) })}
						</button>
					{/if}
				{:else}
					<div class="board" data-testid="collection-board">
						{#each groups as group (group.key)}
							<section class="board-column">
								<h3>{group.key || t('collection.all')}</h3>
								{#each group.rows as row (row.id)}
									<button type="button" class="board-card" onclick={() => openRow(row)}>
										<strong>{row.title}</strong>
										{#each columns.slice(0, 3) as column (column)}
											<span>{column}: {cell(row, column)}</span>
										{/each}
									</button>
								{/each}
							</section>
						{/each}
					</div>
				{/if}
			</div>
			<p class="collection-note">{t('collection.note')}</p>
		</div>
	</div>
{/if}

<style>
	.collection-backdrop {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: grid;
		place-items: center;
		padding: 16px;
		background: rgb(0 0 0 / 0.55);
	}
	.collection-panel {
		display: flex;
		max-height: calc(100dvh - 32px);
		width: min(100%, 980px);
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
	.collection-controls,
	.collection-views {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 8px 16px;
		border-bottom: 1px solid var(--color-border);
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.collection-controls input,
	.collection-controls select,
	.collection-views input,
	.collection-views select {
		min-height: 32px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		padding: 2px 6px;
	}
	.collection-controls input[type='search'] {
		min-width: 180px;
		flex: 1;
	}
	.collection-controls button,
	.collection-views button {
		min-height: 32px;
		padding: 3px 9px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
	}
	.collection-controls button[aria-pressed='true'] {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}
	.collection-body {
		min-height: 0;
		flex: 1;
		overflow: auto;
		padding: 10px 16px;
	}
	.table-scroll {
		overflow: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	th,
	td {
		padding: 5px 8px;
		border-bottom: 1px solid var(--color-border);
		text-align: left;
		white-space: nowrap;
	}
	thead th {
		position: sticky;
		top: 0;
		background: var(--color-bg-2);
	}
	tbody th button {
		border: 0;
		background: transparent;
		color: var(--color-accent);
		text-align: left;
	}
	.board {
		display: flex;
		gap: 10px;
		overflow-x: auto;
		padding-bottom: 8px;
	}
	.board-column {
		min-width: 220px;
		flex: 0 0 240px;
	}
	.board-column h3 {
		margin: 0 0 6px;
		font-size: 12px;
	}
	.board-card {
		display: flex;
		width: 100%;
		flex-direction: column;
		gap: 3px;
		margin-bottom: 6px;
		padding: 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		font-size: 11px;
		text-align: left;
	}
	.board-card span {
		color: var(--color-fg-muted);
	}
	.collection-note {
		margin: 0;
		padding: 8px 16px;
		border-top: 1px solid var(--color-border);
		font-size: 11px;
		color: var(--color-fg-muted);
	}
</style>
