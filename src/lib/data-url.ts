// Asynchronous data-URL decoding for binary documents.
//
// A large PDF must not freeze the UI with one synchronous atob pass. The
// browser fetch path decodes natively; the fallback yields between chunks so
// input and paint still run while the bytes are prepared.

const CHUNK_CHARS = 256 * 1024;

function yieldToMainThread(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
		else setTimeout(resolve, 0);
	});
}

function dataUrlMime(data: string): string {
	const comma = data.indexOf(',');
	const header = comma < 0 ? data : data.slice(0, comma);
	return /^data:([^;,]+)/.exec(header)?.[1] ?? 'application/octet-stream';
}

async function decodeInChunks(data: string): Promise<Blob> {
	const comma = data.indexOf(',');
	if (comma < 0) return new Blob([]);
	const header = data.slice(0, comma);
	const mime = dataUrlMime(data);
	const payload = data.slice(comma + 1);
	if (/;base64/i.test(header)) {
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		const aligned = CHUNK_CHARS - (CHUNK_CHARS % 4);
		for (let offset = 0; offset < payload.length; offset += aligned) {
			const binary = atob(payload.slice(offset, offset + aligned));
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
			chunks.push(bytes);
			if (offset + aligned < payload.length) await yieldToMainThread();
		}
		return new Blob(chunks, { type: mime });
	}
	return new Blob([decodeURIComponent(payload)], { type: mime });
}

/** Returns the exact bytes of a data URL without one synchronous full decode. */
export async function dataUrlToBlob(data: string): Promise<Blob> {
	if (!data.startsWith('data:')) return new Blob([]);
	if (typeof fetch === 'function') {
		try {
			const response = await fetch(data);
			if (response.ok) return await response.blob();
		} catch {
			/* Fall back to the bounded chunk decoder. */
		}
	}
	return decodeInChunks(data);
}
