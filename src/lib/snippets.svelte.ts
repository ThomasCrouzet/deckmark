// Snippet store (runes singleton). All writes reach IndexedDB before the
// in-memory list changes. A failed write keeps the visible list valid.

import { browser } from '$app/env';
import { db, newId, type SnippetRow } from './db';
import { reportPersistenceError } from './storage';
import { t } from '#lib/i18n/index.js';
import {
	findDuplicateSnippet,
	normalizeSnippetRow,
	serializeSnippetExport,
	snippetLanguage,
	type SnippetCapture
} from './snippets';

export interface SnippetInput {
	title: string;
	code: string;
	language: string;
	tags: string[];
	folder?: string;
	projectId?: string;
	favorite?: boolean;
}

export type SnippetSaveResult =
	{ ok: true; row: SnippetRow; updated: boolean } | { ok: false; duplicate: SnippetRow };

function cleanOptional(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

class SnippetsStore {
	rows = $state<SnippetRow[]>([]);
	loaded = $state(false);

	async load(): Promise<void> {
		if (!browser || this.loaded) return;
		this.rows = await db.snippets.orderBy('updatedAt').reverse().toArray();
		this.loaded = true;
	}

	async reload(): Promise<void> {
		this.loaded = false;
		await this.load();
	}

	async save(input: SnippetInput, existingId: string | null = null): Promise<SnippetSaveResult> {
		const language = snippetLanguage(input.language);
		const code = input.code;
		const duplicate = findDuplicateSnippet(this.rows, code, language, existingId);
		if (duplicate) return { ok: false, duplicate };
		const now = Date.now();
		const current = existingId ? (this.rows.find((row) => row.id === existingId) ?? null) : null;
		const row: SnippetRow = {
			id: current?.id ?? newId(),
			title: input.title.trim() || t('snippets.untitled'),
			code,
			language,
			tags: [...input.tags],
			...(cleanOptional(input.folder) ? { folder: cleanOptional(input.folder)! } : {}),
			...(cleanOptional(input.projectId) ? { projectId: cleanOptional(input.projectId)! } : {}),
			favorite: input.favorite ?? current?.favorite ?? false,
			createdAt: current?.createdAt ?? now,
			updatedAt: now
		};
		try {
			await db.snippets.put($state.snapshot(row));
		} catch (error) {
			reportPersistenceError(error, 'save');
			throw error;
		}
		if (current) {
			this.rows = this.rows.map((entry) => (entry.id === row.id ? row : entry));
		} else {
			this.rows = [row, ...this.rows];
		}
		return { ok: true, row, updated: current !== null };
	}

	async capture(input: SnippetCapture, title?: string): Promise<SnippetSaveResult> {
		return this.save({
			title: title ?? input.title,
			code: input.code,
			language: snippetLanguage(undefined, input.fileName),
			tags: [],
			...(input.projectId ? { projectId: input.projectId } : {})
		});
	}

	async toggleFavorite(id: string): Promise<void> {
		const current = this.rows.find((row) => row.id === id);
		if (!current) return;
		const next = { ...current, favorite: !current.favorite, updatedAt: Date.now() };
		try {
			await db.snippets.put($state.snapshot(next));
		} catch (error) {
			reportPersistenceError(error, 'save');
			return;
		}
		this.rows = this.rows.map((row) => (row.id === id ? next : row));
	}

	async delete(id: string): Promise<boolean> {
		try {
			await db.snippets.delete(id);
		} catch (error) {
			reportPersistenceError(error, 'delete');
			return false;
		}
		this.rows = this.rows.filter((row) => row.id !== id);
		return true;
	}

	/** Replaces rows with the same identifier and adds all other rows. */
	async importRows(rows: readonly SnippetRow[]): Promise<number> {
		if (rows.length === 0) return 0;
		const normalized = rows.map(normalizeSnippetRow);
		try {
			await db.transaction('rw', db.snippets, async () => {
				await db.snippets.bulkPut(normalized);
			});
		} catch (error) {
			reportPersistenceError(error, 'save');
			throw error;
		}
		const incoming = new Set(normalized.map((row) => row.id));
		this.rows = [...normalized, ...this.rows.filter((row) => !incoming.has(row.id))].toSorted(
			(left, right) => right.updatedAt - left.updatedAt
		);
		return normalized.length;
	}

	exportJson(now = Date.now()): string {
		return serializeSnippetExport(this.rows, now);
	}
}

export const snippetsStore = new SnippetsStore();
