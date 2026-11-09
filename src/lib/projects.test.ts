import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { addProjectImage, createProject } from './projects';

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
	vi.unstubAllGlobals();
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
