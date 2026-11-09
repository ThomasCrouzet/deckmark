import { describe, expect, it } from 'vitest';
import { buildProjectZip } from './project-archive';

const IMAGE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_URL = `data:image/png;base64,${Buffer.from(IMAGE).toString('base64')}`;

async function loadArchive(blob: Blob) {
	const { default: JSZip } = await import('jszip');
	if (typeof blob.arrayBuffer === 'function') return JSZip.loadAsync(await blob.arrayBuffer());
	const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as ArrayBuffer);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(blob);
	});
	return JSZip.loadAsync(bytes);
}

describe('portable project ZIP binary documents', () => {
	it('writes the exact bytes of a typed image document without an asset copy', async () => {
		const blob = await buildProjectZip(
			'Project',
			[
				{ relativePath: 'README.md', content: '# Project\n' },
				{
					relativePath: 'photo.png',
					content: '',
					kind: 'image',
					mime: 'image/png',
					data: IMAGE_URL
				}
			],
			[]
		);
		const zip = await loadArchive(blob);
		expect(new Uint8Array(await zip.file('photo.png')!.async('uint8array'))).toEqual(IMAGE);
		expect(
			Object.keys(zip.files).filter((path) => path.startsWith('assets/') && !zip.files[path]!.dir)
		).toEqual([]);
	});

	it('rejects a binary document without data', async () => {
		await expect(
			buildProjectZip('Project', [{ relativePath: 'photo.png', content: '', kind: 'image' }], [])
		).rejects.toThrow(/no data/i);
	});

	it('rejects a binary document whose payload contradicts its kind', async () => {
		await expect(
			buildProjectZip(
				'Project',
				[
					{
						relativePath: 'manual.pdf',
						content: '',
						kind: 'pdf',
						mime: 'application/pdf',
						data: IMAGE_URL
					}
				],
				[]
			)
		).rejects.toThrow(/incompatible type/i);
	});

	it('rejects malformed base64 before creating an archive entry', async () => {
		await expect(
			buildProjectZip(
				'Project',
				[
					{
						relativePath: 'photo.png',
						content: '',
						kind: 'image',
						mime: 'image/png',
						data: 'data:image/png;base64,AA=A'
					}
				],
				[]
			)
		).rejects.toThrow(/not valid base64/i);
	});
});

describe('portable project ZIP media', () => {
	it('decodes one shared inline image once and keeps exact bytes', async () => {
		const source = `# Document\n\n![Pixel](${IMAGE_URL})\n`;
		const blob = await buildProjectZip(
			'Project',
			[
				{ relativePath: 'a.md', content: source },
				{ relativePath: 'b.md', content: source }
			],
			[]
		);
		const zip = await loadArchive(blob);
		const assets = Object.keys(zip.files).filter(
			(path) => path.startsWith('assets/') && !zip.files[path]!.dir
		);
		expect(assets).toHaveLength(1);
		expect(new Uint8Array(await zip.file(assets[0]!)!.async('uint8array'))).toEqual(IMAGE);
		const portable = `# Document\n\n![Pixel](${assets[0]})\n`;
		expect(await zip.file('a.md')!.async('string')).toBe(portable);
		expect(await zip.file('b.md')!.async('string')).toBe(portable);
	});
});
