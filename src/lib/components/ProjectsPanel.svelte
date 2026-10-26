<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { db, type ProjectRow } from '#lib/db.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import { diskConflictStore } from '#lib/disk-conflict.svelte.js';
	import { reportError } from '#lib/report.js';
	import { notify } from '#lib/notify.svelte.js';
	import { readProjectFolder, readProjectZip } from '#lib/project-archive.js';
	import ProjectTree from './ProjectTree.svelte';
	import {
		importProject,
		createProject,
		createProjectDocument,
		exportProject,
		checkProjectLinks
	} from '#lib/projects.js';
	import type { ProjectLinkIssue } from '#lib/project-links.js';
	import {
		disconnectNativeProject,
		NativeProjectOperationError,
		nativeProjectsAvailable,
		pickAndImportNativeProject,
		refreshNativeProjectFromDisk,
		reopenNativeProjects,
		saveNativeProject,
		type NativeProjectFailure
	} from '#lib/projects-native.js';

	let { onClose }: { onClose: () => void } = $props();
	let projects = $state<ProjectRow[]>([]);
	let selected = $state<string | null>(filesStore.active?.projectId ?? null);
	let busy = $state(false);
	let error = $state(false);
	let issues = $state<ProjectLinkIssue[] | null>(null);
	let nativeFailures = $state<NativeProjectFailure[]>([]);
	let zipInput: HTMLInputElement;
	let folderInput: HTMLInputElement;
	let closeButton: HTMLButtonElement;
	const documents = $derived(
		filesStore.library
			.filter((file) => file.projectId === selected)
			.toSorted((a, b) => (a.relativePath ?? '').localeCompare(b.relativePath ?? ''))
	);
	const selectedProject = $derived(projects.find((project) => project.id === selected) ?? null);
	const nativeAvailable = nativeProjectsAvailable();

	async function load() {
		projects = await db.projects.orderBy('updatedAt').reverse().toArray();
		if (!projects.some((project) => project.id === selected)) selected = projects[0]?.id ?? null;
	}

	async function run(operation: () => Promise<void>) {
		if (busy) return;
		busy = true;
		error = false;
		issues = null;
		nativeFailures = [];
		try {
			await operation();
			await load();
		} catch (failure) {
			error = true;
			if (failure instanceof NativeProjectOperationError) nativeFailures = failure.report.failed;
			reportError('project operation', failure);
		} finally {
			busy = false;
			await tick();
			closeButton?.focus();
		}
	}

	onMount(() => {
		folderInput.setAttribute('webkitdirectory', '');
		closeButton.focus();
		void run(async () => {
			nativeFailures = await reopenNativeProjects();
		});
	});

	async function openNativeFolder() {
		await run(async () => {
			const project = await pickAndImportNativeProject();
			if (project) selected = project.id;
		});
	}

	async function saveNative() {
		const projectId = selected;
		if (!projectId) return;
		await run(async () => {
			await saveNativeProject(projectId);
			notify.success(t('projects.saved'));
		});
	}

	async function refreshNative() {
		const projectId = selected;
		if (!projectId) return;
		await run(async () => {
			await refreshNativeProjectFromDisk(projectId);
			notify.success(t('projects.refreshed'));
		});
	}

	async function unlinkNative() {
		const projectId = selected;
		if (!projectId) return;
		await run(async () => {
			await disconnectNativeProject(projectId);
		});
	}

	async function importZip(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file)
			await run(async () => {
				selected = (await importProject(await readProjectZip(file))).id;
			});
		input.value = '';
	}

	async function importFolder(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		if (files.length)
			await run(async () => {
				selected = (await importProject(await readProjectFolder(files))).id;
			});
		input.value = '';
	}

	async function newProject() {
		const name = await promptStore.prompt({
			title: t('projects.name'),
			confirmLabel: t('projects.create')
		});
		if (name?.trim())
			await run(async () => {
				selected = (await createProject(name.trim())).id;
			});
	}

	async function newDocument() {
		const projectId = selected;
		if (!projectId) return;
		const path = await promptStore.prompt({
			title: t('projects.documentPath'),
			confirmLabel: t('projects.newDocument')
		});
		if (path?.trim())
			await run(async () => {
				await createProjectDocument(projectId, path.trim());
				onClose();
			});
	}

	async function openDocument(id: string) {
		filesStore.openDocument(id);
		onClose();
		for (let attempt = 0; attempt < 8; attempt++) {
			await tick();
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const editor = document.querySelector<HTMLElement>(
				'.cm-content, .ProseMirror, .mdsh-preview'
			);
			if (!editor) continue;
			editor.focus();
			if (document.activeElement === editor || editor.contains(document.activeElement)) return;
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
		aria-labelledby="projects-title"
		tabindex="-1"
		use:focusTrap
		inert={promptStore.open || !!diskConflictStore.pending}
		onkeydown={(event) => {
			if (event.key === 'Escape' && !promptStore.open && !diskConflictStore.pending && !busy) {
				event.stopPropagation();
				onClose();
			}
		}}
	>
		<header class="flex items-center gap-3 border-b border-border p-4">
			<h2 id="projects-title" class="flex-1 font-semibold">{t('projects.title')}</h2>
			<button
				bind:this={closeButton}
				onclick={onClose}
				disabled={busy}
				aria-label={t('projects.close')}
				class="rounded border border-border px-3 py-1">×</button
			>
		</header>
		<div class="flex flex-wrap gap-2 border-b border-border p-3">
			<button disabled={busy} onclick={newProject}>{t('projects.create')}</button>
			<button disabled={busy} onclick={() => zipInput.click()}>{t('projects.importZip')}</button>
			<button disabled={busy} onclick={() => folderInput.click()}
				>{t('projects.importFolder')}</button
			>
			{#if nativeAvailable}<button disabled={busy} onclick={openNativeFolder}
					>{t('projects.nativeOpen')}</button
				>{/if}
			<input
				bind:this={zipInput}
				type="file"
				accept=".zip"
				onchange={importZip}
				class="hidden"
				aria-label={t('projects.importZip')}
			/>
			<input
				bind:this={folderInput}
				type="file"
				multiple
				onchange={importFolder}
				class="hidden"
				aria-label={t('projects.importFolder')}
			/>
		</div>
		{#if error}<p role="alert" class="p-3 text-sm text-danger">
				{t('projects.operationFailed')}
			</p>{/if}
		{#if nativeFailures.length}
			<ul data-native-project-failures role="alert" class="px-3 pb-3 text-sm text-danger">
				{#each nativeFailures as failure (failure)}
					<li class="break-words">{failure.path}: {failure.message}</li>
				{/each}
			</ul>
		{/if}
		{#if busy}<p role="status" class="p-3 text-sm text-fg-muted">{t('projects.busy')}</p>{/if}
		<div class="min-h-0 flex-1 overflow-auto p-3">
			{#if projects.length}
				<label class="flex items-center gap-2 text-sm"
					>{t('projects.name')}
					<select
						bind:value={selected}
						onchange={() => (issues = null)}
						disabled={busy}
						class="min-w-0 rounded border border-border bg-bg px-2 py-2"
					>
						{#each projects as project (project.id)}<option value={project.id}
								>{project.name}</option
							>{/each}
					</select>
				</label>
				<div class="my-3 flex flex-wrap gap-2">
					<button disabled={busy || !selected} onclick={newDocument}
						>{t('projects.newDocument')}</button
					>
					<button
						disabled={busy || !selected}
						onclick={() =>
							run(async () => {
								if (selected) await exportProject(selected);
							})}>{t('projects.export')}</button
					>
					<button
						disabled={busy || !selected}
						onclick={() =>
							run(async () => {
								if (selected) issues = await checkProjectLinks(selected);
							})}>{t('projects.checkLinks')}</button
					>
					{#if nativeAvailable && selectedProject?.nativeRootId}
						<button disabled={busy} onclick={refreshNative}>{t('projects.refresh')}</button>
						<button disabled={busy} onclick={saveNative}>{t('projects.save')}</button>
						<button disabled={busy} onclick={unlinkNative}>{t('projects.unlink')}</button>
					{/if}
				</div>
				{#if issues}
					<div
						data-project-link-report
						role="status"
						class="my-3 rounded border border-border p-3 text-sm"
					>
						{#if !issues.length}{t('projects.noIssues')}{:else}
							<ul>
								{#each issues as issue, index (index)}<li class="break-words">
										{issue.document}: {issue.destination} ({t(`projects.${issue.reason}`)})
									</li>{/each}
							</ul>
						{/if}
					</div>
				{/if}
				<ProjectTree {documents} {busy} onOpen={openDocument} />
			{:else}<p class="py-6 text-sm text-fg-muted">{t('projects.empty')}</p>{/if}
		</div>
		<footer class="space-y-1 border-t border-border p-3 text-xs text-fg-muted">
			<p>{t('projects.local')}</p>
			<p>{t('projects.limits')}</p>
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
