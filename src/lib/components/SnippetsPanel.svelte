<script lang="ts">
	import { tick } from 'svelte';
	import { browser } from '$app/env';
	import { db, type ProjectRow, type SnippetRow } from '#lib/db.js';
	import { snippetsStore } from '#lib/snippets.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import { CODE_LANGUAGES, type CodeLanguageId } from '#lib/code/languages.js';
	import {
		parseSnippetExport,
		parseSnippetTags,
		resolveSnippetForCopy,
		searchSnippets,
		snippetLanguage,
		snippetLanguageFileName,
		snippetLanguageLabel,
		type SnippetCapture,
		type SnippetCopyContext,
		type SnippetSort
	} from '#lib/snippets.js';
	import { copyTextWithFallback } from '#lib/services/clipboard.js';
	import { triggerDownload } from '#lib/services/export.js';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { notify } from '#lib/notify.svelte.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import { reportError } from '#lib/report.js';
	import { IMPORT_LIMITS } from '#lib/config.js';
	import { Copy, Download, Pencil, Search, Star, Trash2, Upload, X } from '@lucide/svelte';

	interface Props {
		open: boolean;
		capture?: SnippetCapture | null;
		context?: SnippetCopyContext;
		onClose: () => void;
	}

	let { open, capture = null, context = {}, onClose }: Props = $props();

	let query = $state('');
	let favoritesOnly = $state(false);
	let folderFilter = $state('');
	let projectFilter = $state('');
	let sort = $state<SnippetSort>('updated');
	let selectedId = $state<string | null>(null);
	let mode = $state<'detail' | 'create'>('detail');
	let editingId = $state<string | null>(null);
	let formTitle = $state('');
	let formCode = $state('');
	let formLanguage = $state<CodeLanguageId>('plain');
	let formTags = $state('');
	let formFolder = $state('');
	let formProjectId = $state('');
	let formError = $state('');
	let status = $state('');
	let loading = $state(false);
	let loadError = $state(false);
	let projects = $state<ProjectRow[]>([]);
	let inputEl = $state<HTMLInputElement>();
	let titleEl = $state<HTMLInputElement>();
	let importInput = $state<HTMLInputElement>();
	let initialized = false;

	const result = $derived(
		searchSnippets(snippetsStore.rows, {
			query,
			favoritesOnly,
			folder: folderFilter || null,
			projectId: projectFilter || null,
			sort
		})
	);
	const selected = $derived<SnippetRow | null>(
		result.rows.find((row) => row.id === selectedId) ?? result.rows[0] ?? null
	);
	const projectNames = $derived(new Map(projects.map((project) => [project.id, project.name])));
	const folders = $derived(
		[
			...new Set(
				snippetsStore.rows.map((row) => row.folder).filter((folder): folder is string => !!folder)
			)
		].toSorted((left, right) => left.localeCompare(right))
	);
	const copyProjectName = $derived<string | undefined>(
		selected?.projectId
			? (projectNames.get(selected.projectId) ?? '')
			: context.projectId
				? projectNames.get(context.projectId)
				: context.projectName
	);
	const copyContext = $derived<SnippetCopyContext>({
		...(copyProjectName ? { projectName: copyProjectName } : {}),
		...(context.fileName ? { fileName: context.fileName } : {}),
		...(context.documentTitle ? { documentTitle: context.documentTitle } : {})
	});
	const resolved = $derived(
		selected ? resolveSnippetForCopy(selected.code, copyContext) : { text: '', unresolved: [] }
	);
	const duplicate = $derived(
		mode === 'create' && editingId === null
			? snippetsStore.findDuplicateCandidate(formCode, formLanguage)
			: null
	);

	$effect(() => {
		if (selected?.contentDeferred) void snippetsStore.contentFor(selected.id);
	});

	$effect(() => {
		if (!open) {
			initialized = false;
			return;
		}
		if (initialized) return;
		initialized = true;
		void initialize();
	});

	$effect(() => {
		if (selected && selectedId !== selected.id) selectedId = selected.id;
	});

	async function initialize() {
		await loadData();
		if (capture) {
			startCreate(capture);
		} else {
			await tick();
			inputEl?.focus();
		}
	}

	async function loadData() {
		if (!browser) return;
		loading = true;
		loadError = false;
		try {
			await snippetsStore.load();
			projects = await db.projects.orderBy('updatedAt').reverse().toArray();
		} catch (error) {
			loadError = true;
			reportError('snippet load', error, { notifyUser: t('snippets.loadError') });
		} finally {
			loading = false;
		}
	}

	function stripExtension(name: string | undefined): string {
		return (name ?? '').replace(/\.[a-z0-9]{1,12}$/i, '');
	}

	function suggestedTitle(source: SnippetCapture['source']): string {
		const name = stripExtension(context.fileName);
		if (!name)
			return t(source === 'selection' ? 'snippets.selectionFallback' : 'snippets.fileFallback');
		return t(source === 'selection' ? 'snippets.selectionTitle' : 'snippets.fileTitle', {
			name
		});
	}

	function startCreate(source: SnippetCapture) {
		mode = 'create';
		editingId = null;
		formTitle = source.title || suggestedTitle(source.source);
		formCode = source.code;
		formLanguage = snippetLanguage(undefined, source.fileName ?? context.fileName);
		formTags = '';
		formFolder = '';
		formProjectId = source.projectId ?? context.projectId ?? '';
		formError = source.code ? '' : t('snippets.fileMissing');
		status = '';
		void tick().then(() => titleEl?.focus());
	}

	function startNew() {
		mode = 'create';
		editingId = null;
		formTitle = '';
		formCode = '';
		formLanguage = snippetLanguage(undefined, context.fileName);
		formTags = '';
		formFolder = '';
		formProjectId = context.projectId ?? '';
		formError = '';
		status = '';
		void tick().then(() => titleEl?.focus());
	}

	function startEdit(row: SnippetRow) {
		mode = 'create';
		editingId = row.id;
		formTitle = row.title;
		formCode = row.code;
		formLanguage = snippetLanguage(row.language);
		formTags = row.tags.join(', ');
		formFolder = row.folder ?? '';
		formProjectId = row.projectId ?? '';
		formError = '';
		status = '';
		void tick().then(() => titleEl?.focus());
	}

	async function cancelEdit() {
		mode = 'detail';
		editingId = null;
		formError = '';
		await tick();
		inputEl?.focus();
	}

	async function saveForm() {
		formError = '';
		if (!formTitle.trim()) {
			formError = t('snippets.untitled');
			titleEl?.focus();
			return;
		}
		try {
			const saved = await snippetsStore.save(
				{
					title: formTitle,
					code: formCode,
					language: formLanguage,
					tags: parseSnippetTags(formTags),
					folder: formFolder,
					projectId: formProjectId
				},
				editingId
			);
			if (!saved.ok) {
				formError = t('snippets.duplicate', { title: saved.duplicate.title });
				return;
			}
			selectedId = saved.row.id;
			mode = 'detail';
			editingId = null;
			status = saved.updated ? t('snippets.updated') : t('snippets.saved');
			notify.success(status);
			await tick();
			inputEl?.focus();
		} catch (error) {
			reportError('snippet save', error);
			formError = t('snippets.loadError');
		}
	}

	async function copySelected() {
		if (!selected) return;
		const text = resolveSnippetForCopy(selected.code, copyContext).text;
		const copied = await copyTextWithFallback(text);
		status = copied ? t('snippets.copied') : t('snippets.copyFailed');
		if (copied) notify.success(status);
		else notify.error(status);
	}

	async function toggleFavorite(row: SnippetRow) {
		await snippetsStore.toggleFavorite(row.id);
	}

	async function removeSelected() {
		if (!selected) return;
		const confirmed = await promptStore.confirm({
			title: t('snippets.deleteConfirm'),
			message: t('snippets.deleteMessage'),
			danger: true
		});
		if (!confirmed) return;
		if (await snippetsStore.delete(selected.id)) {
			selectedId = null;
			status = t('snippets.deleted');
			notify.success(status);
		}
		await tick();
		inputEl?.focus();
	}

	function moveSelection(step: number) {
		if (result.rows.length === 0) return;
		const current = Math.max(
			0,
			result.rows.findIndex((row) => row.id === selected?.id)
		);
		const next = Math.min(Math.max(current + step, 0), result.rows.length - 1);
		selectedId = result.rows[next]!.id;
	}

	function handleSearchKey(event: KeyboardEvent) {
		if (event.isComposing || event.defaultPrevented) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveSelection(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveSelection(-1);
		} else if (event.key === 'Enter' && selected) {
			event.preventDefault();
			if (event.shiftKey) startEdit(selected);
			else void copySelected();
		}
	}

	async function exportSnippets() {
		const stamp = new Date().toISOString().slice(0, 10);
		const blob = new Blob([await snippetsStore.exportJson()], {
			type: 'application/json;charset=utf-8'
		});
		const exported = await triggerDownload(blob, `deckmark-snippets-${stamp}.json`);
		if (exported) {
			status = t('snippets.exported');
			notify.success(status);
		}
	}

	async function importSnippets(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		if (file.size > IMPORT_LIMITS.maxBatchBytes) {
			notify.error(t('snippets.exportTooLarge'));
			return;
		}
		try {
			const rows = parseSnippetExport(await file.text());
			const count = await snippetsStore.importRows(rows);
			status = t('snippets.imported', { n: count });
			notify.success(status);
			await tick();
			inputEl?.focus();
		} catch (error) {
			notify.error(error instanceof Error ? error.message : t('snippets.importFailed'));
		}
	}

	function projectLabel(row: SnippetRow): string | null {
		if (!row.projectId) return null;
		return projectNames.get(row.projectId) ?? t('snippets.unknownProject');
	}

	function languageName(id: string): string {
		return CODE_LANGUAGES.find((language) => language.id === id)?.label ?? snippetLanguageLabel(id);
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-2 sm:items-start sm:p-4 sm:pt-[max(env(safe-area-inset-top),6vh)]"
		style:padding-left="max(env(safe-area-inset-left), 0.5rem)"
		style:padding-right="max(env(safe-area-inset-right), 0.5rem)"
		role="dialog"
		aria-modal="true"
		aria-labelledby="snippets-title"
		tabindex="-1"
		inert={promptStore.open}
		aria-hidden={promptStore.open ? 'true' : undefined}
		data-testid="snippets-dialog"
		use:focusTrap
		onclick={(event) => {
			if (event.target === event.currentTarget && !promptStore.open) onClose();
		}}
		onkeydown={(event) => {
			if (event.key === 'Escape' && !promptStore.open && mode === 'detail') {
				event.stopPropagation();
				onClose();
			} else if (event.key === 'Escape' && mode === 'create') {
				event.preventDefault();
				void cancelEdit();
			}
		}}
	>
		<section
			class="mdsh-dialog-panel flex h-full max-h-[96dvh] w-full max-w-5xl flex-col overflow-hidden border border-border bg-bg-1 text-fg shadow-xl sm:h-auto sm:max-h-[86dvh] md:flex-row"
			aria-busy={loading}
		>
			<div class="flex min-h-0 min-w-0 flex-col md:w-[46%] md:border-r md:border-border">
				<header class="flex items-center gap-2 border-b border-border px-3 py-2">
					<h2 id="snippets-title" class="min-w-0 flex-1 truncate text-sm font-medium">
						{t('snippets.title')}
						<span class="text-fg-muted">({snippetsStore.rows.length})</span>
					</h2>
					<button
						type="button"
						class="min-h-10 rounded border border-border px-2 text-xs"
						onclick={startNew}
						data-testid="snippet-new">{t('snippets.new')}</button
					>
					<button
						type="button"
						class="min-h-10 rounded border border-border px-2 text-xs"
						onclick={() => importInput?.click()}
						data-testid="snippet-import"
						title={t('snippets.importHint')}
						aria-label={t('snippets.import')}
					>
						<Upload size={14} />
					</button>
					<button
						type="button"
						class="min-h-10 rounded border border-border px-2 text-xs"
						onclick={() => void exportSnippets()}
						data-testid="snippet-export"
						title={t('snippets.exportHint')}
						aria-label={t('snippets.export')}
					>
						<Download size={14} />
					</button>
					<button
						type="button"
						class="min-h-10 rounded p-2"
						onclick={onClose}
						aria-label={t('snippets.close')}
					>
						<X size={16} />
					</button>
					<input
						bind:this={importInput}
						type="file"
						accept="application/json,.json"
						class="hidden"
						onchange={importSnippets}
					/>
				</header>

				{#if loadError}
					<div class="border-b border-border p-3 text-xs text-danger" role="alert">
						{t('snippets.loadError')}
						<button type="button" class="underline" onclick={() => void loadData()}>
							{t('snippets.loading')}
						</button>
					</div>
				{/if}

				<div class="border-b border-border p-3">
					<label class="flex items-center gap-2">
						<Search size={16} aria-hidden="true" />
						<input
							bind:this={inputEl}
							bind:value={query}
							onkeydown={handleSearchKey}
							type="text"
							class="min-w-0 flex-1 rounded border border-border bg-bg px-3 py-2 text-sm"
							placeholder={t('snippets.search')}
							aria-label={t('snippets.searchLabel')}
							role="combobox"
							aria-controls="snippet-listbox"
							aria-expanded={result.rows.length > 0}
							aria-autocomplete="list"
							aria-activedescendant={selected ? `snippet-opt-${selected.id}` : undefined}
							autocomplete="off"
							spellcheck="false"
							data-testid="snippet-search"
						/>
					</label>
					<p class="mt-1 text-[11px] text-fg-muted">{t('snippets.keyboardHint')}</p>
				</div>

				<div
					class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2"
					role="group"
					aria-label={t('snippets.filters')}
				>
					<button
						type="button"
						class="min-h-9 rounded border border-border px-2 text-xs"
						class:text-accent={favoritesOnly}
						aria-pressed={favoritesOnly}
						onclick={() => (favoritesOnly = !favoritesOnly)}
						data-testid="snippet-favorites-filter"
						aria-label={t('snippets.favoritesOnly')}
					>
						<Star size={14} aria-hidden="true" />
					</button>
					<select
						bind:value={folderFilter}
						class="min-h-9 min-w-0 rounded border border-border bg-bg px-2 text-xs"
						aria-label={t('snippets.folderFilter')}
						data-testid="snippet-folder-filter"
					>
						<option value="">{t('snippets.allFolders')}</option>
						{#each folders as folder (folder)}
							<option value={folder}>{folder}</option>
						{/each}
					</select>
					<select
						bind:value={projectFilter}
						class="min-h-9 min-w-0 rounded border border-border bg-bg px-2 text-xs"
						aria-label={t('snippets.projectFilter')}
						data-testid="snippet-project-filter"
					>
						<option value="">{t('snippets.allProjects')}</option>
						{#each projects as project (project.id)}
							<option value={project.id}>{project.name}</option>
						{/each}
					</select>
					<select
						bind:value={sort}
						class="min-h-9 min-w-0 rounded border border-border bg-bg px-2 text-xs"
						aria-label={t('snippets.sort')}
						data-testid="snippet-sort"
					>
						<option value="updated">{t('snippets.sortUpdated')}</option>
						<option value="title">{t('snippets.sortTitle')}</option>
						<option value="language">{t('snippets.sortLanguage')}</option>
					</select>
				</div>

				<div class="min-h-0 flex-1 overflow-y-auto">
					{#if snippetsStore.rows.length === 0 && !loading}
						<p class="p-6 text-center text-sm text-fg-muted" data-testid="snippet-empty">
							{t('snippets.empty')}
						</p>
					{:else if result.rows.length === 0}
						<p class="p-6 text-center text-sm text-fg-muted" data-testid="snippet-no-match">
							{t('snippets.noMatch')}
						</p>
					{:else}
						<ul id="snippet-listbox" role="listbox" aria-label={t('snippets.listLabel')}>
							{#each result.rows as row, index (row.id)}
								<li
									id={`snippet-opt-${row.id}`}
									role="option"
									aria-selected={selected?.id === row.id}
									tabindex="-1"
									class="snippet-row flex cursor-pointer items-start gap-2 border-b border-border px-3 py-2"
									class:bg-bg-2={selected?.id === row.id}
									data-testid="snippet-row"
									onclick={() => (selectedId = row.id)}
									onkeydown={(event) => {
										if (event.key === 'Enter') {
											event.preventDefault();
											selectedId = row.id;
											void copySelected();
										}
									}}
									onmouseenter={() => (selectedId = row.id)}
								>
									<span
										class="w-5 shrink-0 pt-0.5 font-mono text-[9px] text-fg-dim"
										aria-hidden="true">{(index + 1).toString().padStart(2, '0')}</span
									>
									<span class="min-w-0 flex-1">
										<span class="flex items-center gap-1.5">
											<span class="min-w-0 truncate text-sm font-medium">{row.title}</span>
											{#if row.favorite}
												<Star
													size={12}
													class="shrink-0 text-accent"
													aria-label={t('snippets.favorite')}
												/>
											{/if}
										</span>
										<span class="mt-0.5 flex flex-wrap gap-1 text-[11px] text-fg-muted">
											<span>{languageName(row.language)}</span>
											{#if row.folder}<span>· {row.folder}</span>{/if}
											{#if projectLabel(row)}<span>· {projectLabel(row)}</span>{/if}
											{#each row.tags as tag (tag)}<span>· #{tag}</span>{/each}
										</span>
									</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
				<p class="border-t border-border px-3 py-1.5 text-[11px] text-fg-muted" role="status">
					{t('snippets.resultCount', { shown: result.rows.length, total: result.total })}
				</p>
			</div>

			<div class="flex min-h-0 min-w-0 flex-1 flex-col md:w-[54%]">
				{#if mode === 'create'}
					<form
						class="flex min-h-0 flex-1 flex-col overflow-y-auto"
						onsubmit={(event) => {
							event.preventDefault();
							void saveForm();
						}}
						data-testid="snippet-form"
					>
						<div class="grid gap-2 border-b border-border p-3 sm:grid-cols-2">
							<label class="flex flex-col gap-1 text-xs sm:col-span-2">
								<span>{t('snippets.titleLabel')}</span>
								<input
									bind:this={titleEl}
									bind:value={formTitle}
									class="min-h-10 rounded border border-border bg-bg px-3 py-2 text-sm"
									placeholder={t('snippets.titlePlaceholder')}
									aria-label={t('snippets.titleLabel')}
									data-testid="snippet-title"
								/>
							</label>
							<label class="flex flex-col gap-1 text-xs">
								<span>{t('snippets.language')}</span>
								<select
									bind:value={formLanguage}
									class="min-h-10 rounded border border-border bg-bg px-2 text-sm"
									aria-label={t('snippets.language')}
									data-testid="snippet-language"
								>
									{#each CODE_LANGUAGES as language (language.id)}
										<option value={language.id}>{language.label}</option>
									{/each}
								</select>
							</label>
							<label class="flex flex-col gap-1 text-xs">
								<span>{t('snippets.tags')}</span>
								<input
									bind:value={formTags}
									class="min-h-10 rounded border border-border bg-bg px-3 py-2 text-sm"
									placeholder={t('snippets.tagsPlaceholder')}
									aria-label={t('snippets.tags')}
									data-testid="snippet-tags"
								/>
							</label>
							<label class="flex flex-col gap-1 text-xs">
								<span>{t('snippets.folder')}</span>
								<input
									bind:value={formFolder}
									class="min-h-10 rounded border border-border bg-bg px-3 py-2 text-sm"
									placeholder={t('snippets.folderPlaceholder')}
									aria-label={t('snippets.folder')}
									data-testid="snippet-folder"
								/>
							</label>
							<label class="flex flex-col gap-1 text-xs">
								<span>{t('snippets.project')}</span>
								<select
									bind:value={formProjectId}
									class="min-h-10 rounded border border-border bg-bg px-2 text-sm"
									aria-label={t('snippets.project')}
									data-testid="snippet-project"
								>
									<option value="">{t('snippets.noProject')}</option>
									{#each projects as project (project.id)}
										<option value={project.id}>{project.name}</option>
									{/each}
								</select>
							</label>
						</div>
						<div class="flex min-h-0 flex-1 flex-col p-3">
							<span class="mb-1 text-xs">{t('snippets.code')}</span>
							<div
								class="min-h-[220px] flex-1 overflow-hidden rounded border border-border"
								data-testid="snippet-code"
							>
								{#key `${editingId ?? 'new'}-${formLanguage}`}
									{#await import('./CodeEditor.svelte') then module}
										<module.default
											fileId={`snippet-form-${editingId ?? 'new'}`}
											name={snippetLanguageFileName(formLanguage)}
											content={formCode}
											onChange={(text) => (formCode = text)}
										/>
									{:catch}
										<p class="p-3 text-sm text-danger" role="alert">
											{t('source.loadErrorTitle')}
										</p>
									{/await}
								{/key}
							</div>
							{#if formError || duplicate}
								<p class="mt-2 text-xs text-danger" role="alert" data-testid="snippet-form-error">
									{formError || t('snippets.duplicate', { title: duplicate?.title ?? '' })}
								</p>
							{/if}
						</div>
						<div class="flex flex-wrap gap-2 border-t border-border p-3">
							<button
								type="submit"
								class="min-h-10 rounded border border-accent bg-accent px-3 text-sm text-bg"
								data-testid="snippet-save"
								>{editingId ? t('snippets.update') : t('snippets.save')}</button
							>
							<button
								type="button"
								class="min-h-10 rounded border border-border px-3 text-sm"
								onclick={() => void cancelEdit()}
								data-testid="snippet-cancel">{t('snippets.cancel')}</button
							>
						</div>
					</form>
				{:else if selected}
					<div class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="snippet-detail">
						<header class="flex flex-wrap items-start gap-2 border-b border-border p-3">
							<div class="min-w-0 flex-1">
								<h3 class="truncate text-base font-medium" data-testid="snippet-detail-title">
									{selected.title}
								</h3>
								<p class="mt-0.5 flex flex-wrap gap-1 text-xs text-fg-muted">
									<span>{languageName(selected.language)}</span>
									{#if selected.folder}<span>· {selected.folder}</span>{/if}
									{#if projectLabel(selected)}<span>· {projectLabel(selected)}</span>{/if}
									{#if selected.tags.length === 0}<span>· {t('snippets.tagsNone')}</span>{/if}
									{#each selected.tags as tag (tag)}<span>· #{tag}</span>{/each}
								</p>
							</div>
							<div class="flex flex-wrap gap-1">
								<button
									type="button"
									class="min-h-10 rounded border border-border px-2"
									class:text-accent={selected.favorite}
									aria-pressed={selected.favorite}
									aria-label={t(selected.favorite ? 'snippets.unfavorite' : 'snippets.favorite')}
									onclick={() => void toggleFavorite(selected)}
									data-testid="snippet-favorite"
								>
									<Star size={16} aria-hidden="true" />
								</button>
								<button
									type="button"
									class="min-h-10 rounded border border-border px-2"
									aria-label={t('snippets.edit')}
									onclick={() => startEdit(selected)}
									data-testid="snippet-edit"
								>
									<Pencil size={16} />
								</button>
								<button
									type="button"
									class="min-h-10 rounded border border-border px-2 text-danger"
									aria-label={t('snippets.delete')}
									onclick={() => void removeSelected()}
									data-testid="snippet-delete"
								>
									<Trash2 size={16} />
								</button>
								<button
									type="button"
									class="min-h-10 rounded border border-accent bg-accent px-3 text-sm text-bg"
									onclick={() => void copySelected()}
									data-testid="snippet-copy"
								>
									<Copy size={14} class="inline" aria-hidden="true" />
									{t('snippets.copy')}
								</button>
							</div>
						</header>
						<div class="flex min-h-[220px] flex-1 flex-col p-3">
							<div class="min-h-0 flex-1 overflow-hidden rounded border border-border">
								{#key selected.id}
									{#await import('./CodeEditor.svelte') then module}
										<module.default
											fileId={`snippet-preview-${selected.id}`}
											name={snippetLanguageFileName(selected.language)}
											content={selected.code}
											readonly
											onChange={() => {}}
										/>
									{:catch}
										<p class="p-3 text-sm text-danger" role="alert">
											{t('source.loadErrorTitle')}
										</p>
									{/await}
								{/key}
							</div>
							<h4 class="mb-1 mt-3 text-xs font-medium">{t('snippets.placeholderPreview')}</h4>
							<pre
								class="max-h-40 overflow-auto rounded border border-border bg-bg p-2 font-mono text-xs whitespace-pre-wrap"
								data-testid="snippet-resolved">{resolved.text}</pre>
							<p class="mt-1 text-[11px] text-fg-muted">{t('snippets.variables')}</p>
							{#if resolved.unresolved.length > 0}
								<p class="mt-1 text-[11px] text-danger" role="status">
									{t('snippets.unresolved', { names: resolved.unresolved.join(', ') })}
								</p>
							{/if}
							<p class="mt-1 text-[11px] text-fg-muted">{t('snippets.escapeHint')}</p>
							{#if status}
								<p class="mt-2 text-xs text-accent" role="status" data-testid="snippet-status">
									{status}
								</p>
							{/if}
						</div>
					</div>
				{:else}
					<p class="p-6 text-center text-sm text-fg-muted" data-testid="snippet-detail-empty">
						{t('snippets.empty')}
					</p>
				{/if}
			</div>
		</section>
	</div>
{/if}

<style>
	.snippet-row {
		min-height: 44px;
	}
	.snippet-row:hover,
	.snippet-row[aria-selected='true'] {
		background: var(--color-bg-2);
	}
	.snippet-row:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}
	@media (max-width: 767px) {
		.snippet-row {
			min-height: 48px;
		}
	}
</style>
