import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { addProjectImage, createProject, createProjectDocument } from './projects';

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
