<script lang="ts">
	// §2.9 - Graph view of the links between files.
	//
	// SVG rendering of an in-house force-directed layout (cf. lib/graph.ts) - nodes =
	// files, edges = resolved wiki-links. No graph library (bundle budget).
	// Clicking a node opens the file. Lazy-loaded (modal).

	import { tick, untrack } from 'svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { t } from '#lib/i18n/index.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { buildGraph, computeLayout, type PositionedNode, type GraphEdge } from '#lib/graph.js';
	import { Workflow, X } from '@lucide/svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	const WIDTH = 900;
	const HEIGHT = 620;

	let positions = $state<PositionedNode[]>([]);
	let edges = $state<GraphEdge[]>([]);
	let closeButton: HTMLButtonElement | null = $state(null);

	// §a11y - Sets the initial focus inside the dialog on open (WCAG 2.4.3).
	// `use:focusTrap` only moves focus on Tab; without this initial focus, the
	// focus stayed outside the modal (all the other modals do the same).
	$effect(() => {
		if (open) tick().then(() => closeButton?.focus());
	});

	// Recompute the layout on OPEN only (costly: O(n²×iters), one-shot).
	// `untrack` around the file read: without it, the effect re-ran on every
	// keystroke (mutation of `filesStore.files`) as long as the graph is open.
	$effect(() => {
		if (!open) return;
		untrack(() => {
			const files = filesStore.library.map((f) => ({
				id: f.id,
				label: filesStore.displayTitle(f.id)
			}));
			const data = buildGraph(
				files,
				(id) =>
					filesStore
						.wikiLinkTargets(id)
						.map((target) => filesStore.resolveWikiLink(target, id))
						.filter((target): target is string => target !== null),
				(target) => target
			);
			edges = data.edges;
			// Fewer iterations on large graphs to stay smooth.
			const iterations = data.nodes.length > 120 ? 60 : 120;
			positions = computeLayout(data, { width: WIDTH, height: HEIGHT, iterations });
		});
	});

	const posById = $derived(new Map(positions.map((p) => [p.id, p])));
	// Degree per node via a plain object (no mutated Map → avoids the
	// svelte/prefer-svelte-reactivity rule; this is not reactive state).
	const degree = $derived.by(() => {
		const d: Record<string, number> = {};
		for (const e of edges) {
			d[e.source] = (d[e.source] ?? 0) + 1;
			d[e.target] = (d[e.target] ?? 0) + 1;
		}
		return d;
	});

	function radius(id: string): number {
		return Math.min(12, 4 + (degree[id] ?? 0));
	}

	function openNode(id: string) {
		filesStore.openDocument(id);
		onClose();
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pb-4 backdrop-blur-sm
		       pt-[max(env(safe-area-inset-top),6vh)]"
		style:padding-left="max(env(safe-area-inset-left), 1rem)"
		style:padding-right="max(env(safe-area-inset-right), 1rem)"
		onclick={(e) => {
			if (e.target === e.currentTarget) onClose();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') onClose();
		}}
		role="dialog"
		aria-modal="true"
		aria-labelledby="graph-title"
		tabindex="-1"
		use:focusTrap
	>
		<div
			class="mdsh-dialog-panel flex h-[84vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border
			       bg-bg-1 shadow-2xl animate-fade-in"
		>
			<header class="flex items-center gap-2 border-b border-border px-4 py-2.5">
				<Workflow size={16} class="text-fg-dim" aria-hidden="true" />
				<h2 id="graph-title" class="flex-1 text-sm font-medium text-fg">{t('graph.title')}</h2>
				<span class="text-[11px] text-fg-dim"
					>{t('graph.counts', { nodes: positions.length, edges: edges.length })}</span
				>
				<button
					bind:this={closeButton}
					class="rounded p-1 text-fg-dim transition hover:bg-bg-2 hover:text-fg"
					onclick={onClose}
					aria-label={t('graph.close')}
				>
					<X size={14} />
				</button>
			</header>

			{#if positions.length === 0}
				<p class="px-4 py-10 text-center text-sm text-fg-dim">{t('graph.empty')}</p>
			{:else}
				<!-- labelled role="group": keeps the per-node buttons (role="button")
				     exposed to assistive technologies. A role="img" on the
				     <svg> would instead make its descendants presentational. -->
				<div
					class="min-h-0 flex-1 overflow-auto p-2"
					role="group"
					aria-label={t('graph.regionLabel')}
				>
					<svg viewBox="0 0 {WIDTH} {HEIGHT}" class="h-full w-full">
						<!-- Edges -->
						{#each edges as e (e.source + '|' + e.target)}
							{@const a = posById.get(e.source)}
							{@const b = posById.get(e.target)}
							{#if a && b}
								<line
									x1={a.x}
									y1={a.y}
									x2={b.x}
									y2={b.y}
									stroke="var(--color-border-strong)"
									stroke-width="1"
								/>
							{/if}
						{/each}
						<!-- Nodes -->
						{#each positions as p (p.id)}
							<g
								class="graph-node cursor-pointer"
								role="button"
								tabindex="0"
								aria-label={t('graph.openNode', { label: p.label })}
								onclick={() => openNode(p.id)}
								onkeydown={(ev) => {
									if (ev.key === 'Enter' || ev.key === ' ') {
										ev.preventDefault();
										openNode(p.id);
									}
								}}
							>
								<circle
									class="graph-node-dot"
									cx={p.x}
									cy={p.y}
									r={radius(p.id)}
									fill="var(--color-accent)"
									fill-opacity="0.85"
								/>
								<text
									x={p.x}
									y={p.y - radius(p.id) - 4}
									text-anchor="middle"
									font-size="11"
									fill="var(--color-fg-muted)"
								>
									{p.label.length > 24 ? p.label.slice(0, 23) + '…' : p.label}
								</text>
							</g>
						{/each}
					</svg>
				</div>
				<details class="max-h-48 overflow-y-auto border-t border-border p-3 text-sm">
					<summary class="cursor-pointer">{t('graph.textView')}</summary>
					<ul>
						{#each positions as node (node.id)}
							<li class="py-1">
								<button class="underline" onclick={() => openNode(node.id)}>{node.label}</button>
								{#each edges.filter((edge) => edge.source === node.id) as edge (edge.target)}
									<span> / {t('graph.linksTo')} </span><button
										class="underline"
										onclick={() => openNode(edge.target)}>{posById.get(edge.target)?.label}</button
									>
								{/each}
							</li>
						{/each}
					</ul>
				</details>
				<footer class="border-t border-border px-3 py-1.5 text-[11px] text-fg-dim">
					{t('graph.help')}
					<code>[[…]]</code>.
				</footer>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* §a11y WCAG 2.4.7 - Show a reliable focus indicator on graph nodes.
	   Chromium and WebKit do not reliably paint an outline on the focusable <g>.
	   Draw the focus ring on its <circle> and disable the default <g> outline. */
	.graph-node:focus {
		outline: none;
	}
	.graph-node:focus-visible {
		outline: none;
	}
	.graph-node:focus-visible :global(.graph-node-dot) {
		stroke: var(--color-fg);
		stroke-width: 3;
		paint-order: stroke;
	}
</style>
