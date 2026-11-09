// §2.7 - Document-template store (runes singleton).
//
// Merges the builtin templates (code, never persisted) and the user templates
// (`db.templates`). Powers the palette's "New from template", saving a
// current document as a template, and deleting user templates (the builtin ones
// are protected).

import { browser } from '$app/env';
import { db, newId, type TemplateRow } from './db';
import { documentKind, type DocumentKind } from './document-kind';
import { reportPersistenceError } from './storage';
import { t } from '#lib/i18n/index.js';
import {
	BUILTIN_TEMPLATES,
	applyTemplateVars,
	templateFileName,
	type TemplateDef
} from './templates';
import { decodeTemplateManifest, type TemplateManifest } from './template-manifest-key';

async function readTemplateManifests(): Promise<TemplateManifest[] | null> {
	try {
		const expected = await db.templates.count();
		const idb = db.backendDB();
		const manifests = await new Promise<TemplateManifest[]>((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = idb.transaction('templates', 'readonly');
			} catch (error) {
				reject(error);
				return;
			}
			const values: TemplateManifest[] = [];
			const request = transaction.objectStore('templates').index('manifest').openKeyCursor();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) return;
				const manifest = decodeTemplateManifest(cursor.key);
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

export interface TemplateChoice {
	id: string;
	name: string;
	description: string;
	builtin: boolean;
	kind: DocumentKind;
}

class TemplatesStore {
	/** User templates (persisted). The builtin ones come from `BUILTIN_TEMPLATES`. */
	userTemplates = $state<TemplateRow[]>([]);
	loaded = $state(false);
	/** Latest catalog load. An older asynchronous read must not publish. */
	private loadGeneration = 0;

	/** Displayable list: builtin first, then user templates (recent first). */
	get choices(): TemplateChoice[] {
		const builtin = BUILTIN_TEMPLATES.map((template) => ({
			id: template.id,
			name: template.nameKey ? t(template.nameKey) : template.name,
			description: template.descriptionKey ? t(template.descriptionKey) : template.description,
			builtin: true,
			kind: template.kind ?? 'note'
		}));
		const user = this.userTemplates.map((tpl) => ({
			id: tpl.id,
			name: tpl.name,
			description: t('templates.userDescription'),
			builtin: false,
			kind: tpl.kind ?? 'note'
		}));
		return [...builtin, ...user];
	}

	async load(): Promise<void> {
		if (!browser || this.loaded) return;
		const generation = ++this.loadGeneration;
		const manifests = await readTemplateManifests();
		const next = manifests
			? manifests
					.sort((a, b) => b.updatedAt - a.updatedAt)
					.map((manifest) => ({
						id: manifest.id,
						name: manifest.name,
						content: '',
						builtin: manifest.builtin,
						kind: manifest.kind,
						createdAt: manifest.createdAt,
						updatedAt: manifest.updatedAt,
						contentDeferred: true
					}))
			: await db.templates.orderBy('updatedAt').reverse().toArray();
		if (generation !== this.loadGeneration) return;
		this.userTemplates = next;
		this.loaded = true;
	}

	/** Reads the exact current body for a selected or edited template. */
	async contentFor(id: string): Promise<string | null> {
		if (id.startsWith('builtin:'))
			return BUILTIN_TEMPLATES.find((template) => template.id === id)?.content ?? null;
		const requestGeneration = this.loadGeneration;
		const item = this.userTemplates.find((template) => template.id === id);
		const expectedUpdatedAt = item?.updatedAt;
		const row = await db.templates.get(id);
		if (this.loadGeneration !== requestGeneration) {
			const current = this.userTemplates.find((template) => template.id === id);
			if (current && !current.contentDeferred) return current.content;
			return (await db.templates.get(id))?.content ?? null;
		}
		const current = this.userTemplates.find((template) => template.id === id);
		if (!row) {
			if (current && current.updatedAt === expectedUpdatedAt)
				this.userTemplates = this.userTemplates.filter((template) => template.id !== id);
			return null;
		}
		if (!current || current.updatedAt !== expectedUpdatedAt || row.updatedAt < current.updatedAt) {
			if (current && !current.contentDeferred) return current.content;
			return (await db.templates.get(id))?.content ?? null;
		}
		current.content = row.content;
		current.name = row.name;
		current.kind = row.kind ?? documentKind(row.content);
		current.updatedAt = row.updatedAt;
		current.contentDeferred = false;
		return row.content;
	}

	/** §1.1 - Reloads after a backup restore. */
	async reload(): Promise<void> {
		this.loaded = false;
		this.loadGeneration += 1;
		await this.load();
	}

	/** Resolves a template (builtin or user) into `{ name, content }` ready to create. */
	async resolve(
		id: string,
		now: Date = new Date()
	): Promise<{ name: string; content: string; kind: DocumentKind } | null> {
		const builtin: TemplateDef | undefined = BUILTIN_TEMPLATES.find((t) => t.id === id);
		if (builtin) {
			return {
				name: templateFileName(builtin, now),
				content: applyTemplateVars(builtin.content, now),
				kind: builtin.kind ?? 'note'
			};
		}
		const user = this.userTemplates.find((t) => t.id === id);
		if (!user) return null;
		let content = user.content;
		if (user.contentDeferred) {
			const hydrated = await this.contentFor(id);
			if (hydrated === null) return null;
			content = hydrated;
		}
		// The catalog row can be replaced by a save or a cross-window update
		// while the deferred body loads. Read the current row after the await.
		const current = this.userTemplates.find((t) => t.id === id);
		if (!current) return null;
		return {
			name: `${current.name}.md`,
			content: applyTemplateVars(content, now),
			kind: current.kind ?? documentKind(content)
		};
	}

	/**
	 * Saves a current content as a new user template.
	 *
	 * Write-then-mutate: IDB write BEFORE mutating the runes state. If the `put`
	 * fails (full quota…), the error is notified and the list stays intact - no
	 * phantom template that would disappear on reload. Returns `null` on failure.
	 */
	async save(
		name: string,
		content: string,
		kind: DocumentKind = documentKind(content)
	): Promise<TemplateRow | null> {
		const now = Date.now();
		const row: TemplateRow = {
			id: newId(),
			name: name.trim() || t('templates.defaultName'),
			content,
			builtin: false,
			kind,
			createdAt: now,
			updatedAt: now
		};
		try {
			await db.templates.put($state.snapshot(row));
		} catch (err) {
			reportPersistenceError(err, 'save');
			return null;
		}
		this.userTemplates.unshift(row);
		return row;
	}

	/**
	 * Deletes a user template. No-op on a builtin (protected).
	 *
	 * Write-then-mutate: IDB deletion BEFORE removal from the list. If the
	 * `delete` fails, the template stays displayed (still in the database) and
	 * the error is notified - no phantom disappearance reappearing on reload.
	 */
	async delete(id: string): Promise<void> {
		if (id.startsWith('builtin:')) return;
		const idx = this.userTemplates.findIndex((t) => t.id === id);
		if (idx === -1) return;
		try {
			await db.templates.delete(id);
		} catch (err) {
			reportPersistenceError(err, 'delete');
			return;
		}
		// Re-look-up the index (the list may have changed during the await).
		const cur = this.userTemplates.findIndex((t) => t.id === id);
		if (cur !== -1) this.userTemplates.splice(cur, 1);
	}

	async update(id: string, name: string, content: string): Promise<boolean> {
		const current = this.userTemplates.find((template) => template.id === id);
		if (!current || !name.trim()) return false;
		const next = {
			...current,
			name: name.trim(),
			content,
			updatedAt: Date.now(),
			contentDeferred: false
		};
		try {
			await db.templates.put($state.snapshot(next));
		} catch (error) {
			reportPersistenceError(error, 'save');
			return false;
		}
		this.userTemplates = this.userTemplates.map((template) =>
			template.id === id ? next : template
		);
		return true;
	}
}

export const templatesStore = new TemplatesStore();
