<script lang="ts">
	import { tick, onMount, untrack } from 'svelte';
	import { browser } from '$app/env';
	import { filesStore } from '#lib/files.svelte.js';
	import { t, type MessageKey } from '#lib/i18n/index.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import { notify } from '#lib/notify.svelte.js';
	import { reportError } from '#lib/report.js';
	import { reportPersistenceError } from '#lib/storage.js';
	import { commitReplacements } from '#lib/replacement-commit.js';
	import { replaceInFilesAsync } from '#lib/replace-worker.js';
	import type { Hit } from '#lib/types.js';
	import type { SearchRequest, SearchResponse } from '#lib/workers/search.worker.js';
	import { corpusFingerprint, SEARCH_MAX_HITS } from '#lib/search-core.js';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { Search, X, CaseSensitive, Regex, WholeWord, Replace } from '@lucide/svelte';
	import DiffView from './DiffView.svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
		/** §B3.7 - Callback: open a hit in the source editor at the targeted line
		 *  with the query preloaded in the CodeMirror panel. If not provided, fallback
		 *  to a plain `filesStore.setActive`. */
		onOpenHit?: (fileId: string, line: number, query: string) => void;
	}

	let { open, onClose, onOpenHit }: Props = $props();

	let query = $state('');
	let scope = $state<'library' | 'open'>('library');
	const corpus = $derived(scope === 'library' ? filesStore.library : filesStore.files);
	// Debounced query (120 ms): avoids the split×lines of every file
	// on each keystroke. Measurable gain from ~20 moderately-sized files.
	let debouncedQuery = $state('');
	let selected = $state(0);
	let inputEl: HTMLInputElement | null = $state(null);

	// §B3.8 - Search options. Persisted in localStorage to keep
	// the preference across sessions; reset on reload if IDB is cleared.
	let caseSensitive = $state(false);
	let wholeWord = $state(false);
	let useRegex = $state(false);
	let regexError = $state<string | null>(null);
	let queryError = $state<string | null>(null);
	let replacing = $state(false);

	// §2.6 - Cross-file replacement (opt-in: toggled via the replace button).
	let showReplace = $state(false);
	let replacement = $state('');

	interface ReplacePreviewFile {
		id: string;
		name: string;
		before: string;
		after: string;
		count: number;
		updatedAt: number;
		relativePath: string | undefined;
	}

	interface ReplacePreview {
		files: ReplacePreviewFile[];
		total: number;
		query: string;
		replacement: string;
		caseSensitive: boolean;
		wholeWord: boolean;
		useRegex: boolean;
		scope: 'library' | 'open';
	}

	let replacementPreview = $state<ReplacePreview | null>(null);
	let previewIndex = $state(0);
	let previewCancelButton: HTMLButtonElement | null = $state(null);
	const previewFile = $derived(replacementPreview?.files[previewIndex] ?? null);

	function closeReplacementPreview(): void {
		replacementPreview = null;
		previewIndex = 0;
		void tick().then(() => inputEl?.focus());
	}

	function diffMessage(key: MessageKey, params?: Record<string, string | number>): string {
		return t(key, params);
	}

	// §A4.1 - Search is offloaded to a Web Worker (cf.
	// `src/lib/workers/search.worker.ts`) so as not to block the main thread
	// on large corpora. The worker is created once on mount and terminated on
	// the component's unmount. Each request carries an incremental `id`; we
	// ignore responses whose id is no longer the latest - equivalent to
	// cancellation without interrupting the worker (which is single-threaded but
	// stays responsive to subsequent messages).
	let hits = $state<Hit[]>([]);
	let worker: Worker | null = null;
	let nextQueryId = 0;
	let lastSentQueryId = 0;
	/** Fingerprint of the last corpus posted to the worker - skip full
	 *  structured-clone when the snapshot is unchanged (id + updatedAt). */
	let lastCorpusFingerprint = '';

	let searchTimeout: ReturnType<typeof setTimeout> | null = null;
	function stopWorker(): void {
		if (searchTimeout) clearTimeout(searchTimeout);
		searchTimeout = null;
		worker?.terminate();
		worker = null;
		lastCorpusFingerprint = '';
	}
	function createWorker(): void {
		try {
			worker = new Worker(new URL('../workers/search.worker.ts', import.meta.url), {
				type: 'module'
			});
		} catch (error) {
			queryError = t('search.unavailable');
			reportError('search worker creation', error);
			return;
		}
		worker.addEventListener('message', (e: MessageEvent<SearchResponse>) => {
			// Ignore stale responses (the user typed in the meantime).
			if (e.data.id !== lastSentQueryId) return;
			if (searchTimeout) clearTimeout(searchTimeout);
			searchTimeout = null;
			hits = e.data.hits;
			regexError = e.data.regexError;
		});
		// Load/parse failure of the worker script: without this handler, the error
		// is swallowed (no results, no feedback). We surface it to the user.
		worker.addEventListener('error', (e) => {
			reportError('search-worker', e.message ?? String(e));
			notify.error(t('search.unavailable'));
			stopWorker();
			hits = [];
			queryError = t('search.unavailable');
		});
	}
	onMount(() => {
		if (!browser) return;
		createWorker();
		return () => {
			stopWorker();
			if (debounceTimer) clearTimeout(debounceTimer);
		};
	});

	function stripExt(name: string) {
		return name.replace(/\.(md|markdown|mdx|txt)$/i, '');
	}

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const q = query;
		if (debounceTimer) clearTimeout(debounceTimer);
		// Instant feedback for queries that are too short (already filtered out).
		if (q.trim().length < 2) {
			debouncedQuery = q;
			return;
		}
		debounceTimer = setTimeout(() => {
			debouncedQuery = q;
		}, 120);
	});

	// Sends the request to the worker as soon as `debouncedQuery` or the options
	// change. When the panel is closed we send nothing (CPU savings if
	// the user closes before the debounce finishes, for example).
	$effect(() => {
		const q = debouncedQuery.trim();
		void scope;
		const _opts = [caseSensitive, wholeWord, useRegex];
		void _opts;
		if (!open) return;
		queryError = null;
		regexError = null;
		if (q.length < 2) {
			if (searchTimeout) stopWorker();
			hits = [];
			regexError = null;
			return;
		}
		if (searchTimeout) stopWorker();
		if (!worker) createWorker();
		if (!worker) return;
		const id = ++nextQueryId;
		lastSentQueryId = id;
		// `untrack`: do not subscribe to file content mutations.
		// Without it, any keystroke in the editor re-posts the whole corpus to the worker.
		// The effect only re-triggers on the debounced query and the options.
		// Fingerprint only needs id+updatedAt (O(N)); clone full content only when
		// the corpus actually changed so each keystroke does not copy megabytes.
		const meta = untrack(() =>
			corpus.map((f) => ({
				id: f.id,
				updatedAt: f.updatedAt
			}))
		);
		const fingerprint = corpusFingerprint(meta);
		const corpusChanged = fingerprint !== lastCorpusFingerprint;
		if (corpusChanged) lastCorpusFingerprint = fingerprint;
		const req: SearchRequest = {
			id,
			query: q,
			caseSensitive,
			wholeWord,
			useRegex,
			...(corpusChanged
				? {
						files: untrack(() =>
							corpus.map((f) => ({
								id: f.id,
								name: f.name,
								content: f.content
							}))
						)
					}
				: {})
		};
		try {
			worker.postMessage(req);
		} catch (error) {
			stopWorker();
			queryError = t('search.unavailable');
			reportError('search request', error);
			return;
		}
		searchTimeout = setTimeout(() => {
			stopWorker();
			hits = [];
			queryError = t('search.timeout');
		}, 1000);
	});

	$effect(() => {
		if (open) {
			selected = 0;
			tick().then(() => inputEl?.focus());
		}
	});

	$effect(() => {
		const _ = query;
		void _;
		selected = 0;
	});

	$effect(() => {
		const preview = replacementPreview;
		if (
			preview &&
			(preview.query !== debouncedQuery.trim() ||
				preview.replacement !== replacement ||
				preview.caseSensitive !== caseSensitive ||
				preview.wholeWord !== wholeWord ||
				preview.useRegex !== useRegex ||
				preview.scope !== scope)
		) {
			replacementPreview = null;
			previewIndex = 0;
		}
	});

	$effect(() => {
		if (!replacementPreview) return;
		void tick().then(() => previewCancelButton?.focus());
	});

	$effect(() => {
		const hit = hits[selected];
		const index = selected;
		if (!hit) return;
		tick().then(() => {
			document
				.getElementById(`search-hit-${hit.fileId}-${hit.line}-${index}`)
				?.scrollIntoView({ block: 'nearest' });
		});
	});

	function openHit(h: Hit) {
		// §B3.7 - Switches to source mode + scrolls to the line + preloads the query
		// in the CodeMirror search panel (callback handled by +page.svelte).
		// Fallback: if no callback, just setActive (legacy).
		if (onOpenHit) {
			onOpenHit(h.fileId, h.line, debouncedQuery);
		} else {
			filesStore.openDocument(h.fileId);
		}
		onClose();
	}

	// Create an immutable preview. Confirmation records all checkpoints before
	// it changes any draft.
	async function handleReplaceAll(): Promise<void> {
		const q = debouncedQuery.trim();
		if (q.length < 2 || replacing) return;
		replacing = true;
		queryError = null;
		const opts = { caseSensitive, wholeWord, useRegex };
		const replacementValue = replacement;
		try {
			await filesStore.flushPendingAwait();
			const slices = corpus.map((file) => ({
				id: file.id,
				name: file.name,
				content: file.content,
				updatedAt: file.updatedAt,
				relativePath: file.relativePath
			}));
			const preview = await replaceInFilesAsync(slices, q, replacementValue, opts);
			if (preview.regexError) {
				queryError = preview.regexError;
				return;
			}
			if (preview.total === 0) {
				notify.info(t('search.noOccurrence'));
				return;
			}
			replacementPreview = {
				files: preview.results.map((result) => {
					const source = slices.find((file) => file.id === result.id)!;
					return {
						id: result.id,
						name: result.name,
						before: source.content,
						after: result.content,
						count: result.count,
						updatedAt: source.updatedAt,
						relativePath: source.relativePath
					};
				}),
				total: preview.total,
				query: q,
				replacement: replacementValue,
				caseSensitive,
				wholeWord,
				useRegex,
				scope
			};
			previewIndex = 0;
		} catch (error) {
			queryError = t('search.replaceFailed');
			reportPersistenceError(error, 'save');
		} finally {
			replacing = false;
		}
	}

	function previewIsCurrent(preview: ReplacePreview): boolean {
		return preview.files.every((planned) => {
			const current = filesStore.library.find((file) => file.id === planned.id);

			return (
				current?.name === planned.name &&
				current.content === planned.before &&
				current.updatedAt === planned.updatedAt &&
				current.relativePath === planned.relativePath
			);
		});
	}

	async function confirmReplacement(): Promise<void> {
		const preview = replacementPreview;
		if (!preview || replacing) return;
		replacing = true;
		queryError = null;
		try {
			if (!previewIsCurrent(preview)) {
				closeReplacementPreview();
				queryError = diffMessage('replacePreview.stale');
				return;
			}
			const committed = await commitReplacements(preview.files);
			if (committed.status === 'stale') {
				closeReplacementPreview();
				queryError = diffMessage('replacePreview.stale');
				return;
			}
			const expected = new Map(
				preview.files.map((file) => [
					file.id,
					{
						content: file.before,
						relativePath: file.relativePath,
						updatedAt: file.updatedAt
					}
				])
			);
			const applied = filesStore.acceptProjectRows(committed.rows, expected);
			if (applied.length === committed.rows.length) {
				notify.success(
					t('search.replacedSummary', { n: preview.total, files: preview.files.length })
				);
			} else notify.info(t('files.otherTabChanges'));
			replacementPreview = null;
			onClose();
		} catch (error) {
			queryError = t('search.replaceFailed');
			reportPersistenceError(error, 'save');
		} finally {
			replacing = false;
		}
	}

	function handleKey(e: KeyboardEvent) {
		if (e.isComposing || e.defaultPrevented || promptStore.open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (replacementPreview) {
				closeReplacementPreview();
			} else onClose();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			selected = Math.min(selected + 1, hits.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selected = Math.max(selected - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const hit = hits[selected];
			if (hit) openHit(hit);
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pb-4 backdrop-blur-sm
		       pt-[max(env(safe-area-inset-top),10vh)]"
		style:padding-left="max(env(safe-area-inset-left), 1rem)"
		style:padding-right="max(env(safe-area-inset-right), 1rem)"
		onclick={(e) => {
			if (e.target === e.currentTarget) onClose();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') {
				if (replacementPreview) {
					e.preventDefault();
					closeReplacementPreview();
				} else onClose();
			}
		}}
		role="dialog"
		aria-modal="true"
		aria-label={t('search.dialogLabel')}
		inert={promptStore.open}
		aria-hidden={promptStore.open ? 'true' : undefined}
		tabindex="-1"
		use:focusTrap
	>
		<div
			class="mdsh-dialog-panel flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border
			       bg-bg-1 shadow-2xl animate-fade-in"
		>
			<!-- §B1.5 - ARIA combobox + listbox pattern identical to CommandPalette. -->
			<div
				class="search-input-row flex flex-wrap items-center gap-2 border-b border-border px-3 py-2"
			>
				<Search size={16} class="text-fg-dim" />
				<input
					bind:this={inputEl}
					bind:value={query}
					onkeydown={handleKey}
					type="text"
					placeholder={t('search.placeholder')}
					class="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-dim"
					spellcheck="false"
					autocapitalize="off"
					autocomplete="off"
					role="combobox"
					aria-controls="search-listbox"
					aria-expanded={hits.length > 0 && !queryError && !regexError}
					aria-autocomplete="list"
					aria-activedescendant={!queryError && !regexError && hits[selected]?.fileId != null
						? `search-hit-${hits[selected]!.fileId}-${hits[selected]!.line}-${selected}`
						: undefined}
					aria-label={t('search.inputLabel')}
				/>
				<!-- §B3.8 - Option toggles: Aa (case), \b (whole word), .* (regex). -->
				<button
					type="button"
					class="rounded p-1 text-fg-dim transition hover:bg-bg-2"
					class:bg-bg-2={caseSensitive}
					class:text-accent={caseSensitive}
					class:hover:text-fg={!caseSensitive}
					onclick={() => (caseSensitive = !caseSensitive)}
					aria-pressed={caseSensitive}
					title={t('search.caseSensitive')}
					aria-label={t('search.caseSensitiveLabel')}
				>
					<CaseSensitive size={14} />
				</button>
				<button
					type="button"
					class="rounded p-1 text-fg-dim transition hover:bg-bg-2 disabled:cursor-not-allowed disabled:opacity-40"
					class:bg-bg-2={wholeWord && !useRegex}
					class:text-accent={wholeWord && !useRegex}
					class:hover:text-fg={!wholeWord && !useRegex}
					onclick={() => (wholeWord = !wholeWord)}
					disabled={useRegex}
					aria-pressed={wholeWord && !useRegex}
					title={useRegex ? t('search.wholeWordDisabled') : t('search.wholeWord')}
					aria-label={t('search.wholeWordLabel')}
				>
					<WholeWord size={14} />
				</button>
				<button
					type="button"
					class="rounded p-1 text-fg-dim transition hover:bg-bg-2"
					class:bg-bg-2={useRegex}
					class:text-accent={useRegex}
					class:hover:text-fg={!useRegex}
					onclick={() => (useRegex = !useRegex)}
					aria-pressed={useRegex}
					title={t('search.regex')}
					aria-label={t('search.regexLabel')}
				>
					<Regex size={14} />
				</button>
				<!-- §2.6 - Toggles replacement mode. -->
				<button
					type="button"
					class="rounded p-1 text-fg-dim transition hover:bg-bg-2"
					class:bg-bg-2={showReplace}
					class:text-accent={showReplace}
					class:hover:text-fg={!showReplace}
					onclick={() => (showReplace = !showReplace)}
					aria-pressed={showReplace}
					title={t('search.replaceInFiles')}
					aria-label={t('search.replaceToggleLabel')}
				>
					<Replace size={14} />
				</button>
				<button
					class="rounded p-1 text-fg-dim transition hover:bg-bg-2 hover:text-fg"
					onclick={onClose}
					aria-label={t('search.close')}
				>
					<X size={14} />
				</button>
			</div>

			<div
				role="group"
				aria-label={t('library.scope')}
				class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs text-fg-muted"
			>
				{#each ['library', 'open'] as value (value)}
					<button
						class="rounded border border-border px-2 py-1"
						class:text-accent={scope === value}
						aria-pressed={scope === value}
						disabled={replacing}
						onclick={() => (scope = value as typeof scope)}
						>{t(value === 'library' ? 'library.all' : 'library.open')}</button
					>
				{/each}
				{#if debouncedQuery.trim().length >= 2 && !regexError && !queryError}
					<span class="ml-auto text-fg-dim" aria-live="polite" aria-atomic="true"
						>{t('search.resultCount', { n: hits.length })}</span
					>
				{/if}
			</div>
			{#if hits.length >= SEARCH_MAX_HITS}
				<p class="px-3 py-2 text-xs text-fg-muted" role="status">
					{t('search.limited', { n: SEARCH_MAX_HITS })}
				</p>
			{/if}

			{#if showReplace}
				<!-- §2.6 - Cross-file replacement row. -->
				<div class="flex items-center gap-2 border-b border-border px-3 py-2">
					<Replace size={16} class="text-fg-dim" aria-hidden="true" />
					<input
						bind:value={replacement}
						type="text"
						placeholder={t('search.replaceWith')}
						class="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-dim"
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
						aria-label={t('search.replacementLabel')}
					/>
					<button
						type="button"
						class="shrink-0 rounded border border-border px-2.5 py-1 text-xs text-fg-muted transition hover:bg-bg-2 hover:text-fg disabled:opacity-40"
						onclick={() => void handleReplaceAll()}
						disabled={replacing || debouncedQuery.trim().length < 2}
					>
						{t('search.replaceAll')}
					</button>
				</div>
			{/if}

			{#if queryError || regexError}
				<div
					class="border-b border-border bg-danger/10 px-3 py-1.5 text-xs text-danger"
					role="alert"
				>
					{queryError ?? t('search.invalidRegex', { error: regexError ?? '' })}
				</div>
			{/if}

			{#if replacementPreview && previewFile}
				<section class="flex min-h-0 max-h-[68vh] flex-col" aria-labelledby="replace-preview-title">
					<header class="border-b border-border px-3 py-2">
						<h2 id="replace-preview-title" class="text-sm font-medium text-fg">
							{diffMessage('replacePreview.title')}
						</h2>
						<p class="mt-1 text-xs text-fg-muted">{diffMessage('replacePreview.description')}</p>
						<p class="mt-1 text-xs text-fg-dim" role="status">
							{diffMessage('replacePreview.fileCount', {
								files: replacementPreview.files.length,
								occurrences: replacementPreview.total
							})}
						</p>
					</header>
					<div class="flex min-h-0 flex-1 flex-col sm:flex-row">
						<ul
							class="max-h-28 shrink-0 overflow-y-auto border-b border-border py-1 sm:max-h-none sm:w-48 sm:border-b-0 sm:border-r"
							aria-label={diffMessage('replacePreview.title')}
						>
							{#each replacementPreview.files as file, index (file.id)}
								<li>
									<button
										class="w-full px-3 py-2 text-left text-xs text-fg-muted transition hover:bg-bg-2"
										class:bg-bg-2={index === previewIndex}
										class:text-fg={index === previewIndex}
										aria-current={index === previewIndex ? 'true' : undefined}
										onclick={() => (previewIndex = index)}
									>
										<span class="block truncate font-medium">{file.name}</span>
										<span class="text-fg-dim">{file.count}</span>
									</button>
								</li>
							{/each}
						</ul>
						<div class="min-h-0 min-w-0 flex-1 overflow-auto p-3">
							<DiffView
								before={previewFile.before}
								after={previewFile.after}
								ariaLabel={previewFile.name}
								maxHeight="42vh"
							/>
						</div>
					</div>
					<footer class="flex flex-wrap justify-end gap-2 border-t border-border px-3 py-2">
						<button
							bind:this={previewCancelButton}
							class="rounded border border-border px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-2 hover:text-fg"
							onclick={closeReplacementPreview}
						>
							{diffMessage('replacePreview.cancel')}
						</button>
						<button
							class="rounded bg-danger px-3 py-1.5 text-xs text-on-danger transition hover:opacity-90 disabled:opacity-40"
							disabled={replacing}
							onclick={() => void confirmReplacement()}
						>
							{diffMessage('replacePreview.confirm')}
						</button>
					</footer>
				</section>
			{:else}
				<ul
					id="search-listbox"
					hidden={Boolean(queryError || regexError)}
					role="listbox"
					aria-label={t('search.resultsLabel')}
					class="max-h-[60vh] overflow-y-auto py-1"
				>
					{#if query.trim().length < 2}
						<li
							class="px-4 py-6 text-center text-xs text-fg-dim"
							role="option"
							aria-disabled="true"
							aria-selected="false"
						>
							{t('search.minChars')}
						</li>
					{:else if hits.length === 0}
						<li
							class="px-4 py-6 text-center text-xs text-fg-dim"
							role="option"
							aria-disabled="true"
							aria-selected="false"
						>
							{t('search.noResult')}
						</li>
					{:else}
						{#each hits as hit, i (hit.fileId + ':' + hit.line + ':' + i)}
							<li
								role="option"
								id={`search-hit-${hit.fileId}-${hit.line}-${i}`}
								aria-selected={i === selected}
							>
								<button
									class="flex w-full flex-col gap-1 px-3 py-2 text-left transition"
									class:bg-bg-2={i === selected}
									onclick={() => openHit(hit)}
									onmouseenter={() => (selected = i)}
									tabindex="-1"
								>
									<div class="flex items-center gap-2 text-xs text-fg-muted">
										<span class="truncate font-medium">{stripExt(hit.name)}</span>
										<span class="text-fg-dim">:{hit.line}</span>
									</div>
									<div class="truncate font-mono text-xs text-fg">
										{hit.snippet.slice(0, hit.matchStart)}<mark
											class="bg-accent/25 text-accent rounded-sm px-0.5"
											>{hit.snippet.slice(hit.matchStart, hit.matchEnd)}</mark
										>{hit.snippet.slice(hit.matchEnd)}
									</div>
								</button>
							</li>
						{/each}
					{/if}
				</ul>
			{/if}
		</div>
	</div>
{/if}
