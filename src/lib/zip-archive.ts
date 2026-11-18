// Bounded ZIP generation with cancellation.
//
// JSZip emits output chunks through a stream. This helper accumulates them and
// pauses the stream when the caller aborts. Rejecting an outer promise without
// pausing the stream would leave compression running.

// eslint-disable-next-line no-restricted-imports -- type-only, erased at build time
import type JSZip from 'jszip';
import { checkAborted } from './abort';
import type { ExportProgressReporter } from './export-pipeline';

export interface ZipStreamOptions {
	signal?: AbortSignal | undefined;
	onProgress?: ExportProgressReporter | undefined;
	compressionLevel?: number | undefined;
	platform?: 'DOS' | 'UNIX' | undefined;
	mimeType?: string | undefined;
}

/** Generates the archive bytes and stops the stream at an abort. */
export function generateZipBytes(
	zip: JSZip,
	options: ZipStreamOptions = {}
): Promise<Uint8Array<ArrayBuffer>> {
	checkAborted(options.signal);
	return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		let size = 0;
		let settled = false;
		const abortError = () => new DOMException('Operation cancelled', 'AbortError');
		const stream = zip.generateInternalStream({
			type: 'uint8array',
			compression: 'DEFLATE',
			compressionOptions: { level: options.compressionLevel ?? 6 },
			...(options.platform ? { platform: options.platform } : {}),
			...(options.mimeType ? { mimeType: options.mimeType } : {})
		});
		const onAbort = () => {
			if (settled) return;
			settled = true;
			// Stop the producer before the rejected promise returns to the caller.
			stream.pause();
			reject(abortError());
		};
		options.signal?.addEventListener('abort', onAbort, { once: true });
		const settle = () => {
			options.signal?.removeEventListener('abort', onAbort);
		};
		stream
			.on('data', (chunk, metadata) => {
				if (settled) return;
				if (options.signal?.aborted) {
					onAbort();
					return;
				}
				chunks.push(chunk);
				size += chunk.length;
				const percent = Math.round(metadata.percent);
				options.onProgress?.({ phase: 'compress', completed: percent, total: 100, percent });
			})
			.on('error', (error) => {
				if (settled) return;
				settled = true;
				settle();
				reject(error);
			})
			.on('end', () => {
				if (settled) return;
				if (options.signal?.aborted) {
					onAbort();
					return;
				}
				settled = true;
				settle();
				const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(size);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.length;
				}
				chunks.length = 0;
				resolve(bytes);
			});
		stream.resume();
	});
}
