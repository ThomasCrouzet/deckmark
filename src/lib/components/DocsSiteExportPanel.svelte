<script lang="ts">
	import { onMount } from 'svelte';
	import { db, type ProjectRow } from '#lib/db.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { i18n } from '#lib/i18n/index.js';
	import { interpolate, type Locale } from '#lib/i18n/locale.js';
	import { docsSiteEn, type DocsSiteMessageKey } from '#lib/i18n/messages/docs-site-en.js';
	import { docsSiteFr } from '#lib/i18n/messages/docs-site-fr.js';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { notify } from '#lib/notify.svelte.js';
	import { reportError } from '#lib/report.js';
	import { projectSiteSnapshot } from '#lib/projects.js';
	import type { DocsSiteIssue, DocsSiteReport } from '#lib/services/docs-site-export.js';

	interface Props {
		onClose: () => void;
		initialProjectId?: string | null;
	}

	let { onClose, initialProjectId = null }: Props = $props();

	const MESSAGES: Record<Locale, Record<DocsSiteMessageKey, string>> = {
		en: docsSiteEn,
		fr: docsSiteFr
	};
	function td(key: DocsSiteMessageKey, params?: Record<string, string | number>): string {
		const dictionary = MESSAGES[i18n.locale] ?? docsSiteEn;
		return interpolate(dictionary[key] ?? docsSiteEn[key] ?? key, params);
	}

	let projects = $state<ProjectRow[]>([]);
	let selected = $state<string | null>(null);
	let includeSearchIndex = $state(true);
	let busy = $state(false);
	let error = $state(false);
	let cancelled = $state(false);
	let closeButton = $state<HTMLButtonElement | null>(null);
	let activeController: AbortController | null = null;
	let runToken = 0;

	interface BoundReport {
		report: DocsSiteReport;
		projectId: string;
		projectName: string;
		includeSearchIndex: boolean;
	}

	// A report belongs to the project and options that produced it. It is never
	// a property of whatever the selector shows later.
	let reportBinding = $state<BoundReport | null>(null);
	const report = $derived(reportBinding?.report ?? null);

	function resetReport(): void {
		if (busy) return;
		reportBinding = null;
		error = false;
		cancelled = false;
	}

	onMount(() => {
		if (initialProjectId) selected = initialProjectId;
		void load();
		closeButton?.focus();
		return () => {
			runToken++;
			activeController?.abort();
		};
	});

	async function load(): Promise<void> {
		try {
			projects = await db.projects.orderBy('updatedAt').reverse().toArray();
			const activeProject = filesStore.active?.projectId ?? null;
			if (!projects.some((project) => project.id === selected)) {
				selected =
					projects.find((project) => project.id === activeProject)?.id ?? projects[0]?.id ?? null;
			}
		} catch (failure) {
			error = true;
			reportError('documentation site projects', failure);
		}
	}

	function updateSearchIndex(event: Event): void {
		includeSearchIndex = (event.currentTarget as HTMLInputElement).checked;
		resetReport();
	}

	function errorReport(failure: unknown): DocsSiteReport | null {
		if (!failure || typeof failure !== 'object' || !('report' in failure)) return null;
		return (failure as { report?: DocsSiteReport }).report ?? null;
	}

	function isAbort(failure: unknown): boolean {
		return (
			(failure instanceof DOMException && failure.name === 'AbortError') ||
			(failure instanceof Error && failure.name === 'AbortError')
		);
	}

	async function runExport(): Promise<void> {
		const projectId = selected;
		if (!projectId || busy) return;
		const token = ++runToken;
		const controller = new AbortController();
		activeController = controller;
		busy = true;
		error = false;
		cancelled = false;
		reportBinding = null;
		const originSearchIndex = includeSearchIndex;
		let originName = projects.find((project) => project.id === projectId)?.name ?? 'project';
		try {
			const snapshot = await projectSiteSnapshot(projectId);
			if (token !== runToken) return;
			originName = snapshot.project.name;
			const [{ buildDocsSite }, { sanitizeFilename, triggerDownload }] = await Promise.all([
				import('#lib/services/docs-site-export.js'),
				import('#lib/services/export.js')
			]);
			if (token !== runToken) return;
			const result = await buildDocsSite(
				{
					name: snapshot.project.name,
					documents: snapshot.documents,
					assets: snapshot.assets,
					locale: i18n.locale,
					includeSearchIndex
				},
				{ signal: controller.signal }
			);
			if (token !== runToken) return;
			reportBinding = {
				report: result.report,
				projectId,
				projectName: originName,
				includeSearchIndex: originSearchIndex
			};
			const saved = await triggerDownload(
				result.blob,
				sanitizeFilename(`${snapshot.project.name}-site.zip`)
			);
			if (token !== runToken) return;
			if (saved) notify.success(td('docsSite.exported'));
		} catch (failure) {
			if (token !== runToken) return;
			const failureReport = errorReport(failure);
			if (failureReport) {
				reportBinding = {
					report: failureReport,
					projectId,
					projectName: originName,
					includeSearchIndex: originSearchIndex
				};
				error = true;
			} else if (isAbort(failure) || controller.signal.aborted) {
				cancelled = true;
			} else {
				error = true;
				reportError('documentation site export', failure, { notifyUser: td('docsSite.failed') });
			}
		} finally {
			if (token === runToken) {
				busy = false;
				activeController = null;
			}
		}
	}

	function cancel(): void {
		if (!busy) return;
		runToken++;
		activeController?.abort();
		activeController = null;
		busy = false;
		cancelled = true;
	}

	function close(): void {
		cancel();
		onClose();
	}

	function issueMessage(issue: DocsSiteIssue): string {
		return td(`docsSite.issue.${issue.code}` as DocsSiteMessageKey, { target: issue.target });
	}

	async function exportReport(): Promise<void> {
		const binding = reportBinding;
		if (!binding) return;
		try {
			const [{ serializeDocsSiteReport }, { sanitizeFilename, triggerDownload }] =
				await Promise.all([
					import('#lib/services/docs-site-export.js'),
					import('#lib/services/export.js')
				]);
			const saved = await triggerDownload(
				new Blob([serializeDocsSiteReport(binding.report)], { type: 'application/json' }),
				sanitizeFilename(`${binding.projectName || 'project'}-site-report.json`)
			);
			if (saved) notify.success(td('docsSite.reportExported'));
		} catch (failure) {
			reportError('documentation site report export', failure, {
				notifyUser: td('docsSite.reportFailed')
			});
		}
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3"
	role="presentation"
>
	<div
		class="flex max-h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-bg-1 text-fg shadow-xl"
		role="dialog"
		aria-modal="true"
		aria-labelledby="docs-site-title"
		data-testid="docs-site-panel"
		tabindex="-1"
		use:focusTrap
		onkeydown={(event) => {
			if (event.key === 'Escape' && !busy) {
				event.stopPropagation();
				close();
			}
		}}
	>
		<header class="flex items-center gap-3 border-b border-border p-4">
			<h2 id="docs-site-title" class="flex-1 font-semibold">{td('docsSite.title')}</h2>
			<button
				bind:this={closeButton}
				type="button"
				onclick={close}
				aria-label={td('docsSite.close')}
				class="rounded border border-border px-3 py-1">×</button
			>
		</header>

		<div class="flex flex-wrap items-end gap-3 border-b border-border p-3">
			<label class="flex min-w-48 flex-1 flex-col gap-1 text-xs text-fg-muted">
				{td('docsSite.project')}
				<select
					data-testid="docs-site-project"
					bind:value={selected}
					onchange={resetReport}
					disabled={busy}
					class="min-w-0 rounded border border-border bg-bg px-2 py-2 text-sm text-fg"
				>
					{#each projects as project (project.id)}<option value={project.id}>{project.name}</option
						>{/each}
				</select>
			</label>
			<label class="flex items-center gap-2 text-sm">
				<input
					data-testid="docs-site-search-toggle"
					type="checkbox"
					checked={includeSearchIndex}
					disabled={busy}
					onchange={updateSearchIndex}
				/>
				{td('docsSite.searchIndex')}
			</label>
			<button
				data-testid="docs-site-run"
				type="button"
				disabled={busy || !selected}
				onclick={runExport}>{td('docsSite.export')}</button
			>
			{#if busy}
				<button data-testid="docs-site-cancel" type="button" onclick={cancel}
					>{td('docsSite.cancel')}</button
				>
			{/if}
			<button
				data-testid="docs-site-export-report"
				type="button"
				disabled={busy || !report}
				onclick={exportReport}>{td('docsSite.report')}</button
			>
		</div>

		<div class="min-h-0 flex-1 overflow-auto p-3">
			{#if error}
				<p role="alert" class="text-sm text-danger">{td('docsSite.failed')}</p>
			{/if}
			{#if cancelled}
				<p role="status" data-testid="docs-site-cancelled" class="text-sm text-fg-muted">
					{td('docsSite.cancelled')}
				</p>
			{/if}
			{#if !projects.length}
				<p class="py-6 text-sm text-fg-muted">{td('docsSite.empty')}</p>
			{:else if busy}
				<p role="status" data-testid="docs-site-busy" class="py-6 text-sm text-fg-muted">
					{td('docsSite.exporting')}
				</p>
			{:else if report}
				<p data-testid="docs-site-report-origin" class="text-xs text-fg-muted">
					{reportBinding?.projectName}
				</p>
				<p data-testid="docs-site-summary" class="text-sm text-fg-muted">
					{td('docsSite.summary', {
						pages: report.summary.pages,
						assets: report.summary.assets,
						errors: report.summary.errors,
						warnings: report.summary.warnings
					})}
				</p>
				<p class="text-xs text-fg-muted">
					{report.summary.searchIndex
						? td('docsSite.searchIncluded')
						: td('docsSite.searchOmitted')}
				</p>
				{#if report.summary.errors}
					<p role="alert" class="mt-2 text-sm text-danger">{td('docsSite.blocked')}</p>
				{/if}
				{#if report.issues.length}
					<h3 class="mt-4 text-sm font-semibold">{td('docsSite.issues')}</h3>
					<ul data-testid="docs-site-issues" class="mt-2 space-y-1">
						{#each report.issues as issue, index (index)}
							<li
								data-docs-site-issue
								data-code={issue.code}
								data-path={issue.path}
								class="rounded border border-border px-2 py-2 text-sm"
							>
								<span class="mr-2 font-mono text-xs text-fg-muted">{issue.path}</span>
								<span class={issue.severity === 'error' ? 'text-danger' : 'text-fg-muted'}>
									{td(
										issue.severity === 'error'
											? 'docsSite.severity.error'
											: 'docsSite.severity.warning'
									)}
								</span>
								<span class="ml-2 break-words">{issueMessage(issue)}</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="mt-2 text-sm text-fg-muted">{td('docsSite.noIssues')}</p>
				{/if}
				<details class="mt-4 text-sm">
					<summary>{td('docsSite.pages')}</summary>
					<ul class="mt-2 list-disc space-y-1 pl-5">
						{#each report.pages as page (page.path)}
							<li class="break-words">
								<span class="font-mono text-xs">{page.path}</span>
								{page.title}
							</li>
						{/each}
					</ul>
				</details>
				<details class="mt-2 text-sm">
					<summary>{td('docsSite.assets')}</summary>
					<ul class="mt-2 list-disc space-y-1 pl-5">
						{#each report.assets as asset (asset.path)}
							<li class="break-words"><span class="font-mono text-xs">{asset.path}</span></li>
						{/each}
					</ul>
				</details>
			{/if}
		</div>

		<footer class="border-t border-border p-3 text-xs text-fg-muted">
			<p>{td('docsSite.limits')}</p>
		</footer>
	</div>
</div>

<style>
	button {
		border: 1px solid var(--color-border);
		border-radius: 4px;
		padding: 0.5rem 0.75rem;
		font-size: 0.8rem;
	}
	button:hover:enabled {
		background: var(--color-bg-2);
	}
	button:disabled {
		opacity: 0.5;
	}
	button:focus-visible,
	select:focus-visible,
	input:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
</style>
