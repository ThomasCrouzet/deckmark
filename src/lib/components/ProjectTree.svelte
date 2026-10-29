<script lang="ts">
	import type { FileItem } from '#lib/types.js';
	import { t } from '#lib/i18n/index.js';
	import { Folder, FileText } from '@lucide/svelte';

	let {
		documents,
		busy = false,
		onOpen
	}: {
		documents: FileItem[];
		busy?: boolean;
		onOpen: (id: string) => void;
	} = $props();

	interface ProjectFolder {
		name: string;
		path: string;
		folders: ProjectFolder[];
		files: FileItem[];
	}

	const root = $derived.by(() => {
		const tree: ProjectFolder = { name: '', path: '', folders: [], files: [] };
		for (const file of documents) {
			const parts = (file.relativePath ?? file.name).split('/');
			parts.pop();
			let folder = tree;
			for (const name of parts) {
				let child = folder.folders.find((entry) => entry.name === name);
				if (!child) {
					child = { name, path: `${folder.path}/${name}`, folders: [], files: [] };
					folder.folders.push(child);
				}
				folder = child;
			}
			folder.files.push(file);
		}
		return tree;
	});
</script>

{#snippet contents(folder: ProjectFolder)}
	<ul class="space-y-1">
		{#each folder.folders as child (child.path)}
			<li>
				<details open>
					<summary
						class="cursor-pointer rounded px-2 py-2 text-sm hover:bg-bg-2 focus-visible:outline-2 focus-visible:outline-accent"
					>
						<Folder
							size={15}
							class="mr-2 inline-block text-fg-dim"
							aria-hidden="true"
						/>{child.name}
					</summary>
					<div class="ml-4 border-l border-border pl-2">{@render contents(child)}</div>
				</details>
			</li>
		{/each}
		{#each folder.files as file (file.id)}
			<li data-project-document={file.relativePath}>
				<button
					disabled={busy}
					onclick={() => onOpen(file.id)}
					aria-label={t('projects.openDocument', { path: file.relativePath ?? file.name })}
					class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-bg-2 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
				>
					<FileText size={15} class="shrink-0 text-fg-dim" aria-hidden="true" />
					<span class="break-all font-mono">{file.name}</span>
				</button>
			</li>
		{/each}
	</ul>
{/snippet}

{@render contents(root)}
