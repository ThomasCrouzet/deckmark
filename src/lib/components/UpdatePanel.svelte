<script lang="ts">
	// Update delivery is on standby. This component is kept for a future signed
	// release, but Settings no longer mounts it. Re-enable it only after the
	// signing prerequisites in docs/decisions/desktop-updates-standby.md exist.
	import { onMount } from 'svelte';
	import { ShieldCheck, ShieldAlert } from '@lucide/svelte';
	import { t } from '#lib/i18n/index.js';
	import { copyTextWithFallback } from '#lib/services/clipboard.js';
	import {
		checkForUpdates,
		updateStatus,
		updatesSupported,
		type UpdateStatus,
		type VerifiedUpdate
	} from '#lib/updates.js';

	let status = $state<UpdateStatus | null>(null);
	let checked = $state<VerifiedUpdate | null>(null);
	let busy = $state(false);
	let message = $state('');

	onMount(() => {
		if (!updatesSupported()) return;
		void updateStatus()
			.then((value) => (status = value))
			.catch((error) => (message = String(error)));
	});

	async function check() {
		if (busy) return;
		busy = true;
		message = '';
		checked = null;
		try {
			checked = await checkForUpdates();
			message = t('updates.available', { version: checked.version });
		} catch (error) {
			message = String(error);
		} finally {
			busy = false;
		}
	}

	async function copyUrl() {
		if (!checked) return;
		try {
			const copied = await copyTextWithFallback(checked.url);
			message = copied ? t('updates.copied') : checked.url;
		} catch {
			message = checked.url;
		}
	}
</script>

{#if updatesSupported()}
	<section class="mt-5 border-t border-border pt-3 text-xs" data-testid="update-panel">
		<h3 class="mb-2 flex items-center gap-1.5 font-medium text-fg">
			{#if status?.configured}
				<ShieldCheck size={14} aria-hidden="true" />
			{:else}
				<ShieldAlert size={14} aria-hidden="true" />
			{/if}
			{t('updates.title')}
		</h3>
		{#if status}
			<p class="text-fg-muted">
				{t('updates.channel', { channel: status.channel })}
			</p>
			{#if status.configured}
				<p class="mt-1 text-fg-muted" data-testid="update-status">
					{t('updates.configured', { fingerprint: status.publicKeyFingerprint ?? '' })}
				</p>
				<button
					type="button"
					class="mt-2 rounded border border-border px-2.5 py-1"
					disabled={busy}
					onclick={() => void check()}
					data-testid="update-check">{t('updates.check')}</button
				>
			{:else}
				<p class="mt-1 text-fg-muted" role="status" data-testid="update-blocked">
					{t('updates.blocked')}
				</p>
				<p class="mt-1 text-fg-muted">{t('updates.blockedHelp')}</p>
			{/if}
		{/if}
		{#if checked}
			<div class="mt-2 rounded border border-border p-2" data-testid="update-available">
				<p class="font-medium text-fg">{t('updates.verified', { version: checked.version })}</p>
				<p class="mt-1 break-all font-mono text-[10px] text-fg-muted">{checked.url}</p>
				<p class="mt-1 font-mono text-[10px] text-fg-muted">sha256 {checked.sha256}</p>
				{#if checked.notes}<p class="mt-1 text-fg-muted">{checked.notes}</p>{/if}
				<div class="mt-2 flex flex-wrap gap-2">
					<button type="button" class="rounded border border-border px-2.5 py-1" onclick={copyUrl}>
						{t('updates.copyLink')}
					</button>
				</div>
				<p class="mt-2 text-fg-muted">{t('updates.manualInstall')}</p>
			</div>
		{/if}
		{#if message}
			<p class="mt-2 break-words text-fg-muted" role="status" data-testid="update-message">
				{message}
			</p>
		{/if}
	</section>
{/if}
