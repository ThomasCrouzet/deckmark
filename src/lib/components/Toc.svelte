<script lang="ts">
	import {
		completeRenderedHeadings,
		focusDocumentHeading,
		headingIndexForLine,
		invalidateRenderedHeadings,
		sourceHeadingIndex,
		type DocumentHeading
	} from '#lib/document-navigation.js';
	import type { EditMode } from '#lib/types.js';
	import { t } from '#lib/i18n/index.js';

	let {
		container,
		content,
		mode,
		sourceLine,
		onLine,
		onEmpty
	}: {
		container: HTMLElement | null;
		content: string;
		mode: EditMode;
		sourceLine: number;
		onLine: (line: number) => void;
		onEmpty: (empty: boolean) => void;
	} = $props();

	let items = $state<readonly DocumentHeading[]>([]);
	let activeIndex = $state(-1);
	let previousMode: EditMode | undefined;
	let previousRoot: HTMLElement | null = null;

	$effect(() => {
		if (mode === 'source') {
			activeIndex = headingIndexForLine(items, sourceLine);
		}
	});

	$effect(() => {
		const root = container;
		const selectedMode = mode;
		const text = selectedMode === 'source' ? content : '';
		let timer: ReturnType<typeof setTimeout>;
		let intersection: IntersectionObserver | null = null;
		const headingIndexes = new WeakMap<Element, number>();
		const modeOrRootChanged = selectedMode !== previousMode || root !== previousRoot;
		const renderedRoot = () =>
			root?.querySelector<HTMLElement>(
				selectedMode === 'read' ? '.mdsh-preview' : '.ProseMirror'
			) ?? null;
		invalidateRenderedHeadings(renderedRoot());
		const publishRenderedVisibility = () => {
			if (selectedMode === 'source') return;
			onEmpty(!renderedRoot()?.querySelector('h1,h2,h3,h4,h5,h6'));
		};
		if (modeOrRootChanged) {
			items = [];
			activeIndex = -1;
			previousMode = selectedMode;
			previousRoot = root;
			if (selectedMode === 'source') {
				items = sourceHeadingIndex(text).headings;
				onEmpty(items.length === 0);
			}
		}
		publishRenderedVisibility();
		const update = () => {
			items =
				selectedMode === 'source'
					? sourceHeadingIndex(text).headings
					: completeRenderedHeadings(renderedRoot());
			onEmpty(items.length === 0);
			intersection?.disconnect();
			if (selectedMode !== 'source' && root) {
				intersection = new IntersectionObserver(
					(entries) => {
						const visible = entries
							.filter((entry) => entry.isIntersecting)
							.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
						if (visible[0])
							activeIndex = items.findIndex((item) => item.element === visible[0]!.target);
					},
					{ root, rootMargin: '0px 0px -70% 0px', threshold: 0 }
				);
				for (const [index, item] of items.entries()) {
					if (!item.element) continue;
					headingIndexes.set(item.element, index);
					intersection.observe(item.element);
				}
			}
		};
		const schedule = () => {
			clearTimeout(timer);
			timer = setTimeout(update, 120);
		};
		const headingSelector = 'h1,h2,h3,h4,h5,h6';
		const isHeadingNode = (node: Node): boolean =>
			node.nodeType === Node.ELEMENT_NODE &&
			((node as Element).matches(headingSelector) ||
				(node as Element).querySelector(headingSelector) !== null);
		const observer = new MutationObserver((records) => {
			let headingsChanged = false;
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local mutation batch, never rendered
			const changedText = new Set<Element>();
			for (const record of records) {
				const parent =
					record.target instanceof Element ? record.target : record.target.parentElement;
				const heading = parent?.closest(headingSelector);
				if (heading) {
					changedText.add(heading);
					continue;
				}
				if (record.type === 'characterData') {
					if (record.target.parentElement?.closest(headingSelector)) headingsChanged = true;
				} else if (record.type === 'childList') {
					if (
						[...record.addedNodes, ...record.removedNodes].some(isHeadingNode) ||
						(record.target instanceof Element &&
							(record.target.matches(headingSelector) ||
								record.target.closest(headingSelector) !== null ||
								record.target.matches('.ProseMirror, .mdsh-preview')))
					)
						headingsChanged = true;
				}
				if (headingsChanged) break;
			}
			if (!headingsChanged && changedText.size) {
				invalidateRenderedHeadings(renderedRoot());
				for (const heading of changedText) {
					const index = headingIndexes.get(heading);
					const item = index === undefined ? undefined : items[index];
					if (!item || item.element !== heading) {
						headingsChanged = true;
						break;
					}
					item.text = heading.textContent ?? '';
				}
			}
			// Paragraph text and inline marks do not change heading topology. Rebuilding
			// every heading subscription after each keystroke would stall a large note.
			if (!headingsChanged) return;
			invalidateRenderedHeadings(renderedRoot());
			publishRenderedVisibility();
			schedule();
		});
		if (root && selectedMode !== 'source') {
			observer.observe(root, { childList: true, subtree: true, characterData: true });
		}
		schedule();
		return () => {
			clearTimeout(timer);
			intersection?.disconnect();
			observer.disconnect();
		};
	});

	function currentHeadings(): readonly DocumentHeading[] {
		if (mode === 'source') return sourceHeadingIndex(content).headings;
		const root =
			container?.querySelector<HTMLElement>(mode === 'read' ? '.mdsh-preview' : '.ProseMirror') ??
			null;
		invalidateRenderedHeadings(root);
		return completeRenderedHeadings(root);
	}

	function jump(item: DocumentHeading, index: number) {
		activeIndex = index;
		// Resolve the heading again at click time. A render can replace the nodes
		// held by the list, and a detached node cannot scroll into view. Without
		// this lookup, the first click after a render did nothing.
		const fresh = currentHeadings()[index] ?? item;
		if (mode === 'source') onLine(fresh.line);
		else focusDocumentHeading(fresh, mode === 'wysiwyg');
	}
</script>

{#if items.length > 0}
	<nav class="mdsh-toc" aria-label={t('toc.ariaLabel')}>
		<div class="mdsh-toc-title" aria-hidden="true">{t('toc.title')}</div>
		<ol>
			{#each items as item, index (index)}
				<li
					style:--heading-indent={`${8 + (item.level - 1) * 10}px`}
					class:active={index === activeIndex}
				>
					<button
						type="button"
						onclick={() => jump(item, index)}
						title={item.text || t('toolbar.untitled')}
						aria-current={index === activeIndex ? 'location' : undefined}
					>
						{item.text || t('toolbar.untitled')}
					</button>
				</li>
			{/each}
		</ol>
	</nav>
{/if}

<style>
	.mdsh-toc {
		height: 100%;
		max-height: 100%;
		overflow-y: auto;
		padding: 0.75rem 0.75rem 1rem;
		font-size: 12px;
		line-height: 1.5;
		color: var(--color-fg-dim);
		border-left: 1px solid var(--color-border);
	}
	.mdsh-toc-title {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-fg-subtle);
		margin: 0 0 0.5rem 8px;
	}
	.mdsh-toc ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.mdsh-toc li {
		margin: 0;
	}
	.mdsh-toc li button {
		display: block;
		width: 100%;
		text-align: left;
		background: transparent;
		border: none;
		padding: 2px 0 2px var(--heading-indent);
		color: inherit;
		cursor: pointer;
		border-left: 2px solid transparent;
		transition:
			color 0.12s,
			border-color 0.12s;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: inherit;
	}
	.mdsh-toc li button:hover {
		color: var(--color-fg);
	}
	.mdsh-toc li button:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
		border-radius: var(--radius-xs);
	}
	.mdsh-toc li.active button {
		color: var(--color-accent);
		border-left-color: var(--color-accent);
	}

	/* Mobile: the TOC is hidden. The toggle stays functional but the
	   grid column disappears on the +page.svelte side (cf. .with-toc). */
	@media (max-width: 1023px) {
		.mdsh-toc {
			display: none;
		}
	}
</style>
