<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '#lib/i18n/index.js';
	import { version } from '../../../package.json';
	import { editionManifest } from '#lib/edition.js';
	import { isDesktop } from '#lib/desktop.js';
	import { offlineState } from '#lib/ui/offline.svelte.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { diagnosticEvents } from '#lib/report.js';
	import {
		buildDiagnosticReport,
		documentStats,
		downloadDiagnosticReport,
		type DiagnosticMetadata
	} from '#lib/diagnostics.js';

	let open = $state(false);
	let description = $state('');
	let includeStats = $state(false);
	let preview = $state('');
	let status = $state('');
	let section = $state<HTMLElement | null>(null);

	async function metadata(): Promise<DiagnosticMetadata> {
		const storage = navigator.storage;
		let usage: number | null = null;
		let quota: number | null = null;
		let persistent: boolean | null = null;
		try {
			const estimate = await storage?.estimate?.();
			usage = estimate?.usage ?? null;
			quota = estimate?.quota ?? null;
			persistent = (await storage?.persisted?.()) ?? null;
		} catch {
			// Keep unknown values as null.
		}
		return {
			version,
			edition: editionManifest().edition,
			host: location.host || null,
			userAgent: navigator.userAgent || null,
			platform: navigator.platform || null,
			language: navigator.language || null,
			serviceWorker: offlineState.status,
			displayMode: matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser',
			storage: { usage, quota, persistent },
			capabilities: {
				serviceWorker: 'serviceWorker' in navigator,
				storageEstimate: typeof storage?.estimate === 'function',
				fileSystemAccess: 'showSaveFilePicker' in window,
				desktop: isDesktop(),
				clipboard: typeof navigator.clipboard?.writeText === 'function'
			}
		};
	}

	async function buildPreview(): Promise<void> {
		status = '';
		try {
			preview = buildDiagnosticReport({
				metadata: await metadata(),
				events: diagnosticEvents(),
				stats: includeStats ? documentStats(filesStore.library) : null,
				description
			});
		} catch {
			status = t('settings.diagnosticsFailed');
		}
	}

	function cancel(): void {
		preview = '';
		status = '';
		open = false;
	}

	function download(): void {
		if (!preview) return;
		downloadDiagnosticReport(preview);
	}

	onMount(() => {
		const showReport = () => {
			open = true;
			void tick().then(() => section?.scrollIntoView({ block: 'start' }));
		};
		window.addEventListener('mdsh:report-problem', showReport);
		return () => window.removeEventListener('mdsh:report-problem', showReport);
	});
</script>

<section
	class="mt-5 border-t border-border pt-3 text-xs text-fg-muted"
	data-testid="diagnostics-section"
	bind:this={section}
>
	<h3 class="mb-2 font-medium text-fg">{t('settings.diagnostics')}</h3>
	<p class="mb-2">{t('settings.diagnosticsHint')}</p>
	<button
		type="button"
		class="rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-2"
		data-testid="diagnostics-open"
		onclick={() => (open = !open)}
	>
		{t('settings.reportProblem')}
	</button>
	{#if open}
		<div class="mt-2 grid gap-2">
			<label class="grid gap-1">
				<span>{t('settings.diagnosticsDescription')}</span>
				<textarea
					class="min-h-20 rounded-md border border-border bg-bg-2 p-2 text-fg"
					bind:value={description}
					data-testid="diagnostics-description"></textarea>
			</label>
			<label class="flex items-center gap-2">
				<input
					type="checkbox"
					bind:checked={includeStats}
					data-testid="diagnostics-include-stats"
				/>
				<span>{t('settings.diagnosticsIncludeStats')}</span>
			</label>
			<p class="text-warning" role="note">{t('settings.diagnosticsPrivacy')}</p>
			<div class="flex flex-wrap gap-2">
				<button
					type="button"
					class="rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-2"
					data-testid="diagnostics-build"
					onclick={() => void buildPreview()}
				>
					{t('settings.diagnosticsBuild')}
				</button>
				<button
					type="button"
					class="rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-2"
					data-testid="diagnostics-download"
					disabled={!preview}
					onclick={download}
				>
					{t('settings.diagnosticsDownload')}
				</button>
				<button
					type="button"
					class="rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-2"
					data-testid="diagnostics-cancel"
					onclick={cancel}
				>
					{t('settings.diagnosticsCancel')}
				</button>
			</div>
			{#if status}
				<p role="status" data-testid="diagnostics-status">{status}</p>
			{/if}
			{#if preview}
				<pre
					class="max-h-64 overflow-auto rounded-md border border-border bg-bg-2 p-2 text-[11px] whitespace-pre-wrap"
					data-testid="diagnostics-preview">{preview}</pre>
			{/if}
		</div>
	{/if}
</section>
