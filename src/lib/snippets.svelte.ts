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

export interface SnippetImportReport {
	added: number;
	preserved: number;
	unchanged: number;
	replaced: number;
}

function sameSnippetIdentity(left: SnippetRow, right: SnippetRow): boolean {
	return (
		left.id === right.id &&
		left.title === right.title &&
		left.code === right.code &&
		left.language === right.language &&
		left.tags.length === right.tags.length &&
		left.tags.every((tag, index) => tag === right.tags[index]) &&
		left.folder === right.folder &&
		left.projectId === right.projectId &&
		left.favorite === right.favorite &&
		left.createdAt === right.createdAt &&
		left.updatedAt === right.updatedAt
	);
}

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
	/** Latest catalog publication. Older async reads must not replace it. */
	private catalogGeneration = 0;

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
					const generation = ++this.catalogGeneration;
					void (async () => {
						const manifests = await readSnippetManifests();
						if (generation !== this.catalogGeneration) return;
						let nextRows: SnippetRow[];
						if (manifests) {
							const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
							nextRows = ids
								.map((id) => byId.get(id))
								.filter((manifest): manifest is SnippetManifest => !!manifest)
								.map(manifestRow);
						} else {
							nextRows = await db.snippets.orderBy('updatedAt').reverse().toArray();
						}
						if (generation !== this.catalogGeneration) return;
						this.rows = nextRows;
						this.loaded = true;
						if (first) {
							first = false;
							resolve();
						}
					})().catch((error: unknown) => {
						this.catalogGeneration += 1;
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
					this.catalogGeneration += 1;
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
		this.catalogGeneration += 1;
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
		const requestGeneration = this.catalogGeneration;
		const item = this.rows.find((entry) => entry.id === id);
		const expectedUpdatedAt = item?.updatedAt;
		const row = await db.snippets.get(id);
		// A newer catalog publication or row revision wins over this read.
		if (!row) {
			const current = this.rows.find((entry) => entry.id === id);
			if (
				this.catalogGeneration === requestGeneration &&
				current &&
				current.updatedAt === expectedUpdatedAt
			)
				this.rows = this.rows.filter((entry) => entry.id !== id);
			return null;
		}
		const current = this.rows.find((entry) => entry.id === id);
		const stale =
			this.catalogGeneration !== requestGeneration ||
			!current ||
			current.updatedAt !== expectedUpdatedAt ||
			row.updatedAt < current.updatedAt;
		if (stale) {
			// A save, rename, favorite toggle or cross-tab write replaced the row
			// while the body read was pending. Apply only the exact current
			// revision; an older body must never replace newer resident fields.
			const latest = await db.snippets.get(id);
			const latestCurrent = this.rows.find((entry) => entry.id === id);
			if (latest && latestCurrent && latest.updatedAt === latestCurrent.updatedAt) {
				latestCurrent.title = latest.title;
				latestCurrent.code = latest.code;
				latestCurrent.language = latest.language;
				latestCurrent.tags = latest.tags;
				latestCurrent.favorite = latest.favorite;
				latestCurrent.updatedAt = latest.updatedAt;
				latestCurrent.contentDeferred = false;
				return latest.code;
			}
			if (latestCurrent && !latestCurrent.contentDeferred) return latestCurrent.code;
			return latest?.code ?? null;
		}
		current.title = row.title;
		current.code = row.code;
		current.language = row.language;
		current.tags = row.tags;
		current.favorite = row.favorite;
		current.updatedAt = row.updatedAt;
		current.contentDeferred = false;
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

	/**
	 * Merges an import without replacing a divergent local snippet. An exact
	 * match is idempotent. A conflict keeps the local row and stores the
	 * imported variant under a new identifier, so both remain searchable.
	 */
	async importRows(rows: readonly SnippetRow[]): Promise<SnippetImportReport> {
		const report: SnippetImportReport = { added: 0, preserved: 0, unchanged: 0, replaced: 0 };
		if (rows.length === 0) return report;
		const normalized = rows.map(normalizeSnippetRow);
		const written: SnippetRow[] = [];
		try {
			await db.transaction('rw', db.snippets, async () => {
				// Compare at commit time so a cross-tab save between the file read
				// and this transaction cannot be overwritten.
				const existingRows = await db.snippets.bulkGet(normalized.map((row) => row.id));
				const existing = new Map(
					existingRows
						.filter((row): row is SnippetRow => row !== undefined)
						.map((row) => [row.id, row])
				);
				const toWrite: SnippetRow[] = [];
				for (const row of normalized) {
					const current = existing.get(row.id);
					if (!current) {
						toWrite.push(row);
						report.added += 1;
						continue;
					}
					if (sameSnippetIdentity(current, row)) {
						report.unchanged += 1;
						continue;
					}
					// Safe merge: never replace the local row with the older or
					// unrelated imported variant.
					const variant = { ...row, id: newId() };
					toWrite.push(variant);
					report.preserved += 1;
				}
				if (toWrite.length > 0) await db.snippets.bulkPut(toWrite);
				written.push(...toWrite);
			});
		} catch (error) {
			reportPersistenceError(error, 'save');
			throw error;
		}
		if (written.length > 0) {
			const incoming = new Set(written.map((row) => row.id));
			this.rows = [...written, ...this.rows.filter((row) => !incoming.has(row.id))].toSorted(
				(left, right) => right.updatedAt - left.updatedAt
			);
		}
		return report;
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
