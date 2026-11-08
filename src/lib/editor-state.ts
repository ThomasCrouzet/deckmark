import type { EditMode } from './types';

const STORAGE_KEY = 'mdsh:editor-view-state';
const MAX_FILE_ID_LENGTH = 1024;
const NAVIGATION_LIMIT = 256;

export interface EditorPosition {
	anchor: number;
	head: number;
	scrollTop: number;
}

interface NavigationEntry {
	positions: Partial<Record<EditMode, EditorPosition>>;
}

interface PersistedDraftEditorState {
	fileId: string;
	positions: Partial<Record<EditMode, EditorPosition>>;
}

function validPosition(value: unknown): value is EditorPosition {
	if (!value || typeof value !== 'object') return false;
	const position = value as Partial<EditorPosition>;
	return (
		Number.isFinite(position.anchor) &&
		Number.isFinite(position.head) &&
		Number.isFinite(position.scrollTop)
	);
}

function clonePosition(position: EditorPosition): EditorPosition {
	const coordinate = (value: number) =>
		Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
	const scroll = Number.isFinite(position.scrollTop) ? Math.max(0, position.scrollTop) : 0;
	return {
		anchor: coordinate(position.anchor),
		head: coordinate(position.head),
		scrollTop: scroll
	};
}

function validFileId(fileId: string): boolean {
	return typeof fileId === 'string' && fileId.length > 0 && fileId.length <= MAX_FILE_ID_LENGTH;
}

/**
 * Keeps editor navigation state for the most recently used drafts.
 *
 * Positions use sessionStorage so a page reload restores the same location.
 * This module is part of the boot graph, so it stays free of CodeMirror and of
 * the optional history cache. History lives in `editor-history-cache.ts`.
 */
export class EditorStateCache {
	readonly limit: number;
	#entries = new Map<string, NavigationEntry>();
	#loaded = false;

	constructor(limit = NAVIGATION_LIMIT) {
		this.limit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : NAVIGATION_LIMIT;
	}

	getPosition(fileId: string, mode: EditMode): EditorPosition | undefined {
		this.#load();
		const entry = this.#touch(fileId);
		const position = entry?.positions[mode];
		return position ? clonePosition(position) : undefined;
	}

	setPosition(fileId: string, mode: EditMode, position: EditorPosition): void {
		this.#load();
		if (!validFileId(fileId)) return;
		const entry = this.#touch(fileId) ?? { positions: {} };
		entry.positions[mode] = clonePosition(position);
		this.#put(fileId, entry);
		this.#persist();
	}

	delete(fileId: string): void {
		this.#load();
		if (!this.#entries.delete(fileId)) return;
		this.#persist();
	}

	clear(): void {
		this.#entries.clear();
		this.#loaded = true;
		this.#persist();
	}

	get size(): number {
		this.#load();
		return this.#entries.size;
	}

	#touch(fileId: string): NavigationEntry | undefined {
		const entry = this.#entries.get(fileId);
		if (!entry) return undefined;
		this.#entries.delete(fileId);
		this.#entries.set(fileId, entry);
		return entry;
	}

	#put(fileId: string, entry: NavigationEntry): void {
		this.#entries.delete(fileId);
		this.#entries.set(fileId, entry);
		while (this.#entries.size > this.limit) {
			const oldest = this.#entries.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
	}

	#load(): void {
		if (this.#loaded) return;
		this.#loaded = true;
		if (typeof sessionStorage === 'undefined') return;
		try {
			const raw = sessionStorage.getItem(STORAGE_KEY);
			if (!raw) return;
			const values = JSON.parse(raw) as unknown;
			if (!Array.isArray(values)) return;
			for (const value of values.slice(-this.limit)) {
				if (!value || typeof value !== 'object') continue;
				const saved = value as Partial<PersistedDraftEditorState>;
				if (
					typeof saved.fileId !== 'string' ||
					!validFileId(saved.fileId) ||
					!saved.positions ||
					typeof saved.positions !== 'object'
				)
					continue;
				const positions: Partial<Record<EditMode, EditorPosition>> = {};
				for (const mode of ['wysiwyg', 'source', 'read'] as const) {
					const position = saved.positions[mode];
					if (validPosition(position)) positions[mode] = clonePosition(position);
				}
				this.#put(saved.fileId, { positions });
			}
		} catch {
			// A malformed or unavailable session store must not block the editor.
		}
	}

	#persist(): void {
		if (typeof sessionStorage === 'undefined') return;
		try {
			const values: PersistedDraftEditorState[] = [...this.#entries].map(([fileId, entry]) => ({
				fileId,
				positions: entry.positions
			}));
			sessionStorage.setItem(STORAGE_KEY, JSON.stringify(values));
		} catch {
			// Navigation state is optional when browser storage is unavailable.
		}
	}
}

export const editorStateCache = new EditorStateCache();
