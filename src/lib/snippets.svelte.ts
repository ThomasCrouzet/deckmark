// Snippet store (runes singleton). All writes reach IndexedDB before the
// in-memory list changes. A failed write keeps the visible list valid.

import { browser } from '$app/env';
import { liveQuery, type Subscription } from 'dexie';
import { db, newId, type SnippetRow } from './db';
import { reportPersistenceError } from './storage';
import { t } from '#lib/i18n/index.js';
import { hashSnippetCode } from './snippet-hash';
import { decodeSnippetManifest, type SnippetManifest } from './snippet-manifest-key';
import {
	findDuplicateSnippet,
	normalizeSnippetRow,
	serializeSnippetExport,
	snippetLanguage,
	type SnippetCapture
} from './snippets';

async function readSnippetManifests(): Promise<SnippetManifest[] | null> {
	try {
		const expected = await db.snippets.count();
		const idb = db.backendDB();
		const manifests = await new Promise<SnippetManifest[]>((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = idb.transaction('snippets', 'readonly');
			} catch (error) {
				reject(error);
				return;
			}
			const values: SnippetManifest[] = [];
			const request = transaction.objectStore('snippets').index('manifest').openKeyCursor();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) return;
				const manifest = decodeSnippetManifest(cursor.key);
				if (manifest) values.push(manifest);
				cursor.continue();
			};
			transaction.oncomplete = () => resolve(values);
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
		return manifests.length === expected ? manifests : null;
	} catch {
		return null;
	}
}

function manifestRow(manifest: SnippetManifest): SnippetRow {
	return {
		id: manifest.id,
		title: manifest.title,
		code: '',
		language: manifest.language,
		tags: manifest.tags,
		...(manifest.folder ? { folder: manifest.folder } : {}),
		...(manifest.projectId ? { projectId: manifest.projectId } : {}),
		favorite: manifest.favorite,
		createdAt: manifest.createdAt,
		updatedAt: manifest.updatedAt,
		...(manifest.codeHash ? { codeHash: manifest.codeHash } : {}),
		contentDeferred: true
	};
}

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
	private subscription: Subscription | undefined;
	private loading: Promise<void> | undefined;

	async load(): Promise<void> {
		if (!browser || typeof indexedDB === 'undefined') return;
		if (this.loading) return this.loading;
		if (this.loaded) return;
		this.loading = new Promise<void>((resolve, reject) => {
			let first = true;
			this.subscription = liveQuery(() =>
				db.snippets.orderBy('updatedAt').reverse().primaryKeys()
			).subscribe({
				next: (ids) => {
					void (async () => {
						const manifests = await readSnippetManifests();
						if (manifests) {
							const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
							this.rows = ids
								.map((id) => byId.get(id))
								.filter((manifest): manifest is SnippetManifest => !!manifest)
								.map(manifestRow);
						} else {
							this.rows = await db.snippets.orderBy('updatedAt').reverse().toArray();
						}
						this.loaded = true;
						if (first) {
							first = false;
							resolve();
						}
					})().catch((error: unknown) => {
						if (this.loaded) reportPersistenceError(error, 'load');
						this.loaded = false;
						this.subscription = undefined;
						if (first) {
							first = false;
							reject(error);
						}
					});
				},
				error: (error: unknown) => {
					if (this.loaded) reportPersistenceError(error, 'load');
					this.loaded = false;
					this.subscription = undefined;
					reject(error);
				}
			});
		});
		try {
			await this.loading;
		} finally {
			this.loading = undefined;
		}
	}

	async reload(): Promise<void> {
		if (this.loading) await this.loading;
		this.subscription?.unsubscribe();
		this.subscription = undefined;
		this.loaded = false;
		await this.load();
	}

	async save(input: SnippetInput, existingId: string | null = null): Promise<SnippetSaveResult> {
		(await import('./snippet-hooks')).installSnippetHooks();
		const language = snippetLanguage(input.language);
		const code = input.code;
		let result: SnippetSaveResult;
		try {
			result = await db.transaction('rw', db.snippets, async (): Promise<SnippetSaveResult> => {
				const candidates = await db.snippets
					.where('codeHash')
					.equals(hashSnippetCode(code))
					.toArray();
				const duplicate = findDuplicateSnippet(candidates, code, language, existingId);
				if (duplicate) return { ok: false, duplicate };
				const now = Date.now();
				const current = existingId ? ((await db.snippets.get(existingId)) ?? null) : null;
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
				await db.snippets.put($state.snapshot(row));
				return { ok: true, row, updated: current !== null };
			});
		} catch (error) {
			reportPersistenceError(error, 'save');
			throw error;
		}
		if (result.ok) {
			const { row } = result;
			this.rows = [row, ...this.rows.filter((entry) => entry.id !== row.id)];
		}
		return result;
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

	/** Reads one exact code body and updates the resident catalog row. */
	async contentFor(id: string): Promise<string | null> {
		const row = await db.snippets.get(id);
		const item = this.rows.find((entry) => entry.id === id);
		if (!row) {
			if (item) this.rows = this.rows.filter((entry) => entry.id !== id);
			return null;
		}
		if (item) {
			item.title = row.title;
			item.code = row.code;
			item.language = row.language;
			item.tags = row.tags;
			item.favorite = row.favorite;
			item.updatedAt = row.updatedAt;
			item.contentDeferred = false;
		}
		return row.code;
	}

	/** Advisory duplicate candidate from metadata; save still compares exact bytes. */
	findDuplicateCandidate(
		code: string,
		language: string,
		excludeId: string | null = null
	): SnippetRow | null {
		const hash = hashSnippetCode(code);
		return (
			this.rows.find(
				(row) => row.id !== excludeId && row.language === language && row.codeHash === hash
			) ?? null
		);
	}

	async toggleFavorite(id: string): Promise<void> {
		const current = this.rows.find((row) => row.id === id);
		if (!current) return;
		const favorite = !current.favorite;
		const updatedAt = Date.now();
		try {
			// Narrow update: the selected code body is not rewritten.
			await db.snippets.update(id, { favorite, updatedAt });
		} catch (error) {
			reportPersistenceError(error, 'save');
			return;
		}
		this.rows = this.rows.map((row) => (row.id === id ? { ...row, favorite, updatedAt } : row));
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

	async exportJson(now = Date.now()): Promise<string> {
		const ids = this.rows.filter((row) => row.contentDeferred).map((row) => row.id);
		if (ids.length > 0) {
			const full = await db.snippets.bulkGet(ids);
			const byId = new Map(
				full.filter((row): row is SnippetRow => row !== undefined).map((row) => [row.id, row])
			);
			return serializeSnippetExport(
				this.rows.map((row) => byId.get(row.id) ?? row),
				now
			);
		}
		return serializeSnippetExport(this.rows, now);
	}
}

export const snippetsStore = new SnippetsStore();
