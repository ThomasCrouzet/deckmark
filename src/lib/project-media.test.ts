import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import {
	invalidateProjectMediaCache,
	projectContextFor,
	projectImageSource,
	projectMediaCacheStats,
	resetProjectMediaStats
} from './project-media';

const svgA =
	'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>';
const svgB = svgA.replace('fill="red"', 'fill="tan"');
const encoder = new TextEncoder();

async function seedDraft(content = '# Note\n') {
	await db.drafts.put({
		id: 'media-file',
		name: 'index.md',
		content,
		projectId: 'media-project',
		relativePath: 'notes/index.md',
		createdAt: 1,
		updatedAt: 1,
		order: 0
	});
}

async function seedAsset(data: string) {
	await db.projectAssets.put({
		id: 'asset-1',
		projectId: 'media-project',
		path: 'assets/pixel.svg',
		mime: 'image/svg+xml',
		data: encoder.encode(data)
	});
}

const pixelPng =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function bytes(value: string | Uint8Array): Uint8Array {
	if (typeof value !== 'string') return value;
	return encoder.encode(value);
}

function pngBytes(base64: string): Uint8Array {
	return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function decodedData(uri: string | null): string {
	const encoded = uri?.split(',')[1] ?? '';
	return encoded ? atob(encoded) : '';
}

async function putAsset(
	id: string,
	path: string,
	data: string | Uint8Array,
	mime = 'image/svg+xml'
) {
	await db.projectAssets.put({
		id,
		projectId: 'media-project',
		path,
		mime,
		data: bytes(data)
	});
}

beforeEach(async () => {
	// jsdom has no image decoder. The stub supplies only dimensions; the real
	// SVG sanitizer and base64 encoder still run for every decode.
	vi.stubGlobal(
		'createImageBitmap',
		vi.fn(async () => ({ width: 1, height: 1, close: () => undefined }))
	);
	await db.delete();
	await db.open();
	invalidateProjectMediaCache();
	resetProjectMediaStats();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await db.delete();
});

describe('project media context', () => {
	it('reads project location from the metadata projection without a full draft row', async () => {
		await seedDraft('# Body\n'.repeat(200_000));
		const fullRow = vi.spyOn(db.drafts, 'get');
		const context = await projectContextFor('media-file');
		expect(context).toEqual({ projectId: 'media-project', relativePath: 'notes/index.md' });
		expect(fullRow).not.toHaveBeenCalled();
	});

	it('resolves one context read for 50 concurrent slide elements', async () => {
		await seedDraft();
		const results = await Promise.all(
			Array.from({ length: 50 }, () => projectContextFor('media-file'))
		);
		expect(results.every((context) => context?.projectId === 'media-project')).toBe(true);
		expect(projectMediaCacheStats().contextReads).toBe(1);
	});

	it('drops a location at once when the document moves project or folder', async () => {
		await seedDraft();
		expect(await projectContextFor('media-file')).toEqual({
			projectId: 'media-project',
			relativePath: 'notes/index.md'
		});
		await db.drafts.update('media-file', {
			projectId: 'moved-project',
			relativePath: 'archive/index.md'
		});
		expect(await projectContextFor('media-file')).toEqual({
			projectId: 'moved-project',
			relativePath: 'archive/index.md'
		});
	});
});

describe('project image source', () => {
	it('reads one asset row and decodes once for 20 concurrent references', async () => {
		await seedDraft();
		await seedAsset(svgA);
		const context = { projectId: 'media-project', relativePath: 'notes/index.md' };
		const results = await Promise.all(
			Array.from({ length: 20 }, () => projectImageSource('../assets/pixel.svg', context))
		);
		expect(new Set(results).size).toBe(1);
		expect(results[0]).toMatch(/^data:image\/svg\+xml/);
		expect(projectMediaCacheStats().assetReads).toBe(1);
		expect(projectMediaCacheStats().decodeCalls).toBe(1);
	});

	it('uses the new bytes after an equal-length same-ID and same-MIME replacement', async () => {
		await seedDraft();
		await seedAsset(svgA);
		const context = { projectId: 'media-project', relativePath: 'notes/index.md' };
		const before = await projectImageSource('../assets/pixel.svg', context);
		await db.projectAssets.put({
			id: 'asset-1',
			projectId: 'media-project',
			path: 'assets/pixel.svg',
			mime: 'image/svg+xml',
			data: encoder.encode(svgB)
		});
		const after = await projectImageSource('../assets/pixel.svg', context);
		expect(after).not.toBe(before);
		expect(projectMediaCacheStats().assetReads).toBe(2);
		expect(projectMediaCacheStats().decodeCalls).toBe(2);
	});

	it('serves a repeated render from the resolved path cache without an asset read', async () => {
		await seedDraft();
		await seedAsset(svgA);
		const context = { projectId: 'media-project', relativePath: 'notes/index.md' };
		const first = await projectImageSource('../assets/pixel.svg', context);
		resetProjectMediaStats();
		const second = await projectImageSource('../assets/pixel.svg', context);
		expect(second).toBe(first);
		expect(projectMediaCacheStats().assetReads).toBe(0);
		expect(projectMediaCacheStats().fingerprintCalls).toBe(0);
		expect(projectMediaCacheStats().decodeCalls).toBe(0);
		expect(projectMediaCacheStats().resolvedHits).toBe(1);
	});

	it('stops waiting when the caller aborts without dropping the shared decode', async () => {
		await seedDraft();
		await seedAsset(svgA);
		const context = { projectId: 'media-project', relativePath: 'notes/index.md' };
		const controller = new AbortController();
		const first = projectImageSource('../assets/pixel.svg', context, controller.signal);
		const second = projectImageSource('../assets/pixel.svg', context);
		controller.abort();
		await expect(first).rejects.toMatchObject({ name: 'AbortError' });
		expect(await second).toMatch(/^data:image\/svg\+xml/);
	});
});

describe('canonical project asset paths', () => {
	const context = { projectId: 'media-project', relativePath: 'notes/page.md' };

	beforeEach(async () => {
		await seedDraft();
	});

	it('resolves a case-mismatched nested asset without reading every blob', async () => {
		await putAsset('upper', 'Assets/Diagram.PNG', pngBytes(pixelPng), 'image/png');
		for (let index = 0; index < 30; index++)
			await putAsset(
				`other-${index}`,
				`Assets/Other-${index}.PNG`,
				pngBytes(pixelPng),
				'image/png'
			);
		resetProjectMediaStats();
		const resolved = await projectImageSource('../assets/diagram.png', context);
		expect(resolved).toMatch(/^data:image\/png;base64,/);
		expect(projectMediaCacheStats().assetReads).toBe(1);
	});

	it('matches Unicode NFC and case keys inside nested folders', async () => {
		await putAsset(
			'unicode',
			'Dépôt/Ässets/Diagräm.SVG',
			svgA.replace('fill="red"', 'fill="blue"'),
			'image/svg+xml'
		);
		const decomposed = '../de\u0301po\u0302t/a\u0308ssets/diagra\u0308m.svg';
		const resolved = await projectImageSource(decomposed, context);
		expect(resolved).toMatch(/^data:image\/svg\+xml/);
		expect(decodedData(resolved)).toContain('blue');
	});

	it('rejects a case-only canonical collision instead of choosing one blob', async () => {
		await putAsset('first', 'assets/pixel.svg', svgA);
		await putAsset('second', 'Assets/Pixel.SVG', svgB);
		expect(await projectImageSource('../assets/pixel.svg', context)).toBeNull();
	});

	it('never embeds another project asset with the same path', async () => {
		await putAsset('local', 'assets/pixel.svg', svgA);
		await db.projectAssets.put({
			id: 'foreign',
			projectId: 'other-project',
			path: 'assets/pixel.svg',
			mime: 'image/svg+xml',
			data: encoder.encode(svgB)
		});
		const resolved = await projectImageSource('../assets/pixel.svg', context);
		expect(decodedData(resolved)).toContain('red');
		expect(decodedData(resolved)).not.toContain('tan');
	});

	it('reads the new bytes after a case-mismatched asset is replaced', async () => {
		await putAsset('asset-1', 'Assets/Pixel.SVG', svgA);
		const before = await projectImageSource('../assets/pixel.svg', context);
		await putAsset('asset-1', 'Assets/Pixel.SVG', svgB);
		const after = await projectImageSource('../assets/pixel.svg', context);
		expect(after).not.toBe(before);
		expect(decodedData(after)).toContain('tan');
	});
});
