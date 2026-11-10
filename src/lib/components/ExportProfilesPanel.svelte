<script lang="ts">
	import { onMount } from 'svelte';
	import { X } from '@lucide/svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { t, type MessageKey } from '#lib/i18n/index.js';
	import {
		activeProfile,
		createProfile,
		ExportProfileError,
		parseProfiles,
		persistProfileSelection,
		readProfiles,
		saveProfiles,
		serializeProfiles,
		setActiveProfile,
		type ExportProfile,
		type ExportProfileErrorCode
	} from '#lib/export-profiles.js';

	const PROFILE_ERROR_KEYS = {
		unsupported: 'exportProfiles.error.unsupported',
		missing: 'exportProfiles.error.missing',
		empty: 'exportProfiles.error.empty',
		invalid: 'exportProfiles.error.invalid',
		duplicate: 'exportProfiles.error.duplicate',
		excess: 'exportProfiles.error.excess',
		oversized: 'exportProfiles.error.oversized'
	} satisfies Record<ExportProfileErrorCode, MessageKey>;

	function importErrorMessage(failure: unknown): string {
		if (failure instanceof ExportProfileError) return t(PROFILE_ERROR_KEYS[failure.code]);
		return t('exportProfiles.error.import');
	}

	let { open, onClose }: { open: boolean; onClose: () => void } = $props();

	let profiles = $state<ExportProfile[]>([]);
	let selectedId = $state('');
	let activeId = $state('');
	let error = $state('');
	let importInput = $state<HTMLInputElement | null>(null);
	const selected = $derived(profiles.find((profile) => profile.id === selectedId) ?? null);

	onMount(load);

	function load() {
		profiles = readProfiles();
		activeId = activeProfile(profiles)?.id ?? '';
		// Always offer a profile for editing. Only `activeId` controls exports.
		selectedId = activeId || (profiles[0]?.id ?? '');
	}

	function update(patch: Partial<ExportProfile>) {
		if (!selected) return;
		const next = profiles.map((profile) =>
			profile.id === selected.id ? { ...profile, ...patch, updatedAt: Date.now() } : profile
		);
		try {
			saveProfiles(next);
		} catch (failure) {
			error = importErrorMessage(failure);
			return;
		}
		profiles = next;
		error = '';
	}

	function add() {
		const profile = createProfile(t('exportProfiles.newName'));
		const next = [...profiles, profile];
		try {
			saveProfiles(next);
		} catch (failure) {
			error = importErrorMessage(failure);
			return;
		}
		profiles = next;
		selectedId = profile.id;
		error = '';
	}

	function remove() {
		if (!selected || profiles.length <= 1) return;
		const next = profiles.filter((profile) => profile.id !== selected.id);
		const nextActive = activeId === selected.id ? next[0]!.id : activeId;
		try {
			persistProfileSelection(next, nextActive);
		} catch (failure) {
			error = importErrorMessage(failure);
			return;
		}
		profiles = next;
		activeId = nextActive;
		selectedId = next[0]!.id;
		error = '';
	}

	function activate() {
		if (!selected) return;
		activeId = selected.id;
		setActiveProfile(selected.id);
	}

	async function exportProfiles() {
		const { triggerDownload, sanitizeFilename } = await import('#lib/services/export.js');
		await triggerDownload(
			new Blob([serializeProfiles(profiles)], { type: 'application/json' }),
			sanitizeFilename('deckmark-export-profiles.json')
		);
	}

	async function importProfiles(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		try {
			const imported = parseProfiles(await file.text());
			// Keep the active profile only when the file contains it. Otherwise
			// select and persist an explicit fallback before the UI changes.
			const nextActiveId = imported.some((profile) => profile.id === activeId)
				? activeId
				: imported[0]!.id;
			persistProfileSelection(imported, nextActiveId);
			profiles = imported;
			activeId = nextActiveId;
			selectedId = nextActiveId;
			error = '';
		} catch (failure) {
			// The previous collection and selection stay persisted and visible.
			error = importErrorMessage(failure);
		}
	}
</script>

{#if open}
	<div class="profile-backdrop">
		<div
			class="profile-panel"
			role="dialog"
			aria-modal="true"
			aria-labelledby="profile-title"
			tabindex="-1"
			use:focusTrap
			onkeydown={(event) => {
				if (event.key === 'Escape') onClose();
			}}
			data-testid="export-profiles"
		>
			<header>
				<h2 id="profile-title">{t('exportProfiles.title')}</h2>
				<button type="button" onclick={onClose} aria-label={t('settings.close')}
					><X size={16} /></button
				>
			</header>
			<div class="profile-body">
				<div class="profile-list" role="listbox" aria-label={t('exportProfiles.list')}>
					{#each profiles as profile (profile.id)}
						<button
							type="button"
							role="option"
							aria-selected={selectedId === profile.id}
							onclick={() => (selectedId = profile.id)}
							data-testid={`export-profile-${profile.id}`}
						>
							<span>{profile.name}</span>
							<em>{profile.format.toUpperCase()} · {profile.pageSize}</em>
							{#if activeId === profile.id}<strong>{t('exportProfiles.active')}</strong>{/if}
						</button>
					{/each}
				</div>
				{#if selected}
					<div class="profile-form">
						<label>
							<span>{t('exportProfiles.name')}</span>
							<input
								type="text"
								value={selected.name}
								oninput={(event) => update({ name: event.currentTarget.value })}
								data-testid="export-profile-name"
							/>
						</label>
						<label>
							<span>{t('exportProfiles.format')}</span>
							<select
								value={selected.format}
								onchange={(event) =>
									update({ format: event.currentTarget.value as ExportProfile['format'] })}
								data-testid="export-profile-format"
							>
								<option value="pdf">PDF</option>
								<option value="html">HTML</option>
							</select>
						</label>
						<label>
							<span>{t('exportProfiles.pageSize')}</span>
							<select
								value={selected.pageSize}
								onchange={(event) =>
									update({ pageSize: event.currentTarget.value as ExportProfile['pageSize'] })}
								data-testid="export-profile-page-size"
							>
								<option value="A4">A4</option>
								<option value="Letter">Letter</option>
								<option value="Legal">Legal</option>
							</select>
						</label>
						<label>
							<span>{t('exportProfiles.margin')}</span>
							<input
								type="number"
								min="5"
								max="60"
								value={selected.marginMm}
								oninput={(event) => update({ marginMm: Number(event.currentTarget.value) })}
							/>
						</label>
						<label>
							<span>{t('exportProfiles.font')}</span>
							<select
								value={selected.fontFamily}
								onchange={(event) =>
									update({ fontFamily: event.currentTarget.value as ExportProfile['fontFamily'] })}
							>
								<option value="serif">{t('exportProfiles.serif')}</option>
								<option value="sans">{t('exportProfiles.sans')}</option>
								<option value="mono">{t('exportProfiles.mono')}</option>
							</select>
						</label>
						<label>
							<span>{t('exportProfiles.fontSize')}</span>
							<input
								type="number"
								min="7"
								max="24"
								value={selected.fontSizePt}
								oninput={(event) => update({ fontSizePt: Number(event.currentTarget.value) })}
							/>
						</label>
						<label class="check">
							<input
								type="checkbox"
								checked={selected.includeCover}
								onchange={(event) => update({ includeCover: event.currentTarget.checked })}
								data-testid="export-profile-cover"
							/>
							<span>{t('exportProfiles.cover')}</span>
						</label>
						<label>
							<span>{t('exportProfiles.header')}</span>
							<input
								type="text"
								value={selected.header}
								oninput={(event) => update({ header: event.currentTarget.value })}
								data-testid="export-profile-header"
							/>
						</label>
						<label>
							<span>{t('exportProfiles.footer')}</span>
							<input
								type="text"
								value={selected.footer}
								oninput={(event) => update({ footer: event.currentTarget.value })}
								data-testid="export-profile-footer"
							/>
						</label>
						<div class="profile-actions">
							<button
								type="button"
								class="primary"
								onclick={activate}
								data-testid="export-profile-use"
							>
								{t(activeId === selected.id ? 'exportProfiles.inUse' : 'exportProfiles.use')}
							</button>
							<button type="button" onclick={add}>{t('exportProfiles.add')}</button>
							<button type="button" onclick={remove} disabled={profiles.length <= 1}>
								{t('exportProfiles.delete')}
							</button>
						</div>
					</div>
				{/if}
				{#if error}<p class="error" role="alert" data-testid="export-profiles-error">
						{error}
					</p>{/if}
				<p class="profile-note">{t('exportProfiles.webLimits')}</p>
				<div class="profile-io">
					<button
						type="button"
						onclick={() => void exportProfiles()}
						data-testid="export-profiles-export"
					>
						{t('exportProfiles.export')}
					</button>
					<button type="button" onclick={() => importInput?.click()}>
						{t('exportProfiles.import')}
					</button>
					<input
						bind:this={importInput}
						type="file"
						accept="application/json,.json"
						class="hidden"
						onchange={importProfiles}
						data-testid="export-profiles-import"
					/>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.profile-backdrop {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: grid;
		place-items: center;
		padding: 16px;
		background: rgb(0 0 0 / 0.55);
	}
	.profile-panel {
		display: flex;
		max-height: calc(100dvh - 32px);
		width: min(100%, 760px);
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
	.profile-body {
		display: grid;
		grid-template-columns: minmax(0, 220px) minmax(0, 1fr);
		gap: 12px;
		min-height: 0;
		overflow-y: auto;
		padding: 12px 16px;
	}
	.profile-list {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 4px;
	}
	.profile-list button {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		padding: 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		font-size: 12px;
	}
	.profile-list button[aria-selected='true'] {
		border-color: var(--color-accent);
	}
	.profile-list em {
		font-style: normal;
		font-size: 10px;
		color: var(--color-fg-muted);
	}
	.profile-list strong {
		font-size: 10px;
		color: var(--color-accent);
	}
	.profile-form {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
		min-width: 0;
	}
	.profile-form label {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.profile-form label.check {
		flex-direction: row;
		align-items: center;
	}
	.profile-form input,
	.profile-form select {
		min-height: 32px;
		width: 100%;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		padding: 2px 6px;
	}
	.profile-actions,
	.profile-io {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		grid-column: 1 / -1;
	}
	.profile-actions button,
	.profile-io button {
		min-height: 32px;
		padding: 3px 9px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		font-size: 11px;
	}
	.profile-actions .primary {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}
	.profile-note {
		grid-column: 1 / -1;
		margin: 0;
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.error {
		grid-column: 1 / -1;
		color: var(--color-danger);
		font-size: 12px;
	}
	.hidden {
		display: none;
	}
	@media (max-width: 640px) {
		.profile-body {
			grid-template-columns: minmax(0, 1fr);
		}
		.profile-form {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
