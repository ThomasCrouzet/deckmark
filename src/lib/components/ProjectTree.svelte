<script lang="ts">
	import type { FileItem } from '#lib/types.js';
	import { t } from '#lib/i18n/index.js';
	import {
		FileText,
		Folder,
		FolderOpen,
		FilePlus,
		MoreHorizontal,
		Pencil,
		Trash2,
		FolderInput,
		FolderCog,
		Settings2
	} from '@lucide/svelte';
	import FileStatusBadge from './FileStatusBadge.svelte';
	import { PROJECT_SCALE_LIMITS } from '#lib/project-limits.js';
	import ProjectMoveDialog from './ProjectMoveDialog.svelte';
	import { filesStore } from '#lib/files.svelte.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import { notify } from '#lib/notify.svelte.js';
	import { reportError } from '#lib/report.js';
	import { isFilesDrag } from '#lib/ui/image-drop.svelte.js';
	import {
		PROJECT_DRAG_TYPE,
		importProjectEntries,
		readDroppedFiles,
		transferProjectSelection,
		type TransferResult,
		type TransferSelection
	} from '#lib/project-transfer.js';
	import { createProjectDocument, renameProject } from '#lib/projects.js';
	import type { ProjectRoot } from '#lib/project-explorer.svelte.js';
	import { SvelteSet } from 'svelte/reactivity';

	interface Props {
		documents: FileItem[];
		projects?: ProjectRoot[];
		expanded?: ReadonlySet<string>;
		onToggle?: (key: string, open: boolean) => void;
		onOpen: (id: string) => void;
		busy?: boolean;
		actions?: boolean;
		rowLabels?: boolean;
		onManageProjects?: () => void;
		onChanged?: (target: { projectId: string; folder?: string }) => void;
	}

	let {
		documents,
		projects = [],
		expanded,
		onToggle,
		onOpen,
		busy = false,
		actions = false,
		rowLabels = false,
		onManageProjects,
		onChanged
	}: Props = $props();

	interface ProjectFolder {
		name: string;
		path: string;
		folders: ProjectFolder[];
		files: FileItem[];
	}

	interface ProjectNode {
		id: string;
		name: string;
		folders: ProjectFolder[];
		files: FileItem[];
	}

	const FILE_LIMIT = PROJECT_SCALE_LIMITS.boundedFolderRows;
	let localCollapsed = new SvelteSet<string>();
	let showAll = new SvelteSet<string>();
	let dropKey = $state<string | null>(null);
	let moveOpen = $state(false);
	let moveSelection = $state<TransferSelection | null>(null);

	function folderNode(name: string, path: string): ProjectFolder {
		return { name, path, folders: [], files: [] };
	}

	const roots = $derived.by((): ProjectNode[] => {
		const byId: Record<string, ProjectNode> = {};
		const foldersByPath: Record<string, ProjectFolder> = {};
		for (const project of projects)
			byId[project.id] = { id: project.id, name: project.name, folders: [], files: [] };
		for (const file of documents) {
			if (!file.projectId) continue;
			let root = byId[file.projectId];
			if (!root) {
				root = { id: file.projectId, name: file.projectId, folders: [], files: [] };
				byId[file.projectId] = root;
			}
			const parts = (file.relativePath ?? file.name).split('/');
			parts.pop();
			let folder: ProjectFolder = {
				name: root.name,
				path: '',
				folders: root.folders,
				files: root.files
			};
			let path = '';
			for (const part of parts) {
				path = path ? `${path}/${part}` : part;
				const key = `${file.projectId}\0${path}`;
				let child = foldersByPath[key];
				if (!child) {
					child = folderNode(part, path);
					foldersByPath[key] = child;
					folder.folders.push(child);
				}
				folder = child;
			}
			folder.files.push(file);
		}
		const nodes = Object.values(byId);
		for (const root of nodes) {
			root.folders.sort((left, right) => left.name.localeCompare(right.name));
			root.files.sort((left, right) => left.name.localeCompare(right.name));
		}
		return nodes.sort((left, right) => left.name.localeCompare(right.name));
	});

	function rootKey(projectId: string): string {
		return `${projectId}::`;
	}

	function folderKey(projectId: string, folder: string): string {
		return `${projectId}::${folder}`;
	}

	function isOpen(key: string): boolean {
		return expanded ? expanded.has(key) : !localCollapsed.has(key);
	}

	function applyOpen(key: string, open: boolean): void {
		if (onToggle) onToggle(key, open);
		else if (open) localCollapsed.delete(key);
		else localCollapsed.add(key);
	}

	function onDetailsToggle(event: Event, key: string): void {
		const open = (event.currentTarget as HTMLDetailsElement).open;
		if (open === isOpen(key)) return;
		applyOpen(key, open);
	}

	function onDisclosureKey(event: KeyboardEvent, key: string): void {
		if (event.key === 'ArrowRight' && !isOpen(key)) {
			event.preventDefault();
			applyOpen(key, true);
		} else if (event.key === 'ArrowLeft' && isOpen(key)) {
			event.preventDefault();
			applyOpen(key, false);
		}
	}

	function projectName(projectId: string): string {
		return projects.find((project) => project.id === projectId)?.name ?? projectId;
	}

	function canAcceptDrop(event: DragEvent): boolean {
		const types = event.dataTransfer?.types;
		if (!types) return false;
		return isFilesDrag(event) || types.includes(PROJECT_DRAG_TYPE);
	}

	function dropId(projectId: string, folder?: string): string {
		return `${projectId}::${folder ?? ''}`;
	}

	function handleDragOver(event: DragEvent, projectId: string, folder?: string): void {
		if (!canAcceptDrop(event)) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
			event.dataTransfer.effectAllowed = 'all';
		}
		dropKey = dropId(projectId, folder);
	}

	function handleDragLeave(event: DragEvent, projectId: string, folder?: string): void {
		if (dropKey !== dropId(projectId, folder)) return;
		const next = event.relatedTarget as Node | null;
		if (next && (event.currentTarget as Node).contains(next)) return;
		dropKey = null;
	}

	function readSelection(event: DragEvent): TransferSelection | null {
		const raw = event.dataTransfer?.getData(PROJECT_DRAG_TYPE);
		if (raw) {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (parsed && typeof parsed === 'object') return parsed as TransferSelection;
			} catch {
				return null;
			}
		}
		const id = event.dataTransfer?.getData('text/plain');
		return id ? { documentIds: [id] } : null;
	}

	async function handleDrop(event: DragEvent, projectId: string, folder?: string): Promise<void> {
		if (!canAcceptDrop(event)) return;
		event.preventDefault();
		event.stopPropagation();
		dropKey = null;
		if (busy) return;
		try {
			if (isFilesDrag(event)) {
				const dataTransfer = event.dataTransfer;
				if (!dataTransfer) return;
				const files = await readDroppedFiles(dataTransfer);
				const result = await importProjectEntries(projectId, folder, files);
				if (result.documents || result.assets)
					notify.success(t('projects.importedCount', { n: result.documents + result.assets }));
				onChanged?.({ projectId, ...(folder ? { folder } : {}) });
				return;
			}
			const selection = readSelection(event);
			if (!selection) return;
			const result = await transferProjectSelection(selection, {
				mode: event.altKey ? 'copy' : 'move',
				targetProjectId: projectId,
				...(folder ? { targetFolder: folder } : {}),
				onConflict: async (conflicts) =>
					promptStore.confirm({
						title: t('projects.conflictTitle'),
						message: t('projects.conflictMessage', { path: conflicts[0]!.path }),
						confirmLabel: t('projects.keepBoth')
					})
			});
			if (result.status === 'done') {
				if (result.documents)
					notify.success(
						t(event.altKey ? 'projects.copiedCount' : 'projects.movedCount', {
							n: result.documents
						})
					);
				if (result.unresolved.length)
					notify.info(t('projects.unresolvedLinks', { n: result.unresolved.length }));
				onChanged?.({ projectId, ...(folder ? { folder } : {}) });
			}
		} catch (error) {
			reportError('project drop', error);
			notify.error(t('projects.transferFailed'));
		}
	}

	function previewPath(projectId: string, folder?: string): string {
		return folder
			? `${projectName(projectId)}/${folder}`
			: t('projects.dropRoot', { name: projectName(projectId) });
	}

	function isDropActive(projectId: string, folder?: string): boolean {
		return dropKey === dropId(projectId, folder);
	}

	async function newDocument(projectId: string, folder?: string): Promise<void> {
		const path = await promptStore.prompt({
			title: folder ? t('projects.newDocumentIn', { folder }) : t('projects.newDocumentHere'),
			message: t('projects.documentPath'),
			defaultValue: folder ? `${folder}/` : '',
			confirmLabel: t('projects.newDocument')
		});
		if (!path?.trim()) return;
		try {
			const value = path.trim();
			await createProjectDocument(
				projectId,
				value.includes('/') || !folder ? value : `${folder}/${value}`
			);
			onChanged?.({ projectId, ...(folder ? { folder } : {}) });
		} catch (error) {
			reportError('project document create', error);
			notify.error(t('projects.operationFailed'));
		}
	}

	async function renameProjectPrompt(projectId: string): Promise<void> {
		const value = await promptStore.prompt({
			title: t('projects.renameProject'),
			defaultValue: projectName(projectId),
			confirmLabel: t('projects.renameProject')
		});
		if (!value?.trim() || value.trim() === projectName(projectId)) return;
		try {
			if (!(await renameProject(projectId, value.trim())))
				throw new Error('Project rename rejected');
			onChanged?.({ projectId });
		} catch (error) {
			reportError('project rename', error);
			notify.error(t('projects.operationFailed'));
		}
	}

	async function renameFolderPrompt(projectId: string, folder: string): Promise<void> {
		const current = folder.split('/').pop()!;
		const value = await promptStore.prompt({
			title: t('projects.renameFolder'),
			defaultValue: current,
			confirmLabel: t('projects.renameFolder')
		});
		if (!value?.trim() || value.trim() === current) return;
		if (/[\\/]/.test(value)) {
			notify.error(t('projects.operationFailed'));
			return;
		}
		const parent = folder.split('/').slice(0, -1).join('/');
		try {
			const result = await transferProjectSelection(
				{ projectId, folder },
				{
					mode: 'move',
					targetProjectId: projectId,
					...(parent ? { targetFolder: parent } : {}),
					folderName: value.trim(),
					onConflict: async (conflicts) =>
						promptStore.confirm({
							title: t('projects.conflictTitle'),
							message: t('projects.conflictMessage', { path: conflicts[0]!.path }),
							confirmLabel: t('projects.keepBoth')
						})
				}
			);
			if (result.status === 'done') {
				notify.success(t('projects.movedCount', { n: result.documents }));
				onChanged?.({
					projectId,
					...(parent ? { folder: `${parent}/${value.trim()}` } : { folder: value.trim() })
				});
			}
		} catch (error) {
			reportError('project folder rename', error);
			notify.error(t('projects.transferFailed'));
		}
	}

	async function renameDocumentPrompt(file: FileItem): Promise<void> {
		const value = await promptStore.prompt({
			title: t('projects.renameDocument'),
			defaultValue: file.name,
			confirmLabel: t('projects.renameDocument')
		});
		if (!value?.trim() || value.trim() === file.name) return;
		try {
			await filesStore.rename(file.id, value.trim());
			onChanged?.({ projectId: file.projectId! });
		} catch (error) {
			reportError('project document rename', error);
		}
	}

	async function deleteDocument(file: FileItem): Promise<void> {
		if (
			await promptStore.confirm({
				title: t('sidebar.deleteConfirm'),
				message: t('sidebar.deleteMessage'),
				danger: true
			})
		)
			filesStore.delete(file.id);
	}

	function openMove(selection: TransferSelection): void {
		moveSelection = selection;
		moveOpen = true;
	}

	function startDrag(event: DragEvent, selection: TransferSelection): void {
		event.stopPropagation();
		if (!event.dataTransfer) return;
		event.dataTransfer.effectAllowed = 'copyMove';
		event.dataTransfer.setData(PROJECT_DRAG_TYPE, JSON.stringify(selection));
		if (selection.documentIds?.[0])
			event.dataTransfer.setData('text/plain', selection.documentIds[0]);
	}

	function handleMoveDone(result: TransferResult): void {
		if (result.targetProjectId)
			onChanged?.({
				projectId: result.targetProjectId,
				...(result.targetFolder ? { folder: result.targetFolder } : {})
			});
	}

	function visibleFiles(folder: ProjectFolder, key: string): FileItem[] {
		if (showAll.has(key)) return folder.files;
		return folder.files.slice(0, FILE_LIMIT);
	}
</script>

{#snippet folderContents(projectId: string, folder: ProjectFolder)}
	{#each folder.folders as child (child.path)}
		{@const key = folderKey(projectId, child.path)}
		<li
			class={isDropActive(projectId, child.path) ? 'rounded bg-accent/10' : 'rounded'}
			draggable="true"
			ondragstart={(event) => startDrag(event, { projectId, folder: child.path })}
			ondragover={(event) => handleDragOver(event, projectId, child.path)}
			ondragleave={(event) => handleDragLeave(event, projectId, child.path)}
			ondrop={(event) => void handleDrop(event, projectId, child.path)}
			data-project-folder={child.path}
			data-project-drop-active={isDropActive(projectId, child.path) ? 'true' : undefined}
		>
			<details open={isOpen(key)} ontoggle={(event) => onDetailsToggle(event, key)}>
				<summary
					class="min-h-10 cursor-pointer rounded px-2 py-2 text-sm hover:bg-bg-2 focus-visible:outline-2 focus-visible:outline-accent"
					aria-label={t('projects.toggleFolder', { name: child.name })}
					onkeydown={(event) => onDisclosureKey(event, key)}
				>
					{#if isOpen(key)}
						<FolderOpen size={15} class="mr-2 inline-block text-fg-dim" aria-hidden="true" />
					{:else}
						<Folder size={15} class="mr-2 inline-block text-fg-dim" aria-hidden="true" />
					{/if}{child.name}
				</summary>
				<ul class="ml-4 list-none border-l border-border pl-2">
					{#if actions}
						<li class="flex flex-wrap gap-1 px-2 pb-1">
							<button
								type="button"
								class="rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-fg"
								data-project-action="new-document"
								aria-label={t('projects.newDocumentIn', { folder: child.path })}
								onclick={() => void newDocument(projectId, child.path)}
							>
								<FilePlus size={12} aria-hidden="true" />
							</button>
							<button
								type="button"
								class="rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-fg"
								data-project-action="rename-folder"
								aria-label={t('projects.renameFolder')}
								onclick={() => void renameFolderPrompt(projectId, child.path)}
							>
								<Pencil size={12} aria-hidden="true" />
							</button>
							<button
								type="button"
								class="rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-fg"
								data-project-action="move-folder"
								aria-label={t('projects.moveTo')}
								onclick={() => openMove({ projectId, folder: child.path })}
							>
								<FolderInput size={12} aria-hidden="true" />
							</button>
						</li>
					{/if}
					{@render folderContents(projectId, child)}
				</ul>
			</details>
		</li>
	{/each}
	{#each visibleFiles(folder, folderKey(projectId, folder.path)) as file (file.id)}
		<li
			class="mdsh-file-row group relative flex items-stretch"
			data-project-document={file.relativePath}
		>
			<button
				disabled={busy}
				onclick={() => onOpen(file.id)}
				aria-label={rowLabels
					? `${filesStore.displayTitle(file.id)}${file.dirty ? t('sidebar.unexportedChangesHint') : ''}${file.relativePath ? ` (${file.relativePath})` : ''}`
					: t('projects.openDocument', { path: file.relativePath ?? file.name })}
				data-file-id={file.id}
				aria-current={file.id === filesStore.activeId ? 'true' : undefined}
				title={file.relativePath ?? file.name}
				class="flex min-h-[52px] min-w-0 flex-1 items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-bg-2 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
			>
				<FileText size={15} class="shrink-0 text-fg-dim" aria-hidden="true" />
				<span class="min-w-0 flex-1 truncate font-mono">{file.name}</span>
				<FileStatusBadge {file} />
			</button>
			{#if actions}
				<div
					class="flex flex-shrink-0 items-center opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
				>
					<button
						type="button"
						class="rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-fg"
						data-project-action="rename-document"
						aria-label={t('projects.renameDocument')}
						onclick={() => void renameDocumentPrompt(file)}
					>
						<Pencil size={12} aria-hidden="true" />
					</button>
					<button
						type="button"
						class="rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-fg"
						data-project-action="move-document"
						aria-label={t('projects.moveTo')}
						onclick={() => openMove({ projectId, documentIds: [file.id] })}
					>
						<MoreHorizontal size={12} aria-hidden="true" />
					</button>
					<button
						type="button"
						class="rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-danger"
						data-project-action="delete-document"
						aria-label={t('projects.deleteDocumentNamed', { name: file.name })}
						onclick={() => void deleteDocument(file)}
					>
						<Trash2 size={12} aria-hidden="true" />
					</button>
				</div>
			{/if}
		</li>
	{/each}
	{#if folder.files.length > FILE_LIMIT && !showAll.has(folderKey(projectId, folder.path))}
		<li>
			<button
				type="button"
				class="w-full rounded px-3 py-2 text-left text-xs text-fg-muted hover:bg-bg-2"
				onclick={() => showAll.add(folderKey(projectId, folder.path))}
			>
				{t('projects.showAllFiles', { n: folder.files.length })}
			</button>
		</li>
	{/if}
{/snippet}

<div class="text-sm" data-project-explorer>
	{#each roots as project (project.id)}
		{@const key = rootKey(project.id)}
		<div
			class={isDropActive(project.id) ? 'rounded bg-accent/10' : 'rounded'}
			role="group"
			ondragover={(event) => handleDragOver(event, project.id)}
			ondragleave={(event) => handleDragLeave(event, project.id)}
			ondrop={(event) => void handleDrop(event, project.id)}
			data-project-root={project.id}
			data-project-root-name={project.name}
			data-project-drop-active={isDropActive(project.id) ? 'true' : undefined}
		>
			<details open={isOpen(key)} ontoggle={(event) => onDetailsToggle(event, key)}>
				<summary
					class="min-h-10 cursor-pointer rounded px-2 py-2 font-medium hover:bg-bg-2 focus-visible:outline-2 focus-visible:outline-accent"
					aria-label={t('projects.toggleFolder', { name: project.name })}
					onkeydown={(event) => onDisclosureKey(event, key)}
				>
					{#if isOpen(key)}
						<FolderOpen size={15} class="mr-2 inline-block text-fg-dim" aria-hidden="true" />
					{:else}
						<Folder size={15} class="mr-2 inline-block text-fg-dim" aria-hidden="true" />
					{/if}{project.name}
				</summary>
				<ul class="ml-4 list-none border-l border-border pl-2">
					{#if actions}
						<li class="flex flex-wrap gap-1 px-2 pb-1">
							<button
								type="button"
								class="rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-fg"
								data-project-action="new-document"
								aria-label={t('projects.newDocumentHere')}
								onclick={() => void newDocument(project.id)}
							>
								<FilePlus size={12} aria-hidden="true" />
							</button>
							<button
								type="button"
								class="rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-fg"
								data-project-action="rename-project"
								aria-label={t('projects.renameProject')}
								onclick={() => void renameProjectPrompt(project.id)}
							>
								<FolderCog size={12} aria-hidden="true" />
							</button>
							{#if onManageProjects}
								<button
									type="button"
									class="rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-fg"
									data-project-action="manage-projects"
									aria-label={t('projects.manage')}
									onclick={onManageProjects}
								>
									<Settings2 size={12} aria-hidden="true" />
								</button>
							{/if}
						</li>
					{/if}
					{@render folderContents(project.id, {
						name: project.name,
						path: '',
						folders: project.folders,
						files: project.files
					})}
				</ul>
			</details>
		</div>
	{/each}
	{#if !roots.length}
		<p class="px-2 py-3 text-xs text-fg-muted">{t('projects.emptyExplorer')}</p>
	{/if}
	<div class="sr-only" role="status" aria-live="polite">
		{#if dropKey}
			{t('projects.dropMove', {
				path: previewPath(dropKey.split('::')[0]!, dropKey.split('::')[1] || undefined)
			})}
		{/if}
	</div>
</div>

<ProjectMoveDialog
	open={moveOpen}
	selection={moveSelection}
	{projects}
	onClose={() => (moveOpen = false)}
	onDone={handleMoveDone}
/>
