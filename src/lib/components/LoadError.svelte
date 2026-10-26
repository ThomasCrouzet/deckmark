<script lang="ts">
	import { t } from '#lib/i18n/index.js';
	let { onRetry, busy = false }: { onRetry: () => void; busy?: boolean } = $props();
</script>

<div role="alert" class="flex items-center gap-3 border-b border-border p-3 text-sm text-danger">
	<p>{t('panels.loadFailed')}</p>
	<button class="shrink-0 underline disabled:opacity-50" disabled={busy} onclick={onRetry}>
		{t('source.retry')}
	</button>
</div>
