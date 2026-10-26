// §2.7 - Document-template store (runes singleton).
//
// Merges the builtin templates (code, never persisted) and the user templates
// (`db.templates`). Powers the palette's "New from template", saving a
// current document as a template, and deleting user templates (the builtin ones
// are protected).

import { browser } from '$app/env';
import { db, newId, type TemplateRow } from './db';
import { reportPersistenceError } from './storage';
import { t } from '#lib/i18n/index.js';
import {
	BUILTIN_TEMPLATES,
	applyTemplateVars,
	templateFileName,
	type TemplateDef
} from './templates';

export interface TemplateChoice {
	id: string;
	name: string;
	description: string;
	builtin: boolean;
}

class TemplatesStore {
	/** User templates (persisted). The builtin ones come from `BUILTIN_TEMPLATES`. */
	userTemplates = $state<TemplateRow[]>([]);
	loaded = $state(false);

	/** Displayable list: builtin first, then user templates (recent first). */
	get choices(): TemplateChoice[] {
		const builtin = BUILTIN_TEMPLATES.map((template) => ({
			id: template.id,
			name: t(
				template.id === 'builtin:meeting'
					? 'templates.meeting'
					: template.id === 'builtin:journal'
						? 'templates.journal'
						: 'templates.todo'
			),
			description: t(
				template.id === 'builtin:meeting'
					? 'templates.meetingDescription'
					: template.id === 'builtin:journal'
						? 'templates.journalDescription'
						: 'templates.todoDescription'
			),
			builtin: true
		}));
		const user = this.userTemplates.map((tpl) => ({
			id: tpl.id,
			name: tpl.name,
			description: t('templates.userDescription'),
			builtin: false
		}));
		return [...builtin, ...user];
	}

	async load(): Promise<void> {
		if (!browser || this.loaded) return;
		this.userTemplates = await db.templates.orderBy('updatedAt').reverse().toArray();
		this.loaded = true;
	}

	/** §1.1 - Reloads after a backup restore. */
	async reload(): Promise<void> {
		this.loaded = false;
		await this.load();
	}

	/** Resolves a template (builtin or user) into `{ name, content }` ready to create. */
	resolve(id: string, now: Date = new Date()): { name: string; content: string } | null {
		const builtin: TemplateDef | undefined = BUILTIN_TEMPLATES.find((t) => t.id === id);
		if (builtin) {
			return {
				name: templateFileName(builtin, now),
				content: applyTemplateVars(builtin.content, now)
			};
		}
		const user = this.userTemplates.find((t) => t.id === id);
		if (user) {
			return {
				name: `${user.name}.md`,
				content: applyTemplateVars(user.content, now)
			};
		}
		return null;
	}

	/**
	 * Saves a current content as a new user template.
	 *
	 * Write-then-mutate: IDB write BEFORE mutating the runes state. If the `put`
	 * fails (full quota…), the error is notified and the list stays intact - no
	 * phantom template that would disappear on reload. Returns `null` on failure.
	 */
	async save(name: string, content: string): Promise<TemplateRow | null> {
		const now = Date.now();
		const row: TemplateRow = {
			id: newId(),
			name: name.trim() || t('templates.defaultName'),
			content,
			builtin: false,
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
		const next = { ...current, name: name.trim(), content, updatedAt: Date.now() };
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
