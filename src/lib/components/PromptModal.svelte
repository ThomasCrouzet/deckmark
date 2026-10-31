<script lang="ts">
	// §B1.3 - Reusable prompt/confirm modal. Replaces the 4 native
	// `window.prompt` / `window.confirm` calls (CommandPalette + WorkspacesPanel)
	// which had inconsistent native styling (ignores dark mode), focus/Esc
	// behaviors that diverged per OS, and variable SR support.
	//
	// `prompt` mode: text input + OK/Cancel buttons.
	// `confirm` mode: just OK/Cancel with a message + optional danger button.
	//
	// Pattern:
	//   <PromptModal
	//     open={state.promptOpen}
	//     mode="prompt"
	//     title="Workspace name?"
	//     defaultValue=""
	//     onResolve={(value) => { ... }}
	//   />
	//
	// `onResolve(null)` = cancellation, `onResolve(string)` = validated input
	// (prompt mode) or `onResolve(true|false)` (confirm mode).

	import { tick } from 'svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { t } from '#lib/i18n/index.js';
	import { X } from '@lucide/svelte';

	interface Props {
		open: boolean;
		mode: 'prompt' | 'confirm' | 'choice';
		title: string;
		message?: string | undefined;
		defaultValue?: string | undefined;
		placeholder?: string | undefined;
		confirmLabel?: string | undefined;
		cancelLabel?: string | undefined;
		alternateLabel?: string | undefined;
		inputType?: 'text' | 'password' | undefined;
		danger?: boolean | undefined;
		onResolve: (value: string | boolean | null) => void;
	}

	let {
		open,
		mode,
		title,
		message,
		defaultValue = '',
		placeholder,
		confirmLabel,
		cancelLabel,
		alternateLabel,
		inputType = 'text',
		danger = false,
		onResolve
	}: Props = $props();

	let value = $state('');
	let inputEl: HTMLInputElement | null = $state(null);
	let confirmEl: HTMLButtonElement | null = $state(null);
	let cancelEl: HTMLButtonElement | null = $state(null);

	$effect(() => {
		void title;
		if (open) {
			value = defaultValue;
			tick().then(() => {
				if (mode === 'prompt') {
					inputEl?.focus();
					inputEl?.select();
				} else if (danger) {
					cancelEl?.focus();
				} else {
					confirmEl?.focus();
				}
			});
		}
	});

	function handleConfirm() {
		if (mode === 'prompt') onResolve(value);
		else if (mode === 'choice') onResolve('primary');
		else onResolve(true);
	}

	function handleAlternate() {
		onResolve('alternate');
	}

	function handleCancel() {
		onResolve(mode === 'confirm' ? false : null);
	}

	function handleKey(e: KeyboardEvent) {
		if (e.isComposing || e.defaultPrevented) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			handleCancel();
		} else if (e.key === 'Enter' && mode === 'prompt') {
			e.preventDefault();
			handleConfirm();
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-[90] flex items-start justify-center bg-black/60 px-4 pb-4 backdrop-blur-sm
			       pt-[max(env(safe-area-inset-top),18vh)]"
		style:padding-left="max(env(safe-area-inset-left), 1rem)"
		style:padding-right="max(env(safe-area-inset-right), 1rem)"
		onclick={(e) => {
			if (e.target === e.currentTarget) handleCancel();
		}}
		onkeydown={handleKey}
		role="dialog"
		aria-modal="true"
		aria-labelledby="prompt-modal-title"
		aria-describedby={message ? 'prompt-modal-message' : undefined}
		tabindex="-1"
		use:focusTrap
	>
		<div
			class="mdsh-dialog-panel max-h-[75dvh] overflow-y-auto flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-bg-1 p-4
			       shadow-2xl animate-fade-in"
		>
			<header class="flex items-start justify-between gap-3">
				<h2 id="prompt-modal-title" class="text-sm font-medium text-fg">{title}</h2>
				<button
					type="button"
					class="-m-1 rounded p-1 text-fg-dim transition hover:bg-bg-2 hover:text-fg"
					onclick={handleCancel}
					aria-label={t('prompt.close')}
				>
					<X size={14} />
				</button>
			</header>

			{#if message}
				<p id="prompt-modal-message" class="text-sm text-fg-muted">{message}</p>
			{/if}

			{#if mode === 'prompt'}
				<input
					bind:this={inputEl}
					bind:value
					type={inputType}
					{placeholder}
					class="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-fg outline-none
					       transition-colors focus:border-accent"
					spellcheck="false"
					autocapitalize="off"
					autocomplete="off"
					aria-label={title}
				/>
			{/if}

			<div class="flex flex-wrap justify-end gap-2">
				{#if mode === 'choice' && alternateLabel}
					<button
						type="button"
						class="rounded border border-border bg-transparent px-3 py-1.5 text-sm text-fg-muted transition hover:bg-bg-2 hover:text-fg"
						onclick={handleAlternate}
					>
						{alternateLabel}
					</button>
				{/if}
				<button
					bind:this={cancelEl}
					type="button"
					class="rounded border border-border bg-transparent px-3 py-1.5 text-sm text-fg-muted
					       transition hover:bg-bg-2 hover:text-fg"
					onclick={handleCancel}
				>
					{cancelLabel ?? t('prompt.cancel')}
				</button>
				<button
					bind:this={confirmEl}
					type="button"
					class="rounded border px-3 py-1.5 text-sm transition"
					class:border-danger={danger}
					class:text-danger={danger}
					class:hover:bg-danger={danger}
					class:hover:text-on-danger={danger}
					class:border-accent={!danger}
					class:bg-accent={!danger}
					class:text-on-accent={!danger}
					class:hover:opacity-90={!danger}
					onclick={handleConfirm}
				>
					{confirmLabel ?? (mode === 'confirm' ? t('prompt.confirm') : t('prompt.ok'))}
				</button>
			</div>
		</div>
	</div>
{/if}
