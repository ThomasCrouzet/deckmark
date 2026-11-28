import { describe, expect, it, vi } from 'vitest';
import { IMPORT_LIMITS } from './config';
import {
	ImportReadError,
	ImportSession,
	readUtf8File,
	validateMarkdownContent
} from './import-limits';

function input(bytes: number[], size = bytes.length): File {
	return {
		name: 'note.md',
		size,
		arrayBuffer: vi.fn(async () => new Uint8Array(bytes).buffer)
	} as unknown as File;
}

describe('import limits and decoding', () => {
	it('rejects an excessive total before a read and keeps the used budget', async () => {
		const session = new ImportSession();
		for (let i = 0; i < 4; i++) session.reserve(IMPORT_LIMITS.maxFileBytes);
		const file = input([65]);
		expect(await session.read(file)).toBeNull();
		expect(file.arrayBuffer).not.toHaveBeenCalled();
		expect(session.report.bytes).toBe(IMPORT_LIMITS.maxBatchBytes);
		expect(session.report.issues[0]?.reason).toBe('batch-size');
	});
	it('limits reads to 300 when accepted files are invalid', () => {
		const session = new ImportSession();
		for (let i = 0; i < 300; i++) session.reserve(0);
		expect(() => session.reserve(0)).toThrowError(new ImportReadError('file-count'));
	});
	it.each([NaN, -1, 0.5, Infinity])('rejects invalid size %s', (size) => {
		expect(() => new ImportSession().reserve(size)).toThrowError(new ImportReadError('file-size'));
	});
	it('rejects invalid UTF-8 without character replacement', async () => {
		const session = new ImportSession();
		expect(await session.read(input([0xc3, 0x28]))).toBeNull();
		expect(session.report.issues[0]?.reason).toBe('encoding');
	});
	it('rejects a NUL character as binary data', () => {
		expect(() => validateMarkdownContent('titre\u0000')).toThrowError(
			new ImportReadError('binary')
		);
	});
	it.each([1, 8, 11, 12, 27, 31])('accepts the ordinary control character %s', (code) => {
		expect(() => validateMarkdownContent(`titre${String.fromCharCode(code)}`)).not.toThrow();
	});
	it('rejects a size that changes during the read', async () => {
		const session = new ImportSession();
		expect(await session.read(input([65], 2))).toBeNull();
		expect(session.report.issues[0]?.reason).toBe('read');
	});
	it('reports a read error and lets the batch continue', async () => {
		const session = new ImportSession();
		const file = input([65]);
		vi.mocked(file.arrayBuffer).mockRejectedValue(new Error('permission'));
		expect(await session.read(file)).toBeNull();
		expect(await session.read(input([66]))).toBe('B');
		expect(session.report.failed).toBe(1);
	});
	it('ignores a result after cancellation without counting a failure', async () => {
		const controller = new AbortController();
		const session = new ImportSession({ signal: controller.signal });
		const file = input([65]);
		vi.mocked(file.arrayBuffer).mockImplementation(async () => {
			controller.abort();
			return new Uint8Array([65]).buffer;
		});
		expect(await session.read(file)).toBeNull();
		expect(await session.pause()).toBe(false);
		expect(await session.read(input([66]))).toBeNull();
		expect(session.report).toMatchObject({ cancelled: true, failed: 0 });
	});
	it('rejects a canceled direct read before it reads bytes', async () => {
		const controller = new AbortController();
		controller.abort();
		const file = input([65]);
		await expect(
			readUtf8File(file, IMPORT_LIMITS.maxFileBytes, controller.signal)
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(file.arrayBuffer).not.toHaveBeenCalled();
	});
	it('cancels a rejected read and returns independent snapshots', async () => {
		const controller = new AbortController();
		const onProgress = vi.fn();
		const session = new ImportSession({ signal: controller.signal, onProgress });
		const first = session.publish();
		session.skip();
		session.accept();
		session.fail('x', 'read');
		expect(first).toMatchObject({ processed: 0, issues: [] });
		const file = input([65]);
		vi.mocked(file.arrayBuffer).mockImplementation(async () => {
			controller.abort();
			throw new Error('aborted');
		});
		expect(await session.read(file)).toBeNull();
		expect(session.report.failed).toBe(1);
		expect(onProgress).toHaveBeenCalledTimes(4);
	});
});

describe('FileReader compatibility path', () => {
	function legacyFile(): File {
		return { name: 'legacy.md', size: 1 } as File;
	}
	it('classifies a FileReader error as a read error', async () => {
		class Reader {
			result = null;
			error = new Error('disk');
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			onabort: (() => void) | null = null;
			readAsArrayBuffer() {
				this.onerror?.();
			}
			abort() {
				this.onabort?.();
			}
		}
		vi.stubGlobal('FileReader', Reader);
		try {
			const session = new ImportSession();
			expect(await session.read(legacyFile())).toBeNull();
			expect(session.report.issues[0]?.reason).toBe('read');
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it('stops FileReader through AbortSignal and removes the listener', async () => {
		const abort = vi.fn();
		class Reader {
			result = null;
			error = null;
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			onabort: (() => void) | null = null;
			readAsArrayBuffer() {}
			abort() {
				abort();
				this.onabort?.();
			}
		}
		vi.stubGlobal('FileReader', Reader);
		const controller = new AbortController();
		try {
			const session = new ImportSession({ signal: controller.signal });
			const reading = session.read(legacyFile());
			controller.abort();
			expect(await reading).toBeNull();
			expect(abort).toHaveBeenCalledOnce();
			expect(session.report.cancelled).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it('captures a synchronous FileReader startup exception', async () => {
		class Reader {
			result = null;
			error = null;
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			onabort: (() => void) | null = null;
			readAsArrayBuffer() {
				throw new Error('unsupported');
			}
			abort() {
				this.onabort?.();
			}
		}
		vi.stubGlobal('FileReader', Reader);
		try {
			const session = new ImportSession();
			expect(await session.read(legacyFile())).toBeNull();
			expect(session.report.issues[0]?.reason).toBe('read');
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it('ignores a failed progress callback without canceling data', () => {
		const session = new ImportSession({
			onProgress: () => {
				throw new Error('UI detached');
			}
		});
		expect(() => session.accept()).not.toThrow();
		expect(session.report.imported).toBe(1);
	});
});
