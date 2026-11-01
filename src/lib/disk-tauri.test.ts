import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createTauriDiskIo,
	setTauriDiskIoForTests,
	tauriCheckPath,
	tauriOpenNativeGrants,
	tauriPickAndOpen,
	tauriPickSaveTarget,
	tauriReadMeta,
	tauriSaveExportBlob,
	tauriWritePath,
	tauriRenamePath,
	tauriForgetPath,
	type DiskFileMeta,
	type NativeDiskGrant,
	type TauriDiskIo
} from './disk-tauri';

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriMocks.invoke }));

const meta = (revision = 'sha256:one'): DiskFileMeta => ({
	lastModified: 100,
	size: 3,
	revision
});

const grant = (path: string, token = `token:${path}`): NativeDiskGrant => ({
	token,
	path,
	stat: meta()
});

function mockIo(overrides: Partial<TauriDiskIo> = {}): TauriDiskIo {
	return {
		restoreGrants: vi.fn(async () => []),
		forgetGrant: vi.fn(async () => {}),
		renameFile: vi.fn(async () => grant('/tmp/renamed.md')),
		openGrants: vi.fn(async () => []),
		openDirectoryGrants: vi.fn(async () => []),
		saveGrant: vi.fn(async () => null),
		saveExportGrant: vi.fn(async () => null),
		readFile: vi.fn(async () => ({ content: '', stat: meta() })),
		writeText: vi.fn(async () => meta('sha256:written')),
		writeBytes: vi.fn(async () => meta('sha256:written')),
		stat: vi.fn(async () => null),
		...overrides
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	tauriMocks.invoke.mockResolvedValue(null);
	setTauriDiskIoForTests(null);
});

afterEach(() => setTauriDiskIoForTests(null));

describe('native capability helpers', () => {
	it('keeps the UTF-8 bytes from a Markdown export in the saved file', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'deckmark-native-source-'));
		const path = join(directory, 'source.md');
		const source = '\uFEFF# Café\r\n\r\nKeep this sentence.\r\n';
		try {
			setTauriDiskIoForTests(
				mockIo({
					saveExportGrant: async () => ({ token: 'export-source', path, stat: null }),
					writeText: async (_token, content) => {
						await writeFile(path, content, 'utf8');
						return meta('sha256:saved-source');
					}
				})
			);
			await expect(
				tauriSaveExportBlob(new Blob([source], { type: 'text/markdown' }), 'source.md')
			).resolves.toBe(true);
			expect(await readFile(path)).toEqual(Buffer.from(source, 'utf8'));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('restores only native approved paths and shares one restoration request', async () => {
		const io = mockIo({ restoreGrants: vi.fn(async () => [grant('/tmp/approved.md', 'renewed')]) });
		setTauriDiskIoForTests(io);
		await Promise.all([
			tauriWritePath('/tmp/approved.md', 'saved', 'sha256:one'),
			tauriReadMeta('/tmp/approved.md')
		]);
		expect(io.restoreGrants).toHaveBeenCalledOnce();
		expect(io.writeText).toHaveBeenCalledWith('renewed', 'saved', 'sha256:one', false);
		await expect(tauriWritePath('/tmp/forged.md', 'bad', null)).rejects.toThrow(
			'capability expired'
		);
		expect(io.writeText).toHaveBeenCalledOnce();
	});

	it('allows a restoration retry after a native storage failure', async () => {
		const io = mockIo({
			restoreGrants: vi
				.fn()
				.mockRejectedValueOnce(new Error('registry unavailable'))
				.mockResolvedValue([grant('/tmp/approved.md')])
		});
		setTauriDiskIoForTests(io);
		await expect(tauriReadMeta('/tmp/approved.md')).rejects.toThrow('registry unavailable');
		await expect(tauriReadMeta('/tmp/approved.md')).resolves.toBeNull();
		expect(io.restoreGrants).toHaveBeenCalledTimes(2);
	});

	it('moves the in-memory grant to the renamed path and revokes it on unlink', async () => {
		const io = mockIo({
			restoreGrants: vi.fn(async () => [grant('/tmp/old.md', 'approved')]),
			renameFile: vi.fn(async () => grant('/tmp/new.md', 'approved'))
		});
		setTauriDiskIoForTests(io);
		await tauriRenamePath('/tmp/old.md', 'new.md', 'sha256:one');
		expect(io.renameFile).toHaveBeenCalledWith('approved', 'new.md', 'sha256:one');
		await tauriWritePath('/tmp/new.md', 'edited', 'sha256:one');
		await expect(tauriReadMeta('/tmp/old.md')).rejects.toThrow('capability expired');
		await tauriForgetPath('/tmp/new.md');
		expect(io.forgetGrant).toHaveBeenCalledWith('approved');
		await expect(tauriReadMeta('/tmp/new.md')).rejects.toThrow('capability expired');
		await tauriForgetPath('/tmp/unknown.md');
		expect(io.forgetGrant).toHaveBeenCalledOnce();
	});

	it('reports registry failures during unlink', async () => {
		setTauriDiskIoForTests(
			mockIo({ restoreGrants: vi.fn().mockRejectedValue(new Error('registry unavailable')) })
		);
		await expect(tauriForgetPath('/tmp/approved.md')).rejects.toThrow('registry unavailable');
	});
	it('accepts argv and OS-open capabilities without accepting bare paths', async () => {
		const io = mockIo({
			readFile: vi.fn(async () => ({ content: 'body', stat: meta() }))
		});
		setTauriDiskIoForTests(io);
		const result = await tauriOpenNativeGrants([
			grant('/tmp/note.md', 'native-token'),
			grant('/tmp/ignored.pdf', 'ignored-token')
		]);
		expect(result.files).toHaveLength(1);
		expect(io.readFile).toHaveBeenCalledWith('native-token');
		expect(io.readFile).not.toHaveBeenCalledWith('ignored-token');
	});

	it('registers a save-dialog grant and writes with revision preconditions', async () => {
		const writeText = vi.fn(async () => meta('sha256:after'));
		const io = mockIo({
			saveGrant: vi.fn(async () => grant('/tmp/out.md', 'save-token')),
			writeText
		});
		setTauriDiskIoForTests(io);
		expect(await tauriPickSaveTarget('out.md')).toEqual({ kind: 'path', path: '/tmp/out.md' });
		const written = await tauriWritePath('/tmp/out.md', 'body', 'sha256:one');
		expect(written.revision).toBe('sha256:after');
		expect(writeText).toHaveBeenCalledWith('save-token', 'body', 'sha256:one', false);
	});

	it('returns permission-needed for an expired grant and broken for a missing file', async () => {
		const io = mockIo({
			saveGrant: vi.fn(async () => grant('/tmp/missing.md', 'missing-token')),
			stat: vi.fn(async () => null)
		});
		setTauriDiskIoForTests(io);
		await tauriPickSaveTarget('missing.md');
		expect(await tauriCheckPath('/tmp/missing.md')).toBe('broken');
		expect(await tauriCheckPath('/tmp/never-granted.md')).toBe('permission-needed');
	});

	it('counts selected files that disappear or cannot be read', async () => {
		const io = mockIo({
			readFile: vi
				.fn()
				.mockRejectedValueOnce(new Error('missing'))
				.mockRejectedValueOnce(new Error('blocked'))
		});
		setTauriDiskIoForTests(io);
		const result = await tauriOpenNativeGrants([
			{ token: 'missing', path: '/tmp/missing.md', stat: null },
			{ token: 'blocked', path: '/tmp/blocked.md', stat: meta() }
		]);
		expect(result).toMatchObject({ files: [], failed: 2 });
	});
});

describe('desktop export', () => {
	it('writes text and binary exports through the token returned by the save dialog', async () => {
		const writeText = vi.fn(async () => meta('sha256:html'));
		const writeBytes = vi.fn(async () => meta('sha256:zip'));
		const io = mockIo({
			saveExportGrant: vi
				.fn()
				.mockResolvedValueOnce(grant('/tmp/out.html', 'html-token'))
				.mockResolvedValueOnce(grant('/tmp/out.zip', 'zip-token')),
			writeText,
			writeBytes
		});
		setTauriDiskIoForTests(io);
		expect(await tauriSaveExportBlob(new Blob(['<p>x</p>']), 'out.html')).toBe(true);
		expect(writeText).toHaveBeenCalledWith('html-token', '<p>x</p>', 'sha256:one', false);
		expect(await tauriSaveExportBlob(new Blob(['PK\u0003\u0004']), 'out.zip')).toBe(true);
		expect(writeBytes).toHaveBeenCalledWith(
			'zip-token',
			expect.any(Uint8Array),
			'sha256:one',
			false
		);
	});

	it('returns false when the native save dialog is cancelled', async () => {
		setTauriDiskIoForTests(mockIo());
		expect(await tauriSaveExportBlob(new Blob(['x']), 'out.html')).toBe(false);
	});
});

describe('production adapter', () => {
	it('uses only native dialog commands and token-based disk commands', async () => {
		tauriMocks.invoke.mockImplementation(async (command: string) => {
			if (command === 'disk_restore_grants') return [grant('/tmp/restored.md', 'restored-token')];
			if (command === 'disk_rename') return grant('/tmp/renamed.md', 'open-token');
			if (command === 'disk_open_dialog') return [grant('/tmp/a.md', 'open-token')];
			if (command === 'disk_open_directory') return [grant('/tmp/folder/a.md', 'folder-token')];
			if (command === 'disk_save_dialog') return grant('/tmp/out.md', 'save-token');
			if (command === 'disk_read') {
				return {
					content: '# Native',
					stat: { mtimeMs: 100, size: 8, revision: 'sha256:one' }
				};
			}
			if (command === 'disk_stat') return { mtimeMs: 100, size: 3, revision: 'sha256:one' };
			if (command === 'disk_write' || command === 'disk_write_bytes') {
				return { mtimeMs: 101, size: 4, revision: 'sha256:two' };
			}
			return null;
		});
		const adapter = await createTauriDiskIo();
		expect((await adapter.restoreGrants())[0]?.token).toBe('restored-token');
		expect((await adapter.renameFile('open-token', 'renamed.md', 'sha256:one')).path).toBe(
			'/tmp/renamed.md'
		);
		await adapter.forgetGrant('open-token');
		expect(tauriMocks.invoke).toHaveBeenCalledWith('disk_forget_grant', { token: 'open-token' });
		expect((await adapter.openGrants(true))[0]?.token).toBe('open-token');
		expect((await adapter.openDirectoryGrants())[0]?.token).toBe('folder-token');
		expect((await adapter.saveGrant('out.md'))?.token).toBe('save-token');
		expect((await adapter.saveExportGrant('out.zip'))?.token).toBe('save-token');
		expect(await adapter.readFile('open-token')).toEqual({
			content: '# Native',
			stat: { lastModified: 100, size: 8, revision: 'sha256:one' }
		});
		expect((await adapter.stat('open-token'))?.revision).toBe('sha256:one');
		await adapter.writeText('save-token', 'body', 'sha256:one', false);
		await adapter.writeBytes('save-token', new Uint8Array([1]), 'sha256:two', true);
		expect(tauriMocks.invoke).toHaveBeenCalledWith('disk_open_dialog', { multiple: true });
		expect(tauriMocks.invoke).toHaveBeenCalledWith(
			'disk_save_dialog',
			expect.objectContaining({ suggestedName: 'out.md', export: false })
		);
		expect(tauriMocks.invoke).not.toHaveBeenCalledWith('disk_grant', expect.anything());
	});
});

describe('native limits before reads', () => {
	it('rejects an oversized file and batch before readFile', async () => {
		const grants = Array.from({ length: 6 }, (_, index) => ({
			...grant(`/tmp/${index}.md`),
			stat: { ...meta(), size: index === 0 ? 16 * 1024 * 1024 + 1 : 16 * 1024 * 1024 }
		}));
		const io = mockIo({
			readFile: vi.fn(async () => ({ content: 'x', stat: { ...meta(), size: 16 * 1024 * 1024 } }))
		});
		setTauriDiskIoForTests(io);
		const result = await tauriOpenNativeGrants(grants);
		expect(io.readFile).toHaveBeenCalledTimes(4);
		expect(result.failed).toBe(2);
		expect(result.report?.issues.map((issue) => issue.reason)).toEqual(['file-size', 'batch-size']);
	});
	it('checks a grant without metadata and rejects missing files', async () => {
		const io = mockIo();
		setTauriDiskIoForTests(io);
		const result = await tauriOpenNativeGrants([{ ...grant('/tmp/missing.md'), stat: null }]);
		expect(result.failed).toBe(1);
		expect(io.stat).toHaveBeenCalled();
		expect(io.readFile).not.toHaveBeenCalled();
	});
	it('rejects growth and binary content between stat and read', async () => {
		const io = mockIo({
			readFile: vi
				.fn()
				.mockResolvedValueOnce({ content: 'x', stat: { ...meta(), size: 17 * 1024 * 1024 } })
				.mockResolvedValueOnce({ content: '\0', stat: meta() })
		});
		setTauriDiskIoForTests(io);
		const result = await tauriOpenNativeGrants([grant('/tmp/growing.md'), grant('/tmp/binary.md')]);
		expect(result.failed).toBe(2);
		expect(result.files).toEqual([]);
		expect(result.report?.issues.map((issue) => issue.reason)).toEqual(['file-size', 'binary']);
	});
	it('ignores a native response after cancellation and does not read the next file', async () => {
		const controller = new AbortController();
		const io = mockIo({
			readFile: vi.fn(async () => {
				controller.abort();
				return { content: 'x', stat: meta() };
			})
		});
		setTauriDiskIoForTests(io);
		const result = await tauriOpenNativeGrants([grant('/tmp/a.md'), grant('/tmp/b.md')], {
			signal: controller.signal
		});
		expect(result.files).toEqual([]);
		expect(io.readFile).toHaveBeenCalledOnce();
		expect(result.report).toMatchObject({ cancelled: true, failed: 0 });
	});
	it('ignores a read error received after cancellation', async () => {
		const controller = new AbortController();
		const io = mockIo({
			readFile: vi.fn(async () => {
				controller.abort();
				throw new Error('cancelled read');
			})
		});
		setTauriDiskIoForTests(io);
		const result = await tauriOpenNativeGrants([grant('/tmp/a.md'), grant('/tmp/b.md')], {
			signal: controller.signal
		});
		expect(result).toMatchObject({ files: [], failed: 0, report: { cancelled: true } });
		expect(io.readFile).toHaveBeenCalledOnce();
	});
});

describe('native guard paths', () => {
	it('does not start a read when the batch is canceled', async () => {
		const controller = new AbortController();
		controller.abort();
		const io = mockIo();
		setTauriDiskIoForTests(io);
		const result = await tauriOpenNativeGrants([grant('/tmp/a.md')], { signal: controller.signal });
		expect(result).toMatchObject({ files: [], failed: 0, report: { cancelled: true } });
		expect(io.readFile).not.toHaveBeenCalled();
	});
	it('rejects growth that exceeds the 64 MiB total limit', async () => {
		const mib = 1024 * 1024;
		const grants = [15, 15, 15, 15, 4].map((size, index) => ({
			...grant(`/tmp/${index}.md`),
			stat: { ...meta(), size: size * mib }
		}));
		const readFile = vi.fn(async (token: string) => {
			const last = token.includes('/4.md');
			return { content: 'ok', stat: { ...meta(), size: (last ? 5 : 15) * mib } };
		});
		const io = mockIo({ readFile });
		setTauriDiskIoForTests(io);
		const result = await tauriOpenNativeGrants(grants);
		expect(result.files).toHaveLength(4);
		expect(result.report?.issues.at(-1)?.reason).toBe('batch-size');
		expect(readFile).toHaveBeenCalledTimes(5);
	});
	it('does not store an empty capability and maps missing native stat data', async () => {
		const io = mockIo();
		setTauriDiskIoForTests(io);
		await tauriOpenNativeGrants([{ token: '', path: '/tmp/empty.md', stat: meta() }]);
		await expect(tauriWritePath('/tmp/empty.md', 'x', null)).rejects.toThrow('expired');

		setTauriDiskIoForTests(null);
		tauriMocks.invoke.mockImplementation(async (command: string) => {
			if (command === 'disk_open_dialog')
				return [{ token: 'null-stat', path: '/tmp/null.md', stat: null }];
			if (command === 'disk_stat') return null;
			throw new Error(command);
		});
		const result = await tauriPickAndOpen();
		expect(result).toMatchObject({ files: [], failed: 1 });
	});
	it.each([null, new Error('FileReader')])(
		'propage une erreur FileReader de blob export (%s)',
		async (readerError) => {
			const io = mockIo({ saveExportGrant: vi.fn(async () => grant('/tmp/out.pdf')) });
			setTauriDiskIoForTests(io);
			class Reader {
				result = null;
				error = readerError;
				onload: (() => void) | null = null;
				onerror: (() => void) | null = null;
				readAsArrayBuffer() {
					this.onerror?.();
				}
			}
			vi.stubGlobal('FileReader', Reader);
			const blob = { arrayBuffer: undefined } as unknown as Blob;
			try {
				await expect(tauriSaveExportBlob(blob, 'out.pdf')).rejects.toThrow();
			} finally {
				vi.unstubAllGlobals();
			}
		}
	);
});
