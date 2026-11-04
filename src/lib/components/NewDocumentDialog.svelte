<script lang="ts">
	import { onMount } from 'svelte';
	import { FileText, Presentation, Search } from '@lucide/svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { t } from '#lib/i18n/index.js';
	import type { DocumentKind } from '#lib/document-kind.js';
	import { templatesStore, type TemplateChoice } from '#lib/templates.svelte.js';
	let {
		onCreate,
		onCreateFromTemplate,
		onClose
	}: {
		onCreate: (kind: DocumentKind) => Promise<void>;
		onCreateFromTemplate: (templateId: string) => Promise<void>;
		onClose: () => void;
	} = $props();
	let note = $state<HTMLButtonElement | null>(null);
	let busy = $state(false);
	let ready = $state(false);
	let query = $state('');

	onMount(() => {
		void templatesStore
			.load()
			.catch(() => {})
			.finally(() => (ready = true));
		note?.focus();
	});

	const matches = (template: TemplateChoice, search: string) => {
		const value = search.trim().toLocaleLowerCase();
		if (!value) return true;
		return `${template.name} ${template.description}`.toLocaleLowerCase().includes(value);
	};
	const builtin = $derived(
		templatesStore.choices.filter((tpl) => tpl.builtin && matches(tpl, query))
	);
	const saved = $derived(
		templatesStore.choices.filter((tpl) => !tpl.builtin && matches(tpl, query))
	);
	const empty = $derived(ready && builtin.length === 0 && saved.length === 0);

	async function run(action: () => Promise<void>) {
		if (busy) return;
		busy = true;
		try {
			await action();
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
		<div class="dialog-body">
			<h2 id="new-document-title">{t('documents.new')}</h2>
			<div class="cards">
				<button
					bind:this={note}
					data-testid="create-note"
					disabled={busy}
					onclick={() => void run(() => onCreate('note'))}
				>
					<FileText size={28} /><strong>{t('documents.createNote')}</strong><span
						>{t('documents.noteDescription')}</span
					>
				</button>
				<button
					data-testid="create-presentation"
					disabled={busy}
					onclick={() => void run(() => onCreate('presentation'))}
				>
					<Presentation size={28} /><strong>{t('documents.createPresentation')}</strong><span
						>{t('documents.presentationDescription')}</span
					>
				</button>
			</div>

			<section class="templates" aria-labelledby="template-choice-title">
				<h3 id="template-choice-title">{t('templates.choose')}</h3>
				<label class="template-search">
					<Search size={14} aria-hidden="true" />
					<span class="sr-only">{t('templates.search')}</span>
					<input
						type="search"
						bind:value={query}
						placeholder={t('templates.search')}
						aria-label={t('templates.search')}
						data-testid="template-search"
					/>
				</label>
				{#each [{ label: t('templates.builtinGroup'), items: builtin }, { label: t('templates.userGroup'), items: saved }] as group (group.label)}
					{#if group.items.length > 0}
						<h4>{group.label}</h4>
						<div class="template-list">
							{#each group.items as template (template.id)}
								<button
									type="button"
									disabled={busy}
									data-testid={`create-template-${template.id}`}
									onclick={() => void run(() => onCreateFromTemplate(template.id))}
								>
									<strong>{template.name}</strong>
									<span>{template.description}</span>
									<em
										>{t(
											template.kind === 'presentation' ? 'documents.presentation' : 'documents.note'
										)}</em
									>
								</button>
							{/each}
						</div>
					{/if}
				{/each}
				{#if !ready}
					<p class="template-empty" role="status">{t('templates.loading')}</p>
				{:else if empty}
					<p class="template-empty" role="status">{t('templates.noMatch')}</p>
				{/if}
			</section>
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
		width: min(100%, 680px);
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
	h3 {
		margin: 18px 0 8px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-fg-dim);
	}
	h4 {
		margin: 10px 0 6px;
		font-size: 11px;
		font-weight: 500;
		color: var(--color-fg-muted);
	}
	.cards {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		grid-auto-rows: max-content;
		gap: 16px;
		padding: 4px;
	}
	.dialog-body {
		display: flex;
		min-height: 0;
		flex: 1 1 auto;
		flex-direction: column;
		overflow-y: auto;
	}
	.templates {
		min-height: 0;
		margin-top: 6px;
		padding: 4px;
	}
	.template-search {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-bg-2);
		color: var(--color-fg-muted);
	}
	.template-search input {
		min-height: 32px;
		flex: 1;
		border: 0;
		background: transparent;
		color: var(--color-fg);
		outline: none;
	}
	.template-list {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 8px;
	}
	.template-list button {
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		padding: 8px 10px;
		background: var(--color-bg-2);
		text-align: left;
	}
	.template-list button strong {
		font-size: 13px;
		font-weight: 600;
	}
	.template-list button em {
		font-size: 10px;
		font-style: normal;
		color: var(--color-fg-dim);
	}
	.template-empty {
		margin: 8px 0;
		font-size: 12px;
		color: var(--color-fg-muted);
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
		margin-top: 12px;
	}
	@media (max-width: 260px) {
		/* 200 percent browser zoom on a 320 pixel screen leaves 160 CSS pixels. */
		.cards,
		.template-list {
			grid-template-columns: minmax(0, 1fr);
		}
		.cards button {
			min-height: 0;
			padding: 8px;
			gap: 6px;
		}
		.cards button span {
			/* Keep the node laid out: measurement checks reject a zero-size child. */
			display: -webkit-box;
			overflow: hidden;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 2;
			line-clamp: 2;
			font-size: 10px;
			line-height: 1.15;
		}
	}
	@media (max-width: 640px) {
		.template-list {
			grid-template-columns: minmax(0, 1fr);
		}
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
