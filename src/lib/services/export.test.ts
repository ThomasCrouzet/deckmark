import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { FileItem } from '#lib/types.js';

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

import { exportMarkdown, exportZip, sanitizeFilename } from './export';

function makeFile(overrides: Partial<FileItem> = {}): FileItem {
	return {
		id: 'test-id',
		name: 'note.md',
		content: '# Hello\n\nMonde.',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		dirty: false,
		...overrides
	};
}

describe('exportMarkdown - desktop cancel', () => {
	beforeEach(() => {
		desktopMocks.isDesktop.mockReturnValue(true);
		desktopMocks.tauriSaveExportBlob.mockReset();
	});

	afterEach(() => {
		desktopMocks.isDesktop.mockReturnValue(false);
	});

	it('returns false after save dialog cancellation without a Blob download', async () => {
		desktopMocks.tauriSaveExportBlob.mockResolvedValue(false);
		const createObjectURLSpy = vi.fn(() => 'blob:should-not');
		Object.defineProperty(URL, 'createObjectURL', {
			value: createObjectURLSpy,
			writable: true,
			configurable: true
		});
		const ok = await exportMarkdown(makeFile({ name: 'x.md', content: '# hi' }));
		expect(ok).toBe(false);
		expect(desktopMocks.tauriSaveExportBlob).toHaveBeenCalledOnce();
		expect(createObjectURLSpy).not.toHaveBeenCalled();
	});
});

describe('binary document export validation', () => {
	const png = 'data:image/png;base64,iVBORw0KGgo=';
	const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

	beforeEach(() => {
		desktopMocks.isDesktop.mockReturnValue(true);
		desktopMocks.tauriSaveExportBlob.mockReset();
	});

	afterEach(() => {
		desktopMocks.isDesktop.mockReturnValue(false);
	});

	it('rejects a missing payload without opening the native save dialog', async () => {
		await expect(
			exportMarkdown(makeFile({ name: 'photo.png', content: '', kind: 'image', mime: 'image/png' }))
		).rejects.toThrow(/no data/i);
		expect(desktopMocks.tauriSaveExportBlob).not.toHaveBeenCalled();
	});

	it('rejects a malformed payload and a contradictory MIME', async () => {
		await expect(
			exportMarkdown(
				makeFile({
					name: 'photo.png',
					content: '',
					kind: 'image',
					mime: 'image/png',
					data: 'data:image/png;base64'
				})
			)
		).rejects.toThrow(/no payload/i);
		await expect(
			exportMarkdown(
				makeFile({
					name: 'manual.pdf',
					content: '',
					kind: 'pdf',
					mime: 'application/pdf',
					data: png
				})
			)
		).rejects.toThrow(/incompatible type/i);
		expect(desktopMocks.tauriSaveExportBlob).not.toHaveBeenCalled();
	});

	it('exports the exact bytes of a valid image', async () => {
		const saved: Blob[] = [];
		desktopMocks.tauriSaveExportBlob.mockImplementation(async (blob: Blob) => {
			saved.push(blob);
			return true;
		});
		expect(
			await exportMarkdown(
				makeFile({ name: 'photo.png', content: '', kind: 'image', mime: 'image/png', data: png })
			)
		).toBe(true);
		expect(saved).toHaveLength(1);
		expect(saved[0]!.type).toBe('image/png');
		expect(saved[0]!.size).toBe(bytes.length);
	});
});

async function readBlob(blob: Blob): Promise<ArrayBuffer> {
	if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as ArrayBuffer);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(blob);
	});
}

describe('exportZip', () => {
	let clickSpy: Mock<() => void>;
	let restoreCreateElement: () => void = () => {};
	let createObjectURLSpy: ReturnType<typeof vi.fn>;
	let revokeObjectURLSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		clickSpy = vi.fn();
		const realCreate = document.createElement.bind(document);
		const mocked = (tag: string) => {
			if (tag.toLowerCase() === 'a') {
				const a = realCreate('a') as HTMLAnchorElement;
				a.click = clickSpy;
				return a;
			}
			return realCreate(tag);
		};
		document.createElement = mocked as typeof document.createElement;
		restoreCreateElement = () => {
			document.createElement = realCreate as typeof document.createElement;
		};
		createObjectURLSpy = vi.fn(() => 'blob:zip-mocked');
		revokeObjectURLSpy = vi.fn();
		Object.defineProperty(URL, 'createObjectURL', {
			value: createObjectURLSpy,
			writable: true,
			configurable: true
		});
		Object.defineProperty(URL, 'revokeObjectURL', {
			value: revokeObjectURLSpy,
			writable: true,
			configurable: true
		});
	});

	afterEach(() => {
		restoreCreateElement();
	});

	// Prevent silent overwrite when multiple active files use "Sans titre.md".
	// JSZip replaces the previous entry when names are identical.
	//
	// JSZip.file has read and write overloads. Use `unknown` in this test mock.
	// This follows the TypeScript double-cast pattern for test mocks.
	it('resolves duplicate file names', async () => {
		const filesAdded: string[] = [];
		const originalImport = await import('jszip');
		const JSZip = originalImport.default;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const proto = JSZip.prototype as any;
		const realFile = proto.file;
		proto.file = function (this: unknown, name: string, data: unknown) {
			filesAdded.push(name);
			return realFile.call(this, name, data);
		};

		try {
			const files = [
				makeFile({ id: '1', name: 'Sans titre.md', content: '# A' }),
				makeFile({ id: '2', name: 'Sans titre.md', content: '# B' }),
				makeFile({ id: '3', name: 'Sans titre.md', content: '# C' })
			];
			await exportZip(files);
			// The ZIP must contain three separate entries.
			expect(filesAdded).toEqual(['Sans titre.md', 'Sans titre-2.md', 'Sans titre-3.md']);
		} finally {
			proto.file = realFile;
		}
	});

	it('deduplicates names without extensions', async () => {
		const filesAdded: string[] = [];
		const originalImport = await import('jszip');
		const JSZip = originalImport.default;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const proto = JSZip.prototype as any;
		const realFile = proto.file;
		proto.file = function (this: unknown, name: string, data: unknown) {
			filesAdded.push(name);
			return realFile.call(this, name, data);
		};

		try {
			const files = [
				makeFile({ id: '1', name: 'README', content: '# A' }),
				makeFile({ id: '2', name: 'README', content: '# B' })
			];
			await exportZip(files);
			// Add the suffix at the end when no extension exists.
			expect(filesAdded).toEqual(['README', 'README-2']);
		} finally {
			proto.file = realFile;
		}
	});

	it('sanitizes disallowed names before ZIP insertion', async () => {
		const filesAdded: string[] = [];
		const originalImport = await import('jszip');
		const JSZip = originalImport.default;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const proto = JSZip.prototype as any;
		const realFile = proto.file;
		proto.file = function (this: unknown, name: string, data: unknown) {
			filesAdded.push(name);
			return realFile.call(this, name, data);
		};

		try {
			const files = [makeFile({ id: '1', name: 'a/b:c?.md', content: '# X' })];
			await exportZip(files);
			// No slash can remain because it would create a directory in the ZIP file.
			expect(filesAdded[0]).not.toContain('/');
			expect(filesAdded[0]).toBe('a_b_c_.md');
		} finally {
			proto.file = realFile;
		}
	});

	it('rejects a ZIP containing a binary document without data', async () => {
		await expect(
			exportZip([
				makeFile({ id: 'txt', name: 'note.md', content: '# ok' }),
				makeFile({ id: 'bin', name: 'photo.png', content: '', kind: 'image', mime: 'image/png' })
			])
		).rejects.toThrow(/no data/i);
		expect(clickSpy).not.toHaveBeenCalled();
	});

	it('writes exact binary bytes into the library ZIP', async () => {
		const written: Blob[] = [];
		createObjectURLSpy.mockImplementation((blob: Blob) => {
			written.push(blob);
			return 'blob:zip-mocked';
		});
		expect(
			await exportZip([
				makeFile({
					id: 'bin',
					name: 'photo.png',
					content: '',
					kind: 'image',
					mime: 'image/png',
					data: 'data:image/png;base64,iVBORw0KGgo='
				})
			])
		).toBe(true);
		const { default: JSZip } = await import('jszip');
		const zip = await JSZip.loadAsync(await readBlob(written[0]!));
		expect(new Uint8Array(await zip.file('photo.png')!.async('uint8array'))).toEqual(
			Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		);
	});
});

describe('sanitizeFilename', () => {
	it('replaces disallowed characters with underscores', () => {
		expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j.md')).toBe('a_b_c_d_e_f_g_h_i_j.md');
	});

	it('neutralizes control characters', () => {
		expect(sanitizeFilename('a\x00b\x1fc.md')).toBe('a_b_c.md');
	});
});
