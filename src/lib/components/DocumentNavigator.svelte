<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '#lib/i18n/index.js';
	import {
		documentHeadings,
		documentMatches,
		focusDocumentHeading,
		renderedDocumentHeadings,
		type DocumentHeading
	} from '#lib/document-navigation.js';
	import { X, ArrowUp, ArrowDown } from '@lucide/svelte';
	let {
		kind,
		content,
		mode,
		container,
		onLine,
		onClose
	}: {
		kind: 'find' | 'outline';
		content: string;
		mode: string;
		container: HTMLElement | null;
		onLine: (line: number) => void;
		onClose: () => void;
	} = $props();
	let query = $state('');
	let input: HTMLInputElement | undefined = $state();
	let closeButton: HTMLButtonElement | undefined = $state();
	let count = $state(0);
	let current = $state(0);
	let ranges: Range[] = [];
	let lastSearch = '';
	let selectionRequested = false;
	let headings = $state<DocumentHeading[]>([]);
	const target = () =>
		container?.querySelector<HTMLElement>(mode === 'read' ? '.mdsh-preview' : '.ProseMirror') ??
		null;
	function clearHighlights() {
		if (typeof CSS !== 'undefined' && CSS.highlights) {
			CSS.highlights.delete('mdsh-find');
			CSS.highlights.delete('mdsh-current');
		}
	}
	function showMatch(index: number, scroll = true) {
		if (!ranges.length) return;
		current = (index + ranges.length) % ranges.length;
		const range = ranges[current]!;
		if (typeof Highlight !== 'undefined' && CSS.highlights)
			CSS.highlights.set('mdsh-current', new Highlight(range));
		else {
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		}
		if (scroll) {
			selectionRequested = true;
			range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
		}
	}
	function closeNavigation() {
		const range = ranges[current];
		if (kind === 'find' && mode === 'wysiwyg' && selectionRequested && range) {
			target()?.focus({ preventScroll: true });
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range.cloneRange());
		}
		onClose();
	}
	$effect(() => {
		void kind;
		void tick().then(() => (kind === 'find' ? input?.focus() : closeButton?.focus()));
	});
	$effect(() => {
		const text = content;
		const search = query;
		const root = container;
		const selectedMode = mode;
		const selectedKind = kind;
		let timer: ReturnType<typeof setTimeout>;
		const update = () => {
			clearHighlights();
			const documentRoot = target();
			if (selectedKind === 'outline') {
				headings =
					selectedMode === 'source'
						? documentHeadings(text)
						: renderedDocumentHeadings(documentRoot);
			} else {
				const changedQuery = search !== lastSearch;
				lastSearch = search;
				ranges = documentRoot ? documentMatches(documentRoot, search) : [];
				count = ranges.length;
				current = changedQuery ? 0 : Math.max(0, Math.min(current, count - 1));
				if (typeof Highlight !== 'undefined' && CSS.highlights)
					CSS.highlights.set('mdsh-find', new Highlight(...ranges));
				showMatch(current, changedQuery);
			}
		};
		const schedule = () => {
			clearTimeout(timer);
			timer = setTimeout(update, 120);
		};
		const observer = new MutationObserver(schedule);
		const preserveCaret = () => {
			selectionRequested = false;
		};
		root?.addEventListener('pointerdown', preserveCaret);
		root?.addEventListener('keydown', preserveCaret);
		if (root) observer.observe(root, { childList: true, subtree: true, characterData: true });
		schedule();
		return () => {
			root?.removeEventListener('pointerdown', preserveCaret);
			root?.removeEventListener('keydown', preserveCaret);
			clearTimeout(timer);
			observer.disconnect();
			clearHighlights();
		};
	});
	function jump(heading: (typeof headings)[number], index: number) {
		// Resolve the heading again at click time. A render can replace the nodes
		// held by the list, and a detached node cannot scroll into view.
		const fresh =
			(kind === 'outline'
				? mode === 'source'
					? documentHeadings(content)
					: renderedDocumentHeadings(target())
				: [])[index] ?? heading;
		if (mode === 'source') onLine(fresh.line);
		else focusDocumentHeading(fresh, mode === 'wysiwyg');
		onClose();
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (
			event.key === 'Escape' &&
			(event.target as HTMLElement)?.closest?.('[data-document-navigation]')
		) {
			event.stopPropagation();
			closeNavigation();
		}
	}}
/>

<section
	data-document-navigation
	class="shrink-0 border-b border-border bg-bg-1 p-2"
	aria-label={t(kind === 'find' ? 'navigation.find' : 'navigation.outline')}
>
	<div class="flex items-center gap-2">
		{#if kind === 'find'}
			<input
				bind:this={input}
				bind:value={query}
				type="search"
				class="min-w-0 flex-1 rounded border border-border bg-bg px-3 py-2 text-sm"
				aria-label={t('navigation.find')}
				placeholder={t('navigation.find')}
				onkeydown={(event) => {
					if (
						!event.altKey &&
						(event.ctrlKey || event.metaKey) &&
						event.key.toLowerCase() === 'f'
					) {
						event.preventDefault();
						input?.select();
					}
					if (event.key === 'Enter') {
						event.preventDefault();
						showMatch(current + (event.shiftKey ? -1 : 1));
					}
				}}
			/>
			<span class="shrink-0 text-xs text-fg-muted" role="status"
				>{count ? current + 1 : 0}/{count}{count === 200 ? '+' : ''}</span
			>
			<button
				class="p-2"
				disabled={!count}
				aria-label={t('navigation.previous')}
				onclick={() => showMatch(current - 1)}><ArrowUp size={16} /></button
			>
			<button
				class="p-2"
				disabled={!count}
				aria-label={t('navigation.next')}
				onclick={() => showMatch(current + 1)}><ArrowDown size={16} /></button
			>
		{:else}<h2 class="flex-1 px-2 text-sm font-medium">{t('navigation.outline')}</h2>{/if}
		<button
			bind:this={closeButton}
			class="p-2"
			onclick={closeNavigation}
			aria-label={t('navigation.close')}><X size={16} /></button
		>
	</div>
	{#if kind === 'outline'}
		<nav class="max-h-[30dvh] overflow-y-auto" aria-label={t('navigation.outline')}>
			{#each headings as heading, index (index)}<button
					class="block min-h-10 w-full truncate rounded py-2 pr-3 text-left text-sm text-fg-muted hover:bg-bg-2"
					style:padding-left={`${heading.level * 12}px`}
					onclick={() => jump(heading, index)}>{heading.text || t('toolbar.untitled')}</button
				>
			{:else}<p class="p-3 text-xs text-fg-muted">{t('navigation.empty')}</p>{/each}
		</nav>
	{/if}
</section>

<style>
	:global(::highlight(mdsh-find)) {
		background-color: color-mix(in oklab, var(--color-accent) 30%, transparent);
		color: var(--color-fg);
	}
	:global(::highlight(mdsh-current)) {
		background-color: var(--color-accent);
		color: var(--color-bg);
	}
</style>
