<script lang="ts">
	import { lineDiff, type DiffLine } from '#lib/diff.js';
	import { t, type MessageKey } from '#lib/i18n/index.js';

	interface Props {
		before: string;
		after: string;
		beforeLabel?: string;
		afterLabel?: string;
		ariaLabel?: string;
		maxHeight?: string;
	}

	let { before, after, beforeLabel, afterLabel, ariaLabel, maxHeight = '28rem' }: Props = $props();

	const result = $derived(lineDiff(before, after));
	const labelBefore = $derived(beforeLabel ?? t('diff.before'));
	const labelAfter = $derived(afterLabel ?? t('diff.after'));
	const regionLabel = $derived(ariaLabel ?? `${labelBefore}, ${labelAfter}`);

	function message(key: MessageKey, params?: Record<string, string | number>): string {
		return t(key, params);
	}

	function lineLabel(line: DiffLine): string {
		if (line.kind === 'skip') {
			return message('diff.omitted', {
				old: line.omittedOldLines,
				next: line.omittedNewLines
			});
		}
		const number = line.kind === 'add' ? line.newLine : line.oldLine;
		const key =
			line.kind === 'add'
				? 'diff.added'
				: line.kind === 'remove'
					? 'diff.removed'
					: 'diff.unchanged';
		const label = message(key, { line: number ?? '' });
		return line.textTruncated
			? `${label}. ${message('diff.lineTruncated', { line: number ?? '' })}`
			: label;
	}
</script>

<section
	class="diff-view min-h-0 overflow-hidden rounded border border-border"
	aria-label={regionLabel}
>
	<div
		class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-bg-2 px-3 py-2 text-xs"
	>
		<span class="font-medium text-fg">{labelBefore}</span>
		<span class="text-fg-dim">{labelAfter}</span>
		<span class="ml-auto text-fg-muted" role="status" aria-live="polite">
			{result.added === 0 && result.removed === 0
				? message('diff.noChanges')
				: message('diff.summary', { added: result.added, removed: result.removed })}
		</span>
	</div>
	{#if result.approximate}
		<p class="border-b border-border bg-bg-2 px-3 py-1.5 text-xs text-fg-muted" role="status">
			{message('diff.approximate')}
		</p>
	{/if}
	<!-- The focusable list lets keyboard users scroll long diffs. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<ol
		class="m-0 overflow-auto bg-bg-1 p-0 font-mono text-xs leading-5"
		style:max-height={maxHeight}
		aria-label={regionLabel}
		tabindex="0"
	>
		{#each result.lines as line, index (`${line.kind}:${line.oldLine}:${line.newLine}:${index}`)}
			<li
				class="diff-line grid min-w-max grid-cols-[3.5rem_3.5rem_1.5rem_minmax(20rem,1fr)] border-b border-border/40"
				class:diff-remove={line.kind === 'remove'}
				class:diff-add={line.kind === 'add'}
				class:text-fg-dim={line.kind === 'equal' || line.kind === 'skip'}
				data-diff-kind={line.kind}
				aria-label={lineLabel(line)}
			>
				<span class="select-none border-r border-border/50 px-2 text-right" aria-hidden="true"
					>{line.oldLine ?? ''}</span
				>
				<span class="select-none border-r border-border/50 px-2 text-right" aria-hidden="true"
					>{line.newLine ?? ''}</span
				>
				<span class="select-none px-1 text-center" aria-hidden="true">
					{line.kind === 'add'
						? '+'
						: line.kind === 'remove'
							? '-'
							: line.kind === 'skip'
								? '...'
								: ' '}
				</span>
				<span class="whitespace-pre-wrap break-words pr-3" aria-hidden="true">
					{line.kind === 'skip'
						? message('diff.omitted', {
								old: line.omittedOldLines,
								next: line.omittedNewLines
							})
						: line.text || ' '}
				</span>
			</li>
		{/each}
	</ol>
</section>

<style>
	.diff-remove {
		background: color-mix(in oklab, var(--color-danger) 10%, transparent);
	}
	.diff-add {
		background: color-mix(in oklab, var(--color-accent) 10%, transparent);
	}
	.diff-view ol:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}
</style>
