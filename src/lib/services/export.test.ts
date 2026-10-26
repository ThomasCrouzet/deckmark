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
});

describe('sanitizeFilename', () => {
	it('replaces disallowed characters with underscores', () => {
		expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j.md')).toBe('a_b_c_d_e_f_g_h_i_j.md');
	});

	it('neutralizes control characters', () => {
		expect(sanitizeFilename('a\x00b\x1fc.md')).toBe('a_b_c.md');
	});
});
