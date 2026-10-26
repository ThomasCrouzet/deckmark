<script lang="ts">
	// Persistent spinner toast for long exports (PDF/HTML with Mermaid).
	// Distinct from the existing Toast (undo-close 5 s) - this one closes only
	// when the store decides (`dismiss()` in the caller's finally).
	import { spinnerStore } from '#lib/spinner.svelte.js';
	import { t } from '#lib/i18n/index.js';
</script>

{#if spinnerStore.visible}
	<div
		class="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2"
		role="status"
		aria-live="polite"
	>
		<div
			class="pointer-events-auto flex items-center gap-3 rounded-md border border-border
			       bg-bg-1 px-4 py-2.5 text-sm text-fg shadow-lg animate-fade-in"
		>
			<span class="spinner" aria-hidden="true"></span>
			<span>{spinnerStore.message}</span>
			{#if spinnerStore.cancel}
				<button class="underline" onclick={spinnerStore.cancel}>{t('export.cancel')}</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* Pure CSS spinner - a spinning circle. Respects prefers-reduced-motion
	   via the global rule in app.css (transition-duration forced to 0.01ms). */
	.spinner {
		display: inline-block;
		width: 14px;
		height: 14px;
		border: 2px solid var(--color-border-strong);
		border-top-color: var(--color-accent);
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
