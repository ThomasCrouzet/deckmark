import * as cryptoHelpers from '../crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const desktopMocks = vi.hoisted(() => ({
	isDesktop: vi.fn(() => false),
	tauriSaveExportBlob: vi.fn(async (_blob: Blob, _name: string) => true)
}));

vi.mock('../desktop', () => ({
	isDesktop: () => desktopMocks.isDesktop()
}));

vi.mock('../disk-tauri', () => ({
	tauriSaveExportBlob: (blob: Blob, name: string) => desktopMocks.tauriSaveExportBlob(blob, name)
}));

import {
	db,
	newId,
	DISK_LINK_EPOCH_KEY,
	type DraftRow,
	type WorkspaceRow,
	type TemplateRow
} from '../db';
import {
	BACKUP_FORMAT,
	BACKUP_SCHEMA_VERSION,
	BackupParseError,
	applyBackup,
	collectBackup,
	decryptBackupText,
	downloadBackup,
	isEncryptedBackup,
	parseBackup,
	restoreFromFile,
	restoreFromText,
	serializeBackup,
	type BackupFile
} from './backup';

describe('merge link integrity', () => {
	it('remaps cycles and aliases and keeps repeated merges idempotent', async () => {
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 1,
			workspaces: [],
			templates: [],
			drafts: [
				draft({
					id: 'old-a',
					name: 'a.md',
					content: '[[old-b|B]] `[[old-b]]`',
					createdAt: 1,
					updatedAt: 2
				}),
				draft({ id: 'old-b', name: 'b.md', content: '[[old-a]]', createdAt: 1, updatedAt: 2 })
			]
		};
		await applyBackup(backup, 'merge');
		const rows = await db.drafts.toArray();
		const a = rows.find((row) => row.name === 'a.md')!;
		const b = rows.find((row) => row.name === 'b.md')!;
		expect(a.content).toBe(`[[${b.id}|B]] \`[[old-b]]\``);
		expect(b.content).toBe(`[[${a.id}]]`);
		expect((await applyBackup(backup, 'merge')).unchanged.drafts).toBe(2);
		expect(await db.drafts.count()).toBe(2);
	});
	it('keeps references on the imported branch when an existing target differs', async () => {
		await db.drafts.bulkPut([
			draft({ id: 'existing-a', name: 'a.md', content: 'local', createdAt: 1, updatedAt: 2 }),
			draft({
				id: 'existing-b',
				name: 'b.md',
				content: '[[existing-a]]',
				createdAt: 1,
				updatedAt: 2
			})
		]);
		await applyBackup(
			{
				format: BACKUP_FORMAT,
				schemaVersion: 1,
				exportedAt: 1,
				workspaces: [],
				templates: [],
				drafts: [
					draft({ id: 'a', name: 'a.md', content: 'imported', createdAt: 1, updatedAt: 2 }),
					draft({ id: 'b', name: 'b.md', content: '[[a]]', createdAt: 1, updatedAt: 2 })
				]
			},
			'merge'
		);
		const rows = await db.drafts.toArray();
		const imported = rows.find((row) => row.content === 'imported')!;
		expect(rows.some((row) => row.content === `[[${imported.id}]]`)).toBe(true);
		expect(await db.drafts.get('existing-b')).toMatchObject({ content: '[[existing-a]]' });
	});
});
import { encryptString } from '../crypto';

// jsdom Blob and File objects can omit `.text()`. Use it when available, or use FileReader.
function blobText(blob: Blob): Promise<string> {
	if (typeof blob.text === 'function') return blob.text();
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsText(blob);
	});
}

async function clearAll() {
	await Promise.all([
		db.drafts.clear(),
		db.workspaces.clear(),
		db.templates.clear(),
		db.versions.clear(),
		db.trashed.clear(),
		db.metadata.clear(),
		db.snippets.clear(),
		db.projects.clear(),
		db.projectAssets.clear(),
		db.comments.clear()
	]);
}

beforeEach(clearAll);
afterEach(clearAll);

function draft(p: Partial<DraftRow> = {}): DraftRow {
	const now = Date.now();
	return {
		id: p.id ?? newId(),
		name: p.name ?? 'doc.md',
		content: p.content ?? 'hello',
		createdAt: p.createdAt ?? now,
		updatedAt: p.updatedAt ?? now,
		order: p.order ?? 0,
		...(p.projectId ? { projectId: p.projectId } : {}),
		...(p.relativePath ? { relativePath: p.relativePath } : {}),
		...(p.open === undefined ? {} : { open: p.open }),
		...(p.origin ? { origin: p.origin } : {}),
		...(p.kind ? { kind: p.kind } : {}),
		...(p.mime ? { mime: p.mime } : {}),
		...(p.data ? { data: p.data } : {})
	};
}
function workspace(p: Partial<WorkspaceRow> = {}): WorkspaceRow {
	const now = Date.now();
	return {
		id: p.id ?? newId(),
		name: p.name ?? 'WS',
		fileIds: p.fileIds ?? [],
		activeId: p.activeId ?? null,
		createdAt: p.createdAt ?? now,
		updatedAt: p.updatedAt ?? now
	};
}
function template(p: Partial<TemplateRow> = {}): TemplateRow {
	const now = Date.now();
	return {
		id: p.id ?? newId(),
		name: p.name ?? 'T',
		content: p.content ?? '# x',
		builtin: p.builtin ?? false,
		...(p.kind ? { kind: p.kind } : {}),
		createdAt: p.createdAt ?? now,
		updatedAt: p.updatedAt ?? now
	};
}

describe('collectBackup', () => {
	it('collects ordered drafts, workspaces, and templates', async () => {
		await db.drafts.bulkPut([draft({ name: 'b', order: 1 }), draft({ name: 'a', order: 0 })]);
		await db.workspaces.put(workspace({ name: 'WS1' }));
		await db.templates.put(template({ name: 'Tpl' }));

		const b = await collectBackup(1234);
		expect(b.format).toBe(BACKUP_FORMAT);
		expect(b.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
		expect(b.exportedAt).toBe(1234);
		expect(b.drafts.map((d) => d.name)).toEqual(['a', 'b']); // ordre par `order`
		expect(b.workspaces).toHaveLength(1);
		expect(b.templates).toHaveLength(1);
	});

	it('keeps editorial comments outside the draft content', async () => {
		const draftRow = draft({ name: 'review.md', content: 'Anchored text' });
		await db.drafts.put(draftRow);
		const now = Date.now();
		await db.comments.put({
			id: 'comment-1',
			draftId: draftRow.id,
			quote: 'Anchored',
			from: 0,
			to: 8,
			body: 'Check this',
			author: 'Reviewer',
			status: 'open',
			createdAt: now,
			updatedAt: now
		});
		const backup = await collectBackup(1234);
		expect(backup.comments).toHaveLength(1);
		expect(backup.drafts[0]?.content).toBe('Anchored text');
		const parsed = parseBackup(serializeBackup(backup));
		expect(parsed.comments?.[0]).toMatchObject({ body: 'Check this', quote: 'Anchored' });
		await db.comments.clear();
	});

	it('keeps typed text and binary image drafts across a backup round trip', async () => {
		await db.drafts.bulkPut([
			draft({ name: 'script.py', content: 'print("ok")\n', kind: 'code' }),
			draft({
				name: 'plan.png',
				content: '',
				kind: 'image',
				mime: 'image/png',
				data: 'data:image/png;base64,iVBORw0KGgo='
			})
		]);
		const backup = await collectBackup(1234);
		const parsed = parseBackup(serializeBackup(backup));
		expect(parsed.drafts.find((row) => row.name === 'script.py')).toMatchObject({
			kind: 'code',
			content: 'print("ok")\n'
		});
		expect(parsed.drafts.find((row) => row.name === 'plan.png')).toMatchObject({
			kind: 'image',
			mime: 'image/png',
			data: 'data:image/png;base64,iVBORw0KGgo=',
			content: ''
		});
	});

	it('keeps the presentation kind of a template', async () => {
		await db.templates.put(template({ name: 'Deck', kind: 'presentation' }));
		const b = await collectBackup(1234);
		expect(b.templates[0]).toMatchObject({ name: 'Deck', kind: 'presentation' });
		const parsed = parseBackup(serializeBackup(b));
		expect(parsed.templates[0]).toMatchObject({ name: 'Deck', kind: 'presentation' });
	});
});

describe('parseBackup - validation', () => {
	it('rejects invalid JSON', () => {
		expect(() => parseBackup('{not json')).toThrow(BackupParseError);
	});

	it('rejects an object with the wrong format', () => {
		expect(() => parseBackup(JSON.stringify({ format: 'autre', schemaVersion: 1 }))).toThrow(
			/pas une sauvegarde DeckMark/
		);
	});

	it('rejects a future schema version', () => {
		const json = JSON.stringify({
			format: BACKUP_FORMAT,
			schemaVersion: BACKUP_SCHEMA_VERSION + 1
		});
		expect(() => parseBackup(json)).toThrow(/version plus récente/);
	});

	it('rejects a missing schema version', () => {
		expect(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT }))).toThrow(
			/version de schéma/
		);
	});

	it('rejects a non-integer or non-positive schema version', () => {
		for (const bad of [0, -1, 0.5, 1.5]) {
			expect(() =>
				parseBackup(JSON.stringify({ format: BACKUP_FORMAT, schemaVersion: bad }))
			).toThrow(/incohérente/);
		}
	});
});

describe('applyBackup - replace', () => {
	it('rejects an invalid envelope without deleting documents or history', async () => {
		await db.drafts.put(draft({ id: 'local', content: 'à conserver' }));
		await db.versions.put({
			id: 'version',
			draftId: 'local',
			name: 'doc.md',
			content: 'avant',
			createdAt: 1
		});
		const malformed = JSON.stringify({
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			drafts: {},
			workspaces: null
		});
		await expect(restoreFromText(malformed, 'replace')).rejects.toBeInstanceOf(BackupParseError);
		expect((await db.drafts.get('local'))?.content).toBe('à conserver');
		expect(await db.versions.get('version')).toBeDefined();
	});

	it('rejects duplicate IDs before changes', async () => {
		await db.drafts.put(draft({ id: 'local' }));
		const backup = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [draft({ id: 'same', content: 'a' }), draft({ id: 'same', content: 'b' })],
			workspaces: [],
			templates: []
		} satisfies BackupFile;
		await expect(applyBackup(backup, 'replace')).rejects.toBeInstanceOf(BackupParseError);
		expect(await db.drafts.get('local')).toBeDefined();
	});

	it('replaces all existing state', async () => {
		await db.metadata.put({ key: DISK_LINK_EPOCH_KEY, value: 'before' });
		await db.drafts.put(draft({ id: 'old', name: 'old.md' }));
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [draft({ id: 'new', name: 'new.md' })],
			workspaces: [],
			templates: []
		};
		const counts = await applyBackup(backup, 'replace');
		expect(counts.drafts).toBe(1);
		const all = await db.drafts.toArray();
		expect(all.map((d) => d.id)).toEqual(['new']); // 'old' a disparu
		expect((await db.metadata.get(DISK_LINK_EPOCH_KEY))?.value).not.toBe('before');
	});

	it('keeps a replaced document and history in durable recovery', async () => {
		await db.drafts.put(draft({ id: 'old', name: 'old.md', content: 'courant' }));
		await db.versions.put({
			id: newId(),
			draftId: 'old',
			name: 'old.md',
			content: 'v1',
			createdAt: 0
		});
		expect(await db.versions.count()).toBe(1);
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [draft({ id: 'new', name: 'new.md' })],
			workspaces: [],
			templates: []
		};
		await applyBackup(backup, 'replace');
		expect(await db.versions.count()).toBe(1);
		expect((await db.trashed.get('old'))?.file.content).toBe('courant');
	});

	it('rolls back the epoch when replacement data cannot be written', async () => {
		await db.metadata.put({ key: DISK_LINK_EPOCH_KEY, value: 'before' });
		await db.drafts.put(draft({ id: 'old', name: 'old.md' }));
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [draft({ id: 'new', name: 'new.md' })],
			workspaces: [],
			templates: []
		};
		const write = vi.spyOn(db.drafts, 'bulkPut').mockRejectedValueOnce(new Error('write failed'));

		await expect(applyBackup(backup, 'replace')).rejects.toThrow('write failed');
		write.mockRestore();

		expect(await db.drafts.get('old')).toBeDefined();
		expect(await db.drafts.get('new')).toBeUndefined();
		expect((await db.metadata.get(DISK_LINK_EPOCH_KEY))?.value).toBe('before');
	});
});

describe('§2.8 - encrypted backup', () => {
	it('restores an encrypted export from text with a passphrase', async () => {
		await db.drafts.put(draft({ id: 'd', name: 'd.md', content: 'contenu chiffré' }));
		const clearJson = serializeBackup(await collectBackup());
		const encText = JSON.stringify(await encryptString(clearJson, 'motdepasse'));

		await clearAll();
		const counts = await restoreFromText(encText, 'replace', 'motdepasse');
		expect(counts.drafts).toBe(1);
		expect((await db.drafts.get('d'))?.content).toBe('contenu chiffré');
	});

	it('rejects encrypted text restoration without a passphrase', async () => {
		const env = await encryptString('{"format":"mdsh-backup","schemaVersion":1}', 'pw');
		await expect(restoreFromText(JSON.stringify(env), 'replace')).rejects.toThrow(/passphrase/i);
	});
});

describe('applyBackup - merge', () => {
	it('keeps both contents and maps workspaces without duplicate reimport', async () => {
		await db.drafts.put(draft({ id: 'a', content: 'local récent', createdAt: 1, updatedAt: 2000 }));
		const backup = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 1000,
			drafts: [draft({ id: 'a', content: 'ancien importé', createdAt: 1, updatedAt: 1000 })],
			workspaces: [
				workspace({ id: 'w', fileIds: ['a'], activeId: 'a', createdAt: 1, updatedAt: 1000 })
			],
			templates: []
		} satisfies BackupFile;
		const firstCounts = await applyBackup(backup, 'merge');
		expect(firstCounts).toMatchObject({ drafts: 1, workspaces: 1, templates: 0 });
		expect(firstCounts.unchanged).toEqual({ drafts: 0, workspaces: 0, templates: 0 });
		const variant = (await db.drafts.toArray()).find((row) => row.id !== 'a');
		expect((await db.drafts.get('a'))?.content).toBe('local récent');
		expect(variant?.content).toBe('ancien importé');
		expect((await db.workspaces.get('w'))?.fileIds).toEqual([variant?.id]);
		expect((await db.workspaces.get('w'))?.activeId).toBe(variant?.id);
		const secondCounts = await applyBackup(backup, 'merge');
		expect(secondCounts).toMatchObject({ drafts: 0, workspaces: 0, templates: 0 });
		expect(secondCounts.unchanged).toEqual({ drafts: 1, workspaces: 1, templates: 0 });
		expect(await db.drafts.count()).toBe(2);
		expect(await db.workspaces.count()).toBe(1);
	});

	it('keeps local content and imports a variant without order changes', async () => {
		await db.drafts.put(draft({ id: 'a', name: 'a.md', content: 'avant', order: 5 }));
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [draft({ id: 'a', name: 'a.md', content: 'après', order: 99 })],
			workspaces: [],
			templates: []
		};
		await applyBackup(backup, 'merge');
		const a = await db.drafts.get('a');
		expect(a?.content).toBe('avant');
		expect(a?.order).toBe(5); // order courant préservé
		const imported = (await db.drafts.toArray()).find((row) => row.id !== 'a');
		expect(imported?.content).toBe('après');
		expect(imported?.order).toBe(6);
	});

	it('merges workspaces and templates by ID', async () => {
		await db.templates.put(template({ id: 't1', name: 'avant' }));
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [],
			workspaces: [workspace({ id: 'w1', name: 'WS' })],
			templates: [template({ id: 't1', name: 'après' }), template({ id: 't2', name: 'neuf' })]
		};
		await applyBackup(backup, 'merge');
		expect(await db.workspaces.count()).toBe(1);
		expect((await db.templates.get('t1'))?.name).toBe('avant');
		expect(await db.templates.count()).toBe(3);
	});

	it('adds new drafts with increasing order during merge', async () => {
		await db.drafts.put(draft({ id: 'a', name: 'a.md', order: 3 }));
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [
				draft({ id: 'x', name: 'x.md', order: 0 }),
				draft({ id: 'y', name: 'y.md', order: 0 })
			],
			workspaces: [],
			templates: []
		};
		await applyBackup(backup, 'merge');
		const all = await db.drafts.orderBy('order').toArray();
		// Keep the existing item first. Put new items after max(order), which is 3.
		expect(all.map((d) => d.name)).toEqual(['a.md', 'x.md', 'y.md']);
		expect(all.find((d) => d.name === 'x.md')?.order).toBe(4);
		expect(all.find((d) => d.name === 'y.md')?.order).toBe(5);
	});

	it('rejects partial restoration without explicit acceptance', async () => {
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [draft({ id: 'a', name: 'a.md' })],
			workspaces: [],
			templates: []
		};
		await expect(applyBackup(backup, 'merge', 3)).rejects.toBeInstanceOf(BackupParseError);
		expect(await db.drafts.count()).toBe(0);
	});
});

describe('applyBackup - binary document source identity', () => {
	const IMAGE_PNG = 'data:image/png;base64,iVBORw0KGgo=';
	const IMAGE_PNG_B = 'data:image/png;base64,iVBORw0KGgoB';
	const PDF = 'data:application/pdf;base64,JVBERi0xLjQ=';

	it('imports a different binary payload instead of treating equal text as unchanged', async () => {
		const base = {
			id: 'img',
			name: 'img.png',
			content: '',
			kind: 'image' as const,
			mime: 'image/png',
			createdAt: 1,
			updatedAt: 2
		};
		await db.drafts.put(draft({ ...base, data: IMAGE_PNG }));
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [draft({ ...base, data: IMAGE_PNG_B })],
			workspaces: [],
			templates: []
		};
		const first = await applyBackup(backup, 'merge');
		expect(first.drafts).toBe(1);
		const rows = await db.drafts.toArray();
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.id === 'img')?.data).toBe(IMAGE_PNG);
		expect(rows.find((row) => row.id !== 'img')?.data).toBe(IMAGE_PNG_B);
		const second = await applyBackup(backup, 'merge');
		expect(second.drafts).toBe(0);
		expect(second.unchanged.drafts).toBe(1);
		expect(await db.drafts.count()).toBe(2);
	});

	it('treats a changed document kind or MIME as a distinct source', async () => {
		const base = {
			id: 'typed',
			name: 'typed.png',
			content: '',
			createdAt: 1,
			updatedAt: 2,
			order: 0
		};
		await db.drafts.put(draft({ ...base, kind: 'image', mime: 'image/png', data: IMAGE_PNG }));
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [draft({ ...base, kind: 'pdf', mime: 'application/pdf', data: PDF })],
			workspaces: [],
			templates: []
		};
		expect((await applyBackup(backup, 'merge')).drafts).toBe(1);
		const imported = (await db.drafts.toArray()).find((row) => row.id !== 'typed');
		expect(imported).toMatchObject({ kind: 'pdf', mime: 'application/pdf', data: PDF });
	});

	it('keeps the previous binary bytes as recovery trash during replace', async () => {
		await db.drafts.put(
			draft({
				id: 'img',
				name: 'img.png',
				content: '',
				kind: 'image',
				mime: 'image/png',
				data: IMAGE_PNG,
				createdAt: 1,
				updatedAt: 2
			})
		);
		await applyBackup(
			{
				format: BACKUP_FORMAT,
				schemaVersion: 1,
				exportedAt: 0,
				drafts: [
					draft({
						id: 'img',
						name: 'img.png',
						content: '',
						kind: 'image',
						mime: 'image/png',
						data: IMAGE_PNG_B,
						createdAt: 1,
						updatedAt: 2
					})
				],
				workspaces: [],
				templates: []
			},
			'replace'
		);
		expect((await db.drafts.get('img'))?.data).toBe(IMAGE_PNG_B);
		expect((await db.trashed.get('img'))?.file.data).toBe(IMAGE_PNG);
	});

	it('imports a project whose binary document payload differs', async () => {
		const project = { id: 'p', name: 'Project', createdAt: 1, updatedAt: 2 };
		const metadata = {
			name: 'img.png',
			content: '',
			kind: 'image' as const,
			mime: 'image/png',
			projectId: 'p',
			relativePath: 'img.png',
			createdAt: 1,
			updatedAt: 2
		};
		await db.projects.put(project);
		await db.drafts.put(draft({ ...metadata, id: 'local-img', data: IMAGE_PNG }));
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 2,
			exportedAt: 0,
			drafts: [draft({ ...metadata, id: 'incoming-img', data: IMAGE_PNG_B })],
			workspaces: [],
			templates: [],
			projects: [project],
			projectAssets: []
		};
		const counts = await applyBackup(backup, 'merge');
		expect(counts.projects).toBe(1);
		expect(counts.drafts).toBe(1);
		const importedProject = (await db.projects.toArray()).find((row) => row.id !== 'p')!;
		const importedDraft = (await db.drafts.toArray()).find((row) => row.id !== 'local-img')!;
		expect(importedDraft).toMatchObject({ data: IMAGE_PNG_B, projectId: importedProject.id });
	});
});

describe('applyBackup - project-scoped snippets', () => {
	it('remaps snippets to the imported project id before deduplication', async () => {
		await db.projects.put({ id: 'p', name: 'Current project', createdAt: 1, updatedAt: 2 });
		await db.snippets.put({
			id: 'unrelated',
			title: 'Unrelated',
			code: 'keep()',
			language: 'javascript',
			tags: [],
			projectId: 'p',
			favorite: false,
			createdAt: 1,
			updatedAt: 2
		});
		const incomingProject = { id: 'p', name: 'Incoming project', createdAt: 1, updatedAt: 2 };
		const snippet = {
			id: 's',
			title: 'Project helper',
			code: 'helper()',
			language: 'javascript',
			tags: ['project'],
			projectId: 'p',
			favorite: false,
			createdAt: 3,
			updatedAt: 4
		};
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 2,
			exportedAt: 0,
			drafts: [],
			workspaces: [],
			templates: [],
			projects: [incomingProject],
			projectAssets: [],
			snippets: [snippet]
		};
		const counts = await applyBackup(backup, 'merge');
		expect(counts.projects).toBe(1);
		expect(counts.snippets).toBe(1);
		const importedProject = (await db.projects.toArray()).find((row) => row.id !== 'p')!;
		const importedSnippet = (await db.snippets.toArray()).find((row) => row.id !== 'unrelated')!;
		expect(importedSnippet.projectId).toBe(importedProject.id);
		expect(await db.snippets.get('unrelated')).toMatchObject({ projectId: 'p', code: 'keep()' });

		const repeated = await applyBackup(backup, 'merge');
		expect(repeated.snippets).toBe(0);
		expect(repeated.unchanged.snippets).toBe(1);
		expect(await db.snippets.count()).toBe(2);
		expect((await db.snippets.get(importedSnippet.id))?.projectId).toBe(importedProject.id);
	});

	it('keeps a standalone snippet standalone', async () => {
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 2,
			exportedAt: 0,
			drafts: [],
			workspaces: [],
			templates: [],
			projects: [],
			projectAssets: [],
			snippets: [
				{
					id: 'standalone',
					title: 'Standalone',
					code: 'alone()',
					language: 'javascript',
					tags: [],
					favorite: false,
					createdAt: 1,
					updatedAt: 2
				}
			]
		};
		await applyBackup(backup, 'merge');
		expect(await db.snippets.get('standalone')).toMatchObject({ id: 'standalone' });
		expect((await db.snippets.get('standalone'))?.projectId).toBeUndefined();
	});
});

describe('applyBackup - editorial comment identity', () => {
	const comment = (overrides: Record<string, unknown> = {}) => ({
		id: 'c',
		draftId: 'a',
		quote: 'alpha',
		from: 0,
		to: 5,
		body: 'review',
		author: 'Alice',
		status: 'open' as const,
		createdAt: 1,
		updatedAt: 2,
		...overrides
	});

	it('imports a comment that shares the incomplete key but anchors another draft', async () => {
		await db.drafts.put(draft({ id: 'a', name: 'a.md', content: 'alpha beta' }));
		await db.comments.put(comment());
		const backup: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [draft({ id: 'b', name: 'b.md', content: 'beta gamma' })],
			workspaces: [],
			templates: [],
			comments: [
				comment({
					draftId: 'b',
					quote: 'beta',
					from: 6,
					to: 11,
					author: 'Bob'
				}) as never
			]
		};
		const counts = await applyBackup(backup, 'merge');
		expect(counts.comments).toBe(1);
		const rows = await db.comments.toArray();
		expect(rows).toHaveLength(2);
		const importedDraft = (await db.drafts.toArray()).find((row) => row.id !== 'a')!;
		const imported = rows.find((row) => row.id !== 'c')!;
		expect(imported).toMatchObject({
			draftId: importedDraft.id,
			quote: 'beta',
			from: 6,
			to: 11,
			author: 'Bob'
		});
		expect(await db.comments.get('c')).toMatchObject({ draftId: 'a', quote: 'alpha' });

		const repeated = await applyBackup(backup, 'merge');
		expect(repeated.comments).toBe(0);
		expect(await db.comments.count()).toBe(2);
		expect(await db.comments.get(imported.id)).toMatchObject({ quote: 'beta', author: 'Bob' });
	});

	it('deduplicates an exact repeat and keeps a same-id comment with another body', async () => {
		const shared = draft({ id: 'a', name: 'a.md', content: 'alpha', createdAt: 1, updatedAt: 2 });
		await db.drafts.put(shared);
		const exact = comment();
		await db.comments.put(exact);
		const repeated: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [shared],
			workspaces: [],
			templates: [],
			comments: [exact as never]
		};
		const first = await applyBackup(repeated, 'merge');
		expect(first.comments).toBe(0);
		expect(first.unchanged.drafts).toBe(1);
		expect(await db.comments.count()).toBe(1);

		repeated.comments = [comment({ body: 'second review' }) as never];
		const second = await applyBackup(repeated, 'merge');
		expect(second.comments).toBe(1);
		expect(await db.comments.count()).toBe(2);
		expect(new Set((await db.comments.toArray()).map((row) => row.id)).size).toBe(2);
	});
});

describe('applyBackup - replace preserves recovery comments', () => {
	it('rekeys comments to the retained recovery draft instead of the incoming one', async () => {
		await db.drafts.put(
			draft({ id: 'a', name: 'a.md', content: 'CURRENT', createdAt: 1, updatedAt: 2 })
		);
		await db.comments.put({
			id: 'review',
			draftId: 'a',
			quote: 'CURRENT',
			from: 0,
			to: 7,
			body: 'Keep this note',
			author: 'Reviewer',
			status: 'open',
			createdAt: 3,
			updatedAt: 4
		});
		const incoming: BackupFile = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [draft({ id: 'a', name: 'a.md', content: 'INCOMING', createdAt: 1, updatedAt: 2 })],
			workspaces: [],
			templates: [],
			comments: []
		};
		const counts = await applyBackup(incoming, 'replace');
		expect((await db.drafts.get('a'))?.content).toBe('INCOMING');
		const trashed = await db.trashed.get('a');
		expect(trashed).toBeUndefined();
		const recovery = (await db.trashed.toArray()).find((row) => row.file.content === 'CURRENT')!;
		expect(recovery).toBeDefined();
		expect(recovery.id).not.toBe('a');
		const comments = await db.comments.toArray();
		expect(comments).toHaveLength(1);
		expect(comments[0]).toMatchObject({
			draftId: recovery.id,
			quote: 'CURRENT',
			body: 'Keep this note',
			author: 'Reviewer'
		});
		expect(counts.comments).toBe(1);

		const repeated = await applyBackup(incoming, 'replace');
		expect(await db.comments.count()).toBe(1);
		expect(repeated.comments).toBe(1);
		expect((await db.comments.toArray())[0]).toMatchObject({ draftId: recovery.id });
	});

	it('remaps recovery comments with the retained project identity', async () => {
		await db.projects.put({ id: 'p', name: 'Current project', createdAt: 1, updatedAt: 2 });
		await db.drafts.put(
			draft({
				id: 'doc',
				name: 'doc.md',
				content: 'CURRENT',
				projectId: 'p',
				relativePath: 'doc.md',
				createdAt: 1,
				updatedAt: 2
			})
		);
		await db.comments.put({
			id: 'review',
			draftId: 'doc',
			quote: 'CURRENT',
			from: 0,
			to: 7,
			body: 'Project note',
			author: 'Reviewer',
			status: 'open',
			createdAt: 3,
			updatedAt: 4
		});
		await applyBackup(
			{
				format: BACKUP_FORMAT,
				schemaVersion: 2,
				exportedAt: 0,
				drafts: [
					draft({
						id: 'doc',
						name: 'doc.md',
						content: 'INCOMING',
						projectId: 'p',
						relativePath: 'doc.md',
						createdAt: 1,
						updatedAt: 2
					})
				],
				workspaces: [],
				templates: [],
				projects: [{ id: 'p', name: 'Incoming project', createdAt: 1, updatedAt: 2 }],
				projectAssets: [],
				comments: []
			},
			'replace'
		);
		const recoveryProject = (await db.projects.toArray()).find((row) => row.id !== 'p')!;
		expect(recoveryProject).toBeDefined();
		const recovery = (await db.trashed.toArray()).find((row) => row.file.content === 'CURRENT')!;
		expect(recovery.file.projectId).toBe(recoveryProject.id);
		expect((await db.comments.toArray())[0]).toMatchObject({ draftId: recovery.id });
	});

	it('never attaches a preserved comment to an incoming draft', async () => {
		await db.drafts.put(
			draft({ id: 'a', name: 'a.md', content: 'CURRENT', createdAt: 1, updatedAt: 2 })
		);
		await db.comments.put({
			id: 'review',
			draftId: 'a',
			quote: 'CURRENT',
			from: 0,
			to: 7,
			body: 'Local review',
			author: 'Reviewer',
			status: 'open',
			createdAt: 3,
			updatedAt: 4
		});
		await applyBackup(
			{
				format: BACKUP_FORMAT,
				schemaVersion: 1,
				exportedAt: 0,
				drafts: [draft({ id: 'a', name: 'a.md', content: 'INCOMING', createdAt: 1, updatedAt: 2 })],
				workspaces: [],
				templates: [],
				comments: [
					{
						id: 'incoming-review',
						draftId: 'a',
						quote: 'INCOMING',
						from: 0,
						to: 8,
						body: 'Backup review',
						author: 'Backup author',
						status: 'open',
						createdAt: 5,
						updatedAt: 6
					}
				]
			},
			'replace'
		);
		const comments = await db.comments.toArray();
		expect(comments).toHaveLength(2);
		expect(comments.find((row) => row.body === 'Backup review')).toMatchObject({ draftId: 'a' });
		expect(comments.find((row) => row.body === 'Local review')?.draftId).not.toBe('a');
	});
});

describe('restoreFromText - plain text', () => {
	it('rejects an encrypted envelope with an incorrect passphrase', async () => {
		const clearJson = serializeBackup({
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [draft({ id: 'd', name: 'd.md' })],
			workspaces: [],
			templates: []
		});
		const encText = JSON.stringify(await encryptString(clearJson, 'bonpw'));
		await expect(restoreFromText(encText, 'replace', 'mauvaispw')).rejects.toThrow();
		// No data was applied.
		expect(await db.drafts.count()).toBe(0);
	});
});

describe('downloadBackup - orchestration DOM', () => {
	let createdAnchor: {
		href: string;
		download: string;
		click: ReturnType<typeof vi.fn>;
		remove: ReturnType<typeof vi.fn>;
	};
	let createObjectURL: ReturnType<typeof vi.fn>;
	let revokeObjectURL: ReturnType<typeof vi.fn>;
	let createElementSpy: ReturnType<typeof vi.spyOn>;
	let appendSpy: ReturnType<typeof vi.spyOn>;
	let capturedBlobs: Blob[];

	beforeEach(() => {
		desktopMocks.isDesktop.mockReturnValue(false);
		desktopMocks.tauriSaveExportBlob.mockResolvedValue(true);
		capturedBlobs = [];
		createdAnchor = {
			href: '',
			download: '',
			click: vi.fn(),
			remove: vi.fn()
		};
		createObjectURL = vi.fn((blob: Blob) => {
			capturedBlobs.push(blob);
			return 'blob:mock-url';
		});
		revokeObjectURL = vi.fn();
		// jsdom omits URL.createObjectURL and revokeObjectURL. Add them for this test.
		vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
		const realCreate = document.createElement.bind(document);
		createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
			if (tag === 'a') return createdAnchor as unknown as HTMLAnchorElement;
			return realCreate(tag);
		}) as unknown as ReturnType<typeof vi.spyOn>;
		appendSpy = vi
			.spyOn(document.body, 'appendChild')
			.mockImplementation(
				((node: Node) => node) as typeof document.body.appendChild
			) as unknown as ReturnType<typeof vi.spyOn>;
	});

	afterEach(() => {
		createElementSpy.mockRestore();
		appendSpy.mockRestore();
		vi.unstubAllGlobals();
		desktopMocks.isDesktop.mockReturnValue(false);
	});

	it('fails without producing a file when the durability barrier fails', async () => {
		const ensureDurable = vi.fn(async () => {
			throw new Error('IndexedDB indisponible');
		});
		await expect(downloadBackup(undefined, ensureDurable)).rejects.toThrow(
			'IndexedDB indisponible'
		);
		expect(ensureDurable).toHaveBeenCalledOnce();
		expect(createObjectURL).not.toHaveBeenCalled();
		expect(createdAnchor.click).not.toHaveBeenCalled();
	});

	it('downloads an encrypted backup when a passphrase is present', async () => {
		await db.drafts.put(draft({ id: 'd', name: 'd.md', content: 'à protéger' }));
		expect(await downloadBackup('motdepasse')).toBe(true);

		expect(createdAnchor.click).toHaveBeenCalledTimes(1);
		expect(createdAnchor.download).toMatch(/^deckmark-backup-\d{4}-\d{2}-\d{2}\.encrypted\.json$/);

		// The blob is an encrypted envelope and must be detected as one.
		const text = await blobText(capturedBlobs[0]!);
		expect(isEncryptedBackup(text)).toBe(true);
		// The correct passphrase must decrypt the envelope to valid parseable data.
		const clear = await decryptBackupText(text, 'motdepasse');
		expect(parseBackup(clear).drafts.map((x) => x.id)).toEqual(['d']);
	});

	it('rejects download when a document exceeds the restore limit', async () => {
		await db.drafts.put(draft({ content: 'x'.repeat(16 * 1024 * 1024 + 1) }));
		await expect(downloadBackup()).rejects.toThrow(BackupParseError);
		expect(createdAnchor.click).not.toHaveBeenCalled();
		expect(createObjectURL).not.toHaveBeenCalled();
	});

	it('rejects an encrypted envelope larger than 64 MiB before download', async () => {
		const envelope = await encryptString('{}', 'password');
		const encrypt = vi
			.spyOn(cryptoHelpers, 'encryptString')
			.mockResolvedValue({ ...envelope, ct: 'a'.repeat(64 * 1024 * 1024) });
		try {
			await expect(downloadBackup('password')).rejects.toThrow(BackupParseError);
			expect(createdAnchor.click).not.toHaveBeenCalled();
			expect(createObjectURL).not.toHaveBeenCalled();
		} finally {
			encrypt.mockRestore();
		}
	});

	it('backs up more than 300 documents from multiple batches without truncation', async () => {
		await db.drafts.bulkPut(
			Array.from({ length: 301 }, (_, index) => draft({ id: `document-${index}` }))
		);
		expect(await downloadBackup()).toBe(true);
		expect(parseBackup(await blobText(capturedBlobs[0]!)).drafts).toHaveLength(301);
	});

	it('validates the generated snapshot without parsing its own JSON again', async () => {
		await db.drafts.put(draft({ id: 'only', name: 'only.md', content: 'exact bytes' }));
		const parse = vi.spyOn(JSON, 'parse');
		try {
			expect(await downloadBackup()).toBe(true);
			expect(parse).not.toHaveBeenCalled();
		} finally {
			parse.mockRestore();
		}
		const text = await blobText(capturedBlobs[0]!);
		expect(parseBackup(text).drafts).toEqual([
			expect.objectContaining({ id: 'only', content: 'exact bytes' })
		]);
	});

	it('returns false after desktop dialog cancellation', async () => {
		desktopMocks.isDesktop.mockReturnValue(true);
		desktopMocks.tauriSaveExportBlob.mockResolvedValue(false);
		await db.drafts.put(draft({ id: 'd', name: 'd.md', content: 'x' }));
		const ok = await downloadBackup();
		expect(ok).toBe(false);
		expect(desktopMocks.tauriSaveExportBlob).toHaveBeenCalledOnce();
		// No browser blob fallback on cancel.
		expect(createObjectURL).not.toHaveBeenCalled();
		expect(createdAnchor.click).not.toHaveBeenCalled();
	});

	it('returns a native error without a browser download', async () => {
		desktopMocks.isDesktop.mockReturnValue(true);
		desktopMocks.tauriSaveExportBlob.mockRejectedValueOnce(new Error('disk conflict'));
		await expect(downloadBackup()).rejects.toThrow('disk conflict');
		expect(createObjectURL).not.toHaveBeenCalled();
		expect(createdAnchor.click).not.toHaveBeenCalled();
	});
});

describe('restore limits before read and changes', () => {
	it('rejects invalid UTF-8 bytes before changes', async () => {
		await db.drafts.put(draft({ id: 'safe' }));
		await expect(
			restoreFromFile(new File([new Uint8Array([0xc3, 0x28])], 'backup.json'), 'replace')
		).rejects.toThrow(BackupParseError);
		expect(await db.drafts.get('safe')).toBeDefined();
	});
	it('rejects more than 3000 documents and binary content', () => {
		const backup = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: Array.from({ length: 3001 }, (_, index) => draft({ id: String(index) })),
			workspaces: [],
			templates: []
		};
		expect(() => parseBackup(JSON.stringify(backup))).toThrow(BackupParseError);
		backup.drafts = [draft({ id: 'binary', content: '\0' })];
		expect(() => parseBackup(JSON.stringify(backup))).toThrow(BackupParseError);
	});
	it('rejects one document larger than 16 MiB', () => {
		const backup = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [draft({ content: 'x'.repeat(16 * 1024 * 1024 + 1) })],
			workspaces: [],
			templates: []
		};
		expect(() => parseBackup(JSON.stringify(backup))).toThrow(BackupParseError);
	});
});

describe('strict validation for each saved field', () => {
	it.each([
		['drafts', 'id', ''],
		['drafts', 'name', 42],
		['drafts', 'content', false],
		['drafts', 'createdAt', 'hier'],
		['drafts', 'updatedAt', null],
		['drafts', 'updatedAt', 1e100],
		['drafts', 'order', '1'],
		['drafts', 'open', 'false'],
		['workspaces', 'id', ''],
		['workspaces', 'name', null],
		['workspaces', 'fileIds', {}],
		['workspaces', 'fileIds', [42]],
		['workspaces', 'activeId', 42],
		['workspaces', 'createdAt', null],
		['workspaces', 'updatedAt', false],
		['templates', 'id', ''],
		['templates', 'name', 42],
		['templates', 'content', null],
		['templates', 'builtin', 1],
		['templates', 'createdAt', false],
		['templates', 'updatedAt', null]
	])('refuse %s.%s invalide', (collection, field, value) => {
		const backup: Record<string, unknown> = {
			format: BACKUP_FORMAT,
			schemaVersion: 1,
			exportedAt: 0,
			drafts: [],
			workspaces: [],
			templates: []
		};
		const original =
			collection === 'drafts' ? draft() : collection === 'workspaces' ? workspace() : template();
		backup[String(collection)] = [{ ...original, [String(field)]: value }];
		expect(() => parseBackup(JSON.stringify(backup))).toThrow(BackupParseError);
	});
	it.each(['drafts', 'workspaces', 'templates'])(
		'refuse une entrée non objet dans %s',
		(collection) => {
			const backup = {
				format: BACKUP_FORMAT,
				schemaVersion: 1,
				exportedAt: 0,
				drafts: [],
				workspaces: [],
				templates: [],
				[collection]: [null]
			};
			expect(() => parseBackup(JSON.stringify(backup))).toThrow(BackupParseError);
		}
	);
});

describe('saved workspace references', () => {
	it.each([
		workspace({ fileIds: ['a', 'a'], activeId: 'a' }),
		workspace({ fileIds: ['a'], activeId: 'absent' }),
		workspace({ fileIds: [''] }),
		workspace({ fileIds: Array.from({ length: 301 }, (_, index) => String(index)) })
	])('refuse doublons, référence vide, sélection incohérente et espace trop grand', (invalid) => {
		expect(() =>
			parseBackup(
				JSON.stringify({
					format: BACKUP_FORMAT,
					schemaVersion: 1,
					exportedAt: 0,
					drafts: [],
					workspaces: [invalid],
					templates: []
				})
			)
		).toThrow(BackupParseError);
	});
	it('also limits total references across workspaces', () => {
		const workspaces = Array.from({ length: 11 }, (_, index) =>
			workspace({ id: String(index), fileIds: Array.from({ length: 300 }, (_, id) => String(id)) })
		);
		expect(() =>
			parseBackup(
				JSON.stringify({
					format: BACKUP_FORMAT,
					schemaVersion: 1,
					exportedAt: 0,
					drafts: [],
					workspaces,
					templates: []
				})
			)
		).toThrow(BackupParseError);
	});
});
