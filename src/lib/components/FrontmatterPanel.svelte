<script lang="ts">
	import { onMount } from 'svelte';
	import { X } from '@lucide/svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { parseFrontmatter } from '#lib/frontmatter.js';
	import {
		readFrontmatterKeys,
		readFrontmatterProperties,
		updateFrontmatter,
		type FrontmatterProperty,
		type FrontmatterValue
	} from '#lib/frontmatter-edit.js';
	import { t } from '#lib/i18n/index.js';

	let { open, onClose }: { open: boolean; onClose: () => void } = $props();

	let properties = $state<FrontmatterProperty[]>([]);
	let values = $state<Record<string, FrontmatterValue>>({});
	let original = $state<Record<string, FrontmatterValue>>({});
	let error = $state('');
	let addError = $state('');
	let saveError = $state('');
	let newKey = $state('');
	let newValue = $state('');
	let busy = $state(false);
	let content = $state('');
	let fileId: string | null = null;

	onMount(() => {
		const active = filesStore.active;
		if (!active) return;
		fileId = active.id;
		content = active.content;
		properties = readFrontmatterProperties(content);
		original = Object.fromEntries(properties.map((entry) => [entry.key, entry.value]));
		values = { ...original };
		const id = fileId;
		void parseFrontmatter(content).then((parsed) => {
			if (fileId === id) error = parsed.error ?? '';
		});
	});

	function setValue(key: string, value: FrontmatterValue) {
		values = { ...values, [key]: value };
	}

	function remove(key: string) {
		setValue(key, null);
	}

	function add() {
		const key = newKey.trim();
		addError = '';
		if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
			addError = t('properties.invalidKey');
			return;
		}
		if (readFrontmatterKeys(content).includes(key) || key in values) {
			addError = t('properties.keyExists', { key });
			return;
		}
		properties = [...properties, { key, kind: 'string', raw: '', value: newValue.trim() }];
		original = { ...original, [key]: null };
		setValue(key, newValue.trim());
		newKey = '';
		newValue = '';
	}

	function save() {
		if (busy || error) return;
		saveError = '';
		const changes = Object.entries(values)
			.filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(original[key] ?? null))
			.map(([key, value]) => ({ key, value }));
		if (changes.length === 0) {
			onClose();
			return;
		}
		const target = fileId ? filesStore.library.find((entry) => entry.id === fileId) : undefined;
		if (!target || target.content !== content) {
			saveError = t('properties.staleDocument');
			return;
		}
		busy = true;
		try {
			const next = updateFrontmatter(content, changes);
			filesStore.updateContent(target.id, next);
			onClose();
		} catch (reason) {
			saveError =
				reason instanceof Error && reason.message
					? `${t('properties.saveFailed')} ${reason.message}`
					: t('properties.saveFailed');
		} finally {
			busy = false;
		}
	}

	function kindLabel(property: FrontmatterProperty): string {
		return t(`properties.kind_${property.kind}` as 'properties.kind_string');
	}
</script>

{#if open}
	<div class="fm-backdrop">
		<div
			class="fm-panel"
			role="dialog"
			aria-modal="true"
			aria-labelledby="fm-title"
			tabindex="-1"
			use:focusTrap
			onkeydown={(event) => {
				if (event.key === 'Escape') onClose();
			}}
			data-testid="frontmatter-panel"
		>
			<header>
				<h2 id="fm-title">{t('properties.title')}</h2>
				<button type="button" onclick={onClose} aria-label={t('settings.close')}
					><X size={16} /></button
				>
			</header>
			{#if error}
				<div class="fm-error" role="alert" data-testid="frontmatter-error">
					<p>{t('properties.invalidYaml')}</p>
					<pre>{error}</pre>
					<p>{t('properties.repairInSource')}</p>
				</div>
			{:else}
				<div class="fm-list">
					{#each properties as property (property.key)}
						<div class="fm-row" data-testid={`frontmatter-${property.key}`}>
							<label>
								<span class="fm-key">{property.key}</span>
								<small>{kindLabel(property)}</small>
								{#if property.kind === 'boolean'}
									<input
										type="checkbox"
										checked={values[property.key] === true}
										onchange={(event) => setValue(property.key, event.currentTarget.checked)}
									/>
								{:else if property.kind === 'tags'}
									<input
										type="text"
										value={Array.isArray(values[property.key])
											? (values[property.key] as string[]).join(', ')
											: String(values[property.key] ?? '')}
										oninput={(event) =>
											setValue(
												property.key,
												event.currentTarget.value
													.split(',')
													.map((item) => item.trim())
													.filter(Boolean)
											)}
									/>
								{:else if property.kind === 'number'}
									<input
										type="number"
										value={String(values[property.key] ?? '')}
										oninput={(event) => setValue(property.key, Number(event.currentTarget.value))}
									/>
								{:else}
									<input
										type="text"
										value={String(values[property.key] ?? '')}
										oninput={(event) => setValue(property.key, event.currentTarget.value)}
									/>
								{/if}
							</label>
							<button
								type="button"
								onclick={() => remove(property.key)}
								aria-label={t('properties.remove', { key: property.key })}
								data-testid={`frontmatter-remove-${property.key}`}>×</button
							>
						</div>
					{/each}
				</div>
				<div class="fm-add">
					<input
						type="text"
						bind:value={newKey}
						placeholder={t('properties.key')}
						aria-label={t('properties.key')}
						data-testid="frontmatter-new-key"
					/>
					<input
						type="text"
						bind:value={newValue}
						placeholder={t('properties.value')}
						aria-label={t('properties.value')}
						data-testid="frontmatter-new-value"
					/>
					<button type="button" onclick={add} data-testid="frontmatter-add"
						>{t('properties.add')}</button
					>
					{#if addError}
						<p class="fm-inline-error" role="alert" data-testid="frontmatter-add-error">
							{addError}
						</p>
					{/if}
				</div>
				<p class="fm-note">{t('properties.note')}</p>
				{#if saveError}
					<p class="fm-inline-error" role="alert" data-testid="frontmatter-save-error">
						{saveError}
					</p>
				{/if}
				<div class="fm-actions">
					<button type="button" onclick={onClose}>{t('slides.cancel')}</button>
					<button
						type="button"
						class="primary"
						disabled={busy}
						onclick={save}
						data-testid="frontmatter-save"
					>
						{t('properties.save')}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.fm-backdrop {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: grid;
		place-items: center;
		padding: 16px;
		background: rgb(0 0 0 / 0.55);
	}
	.fm-panel {
		display: flex;
		max-height: calc(100dvh - 32px);
		width: min(100%, 560px);
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-bg-1);
		color: var(--color-fg);
		box-shadow: var(--shadow-lg);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--color-border);
	}
	h2 {
		margin: 0;
		font-size: 15px;
	}
	header button {
		min-width: 36px;
		min-height: 36px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--color-fg);
	}
	.fm-list {
		min-height: 0;
		flex: 1;
		overflow-y: auto;
		padding: 10px 16px;
	}
	.fm-row {
		display: flex;
		align-items: flex-end;
		gap: 6px;
		margin-bottom: 8px;
	}
	.fm-row label {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
		gap: 2px;
		font-size: 11px;
	}
	.fm-key {
		font-family: var(--font-mono);
		color: var(--color-fg);
	}
	.fm-row small {
		color: var(--color-fg-dim);
	}
	.fm-row input[type='text'],
	.fm-row input[type='number'] {
		min-height: 34px;
		width: 100%;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		padding: 2px 6px;
	}
	.fm-row > button {
		min-width: 32px;
		min-height: 34px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-danger);
	}
	.fm-add {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 8px 16px;
		border-top: 1px solid var(--color-border);
	}
	.fm-add input {
		min-height: 34px;
		min-width: 0;
		flex: 1;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		padding: 2px 6px;
	}
	.fm-add button,
	.fm-actions button {
		min-height: 34px;
		padding: 4px 10px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
	}
	.fm-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 10px 16px;
		border-top: 1px solid var(--color-border);
	}
	.fm-actions .primary {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}
	.fm-note {
		margin: 0;
		padding: 0 16px;
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.fm-error {
		padding: 16px;
		color: var(--color-danger);
	}
	.fm-inline-error {
		flex-basis: 100%;
		margin: 0;
		font-size: 11px;
		color: var(--color-danger);
	}
	.fm-error pre {
		max-height: 160px;
		overflow: auto;
		white-space: pre-wrap;
		font-size: 11px;
	}
</style>
