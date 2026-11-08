import { describe, expect, it } from 'vitest';
import { dataUrlToBlob } from './data-url';

function readBlob(blob: Blob): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as ArrayBuffer);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(blob);
	});
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
