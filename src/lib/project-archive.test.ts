import { describe, expect, it, vi } from 'vitest';
import { buildProjectZip, readProjectFolder, readProjectZip } from './project-archive';

const IMAGE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_URL = `data:image/png;base64,${Buffer.from(IMAGE).toString('base64')}`;
const MANIFEST_LIMIT = 1024 * 1024;

function withArrayBuffer(file: File): File {
	if (typeof file.arrayBuffer === 'function') return file;
	Object.defineProperty(file, 'arrayBuffer', {
		configurable: true,
		value: () =>
			new Promise<ArrayBuffer>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result as ArrayBuffer);
				reader.onerror = () => reject(reader.error);
				reader.readAsArrayBuffer(file);
			})
	});
	return file;
}

function folderFile(relative: string, content: string | Uint8Array<ArrayBuffer>): File {
	const file = withArrayBuffer(new File([content], relative.split('/').pop()!));
	Object.defineProperty(file, 'webkitRelativePath', { value: relative });
	return file;
}

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

describe('folder manifest size limit', () => {
	it('rejects an oversized manifest without reading its bytes', async () => {
		const manifest = folderFile('workspace/.mdsh/project.json', '');
		Object.defineProperty(manifest, 'size', { value: MANIFEST_LIMIT + 1 });
		const read = vi.fn(() => Promise.reject(new Error('the manifest was read')));
		Object.defineProperty(manifest, 'arrayBuffer', { value: read });

		await expect(
			readProjectFolder([folderFile('workspace/README.md', '# Doc'), manifest])
		).rejects.toThrow(/manifest size/i);
		expect(read).not.toHaveBeenCalled();
	});

	it('accepts a manifest exactly at the limit', async () => {
		const base = JSON.stringify({ format: 'mdsh-project', schemaVersion: 1, name: 'Padded' });
		const text = base + ' '.repeat(MANIFEST_LIMIT - base.length);
		const input = await readProjectFolder([
			folderFile('workspace/README.md', '# Doc'),
			folderFile('workspace/.mdsh/project.json', text)
		]);
		expect(input.name).toBe('Padded');
		expect(input.documents).toHaveLength(1);
	});

	it('rejects malformed manifest bytes before import', async () => {
		await expect(
			readProjectFolder([
				folderFile('workspace/README.md', '# Doc'),
				folderFile('workspace/.mdsh/project.json', new Uint8Array([0xff, 0xfe, 0x00]))
			])
		).rejects.toThrow();
		await expect(
			readProjectFolder([
				folderFile('workspace/README.md', '# Doc'),
				folderFile('workspace/.mdsh/project.json', '{"format":')
			])
		).rejects.toThrow(/Invalid project manifest/i);
	});

	it('applies the same manifest limit to a ZIP archive', async () => {
		const { default: JSZip } = await import('jszip');
		const zip = new JSZip();
		zip.file('README.md', '# Doc');
		zip.file('.mdsh/project.json', ' '.repeat(MANIFEST_LIMIT + 1));
		const bytes = await zip.generateAsync({ type: 'uint8array' });
		await expect(
			readProjectZip(withArrayBuffer(new File([bytes as Uint8Array<ArrayBuffer>], 'oversized.zip')))
		).rejects.toThrow(/Expanded archive limit/i);
	});
});

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
