<script lang="ts">
	import { onMount } from 'svelte';
	import { FileText, Presentation } from '@lucide/svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { t } from '#lib/i18n/index.js';
	import type { DocumentKind } from '#lib/document-kind.js';
	let {
		onCreate,
		onClose
	}: { onCreate: (kind: DocumentKind) => Promise<void>; onClose: () => void } = $props();
	let note = $state<HTMLButtonElement | null>(null);
	let busy = $state(false);
	onMount(() => note?.focus());
	async function create(kind: DocumentKind) {
		if (busy) return;
		busy = true;
		try {
			await onCreate(kind);
		} finally {
			busy = false;
		}
	}
</script>

<div class="backdrop bg-black/60 backdrop-blur-sm">
	<div
		class="dialog"
		role="dialog"
		aria-modal="true"
		aria-labelledby="new-document-title"
		tabindex="-1"
		use:focusTrap
		onkeydown={(event) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				if (!busy) onClose();
			}
		}}
	>
		<h2 id="new-document-title">{t('documents.new')}</h2>
		<div class="cards">
			<button
				bind:this={note}
				data-testid="create-note"
				disabled={busy}
				onclick={() => void create('note')}
			>
				<FileText size={28} /><strong>{t('documents.createNote')}</strong><span
					>{t('documents.noteDescription')}</span
				>
			</button>
			<button
				data-testid="create-presentation"
				disabled={busy}
				onclick={() => void create('presentation')}
			>
				<Presentation size={28} /><strong>{t('documents.createPresentation')}</strong><span
					>{t('documents.presentationDescription')}</span
				>
			</button>
		</div>
		<button class="cancel" disabled={busy} onclick={onClose}>{t('slides.cancel')}</button>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: grid;
		place-items: center;
		padding: 16px;
	}
	.dialog {
		display: flex;
		flex-direction: column;
		min-width: 0;
		width: min(100%, 560px);
		max-height: calc(100dvh - 32px);
		overflow: hidden;
		padding: 24px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-bg-1);
		color: var(--color-fg);
		box-shadow: var(--shadow-lg);
	}
	h2 {
		flex: none;
		margin: 0 0 20px;
		font-size: 18px;
		font-weight: 600;
	}
	.cards {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		grid-auto-rows: max-content;
		min-height: 0;
		overflow-y: auto;
		padding: 4px;
		gap: 16px;
	}
	button {
		min-height: 44px;
		padding: 12px;
		cursor: pointer;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
	}
	.cards button {
		min-width: 0;
		overflow-wrap: anywhere;
		display: flex;
		align-items: flex-start;
		flex-direction: column;
		gap: 12px;
		text-align: left;
		background: var(--color-bg-2);
	}
	span {
		font-size: 14px;
		color: var(--color-fg-muted);
	}
	button:hover {
		border-color: var(--color-accent);
	}
	button:focus-visible {
		outline: 2px solid var(--color-focus);
		outline-offset: 3px;
	}
	button:disabled {
		opacity: 0.5;
		cursor: wait;
	}
	.cancel {
		flex: none;
		align-self: flex-start;
		margin-top: 20px;
	}
	@media (max-width: 480px) {
		.cards {
			grid-template-columns: minmax(0, 1fr);
		}
		.dialog {
			padding: 16px;
		}
	}
	@media (max-width: 240px) {
		.backdrop {
			padding: 8px;
		}
		.dialog {
			max-height: calc(100dvh - 16px);
			padding: 8px;
		}
		.cancel {
			margin-top: 8px;
		}
	}
</style>
