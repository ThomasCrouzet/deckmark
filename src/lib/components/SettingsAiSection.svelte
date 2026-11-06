<script lang="ts">
	// AI settings domain. The settings panel lazy-loads this component, so the
	// provider controls and their local state stay out of the startup path.
	import { t } from '#lib/i18n/index.js';
	import { aiStore, aiErrorMessage } from '#lib/ai/store.svelte.js';

	let aiModels = $state<string[]>([]);
	let aiBusy = $state(false);
	let aiStatus = $state('');
	let aiKeyDraft = $state('');

	async function loadAiModels() {
		if (aiBusy) return;
		aiBusy = true;
		aiStatus = '';
		try {
			aiModels = await aiStore.listModels();
			if (!aiStore.settings.model && aiModels[0]) aiStore.update({ model: aiModels[0] });
			aiStatus = t('settings.aiModelsLoaded', { n: aiModels.length });
		} catch (error) {
			aiStatus = aiErrorMessage(error);
		} finally {
			aiBusy = false;
		}
	}

	async function testAiConnection() {
		if (aiBusy) return;
		aiBusy = true;
		aiStatus = t('settings.aiTesting');
		try {
			const reply = await aiStore.testConnection();
			aiStatus = t('settings.aiTestOk', { reply: reply.slice(0, 40) });
		} catch (error) {
			aiStatus = aiErrorMessage(error);
		} finally {
			aiBusy = false;
		}
	}

	function saveAiKey() {
		void (async () => {
			aiBusy = true;
			try {
				await aiStore.setApiKey(aiKeyDraft);
				aiKeyDraft = '';
				aiStatus = aiStore.keyConfigured
					? t(
							aiStore.usesNativeVault
								? 'settings.aiKeyConfiguredNative'
								: 'settings.aiKeyConfigured'
						)
					: '';
			} catch (error) {
				aiStatus = aiErrorMessage(error);
			} finally {
				aiBusy = false;
			}
		})();
	}

	function clearAiKey() {
		void (async () => {
			aiBusy = true;
			try {
				await aiStore.clearApiKey();
				aiStatus = '';
			} catch (error) {
				aiStatus = aiErrorMessage(error);
			} finally {
				aiBusy = false;
			}
		})();
	}
</script>

<!-- AI: optional provider-agnostic connection -->
<details class="mb-5 rounded border border-border p-3 text-sm" data-testid="ai-settings">
	<summary class="cursor-pointer">{t('settings.ai')}</summary>
	<p class="mt-2 text-xs text-fg-muted">{t('settings.aiHelp')}</p>
	{#if aiStore.usesNativeVault}
		<p class="mt-1 text-xs text-fg-muted" data-testid="ai-native-boundary">
			{t('settings.aiNativeBoundary')}
		</p>
	{:else}
		<p class="mt-1 text-xs text-fg-muted" data-testid="ai-browser-boundary">
			{t('settings.aiBrowserNoVault')}
		</p>
	{/if}
	<label class="mt-3 flex items-center justify-between gap-3">
		<span>{t('settings.aiEnabled')}</span>
		<input
			type="checkbox"
			checked={aiStore.settings.enabled}
			onchange={(event) => aiStore.update({ enabled: event.currentTarget.checked })}
			data-testid="ai-enabled"
		/>
	</label>
	<div
		class="mt-3 flex flex-wrap items-center gap-1"
		role="group"
		aria-label={t('settings.aiPrivacy')}
	>
		<button
			type="button"
			class="rounded border border-border px-2.5 py-1 text-xs"
			class:bg-bg-3={aiStore.settings.privacyMode === 'direct'}
			aria-pressed={aiStore.settings.privacyMode === 'direct'}
			onclick={() => aiStore.update({ privacyMode: 'direct' })}
			data-testid="ai-mode-direct">{t('settings.aiDirect')}</button
		>
		<button
			type="button"
			class="rounded border border-border px-2.5 py-1 text-xs"
			class:bg-bg-3={aiStore.settings.privacyMode === 'local'}
			aria-pressed={aiStore.settings.privacyMode === 'local'}
			onclick={() => aiStore.update({ privacyMode: 'local' })}
			data-testid="ai-mode-local">{t('settings.aiLocal')}</button
		>
	</div>
	{#if aiStore.settings.privacyMode === 'local'}
		<p class="mt-2 text-xs text-warning" role="status">
			{t('settings.aiLocalUnavailable')}
		</p>
	{:else}
		{#if aiStore.usesNativeVault}
			<p class="mt-3 text-xs text-fg-muted" role="note">
				{t('settings.aiNativeKeyNote')}
			</p>
		{:else}
			<label class="mt-3 flex items-center justify-between gap-3">
				<span class="text-xs text-fg-muted">{t('settings.aiAllowKey')}</span>
				<input
					type="checkbox"
					checked={aiStore.settings.allowBrowserKey}
					onchange={(event) => aiStore.update({ allowBrowserKey: event.currentTarget.checked })}
					data-testid="ai-allow-key"
				/>
			</label>
			<p class="mt-1 text-xs text-warning" role="note">
				{t('settings.aiAllowKeyWarning')}
			</p>
		{/if}
	{/if}
	<label class="mt-3 block text-xs text-fg-muted">
		<span>{t('settings.aiBaseUrl')}</span>
		<input
			type="url"
			class="mt-1 w-full rounded border border-border bg-bg-2 px-2 py-1 text-sm text-fg"
			value={aiStore.settings.baseUrl}
			onchange={(event) => aiStore.update({ baseUrl: event.currentTarget.value })}
			data-testid="ai-base-url"
		/>
	</label>
	<label class="mt-2 block text-xs text-fg-muted">
		<span>{t('settings.aiModel')}</span>
		<input
			type="text"
			list="ai-model-list"
			class="mt-1 w-full rounded border border-border bg-bg-2 px-2 py-1 text-sm text-fg"
			value={aiStore.settings.model}
			placeholder={t('settings.aiModelPlaceholder')}
			oninput={(event) => aiStore.update({ model: event.currentTarget.value })}
			data-testid="ai-model"
		/>
	</label>
	<datalist id="ai-model-list">
		{#each aiModels as model (model)}<option value={model}></option>{/each}
	</datalist>
	<div class="mt-2 flex flex-wrap items-end gap-2">
		<button
			type="button"
			class="rounded border border-border px-2.5 py-1 text-xs"
			disabled={aiBusy || aiStore.usesNativeVault}
			onclick={() => void loadAiModels()}
			data-testid="ai-load-models">{t('settings.aiLoadModels')}</button
		>
		<button
			type="button"
			class="rounded border border-border px-2.5 py-1 text-xs"
			disabled={aiBusy}
			onclick={() => void testAiConnection()}
			data-testid="ai-test">{t('settings.aiTest')}</button
		>
	</div>
	<div class="mt-2 flex flex-wrap items-end gap-2">
		<label class="flex-1 text-xs text-fg-muted">
			<span>{t('settings.aiKey')}</span>
			<input
				type="password"
				autocomplete="off"
				class="mt-1 w-full rounded border border-border bg-bg-2 px-2 py-1 text-sm text-fg"
				bind:value={aiKeyDraft}
				placeholder={aiStore.keyConfigured
					? t(
							aiStore.usesNativeVault
								? 'settings.aiKeyConfiguredNative'
								: 'settings.aiKeyConfigured'
						)
					: t(
							aiStore.usesNativeVault
								? 'settings.aiKeyPlaceholderNative'
								: 'settings.aiKeyPlaceholder'
						)}
				data-testid="ai-key"
			/>
		</label>
		<button
			type="button"
			class="rounded border border-border px-2.5 py-1 text-xs"
			disabled={aiBusy}
			onclick={saveAiKey}
			data-testid="ai-key-save">{t('settings.aiKeySave')}</button
		>
		<button
			type="button"
			class="rounded border border-border px-2.5 py-1 text-xs"
			disabled={aiBusy}
			onclick={clearAiKey}
			data-testid="ai-key-clear"
			>{aiStore.usesNativeVault ? t('settings.aiKeyClearNative') : t('settings.aiKeyClear')}</button
		>
	</div>
	<p class="mt-1 text-xs text-fg-muted">
		{aiStore.usesNativeVault ? t('settings.aiKeyHintNative') : t('settings.aiKeyHint')}
	</p>
	{#if aiStore.usesNativeVault}
		<p class="mt-1 text-xs text-fg-muted">
			{t('settings.aiModelsDesktopUnavailable')}
		</p>
	{/if}
	<div class="mt-2 grid grid-cols-2 gap-2 text-xs text-fg-muted">
		<label>
			<span>{t('settings.aiTemperature')}</span>
			<input
				type="number"
				min="0"
				max="2"
				step="0.1"
				class="mt-1 w-full rounded border border-border bg-bg-2 px-2 py-1 text-sm text-fg"
				value={aiStore.settings.temperature}
				onchange={(event) => aiStore.update({ temperature: Number(event.currentTarget.value) })}
			/>
		</label>
		<label>
			<span>{t('settings.aiMaxTokens')}</span>
			<input
				type="number"
				min="1"
				max="32000"
				class="mt-1 w-full rounded border border-border bg-bg-2 px-2 py-1 text-sm text-fg"
				value={aiStore.settings.maxTokens}
				onchange={(event) => aiStore.update({ maxTokens: Number(event.currentTarget.value) })}
			/>
		</label>
	</div>
	{#if aiStore.settings.enabled}
		<p class="mt-2 text-xs text-fg-muted" data-testid="ai-destination">
			{t('settings.aiDestination', { host: aiStore.providerHost })}
		</p>
	{:else}
		<p class="mt-2 text-xs text-fg-muted">{t('settings.aiDisabledHint')}</p>
	{/if}
	{#if aiStatus}
		<p class="mt-2 break-words text-xs text-fg-muted" role="status" data-testid="ai-status">
			{aiStatus}
		</p>
	{/if}
</details>

<style>
	@media (max-width: 639px), (pointer: coarse) {
		button {
			min-width: 44px;
			min-height: 44px;
		}
	}
</style>
