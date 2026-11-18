// Library ZIP export with cancellation.
//
// The module loads only when a user starts a ZIP export. A throwing JSZip
// update callback stops the stream and rejects the promise, so a cancel does
// not continue compression or publish a partial archive.

import type { FileItem } from '#lib/types.js';
import type { ProjectAssetRow } from './db';
import { IMPORT_LIMITS } from './config';
import { isBinaryDocument } from './document-kind';
import { checkAborted } from './abort';
import { binaryPayload, sanitizeFilename, triggerDownload } from './services/export';
import { buildProjectZip, PROJECT_LIMITS } from './project-archive';
import type { ZipProgressReporter } from './project-archive';

/** Test-only pause that makes the entry yield points observable. */
async function profilePause(): Promise<void> {
	const value = (globalThis as { __MDSH_EXPORT_PIPELINE_DELAY_MS__?: unknown })
		.__MDSH_EXPORT_PIPELINE_DELAY_MS__;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return;
	await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, Math.round(value))));
}

// ─── Library ZIP export ───────────────────────────────────────────────────────

export interface ExportArchiveOptions {
	signal?: AbortSignal | undefined;
	onProgress?: ZipProgressReporter | undefined;
}

/** @returns `false` if the desktop save dialog was cancelled. */
export async function exportZip(
	files: FileItem[],
	filename = 'deckmark-export.zip',
	options: ExportArchiveOptions = {}
): Promise<boolean> {
	if (typeof window === 'undefined' || typeof document === 'undefined' || files.length === 0)
		return false;
	if (files.length > IMPORT_LIMITS.maxFiles) throw new Error('Library export document limit');
	checkAborted(options.signal);
	const encoder = new TextEncoder();
	const encoded = new Map<string, Uint8Array>();
	const binaryBytes = new Map<string, Uint8Array>();
	let inputBytes = 0;
	let entries = files.length;
	for (const file of files) {
		checkAborted(options.signal);
		await profilePause();
		if (isBinaryDocument(file)) {
			// Decode once. The ZIP entry reuses these exact bytes instead of
			// decoding the same data URL a second time after the size preflight.
			const { bytes } = await binaryPayload(file);
			binaryBytes.set(file.id, bytes);
			inputBytes += bytes.byteLength;
			if (bytes.byteLength > IMPORT_LIMITS.maxFileBytes || inputBytes > IMPORT_LIMITS.maxBatchBytes)
				throw new Error('Library export size limit');
			continue;
		}
		const data = encoder.encode(file.content);
		encoded.set(file.id, data);
		inputBytes += data.byteLength;
		if (data.byteLength > IMPORT_LIMITS.maxFileBytes || inputBytes > IMPORT_LIMITS.maxBatchBytes)
			throw new Error('Library export size limit');
	}
	const projectIds = new Set(files.flatMap((file) => (file.projectId ? [file.projectId] : [])));
	const projectAssets = new Map<string, ProjectAssetRow[]>();
	if (projectIds.size) {
		const { db } = await import('./db');
		for (const projectId of projectIds) {
			const snapshot: ProjectAssetRow[] = [];
			projectAssets.set(projectId, snapshot);
			await db.projectAssets
				.where('projectId')
				.equals(projectId)
				.each((asset) => {
					inputBytes += asset.data.byteLength;
					entries++;
					if (entries > PROJECT_LIMITS.maxEntries - 3 || inputBytes > IMPORT_LIMITS.maxBatchBytes)
						throw new Error('Library export size limit');
					snapshot.push(asset);
				});
		}
	}
	const { default: JSZip } = await import('jszip');
	const zip = new JSZip();
	let archiveBytes = 0;
	// Nested project ZIPs exist as a Blob and as its transferred buffer while
	// the outer archive is assembled. Keep that transient peak bounded.
	let transientArchiveBytes = 0;
	const used = new Set<string>();
	function archiveName(requested: string): string {
		let name = sanitizeFilename(requested);
		if (used.has(name.toLowerCase())) {
			const ext = name.match(/\.[^.]+$/)?.[0] ?? '';
			const base = ext ? name.slice(0, -ext.length) : name;
			let i = 2;
			while (used.has(`${base}-${i}${ext}`.toLowerCase())) i++;
			name = `${base}-${i}${ext}`;
		}
		used.add(name.toLowerCase());
		return name;
	}
	for (const file of files.filter((file) => !file.projectId)) {
		checkAborted(options.signal);
		if (isBinaryDocument(file)) {
			const buffer = binaryBytes.get(file.id)!;
			archiveBytes += buffer.byteLength;
			zip.file(archiveName(file.name), buffer);
		} else {
			const data = encoded.get(file.id) ?? encoder.encode(file.content);
			archiveBytes += data.byteLength;
			zip.file(archiveName(file.name), data);
		}
	}
	if (projectIds.size) {
		const { db } = await import('./db');
		for (const projectId of projectIds) {
			checkAborted(options.signal);
			const project = await db.projects.get(projectId);
			if (!project) throw new Error('Export project no longer exists');
			const assets = projectAssets.get(projectId) ?? [];
			const documents = files
				.filter((file) => file.projectId === projectId)
				.map((file) => ({
					id: file.id,
					relativePath: file.relativePath!,
					content: file.content,
					...(file.kind ? { kind: file.kind } : {}),
					...(file.mime ? { mime: file.mime } : {}),
					...(file.data ? { data: file.data } : {})
				}));
			const archive = await buildProjectZip(project.name, documents, assets, {
				signal: options.signal,
				onProgress: options.onProgress
			});
			archiveBytes += archive.size;
			transientArchiveBytes += archive.size * 2;
			if (
				archiveBytes > IMPORT_LIMITS.maxBatchBytes ||
				transientArchiveBytes > IMPORT_LIMITS.maxBatchBytes * 2
			)
				throw new Error('Library export size limit');
			zip.file(archiveName(`${project.name}.zip`), await archive.arrayBuffer());
		}
	}
	// A throwing update callback stops the JSZip stream and rejects this
	// promise. No archive reaches the caller after a cancel.
	const blob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
		if (options.signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
		const percent = Math.round(metadata.percent);
		options.onProgress?.({ phase: 'compress', completed: percent, total: 100, percent });
	});
	checkAborted(options.signal);
	if (blob.size > IMPORT_LIMITS.maxBatchBytes) throw new Error('Library export size limit');
	return triggerDownload(blob, filename);
}
