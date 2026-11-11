import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { addProjectImage, createProject, createProjectDocument, importProject } from './projects';
import { buildProjectZip, readProjectZip } from './project-archive';

const PNG_BYTES = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDfoAAAAASUVORK5CYII='
	),
	(character) => character.charCodeAt(0)
);

beforeEach(async () => {
	vi.stubGlobal(
		'createImageBitmap',
		vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
	);
	await Promise.all([db.projects.clear(), db.projectAssets.clear(), db.drafts.clear()]);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('project document creation', () => {
	it('reads only path metadata and keeps duplicate checks atomic', async () => {
		const project = await createProject('Notes');
		const seeded = await db.drafts.where('projectId').equals(project.id).first();
		await db.drafts.update(seeded!.id, { content: 'large body '.repeat(1000) });
		await db.projectAssets.add({
			id: 'asset-1',
			projectId: project.id,
			path: 'three.md',
			mime: 'image/png',
			data: PNG_BYTES
		});
		const draftsWhere = db.drafts.where.bind(db.drafts);
		const assetsWhere = db.projectAssets.where.bind(db.projectAssets);
		const draftsSpy = vi.spyOn(db.drafts, 'where').mockImplementation(((index: string) => {
			if (index === 'projectId') throw new Error('Full project document scan');
			return draftsWhere(index);
		}) as typeof db.drafts.where);
		const assetsSpy = vi.spyOn(db.projectAssets, 'where').mockImplementation(((index: string) => {
			if (index === 'projectId') throw new Error('Full project asset scan');
			return assetsWhere(index);
		}) as typeof db.projectAssets.where);

		const id = await createProjectDocument(project.id, 'two.md');
		expect(await db.drafts.get(id)).toMatchObject({ relativePath: 'two.md', content: '' });
		await expect(createProjectDocument(project.id, 'TWO.md')).rejects.toThrow(
			'Project path already exists'
		);
		await expect(createProjectDocument(project.id, 'three.md')).rejects.toThrow(
			'Project path already exists'
		);
		expect(draftsSpy).not.toHaveBeenCalledWith('projectId');
		expect(assetsSpy).not.toHaveBeenCalledWith('projectId');
	});

	it('commits the final capture body with the path reservation', async () => {
		const project = await createProject('Capture');
		const id = await createProjectDocument(project.id, 'quick.md', '# Captured\n\nExact body.\n');
		expect(await db.drafts.get(id)).toMatchObject({
			relativePath: 'quick.md',
			content: '# Captured\n\nExact body.\n'
		});
	});

	it('leaves no empty document when the atomic insert fails', async () => {
		const project = await createProject('Capture');
		const before = await db.drafts.where('projectId').equals(project.id).count();
		const add = vi.spyOn(db.drafts, 'add').mockRejectedValue(new Error('quota'));
		await expect(
			createProjectDocument(project.id, 'failed.md', '# Must not remain\n')
		).rejects.toThrow('quota');
		add.mockRestore();
		expect(await db.drafts.where('projectId').equals(project.id).count()).toBe(before);
		expect(
			(await db.drafts.where('projectId').equals(project.id).toArray()).some(
				(row) => row.relativePath === 'failed.md'
			)
		).toBe(false);
	});
});

describe('project image assets', () => {
	it('reuses validated bytes and reads quota from index keys', async () => {
		const project = await createProject('Images');
		const file = new File([PNG_BYTES], 'pixel.png', { type: 'image/png' });
		const first = await addProjectImage(project.id, file, {
			data: PNG_BYTES,
			mime: 'image/png'
		});
		expect(first).toContain('assets/');
		const second = await addProjectImage(project.id, file);
		expect(second).not.toBe(first);
		const assets = await db.projectAssets.where('projectId').equals(project.id).toArray();
		expect(assets).toHaveLength(2);
		expect(assets.every((asset) => asset.data.byteLength === PNG_BYTES.byteLength)).toBe(true);
	});
});

function readBlob(blob: Blob): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as ArrayBuffer);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(blob);
	});
}

async function zipFile(blob: Blob): Promise<File> {
	const file = new File([await readBlob(blob)], 'project.zip', { type: 'application/zip' });
	Object.defineProperty(file, 'arrayBuffer', {
		configurable: true,
		value: () => readBlob(file)
	});
	return file;
}

describe('portable project metadata', () => {
	it('keeps an explicit code MIME through ZIP export and import', async () => {
		const blob = await buildProjectZip(
			'Project',
			[
				{ relativePath: 'README.md', content: '# Readme\n' },
				{
					relativePath: 'scripts/build.py',
					content: 'print("ok")\n',
					kind: 'code',
					mime: 'text/x-python'
				}
			],
			[]
		);
		const project = await importProject(await readProjectZip(await zipFile(blob)));
		const rows = await db.drafts.where('projectId').equals(project.id).toArray();
		expect(rows.find((row) => row.relativePath === 'scripts/build.py')).toMatchObject({
			kind: 'code',
			mime: 'text/x-python',
			content: 'print("ok")\n'
		});
	});

	it('writes the MIME in the portable manifest', async () => {
		const blob = await buildProjectZip(
			'Project',
			[
				{ relativePath: 'README.md', content: '# Readme\n' },
				{ relativePath: 'query.sql', content: 'select 1;\n', kind: 'code', mime: 'text/x-sql' }
			],
			[]
		);
		const { default: JSZip } = await import('jszip');
		const zip = await JSZip.loadAsync(await readBlob(blob));
		const manifest = JSON.parse(await zip.file('.mdsh/project.json')!.async('string'));
		expect(manifest.schemaVersion).toBe(2);
		expect(manifest.documents).toContainEqual({
			path: 'query.sql',
			kind: 'code',
			mime: 'text/x-sql'
		});
	});

	it('rejects a malformed document MIME before creating an archive', async () => {
		await expect(
			buildProjectZip(
				'Project',
				[{ relativePath: 'a.py', content: 'x', kind: 'code', mime: 'text plain' }],
				[]
			)
		).rejects.toThrow(/Project document type/i);
	});

	it('imports a project without MIME using the existing defaults', async () => {
		const blob = await buildProjectZip(
			'Project',
			[{ relativePath: 'README.md', content: '# A' }],
			[]
		);
		const project = await importProject(await readProjectZip(await zipFile(blob)));
		const row = await db.drafts.where('projectId').equals(project.id).first();
		expect(row).toMatchObject({ relativePath: 'README.md' });
		expect(row?.mime).toBeUndefined();
	});
});
