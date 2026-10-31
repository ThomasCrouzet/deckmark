<script lang="ts">
	// §J1 - Displays the transient toasts of the `notify` store (errors, success,
	// info). Keep notices below the toolbar, including its mobile second row.
	// The undo-close Toast and SpinnerToast are anchored bottom-center.
	//
	// A11y (WCAG 4.1.3): each toast carries `role="alert"` for errors
	// (assertive announcement) and `role="status"` for success/info (polite
	// announcement). The icon is purely decorative (`aria-hidden`) - the
	// message carries the meaning.
	import { notify, type ToastLevel } from '#lib/notify.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import { TriangleAlert, CircleCheck, Info, X } from '@lucide/svelte';
	import { onMount } from 'svelte';
	let { embedded = false }: { embedded?: boolean } = $props();

	let toolbarBottom = $state(48);
	onMount(() => {
		if (embedded) return;
		const toolbar = document.getElementById('app-toolbar');
		let frame = 0;
		const measure = () => {
			frame = 0;
			toolbarBottom = toolbar?.getBoundingClientRect().bottom ?? 0;
		};
		// Do not change layout during ResizeObserver delivery in WebKit.
		const scheduleMeasure = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		measure();
		const observer =
			typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
		if (toolbar) observer?.observe(toolbar);
		window.addEventListener('resize', scheduleMeasure);
		return () => {
			observer?.disconnect();
			window.removeEventListener('resize', scheduleMeasure);
			if (frame) cancelAnimationFrame(frame);
		};
	});

	const icons = { error: TriangleAlert, success: CircleCheck, info: Info } as const;
	const iconColor: Record<ToastLevel, string> = {
		error: 'text-danger',
		success: 'text-accent',
		info: 'text-fg-muted'
	};
</script>

{#if notify.toasts.length > 0}
	<div
		class={embedded
			? 'flex shrink-0 flex-col gap-2 px-3 py-2'
			: 'pointer-events-none fixed left-1/2 z-[60] flex w-[min(92vw,28rem)] -translate-x-1/2 flex-col gap-2'}
		style:top={embedded ? undefined : `${toolbarBottom + 16}px`}
	>
		{#each notify.toasts as toast (toast.id)}
			{@const Icon = icons[toast.level]}
			<div
				class="animate-fade-in pointer-events-auto flex items-start gap-2.5 rounded-md border border-border bg-bg-1 px-3 py-2.5 text-sm text-fg shadow-lg"
				class:border-danger={toast.level === 'error'}
				role={toast.level === 'error' ? 'alert' : 'status'}
			>
				<span class="mt-0.5 shrink-0 {iconColor[toast.level]}">
					<Icon size={16} aria-hidden="true" />
				</span>
				<span class="min-w-0 flex-1 break-words">{toast.message}</span>
				{#if toast.action}
					<button
						class="shrink-0 rounded border border-accent-dim px-2 py-0.5 text-xs font-medium text-accent transition hover:bg-bg-2"
						onclick={() => {
							toast.action?.run();
							notify.dismiss(toast.id);
						}}
					>
						{toast.action.label}
					</button>
				{/if}
				<button
					class="-mr-1 shrink-0 rounded p-0.5 text-fg-muted transition hover:bg-bg-2 hover:text-fg"
					onclick={() => notify.dismiss(toast.id)}
					aria-label={t('toasts.dismiss')}
				>
					<X size={14} aria-hidden="true" />
				</button>
			</div>
		{/each}
	</div>
{/if}
