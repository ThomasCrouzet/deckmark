import { browser } from '$app/env';
import { db, type ProjectRow } from './db';
import { readPreference, writePreference } from './preferences';
import { projectPath } from './project-paths';
import { SvelteSet } from 'svelte/reactivity';

const EXPANDED_KEY = 'mdsh:project-expanded';

export interface ProjectRoot {
	id: string;
	name: string;
}

function rootKey(projectId: string): string {
	return `${projectId}::`;
}

function folderKey(projectId: string, folder: string): string {
	return `${projectId}::${projectPath(folder)}`;
}

/** Expansion keys include the project id so equal folder names stay separate. */
class ProjectExplorerStore {
	projects = $state<ProjectRow[]>([]);
	expanded = $state<Set<string>>(new SvelteSet());
	loaded = $state(false);
	private hasStoredState = false;

	async load(): Promise<void> {
		if (!browser || typeof indexedDB === 'undefined') return;
		try {
			this.projects = await db.projects.orderBy('updatedAt').reverse().toArray();
		} catch {
			this.projects = [];
		}
		if (this.loaded) return;
		const raw = readPreference(EXPANDED_KEY);
		this.hasStoredState = raw !== null;
		if (raw) {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (Array.isArray(parsed))
					this.expanded = new SvelteSet(
						parsed.filter((entry): entry is string => typeof entry === 'string')
					);
			} catch {
				this.expanded = new SvelteSet();
			}
		}
		this.loaded = true;
	}

	/** Expand the active project and its folders once, before the user chooses a state. */
	revealInitial(projectId: string | undefined, relativePath: string | undefined): void {
		if (!this.loaded || this.hasStoredState || !projectId) return;
		this.expandPath(projectId, relativePath);
		this.hasStoredState = true;
	}

	/** Reveal the active document and keep the other folders unchanged. */
	revealActive(projectId: string | undefined, relativePath: string | undefined): void {
		if (!this.loaded || !projectId) return;
		this.expandPath(projectId, relativePath);
	}

	expandPath(projectId: string, relativePath: string | undefined): void {
		const next = new SvelteSet(this.expanded);
		next.add(rootKey(projectId));
		if (relativePath) {
			const parts = relativePath.split('/');
			parts.pop();
			let current = '';
			for (const part of parts) {
				current = current ? `${current}/${part}` : part;
				next.add(folderKey(projectId, current));
			}
		}
		this.expanded = next;
		this.persist();
	}

	expand(keys: readonly string[]): void {
		const next = new SvelteSet(this.expanded);
		for (const key of keys) next.add(key);
		this.expanded = next;
		this.persist();
	}

	setExpanded(key: string, open: boolean): void {
		const next = new SvelteSet(this.expanded);
		if (open) next.add(key);
		else next.delete(key);
		this.expanded = next;
		this.persist();
	}

	toggle(key: string): void {
		this.setExpanded(key, !this.expanded.has(key));
	}

	isExpanded(key: string, fallback = false): boolean {
		return this.expanded.has(key) || (!this.hasStoredState && fallback);
	}

	keysFor(projectId: string, folder?: string): string[] {
		return folder ? [rootKey(projectId), folderKey(projectId, folder)] : [rootKey(projectId)];
	}

	private persist(): void {
		writePreference(EXPANDED_KEY, JSON.stringify([...this.expanded]));
	}
}

export const projectExplorer = new ProjectExplorerStore();
export { rootKey, folderKey };
