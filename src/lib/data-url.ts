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
	// A data: fetch would violate the production `connect-src` policy. The
	// bounded chunk decoder yields between slices and keeps the CSP intact.
	return decodeInChunks(data);
}

export type BinaryDataReason =
	'missing' | 'malformed' | 'unsupported' | 'mime-mismatch' | 'too-large';

/** An exportable binary document has no valid payload. */
export class BinaryDataError extends Error {
	constructor(
		public readonly reason: BinaryDataReason,
		message: string
	) {
		super(message);
		this.name = 'BinaryDataError';
	}
}

export interface BinaryDataOptions {
	/** Required media kind, derived from the document model. */
	expectedKind?: 'image' | 'pdf' | undefined;
	/** MIME recorded by the document row. */
	expectedMime?: string | undefined;
	/** Maximum decoded byte length. */
	maxBytes?: number | undefined;
}

function validateBinaryDataUrl(
	data: string | undefined,
	options: BinaryDataOptions
): { mime: string; payload: string } {
	if (typeof data !== 'string' || data.length === 0)
		throw new BinaryDataError('missing', 'The binary document has no data.');
	if (!data.startsWith('data:'))
		throw new BinaryDataError('malformed', 'The binary document data is not a data URL.');
	const comma = data.indexOf(',');
	if (comma < 0)
		throw new BinaryDataError('malformed', 'The binary document data URL has no payload.');
	const header = data.slice(0, comma);
	const match = /^data:([^;,]+)((?:;[^;,]*)*)$/.exec(header);
	if (!match) throw new BinaryDataError('malformed', 'The binary document data URL is malformed.');
	const mime = match[1]!.toLowerCase();
	if (!/;base64$/i.test(header))
		throw new BinaryDataError(
			'unsupported',
			'The binary document data URL must use base64 encoding.'
		);
	if (options.expectedKind === 'image' && !mime.startsWith('image/'))
		throw new BinaryDataError(
			'mime-mismatch',
			`The image document declares the incompatible type ${mime}.`
		);
	if (options.expectedKind === 'pdf' && mime !== 'application/pdf')
		throw new BinaryDataError(
			'mime-mismatch',
			`The PDF document declares the incompatible type ${mime}.`
		);
	if (options.expectedMime && options.expectedMime.toLowerCase() !== mime)
		throw new BinaryDataError(
			'mime-mismatch',
			`The document type ${mime} does not match the recorded type ${options.expectedMime}.`
		);
	const payload = data.slice(comma + 1).replace(/\s/g, '');
	if (!payload)
		throw new BinaryDataError('missing', 'The binary document data URL has no payload.');
	if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload))
		throw new BinaryDataError('malformed', 'The binary document payload is not valid base64.');
	const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
	const estimated = (payload.length / 4) * 3 - padding;
	if (options.maxBytes !== undefined && estimated > options.maxBytes)
		throw new BinaryDataError('too-large', 'The binary document exceeds the export size limit.');
	return { mime, payload };
}

async function decodeBase64Payload(payload: string): Promise<Uint8Array<ArrayBuffer>> {
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	const aligned = CHUNK_CHARS - (CHUNK_CHARS % 4);
	for (let offset = 0; offset < payload.length; offset += aligned) {
		const binary = atob(payload.slice(offset, offset + aligned));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		chunks.push(bytes);
		if (offset + aligned < payload.length) await yieldToMainThread();
	}
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

/**
 * Decodes a binary document data URL. Unlike `dataUrlToBlob`, this rejects a
 * missing, malformed or contradictory payload instead of returning an empty
 * blob, so an export cannot claim success after writing an empty file.
 */
export async function decodeBinaryDataBytes(
	data: string | undefined,
	options: BinaryDataOptions = {}
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
	const { mime, payload } = validateBinaryDataUrl(data, options);
	const bytes = await decodeBase64Payload(payload);
	if (bytes.byteLength === 0)
		throw new BinaryDataError('missing', 'The binary document data URL has no payload.');
	return { bytes, mime };
}

/** Blob form of `decodeBinaryDataBytes` for a single download or native save. */
export async function decodeBinaryDataUrl(
	data: string | undefined,
	options: BinaryDataOptions = {}
): Promise<Blob> {
	const { bytes, mime } = await decodeBinaryDataBytes(data, options);
	return new Blob([bytes], { type: mime });
}
