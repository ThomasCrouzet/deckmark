<script lang="ts">
	import { onMount } from 'svelte';
	import { reportError } from '#lib/report.js';

	let {
		initial,
		ariaLabel,
		ariaDescribedBy,
		onchange
	}: {
		initial: string;
		ariaLabel: string;
		ariaDescribedBy: string;
		onchange: (value: string) => void;
	} = $props();

	let host: HTMLDivElement;
	let view: import('@codemirror/view').EditorView | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;

	export function getValue(): string {
		return view?.state.doc.toString() ?? initial;
	}

	export function focus(): void {
		view?.focus();
	}

	onMount(() => {
		let disposed = false;
		void (async () => {
			try {
				const [
					{ EditorState },
					{ EditorView, drawSelection, highlightActiveLine, keymap },
					commands
				] = await Promise.all([
					import('@codemirror/state'),
					import('@codemirror/view'),
					import('@codemirror/commands')
				]);
				if (disposed) return;
				view = new EditorView({
					state: EditorState.create({
						doc: initial,
						extensions: [
							EditorView.lineWrapping,
							drawSelection(),
							highlightActiveLine(),
							commands.history(),
							keymap.of([...commands.defaultKeymap, ...commands.historyKeymap]),
							EditorView.updateListener.of((update) => {
								if (!update.docChanged) return;
								clearTimeout(timer);
								// Keep draft persistence off the input path. Apply reads the
								// native document directly.
								timer = setTimeout(() => {
									if (view) onchange(view.state.doc.toString());
								}, 200);
							})
						]
					}),
					parent: host
				});
				view.focus();
			} catch (error) {
				reportError('presentation source editor load (CodeMirror)', error);
			}
		})();
		return () => {
			disposed = true;
			clearTimeout(timer);
			view?.destroy();
			view = null;
		};
	});
</script>

<div
	bind:this={host}
	class="source-editor"
	role="textbox"
	aria-label={ariaLabel}
	aria-describedby={ariaDescribedBy}
	data-testid="slide-source-editor"
></div>

<style>
	.source-editor {
		flex: 1;
		min-height: 6em;
		width: 100%;
		overflow: auto;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-bg-1);
		color: var(--color-fg);
		font: 13px/1.6 var(--font-mono, monospace);
	}

	.source-editor :global(.cm-editor) {
		height: 100%;
		min-height: 6em;
	}

	.source-editor :global(.cm-scroller) {
		font: inherit;
	}

	.source-editor :global(.cm-content) {
		padding: 16px;
	}
</style>
