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
