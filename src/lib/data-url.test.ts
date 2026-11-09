import { describe, expect, it } from 'vitest';
import { BinaryDataError, dataUrlToBlob, decodeBinaryDataUrl } from './data-url';

async function readBlob(blob: Blob): Promise<ArrayBuffer> {
	if (typeof FileReader === 'function') {
		try {
			return await new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result as ArrayBuffer);
				reader.onerror = () => reject(reader.error);
				reader.readAsArrayBuffer(blob);
			});
		} catch {
			/* A cross-realm Blob is not readable by jsdom's FileReader. */
		}
	}
	if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
	return new Response(blob).arrayBuffer();
}

describe('data URL decoding', () => {
	it('returns the exact base64 bytes and MIME type', async () => {
		const blob = await dataUrlToBlob('data:application/pdf;base64,JVBERi0xLjQ=');
		expect(blob.type).toBe('application/pdf');
		expect([...new Uint8Array(await readBlob(blob))]).toEqual([
			0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34
		]);
	});

	it('decodes a plain percent-encoded data URL', async () => {
		const blob = await dataUrlToBlob('data:text/plain,hello%20world');
		expect(new TextDecoder().decode(await readBlob(blob))).toBe('hello world');
	});
});

describe('validated binary data URL decoding', () => {
	const png = 'data:image/png;base64,iVBORw0KGgo=';

	it('returns exact bytes and declared MIME for a valid image', async () => {
		const blob = await decodeBinaryDataUrl(png, {
			expectedKind: 'image',
			expectedMime: 'image/png',
			maxBytes: 1024
		});
		expect(blob.type).toBe('image/png');
		expect(blob.size).toBe(8);
		expect([...new Uint8Array(await readBlob(blob))]).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
		]);
	});

	it.each([
		['missing', undefined],
		['empty', ''],
		['not a data URL', 'iVBORw0KGgo='],
		['no comma', 'data:image/png;base64'],
		['no payload', 'data:image/png;base64,'],
		['invalid base64', 'data:image/png;base64,AA=A'],
		['unpadded base64', 'data:image/png;base64,AAA'],
		['not base64', 'data:image/png,plain']
	])('rejects %s', async (_name, value) => {
		await expect(decodeBinaryDataUrl(value, { expectedKind: 'image' })).rejects.toBeInstanceOf(
			BinaryDataError
		);
	});

	it('rejects a MIME that contradicts the document kind or declared type', async () => {
		await expect(
			decodeBinaryDataUrl('data:application/pdf;base64,JVBERi0=', { expectedKind: 'image' })
		).rejects.toBeInstanceOf(BinaryDataError);
		await expect(decodeBinaryDataUrl(png, { expectedMime: 'image/jpeg' })).rejects.toBeInstanceOf(
			BinaryDataError
		);
		await expect(
			decodeBinaryDataUrl('data:text/plain;base64,aGVsbG8=', { expectedKind: 'pdf' })
		).rejects.toBeInstanceOf(BinaryDataError);
	});

	it('rejects a payload over the byte budget before reporting success', async () => {
		await expect(
			decodeBinaryDataUrl(`data:image/png;base64,${'A'.repeat(1024)}`, {
				expectedKind: 'image',
				maxBytes: 16
			})
		).rejects.toBeInstanceOf(BinaryDataError);
	});

	it('keeps a legitimate zero-byte text data URL working for display', async () => {
		const blob = await dataUrlToBlob('data:text/plain,');
		expect(blob.size).toBe(0);
	});
});
