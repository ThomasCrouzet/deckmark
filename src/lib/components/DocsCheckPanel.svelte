<script lang="ts">
	import { onMount } from 'svelte';
	import { db, type ProjectRow } from '#lib/db.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { i18n } from '#lib/i18n/index.js';
	import { interpolate, type Locale } from '#lib/i18n/locale.js';
	import { docsCheckEn, type DocsCheckMessageKey } from '#lib/i18n/messages/docs-check-en.js';
	import { docsCheckFr } from '#lib/i18n/messages/docs-check-fr.js';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { notify } from '#lib/notify.svelte.js';
	import { reportError } from '#lib/report.js';
	import { projectDocumentSources } from '#lib/projects.js';
	import {
		serializeDocsCheckReport,
		type DocsCheckIssue,
		type DocsCheckReport
	} from '#lib/docs-check.js';
	import { runDocsCheckAsync, type DocsCheckRun } from '#lib/docs-check-runner.js';
	import { sanitizeFilename, triggerDownload } from '#lib/services/export.js';

	interface Props {
		onClose: () => void;
		onOpenIssue: (fileId: string, line: number) => void;
		initialProjectId?: string | null;
	}

	let { onClose, onOpenIssue, initialProjectId = null }: Props = $props();

	// Panel messages load with this lazy chunk. Keep the startup catalog small.
	const MESSAGES: Record<Locale, Record<DocsCheckMessageKey, string>> = {
		en: docsCheckEn,
		fr: docsCheckFr
	};
	function td(key: DocsCheckMessageKey, params?: Record<string, string | number>): string {
		const dictionary = MESSAGES[i18n.locale] ?? docsCheckEn;
		return interpolate(dictionary[key] ?? docsCheckEn[key] ?? key, params);
	}

	let projects = $state<ProjectRow[]>([]);
	let selected = $state<string | null>(null);
	let busy = $state(false);
	let error = $state(false);
	let closeButton: HTMLButtonElement | null = $state(null);
	let activeRun: DocsCheckRun | null = null;
	let runToken = 0;
	let cancelRequested = false;

	interface BoundReport {
		report: DocsCheckReport;
		projectId: string;
		projectName: string;
	}

	// A report belongs to the project that produced it. It is never a property
	// of whatever the selector shows later.
	let reportBinding = $state<BoundReport | null>(null);
	const report = $derived(
		reportBinding && reportBinding.projectId === selected ? reportBinding.report : null
	);

	const selectedProject = $derived(projects.find((project) => project.id === selected) ?? null);

	function resetReport(): void {
		if (busy) return;
		reportBinding = null;
	}

	onMount(() => {
		selected = initialProjectId;
		void load();
		closeButton?.focus();
		return () => {
			runToken++;
			activeRun?.cancel();
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
			reportError('documentation check projects', failure);
		}
	}

	async function runCheck(): Promise<void> {
		const projectId = selected;
		if (!projectId) return;
		const projectName = selectedProject?.name ?? 'project';
		const token = ++runToken;
		busy = true;
		error = false;
		reportBinding = null;
		cancelRequested = false;
		try {
			const input = await projectDocumentSources(projectId);
			if (token !== runToken) return;
			activeRun = runDocsCheckAsync(input);
			const result = await activeRun.promise;
			if (token !== runToken) return;
			activeRun = null;
			if (result) reportBinding = { report: result, projectId, projectName };
			else if (!cancelRequested) error = true;
		} catch (failure) {
			if (token !== runToken) return;
			error = true;
			reportError('documentation check', failure);
		} finally {
			if (token === runToken) {
				busy = false;
				activeRun = null;
			}
		}
	}

	function cancel(): void {
		if (!busy) return;
		cancelRequested = true;
		runToken++;
		activeRun?.cancel();
		activeRun = null;
		busy = false;
	}

	function close(): void {
		cancel();
		onClose();
	}

	function openIssue(issue: DocsCheckIssue): void {
		cancel();
		onOpenIssue(issue.documentId, issue.line);
	}

	function issueMessage(issue: DocsCheckIssue): string {
		return td(`docsCheck.issue.${issue.code}` as DocsCheckMessageKey, {
			target: issue.target ?? ''
		});
	}

	function skippedMessage(check: string): string {
		return td(`docsCheck.skip.${check}` as DocsCheckMessageKey);
	}

	async function exportReport(): Promise<void> {
		const binding = reportBinding;
		if (!binding || binding.projectId !== selected) return;
		try {
			const name = `${binding.projectName || 'project'}-docs-check.json`;
			const saved = await triggerDownload(
				new Blob([serializeDocsCheckReport(binding.report)], { type: 'application/json' }),
				sanitizeFilename(name)
			);
			if (saved) notify.success(td('docsCheck.exported'));
		} catch (failure) {
			reportError('documentation check export', failure, {
				notifyUser: td('docsCheck.exportFailed')
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
		aria-labelledby="docs-check-title"
		data-testid="docs-check-panel"
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
			<h2 id="docs-check-title" class="flex-1 font-semibold">{td('docsCheck.title')}</h2>
			<button
				bind:this={closeButton}
				type="button"
				onclick={close}
				aria-label={td('docsCheck.close')}
				class="rounded border border-border px-3 py-1">×</button
			>
		</header>

		<div class="flex flex-wrap items-end gap-3 border-b border-border p-3">
			<label class="flex min-w-48 flex-1 flex-col gap-1 text-xs text-fg-muted">
				{td('docsCheck.project')}
				<select
					data-testid="docs-check-project"
					bind:value={selected}
					onchange={resetReport}
					disabled={busy}
					class="min-w-0 rounded border border-border bg-bg px-2 py-2 text-sm text-fg"
				>
					{#each projects as project (project.id)}<option value={project.id}>{project.name}</option
						>{/each}
				</select>
			</label>
			<button
				data-testid="docs-check-run"
				type="button"
				disabled={busy || !selected}
				onclick={runCheck}>{td('docsCheck.run')}</button
			>
			{#if busy}
				<button data-testid="docs-check-cancel" type="button" onclick={cancel}
					>{td('docsCheck.cancel')}</button
				>
			{/if}
			<button
				data-testid="docs-check-export"
				type="button"
				disabled={busy || !report}
				onclick={exportReport}>{td('docsCheck.export')}</button
			>
		</div>

		<div class="min-h-0 flex-1 overflow-auto p-3">
			{#if error}
				<p role="alert" class="text-sm text-danger">{td('docsCheck.failed')}</p>
			{/if}
			{#if !projects.length}
				<p class="py-6 text-sm text-fg-muted">{td('docsCheck.empty')}</p>
			{:else if busy}
				<p role="status" class="py-6 text-sm text-fg-muted">{td('docsCheck.running')}</p>
			{:else if report}
				<p data-testid="docs-check-report-origin" class="text-xs text-fg-muted">
					{reportBinding?.projectName}
				</p>
				<p data-docs-check-summary data-testid="docs-check-summary" class="text-sm text-fg-muted">
					{td('docsCheck.summary', {
						documents: report.documents,
						errors: report.summary.errors,
						warnings: report.summary.warnings
					})}
				</p>
				{#if !report.issues.length}
					<p class="py-6 text-sm text-fg-muted">{td('docsCheck.noIssues')}</p>
				{:else}
					<ul data-docs-check-issues class="mt-3 space-y-1">
						{#each report.issues as issue, index (index)}
							<li>
								<button
									type="button"
									data-docs-check-issue
									data-code={issue.code}
									data-path={issue.path}
									data-line={issue.line}
									aria-label={td('docsCheck.openIssue', {
										path: issue.path,
										line: issue.line
									})}
									class="flex w-full flex-wrap items-baseline gap-2 rounded border border-border px-2 py-2 text-left text-sm hover:bg-bg-2"
									onclick={() => openIssue(issue)}
								>
									<span
										class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
										class:bg-danger={issue.severity === 'error'}
										class:text-on-accent={issue.severity === 'error'}
										class:bg-bg-2={issue.severity === 'warning'}
										class:text-fg-muted={issue.severity === 'warning'}
									>
										{td(
											issue.severity === 'error'
												? 'docsCheck.severity.error'
												: 'docsCheck.severity.warning'
										)}
									</span>
									<span class="font-mono text-xs text-fg-muted"
										>{issue.path}:{issue.line}:{issue.column}</span
									>
									<span class="min-w-0 flex-1 break-words">{issueMessage(issue)}</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
				{#if report.skipped.length}
					<details class="mt-4 text-sm text-fg-muted">
						<summary>{td('docsCheck.skipped')}</summary>
						<ul class="mt-2 list-disc space-y-1 pl-5">
							{#each report.skipped as entry (entry.check)}
								<li>{skippedMessage(entry.check)}</li>
							{/each}
						</ul>
					</details>
				{/if}
			{/if}
		</div>

		<footer class="border-t border-border p-3 text-xs text-fg-muted">
			<p>{td('docsCheck.limits')}</p>
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
	select:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
</style>
