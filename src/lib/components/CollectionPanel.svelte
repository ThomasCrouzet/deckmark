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
		isCollectionAbort,
		readCollectionViews,
		saveCollectionViews,
		sortRows,
		type CollectionBuildStats,
		type CollectionRow,
		type CollectionView
	} from '#lib/collection.js';
	import { t } from '#lib/i18n/index.js';

	let { open, onClose }: { open: boolean; onClose: () => void } = $props();

	const ROW_HEIGHT = 30;
	const COLUMN_WIDTH = 140;
	const TITLE_WIDTH = 220;
	const ROW_OVERSCAN = 8;
	const COLUMN_OVERSCAN = 2;
	const MAX_RENDERED_ROWS = 200;
	const MAX_RENDERED_COLUMNS = 30;
	const BOARD_GROUP_LIMIT = 20;
	const BOARD_CARD_LIMIT = 20;

	let rows = $state<CollectionRow[]>([]);
	let loadState = $state<'loading' | 'ready' | 'error'>('loading');
	let error = $state('');
	let progress = $state({ done: 0, total: 0 });
	let query = $state('');
	let sortKey = $state('title');
	let sortDirection = $state<'asc' | 'desc'>('asc');
	let groupKey = $state('');
	let mode = $state<'table' | 'board'>('table');
	let viewName = $state('');
	let views = $state<CollectionView[]>([]);
	let selectedView = $state('');
	let tableScroll = $state<HTMLElement | null>(null);
	let scrollTop = $state(0);
	let scrollLeft = $state(0);
	let viewportHeight = $state(0);
	let viewportWidth = $state(0);
	let boardGroupLimit = $state(BOARD_GROUP_LIMIT);
	let boardCardLimit = $state(BOARD_CARD_LIMIT);

	const columns = $derived(collectionColumns(rows));
	const filtered = $derived(filterRows(rows, query));
	const sorted = $derived(sortRows(filtered, sortKey, sortDirection));
	const rowWindow = $derived.by(() => {
		const height = viewportHeight > 0 ? viewportHeight : ROW_HEIGHT * 20;
		const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_OVERSCAN);
		const count = Math.min(
			MAX_RENDERED_ROWS,
			Math.max(1, Math.ceil(height / ROW_HEIGHT) + ROW_OVERSCAN * 2)
		);
		const last = Math.min(sorted.length, first + count);
		return {
			first,
			last,
			rows: sorted.slice(first, last),
			top: first * ROW_HEIGHT,
			bottom: Math.max(0, (sorted.length - last) * ROW_HEIGHT)
		};
	});
	const columnWindow = $derived.by(() => {
		const width = viewportWidth > 0 ? viewportWidth : 800;
		const first = Math.max(
			0,
			Math.floor(Math.max(0, scrollLeft - TITLE_WIDTH) / COLUMN_WIDTH) - COLUMN_OVERSCAN
		);
		const count = Math.min(
			MAX_RENDERED_COLUMNS,
			Math.max(4, Math.ceil(width / COLUMN_WIDTH) + COLUMN_OVERSCAN * 2)
		);
		const last = Math.min(columns.length, first + count);
		return {
			first,
			last,
			columns: columns.slice(first, last),
			left: first * COLUMN_WIDTH,
			right: Math.max(0, (columns.length - last) * COLUMN_WIDTH)
		};
	});
	const allGroups = $derived(groupRows(sorted, groupKey));
	const visibleGroups = $derived(allGroups.slice(0, boardGroupLimit));
	const groups = $derived(
		visibleGroups.map((group) => ({ key: group.key, rows: group.rows.slice(0, boardCardLimit) }))
	);
	const hasMoreGroups = $derived(boardGroupLimit < allGroups.length);
	const hasMoreCards = $derived(
		allGroups.slice(0, boardGroupLimit).some((group) => group.rows.length > boardCardLimit)
	);

	$effect(() => {
		void query;
		void sortKey;
		void sortDirection;
		void groupKey;
		boardGroupLimit = BOARD_GROUP_LIMIT;
		boardCardLimit = BOARD_CARD_LIMIT;
		scrollTop = 0;
		if (tableScroll) tableScroll.scrollTop = 0;
	});

	$effect(() => {
		const element = tableScroll;
		if (!element) return;
		const update = () => {
			viewportHeight = element.clientHeight;
			viewportWidth = element.clientWidth;
			scrollTop = element.scrollTop;
			scrollLeft = element.scrollLeft;
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	});

	let loadJob = 0;
	let controller: AbortController | null = null;

	async function load() {
		const job = ++loadJob;
		controller?.abort();
		controller = new AbortController();
		const signal = controller.signal;
		const started = Date.now();
		loadState = 'loading';
		error = '';
		progress = { done: 0, total: filesStore.library.length };
		let lastStats: CollectionBuildStats | null = null;
		try {
			const value = await buildCollection(filesStore.library, {
				signal,
				onProgress: (done, total) => {
					if (job === loadJob) progress = { done, total };
				},
				onStats: (stats) => {
					lastStats = stats;
				}
			});
			if (job !== loadJob || signal.aborted) return;
			rows = value;
			loadState = 'ready';
			const stats = lastStats as CollectionBuildStats | null;
			if (stats !== null)
				exposeProfile({
					...stats,
					notes: filesStore.library.length,
					rows: value.length,
					columns: collectionColumns(value).length,
					durationMs: Date.now() - started
				});
		} catch (reason) {
			if (job !== loadJob || signal.aborted || isCollectionAbort(reason)) return;
			rows = [];
			error = reason instanceof Error ? reason.message : String(reason);
			loadState = 'error';
		}
	}

	function exposeProfile(stats: CollectionBuildStats & Record<string, number>) {
		if (import.meta.env.VITE_SOURCE_FIDELITY_METRICS !== '1' || typeof window === 'undefined')
			return;
		(
			window as unknown as {
				__mdshCollectionProfile?: CollectionBuildStats & Record<string, number>;
			}
		).__mdshCollectionProfile = stats;
	}

	function refreshOnFocus() {
		if (!open || loadState === 'loading') return;
		void load();
	}

	onMount(() => {
		views = readCollectionViews();
		void load();
		window.addEventListener('focus', refreshOnFocus);
		return () => {
			loadJob += 1;
			controller?.abort();
			controller = null;
			window.removeEventListener('focus', refreshOnFocus);
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
			<div class="collection-body" bind:this={tableScroll}>
				{#if loadState === 'loading'}
					<p role="status" data-testid="collection-progress">
						{t('collection.loading')}
						{#if progress.total > 0}({progress.done}/{progress.total}){/if}
					</p>
				{:else if loadState === 'error'}
					<div class="collection-error" role="alert" data-testid="collection-error">
						<p>{t('panels.loadFailed')}</p>
						{#if error}<pre>{error}</pre>{/if}
						<button type="button" onclick={() => void load()}>{t('source.retry')}</button>
					</div>
				{:else if sorted.length === 0}
					<p>{t('collection.empty')}</p>
				{:else if mode === 'table'}
					<div class="table-scroll">
						<table
							data-testid="collection-table"
							aria-rowcount={sorted.length + 1}
							aria-colcount={columns.length + 1}
						>
							<thead>
								<tr>
									<th scope="col" style={`width:${TITLE_WIDTH}px`}>{t('collection.titleColumn')}</th
									>
									{#if columnWindow.left > 0}
										<th class="spacer" style={`width:${columnWindow.left}px`} aria-hidden="true"
										></th>
									{/if}
									{#each columnWindow.columns as column (column)}
										<th scope="col" style={`width:${COLUMN_WIDTH}px`} title={column}>{column}</th>
									{/each}
									{#if columnWindow.right > 0}
										<th class="spacer" style={`width:${columnWindow.right}px`} aria-hidden="true"
										></th>
									{/if}
								</tr>
							</thead>
							<tbody>
								{#if rowWindow.top > 0}
									<tr class="spacer" aria-hidden="true">
										<td
											colspan={columnWindow.columns.length + 3}
											style={`height:${rowWindow.top}px`}
										></td>
									</tr>
								{/if}
								{#each rowWindow.rows as row, index (row.id)}
									<tr style={`height:${ROW_HEIGHT}px`} aria-rowindex={rowWindow.first + index + 2}>
										<th scope="row" style={`width:${TITLE_WIDTH}px`}>
											<button type="button" onclick={() => openRow(row)}>{row.title}</button>
										</th>
										{#if columnWindow.left > 0}
											<td class="spacer" style={`width:${columnWindow.left}px`} aria-hidden="true"
											></td>
										{/if}
										{#each columnWindow.columns as column (column)}
											<td style={`width:${COLUMN_WIDTH}px`} title={cell(row, column)}
												>{cell(row, column)}</td
											>
										{/each}
										{#if columnWindow.right > 0}
											<td class="spacer" style={`width:${columnWindow.right}px`} aria-hidden="true"
											></td>
										{/if}
									</tr>
								{/each}
								{#if rowWindow.bottom > 0}
									<tr class="spacer" aria-hidden="true">
										<td
											colspan={columnWindow.columns.length + 3}
											style={`height:${rowWindow.bottom}px`}
										></td>
									</tr>
								{/if}
							</tbody>
						</table>
					</div>
					<p class="collection-range">
						{rowWindow.first + 1}-{rowWindow.last} / {sorted.length}
						{#if columnWindow.first > 0 || columnWindow.last < columns.length}
							(columns {columnWindow.first + 1}-{columnWindow.last} / {columns.length})
						{/if}
					</p>
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
					{#if hasMoreGroups}
						<button
							type="button"
							class="collection-more"
							onclick={() => (boardGroupLimit += BOARD_GROUP_LIMIT)}
						>
							{t('library.loadMore', {
								n: Math.min(BOARD_GROUP_LIMIT, allGroups.length - boardGroupLimit)
							})}
						</button>
					{/if}
					{#if hasMoreCards}
						<button
							type="button"
							class="collection-more"
							onclick={() => (boardCardLimit += BOARD_CARD_LIMIT)}
						>
							{t('library.loadMore', {
								n: Math.min(
									BOARD_CARD_LIMIT,
									Math.max(
										...allGroups.slice(0, boardGroupLimit).map((group) => group.rows.length)
									) - boardCardLimit
								)
							})}
						</button>
					{/if}
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
	.collection-error {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
	}
	.collection-error button,
	.collection-more {
		min-height: 32px;
		padding: 3px 9px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
	}
	.table-scroll {
		overflow: visible;
	}
	table {
		table-layout: fixed;
		border-collapse: collapse;
		font-size: 12px;
	}
	table td,
	table th {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.spacer {
		border: 0;
		padding: 0;
	}
	.collection-range {
		margin: 6px 0 0;
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.collection-more {
		display: block;
		margin: 8px auto 0;
		font-size: 11px;
		color: var(--color-fg-muted);
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
