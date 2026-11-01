import { IMPORT_LIMITS } from './config';

export type ImportIssueReason =
	'file-size' | 'batch-size' | 'file-count' | 'encoding' | 'binary' | 'read' | 'depth';
export interface ImportReport {
	processed: number;
	imported: number;
	skipped: number;
	failed: number;
	bytes: number;
	cancelled: boolean;
	issues: Array<{ name: string; reason: ImportIssueReason }>;
}
export interface ImportOptions {
	signal?: AbortSignal;
	onProgress?: (report: ImportReport) => void;
}
export class ImportReadError extends Error {
	constructor(readonly reason: ImportIssueReason) {
		super(reason);
	}
}

export function validateMarkdownContent(content: string): void {
	for (let i = 0; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code < 32 && code !== 9 && code !== 10 && code !== 13) throw new ImportReadError('binary');
	}
}

async function readBytes(file: File, signal?: AbortSignal): Promise<ArrayBuffer> {
	if (file.arrayBuffer) return file.arrayBuffer();
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		const abort = () => reader.abort();
		const cleanup = () => signal?.removeEventListener('abort', abort);
		reader.onload = () => {
			cleanup();
			resolve(reader.result as ArrayBuffer);
		};
		reader.onerror = () => {
			cleanup();
			reject(reader.error);
		};
		reader.onabort = () => {
			cleanup();
			reject(new DOMException('Cancelled', 'AbortError'));
		};
		signal?.addEventListener('abort', abort, { once: true });
		try {
			reader.readAsArrayBuffer(file);
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}

export async function readUtf8File(
	file: File,
	maxBytes: number,
	signal?: AbortSignal,
	preserveByteOrderMark = false
): Promise<string> {
	if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes)
		throw new ImportReadError('file-size');
	if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
	const bytes = await readBytes(file, signal);
	if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
	if (bytes.byteLength !== file.size) throw new ImportReadError('read');
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: preserveByteOrderMark }).decode(
			bytes
		);
	} catch {
		throw new ImportReadError('encoding');
	}
}

export class ImportSession {
	readonly report: ImportReport = {
		processed: 0,
		imported: 0,
		skipped: 0,
		failed: 0,
		bytes: 0,
		cancelled: false,
		issues: []
	};
	private admitted = 0;
	constructor(readonly options: ImportOptions = {}) {}
	get cancelled(): boolean {
		if (this.options.signal?.aborted) this.report.cancelled = true;
		return this.report.cancelled;
	}
	publish(): ImportReport {
		this.report.cancelled = this.cancelled;
		const snapshot = { ...this.report, issues: [...this.report.issues] };
		try {
			this.options.onProgress?.(snapshot);
		} catch {
			/* Progress reporting must not invalidate imported data. */
		}
		return snapshot;
	}
	async pause(): Promise<boolean> {
		// Yield so large batches remain cancellable.
		if (this.report.processed > 0 && this.report.processed % 10 === 0)
			await new Promise((resolve) => setTimeout(resolve, 0));
		return !this.cancelled;
	}
	skip(): void {
		this.report.processed++;
		this.report.skipped++;
		this.publish();
	}
	fail(name: string, reason: ImportIssueReason): void {
		this.report.processed++;
		this.report.failed++;
		this.report.issues.push({ name, reason });
		this.publish();
	}
	accept(): void {
		this.report.processed++;
		this.report.imported++;
		this.publish();
	}
	reserve(size: number): void {
		if (this.admitted >= IMPORT_LIMITS.maxFiles) throw new ImportReadError('file-count');
		if (!Number.isSafeInteger(size) || size < 0 || size > IMPORT_LIMITS.maxFileBytes)
			throw new ImportReadError('file-size');
		if (this.report.bytes + size > IMPORT_LIMITS.maxBatchBytes)
			throw new ImportReadError('batch-size');
		this.admitted++;
		this.report.bytes += size;
	}
	async read(file: File): Promise<string | null> {
		if (this.cancelled) return null;
		try {
			this.reserve(file.size);
			const content = await readUtf8File(
				file,
				IMPORT_LIMITS.maxFileBytes,
				this.options.signal,
				true
			);
			if (this.cancelled) return null;
			validateMarkdownContent(content);
			return content;
		} catch (error) {
			if (this.cancelled) return null;
			this.fail(file.name, error instanceof ImportReadError ? error.reason : 'read');
			return null;
		}
	}
}
