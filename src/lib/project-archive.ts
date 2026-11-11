import { IMPORT_LIMITS, MAX_IMAGE_BYTES } from './config';
import { validateMarkdownContent } from './import-limits';
import { imageMime, pathKey, projectPath, relativeDestination } from './project-paths';
import {
	projectDestinations,
	projectLinkReport,
	rewriteProjectDestinations
} from './project-links';
import { rewriteWikiLinkTargets } from './wiki-links';
import { documentKindForFile, isBinaryDocument } from './document-kind';
import { decodeBinaryDataBytes } from './data-url';
import type { ProjectAssetRow } from './db';
type JSZipObject = import('jszip').JSZipObject;

import { PROJECT_SCALE_LIMITS, projectDocumentLimit } from './project-limits';

export const PROJECT_LIMITS = PROJECT_SCALE_LIMITS;
export interface ProjectDocumentInput {
	id?: string;
	relativePath: string;
	content: string;
	kind?: 'note' | 'presentation' | 'code' | 'image' | 'pdf';
	/** MIME recorded for a typed document. */
	mime?: string;
	/** Base64 data URL for an image or PDF document. */
	data?: string;
}
export interface ProjectAssetInput {
	path: string;
	mime: string;
	data: Uint8Array;
}
export interface ProjectInput {
	name: string;
	documents: ProjectDocumentInput[];
	assets: ProjectAssetInput[];
}

type ProjectDocumentKind = NonNullable<ProjectDocumentInput['kind']>;

interface ProjectManifestRole {
	kind: ProjectDocumentKind;
	mime?: string;
}

interface ParsedProjectManifest {
	name: string;
	documents: Map<string, ProjectManifestRole>;
}

const PROJECT_MANIFEST_PATH = '.mdsh/project.json';
const PROJECT_MANIFEST_FORMAT = 'mdsh-project';
const PROJECT_MANIFEST_VERSION = 2;
const PROJECT_MANIFEST_BYTES = 1024 * 1024;
const DOCUMENT_KINDS = new Set<ProjectDocumentKind>([
	'note',
	'presentation',
	'code',
	'image',
	'pdf'
]);

function isBinaryKind(kind: ProjectDocumentKind): boolean {
	return kind === 'image' || kind === 'pdf';
}

function bytesToDataUrl(mime: string, bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 32_768) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
	}
	return `data:${mime};base64,${btoa(binary)}`;
}

function parseProjectManifest(text: string): ParsedProjectManifest {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error('Invalid project manifest');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid project manifest');
	const manifest = value as Record<string, unknown>;
	if (manifest.format !== PROJECT_MANIFEST_FORMAT) throw new Error('Unknown project format');
	const version = manifest.schemaVersion;
	if (version !== 1 && version !== PROJECT_MANIFEST_VERSION)
		throw new Error('Unsupported project manifest version');
	if (
		typeof manifest.name !== 'string' ||
		manifest.name.trim().length === 0 ||
		manifest.name.length > 200
	)
		throw new Error('Invalid project name');
	const documents = new Map<string, ProjectManifestRole>();
	if (version === 2) {
		if (!Array.isArray(manifest.documents)) throw new Error('Invalid project manifest documents');
		for (const value of manifest.documents) {
			if (!value || typeof value !== 'object') throw new Error('Invalid project document entry');
			const entry = value as Record<string, unknown>;
			if (typeof entry.path !== 'string') throw new Error('Invalid project document path');
			const path = projectPath(entry.path);
			if (path.startsWith('.mdsh/')) throw new Error('Reserved project path');
			const kind = entry.kind as ProjectDocumentKind;
			if (!DOCUMENT_KINDS.has(kind)) throw new Error('Invalid project document kind');
			const key = pathKey(path);
			if (documents.has(key)) throw new Error('Duplicate project document path');
			if (isBinaryKind(kind)) {
				if (typeof entry.mime !== 'string' || entry.mime.length === 0)
					throw new Error('Missing project document type');
				if (kind === 'pdf' && entry.mime !== 'application/pdf')
					throw new Error('Project PDF type does not match');
				if (kind === 'image' && !entry.mime.startsWith('image/'))
					throw new Error('Project image type does not match');
			}
			documents.set(key, {
				kind,
				...(typeof entry.mime === 'string' ? { mime: entry.mime } : {})
			});
		}
	}
	return { name: manifest.name, documents };
}

/** Check central-directory limits before the ZIP library builds its entry map. */
function checkZipDirectory(bytes: Uint8Array): void {
	if (bytes.length > PROJECT_LIMITS.maxBytes || bytes.length < 22)
		throw new Error('Invalid archive size');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = bytes.length - 22;
	const minimum = Math.max(0, bytes.length - 65557);
	while (end >= minimum && view.getUint32(end, true) !== 0x06054b50) end--;
	if (end < minimum || end + 22 + view.getUint16(end + 20, true) !== bytes.length)
		throw new Error('Invalid ZIP directory');
	const count = view.getUint16(end + 10, true);
	if (
		view.getUint16(end + 4, true) ||
		view.getUint16(end + 6, true) ||
		count !== view.getUint16(end + 8, true) ||
		count > PROJECT_LIMITS.maxEntries
	)
		throw new Error('Archive entry limit');
	let cursor = view.getUint32(end + 16, true);
	const directorySize = view.getUint32(end + 12, true);
	if (cursor + directorySize !== end) throw new Error('Unsupported ZIP directory');
	let expanded = 0;
	const names = new Set<string>();
	for (let index = 0; index < count; index++) {
		if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50)
			throw new Error('Invalid ZIP entry');
		const flags = view.getUint16(cursor + 8, true);
		const method = view.getUint16(cursor + 10, true);
		const size = view.getUint32(cursor + 24, true);
		const nameSize = view.getUint16(cursor + 28, true);
		const extraSize = view.getUint16(cursor + 30, true);
		const commentSize = view.getUint16(cursor + 32, true);
		const next = cursor + 46 + nameSize + extraSize + commentSize;
		if (next > end || flags & 1 || ![0, 8].includes(method) || size > IMPORT_LIMITS.maxFileBytes)
			throw new Error('Unsupported ZIP entry');
		const name = new TextDecoder('utf-8', { fatal: true }).decode(
			bytes.subarray(cursor + 46, cursor + 46 + nameSize)
		);
		const path = projectPath(name.endsWith('/') ? name.slice(0, -1) : name);
		const key = pathKey(path);
		if (names.has(key)) throw new Error('Duplicate archive path');
		names.add(key);
		const mode = view.getUint32(cursor + 38, true) >>> 16;
		if ((mode & 0xf000) === 0xa000) throw new Error('Archive symlinks are not supported');
		expanded += size;
		if (expanded > PROJECT_LIMITS.maxBytes) throw new Error('Expanded archive limit');
		cursor = next;
	}
	if (cursor !== end) throw new Error('Invalid ZIP directory length');
}

/** Stop decompression before a false ZIP size can allocate an oversized result. */
async function readZipEntry(entry: JSZipObject, maximum: number): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		let size = 0;
		let failed = false;
		const stream = (
			entry as JSZipObject & {
				internalStream(type: 'uint8array'): {
					on(event: 'data', callback: (chunk: Uint8Array) => void): void;
					on(event: 'error', callback: (error: Error) => void): void;
					on(event: 'end', callback: () => void): void;
					pause(): void;
					resume(): void;
				};
			}
		).internalStream('uint8array');
		stream.on('data', (chunk: Uint8Array) => {
			if (failed) return;
			size += chunk.length;
			if (size > maximum) {
				failed = true;
				stream.pause();
				reject(new Error('Expanded archive limit'));
				return;
			}
			chunks.push(chunk);
		});
		stream.on('error', reject);
		stream.on('end', () => {
			if (failed) return;
			const result = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				result.set(chunk, offset);
				offset += chunk.length;
			}
			resolve(result);
		});
		stream.resume();
	});
}

function appendEntry(
	input: ProjectInput,
	path: string,
	data: Uint8Array,
	roles: Map<string, ProjectManifestRole>
): void {
	if (path.startsWith('.mdsh/')) {
		if (path !== PROJECT_MANIFEST_PATH && path !== '.mdsh/link-report.json')
			throw new Error('Reserved project path');
		return;
	}
	if (pathKey(path).startsWith('.mdsh/')) throw new Error('Reserved project path');
	const role = roles.get(pathKey(path));
	if (role) {
		if (input.documents.length >= projectDocumentLimit()) throw new Error('Project document limit');
		if (isBinaryKind(role.kind)) {
			const mime = role.mime!;
			const maxBytes = role.kind === 'image' ? MAX_IMAGE_BYTES : IMPORT_LIMITS.maxFileBytes;
			if (data.length > maxBytes) throw new Error('Project document size limit');
			if (role.kind === 'image' && imageMime(path) !== mime)
				throw new Error('Project image type does not match its path');
			if (role.kind === 'pdf' && !/\.pdf$/i.test(path))
				throw new Error('Project PDF type does not match its path');
			input.documents.push({
				relativePath: path,
				content: '',
				kind: role.kind,
				mime,
				data: bytesToDataUrl(mime, data)
			});
			return;
		}
		if (/\.(md|markdown|mdx|txt)$/i.test(path) || role.kind === 'code') {
			const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
			validateMarkdownContent(content);
			input.documents.push({
				relativePath: path,
				content,
				kind: role.kind,
				...(role.mime ? { mime: role.mime } : {})
			});
			return;
		}
		throw new Error('Project document type does not match its path');
	}
	if (/\.(md|markdown|mdx|txt)$/i.test(path)) {
		if (input.documents.length >= projectDocumentLimit()) throw new Error('Project document limit');
		const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
		validateMarkdownContent(content);
		input.documents.push({ relativePath: path, content });
	} else {
		const mime = imageMime(path);
		if (mime && data.length > MAX_IMAGE_BYTES) throw new Error('Project image size limit');
		input.assets.push({ path, mime: mime ?? 'application/octet-stream', data });
	}
}

export async function readProjectZip(file: File): Promise<ProjectInput> {
	if (file.size > PROJECT_LIMITS.maxBytes) throw new Error('Archive size limit');
	const bytes = new Uint8Array(await file.arrayBuffer());
	checkZipDirectory(bytes);
	const { default: JSZip } = await import('jszip');
	const zip = await JSZip.loadAsync(bytes);
	const manifestEntry = zip.file(PROJECT_MANIFEST_PATH);
	const manifest = manifestEntry
		? parseProjectManifest(
				new TextDecoder('utf-8', { fatal: true }).decode(
					await readZipEntry(manifestEntry, PROJECT_MANIFEST_BYTES)
				)
			)
		: null;
	const roles = manifest?.documents ?? new Map<string, ProjectManifestRole>();
	const input: ProjectInput = {
		name: manifest?.name ?? file.name.replace(/\.zip$/i, ''),
		documents: [],
		assets: []
	};
	const seen = new Set<string>();
	let total = 0;
	for (const entry of Object.values(zip.files)) {
		if (entry.dir) continue;
		const original = (entry as JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName;
		const path = projectPath(original ?? entry.name);
		if (path !== entry.name.normalize('NFC')) throw new Error('Unsafe archive path');
		const data = await readZipEntry(
			entry,
			Math.min(IMPORT_LIMITS.maxFileBytes, PROJECT_LIMITS.maxBytes - total)
		);
		total += data.length;
		appendEntry(input, path, data, roles);
		const key = pathKey(path);
		if (roles.has(key)) {
			if (seen.has(key)) throw new Error('Duplicate project document path');
			seen.add(key);
		}
	}
	for (const key of roles.keys())
		if (!seen.has(key)) throw new Error('Missing project document entry');
	if (!input.documents.length) throw new Error('The project contains no Markdown documents');
	return input;
}

export async function readProjectFolder(files: readonly File[]): Promise<ProjectInput> {
	if (!files.length || files.length > PROJECT_LIMITS.maxEntries)
		throw new Error('Project entry limit');
	const first = files[0]!;
	const name = first.webkitRelativePath.split('/')[0] || 'Project';
	const manifestFile = files.find((file) => {
		const relative = file.webkitRelativePath || file.name;
		const path = projectPath(
			file.webkitRelativePath ? relative.split('/').slice(1).join('/') : relative
		);
		return path === PROJECT_MANIFEST_PATH;
	});
	if (manifestFile && manifestFile.size > PROJECT_MANIFEST_BYTES)
		throw new Error('Project manifest size limit');
	const manifest = manifestFile
		? parseProjectManifest(
				new TextDecoder('utf-8', { fatal: true }).decode(await manifestFile.arrayBuffer())
			)
		: null;
	const roles = manifest?.documents ?? new Map<string, ProjectManifestRole>();
	const input: ProjectInput = { name: manifest?.name ?? name, documents: [], assets: [] };
	const paths = new Set<string>();
	const seen = new Set<string>();
	let size = 0;
	for (const file of files) {
		const relative = file.webkitRelativePath || file.name;
		const path = projectPath(
			file.webkitRelativePath ? relative.split('/').slice(1).join('/') : relative
		);
		if (path.split('/').some((part) => part === '.git' || part === 'node_modules')) continue;
		const key = pathKey(path);
		if (paths.has(key)) throw new Error('Duplicate project path');
		paths.add(key);
		size += file.size;
		if (file.size > IMPORT_LIMITS.maxFileBytes || size > PROJECT_LIMITS.maxBytes)
			throw new Error('Project size limit');
		appendEntry(input, path, new Uint8Array(await file.arrayBuffer()), roles);
		if (roles.has(key)) seen.add(key);
	}
	for (const key of roles.keys())
		if (!seen.has(key)) throw new Error('Missing project document entry');
	if (!input.documents.length) throw new Error('The project contains no Markdown documents');
	return input;
}

export interface ProjectZipOptions {
	/** Fixed entry date for a reproducible archive. */
	date?: Date;
}

export async function buildProjectZip(
	name: string,
	documents: readonly ProjectDocumentInput[],
	assets: readonly Pick<ProjectAssetRow, 'path' | 'data' | 'mime'>[],
	options: ProjectZipOptions = {}
): Promise<Blob> {
	const { default: JSZip } = await import('jszip');
	const zip = new JSZip();
	const entryOptions = options.date ? { date: options.date } : undefined;
	if (documents.length > projectDocumentLimit()) throw new Error('Project document limit');
	const occupied = new Set<string>();
	const exportedAssets = new Map<string, Pick<ProjectAssetRow, 'path' | 'data' | 'mime'>>();
	for (const asset of assets) {
		const path = projectPath(asset.path);
		const key = pathKey(path);
		if (key.startsWith('.mdsh/')) throw new Error('Reserved project path');
		if (occupied.has(key)) throw new Error('Duplicate project path');
		if (asset.data.length > IMPORT_LIMITS.maxFileBytes) throw new Error('Project asset size limit');
		if (imageMime(path) && asset.data.length > MAX_IMAGE_BYTES)
			throw new Error('Project image size limit');
		occupied.add(key);
		exportedAssets.set(key, { ...asset, path });
	}
	const generatedAssetDirectory =
		[...exportedAssets.values()]
			.map((asset) => asset.path.split('/', 1)[0]!)
			.find((directory) => directory.toLowerCase() === 'assets') ?? 'assets';
	const exportProjectId = 'export-project';
	const wikiDocuments = documents.flatMap((document) =>
		document.id
			? [
					{
						id: document.id,
						projectId: exportProjectId,
						relativePath: projectPath(document.relativePath)
					}
				]
			: []
	);
	const wikiById = new Map<string, typeof wikiDocuments>();
	for (const candidate of wikiDocuments) {
		const matches = wikiById.get(candidate.id);
		if (matches) matches.push(candidate);
		else wikiById.set(candidate.id, [candidate]);
	}
	const exportedDocuments: ProjectDocumentInput[] = [];
	const manifestDocuments: Array<{ path: string; kind: ProjectDocumentKind; mime?: string }> = [];
	// The same inline image data URL can occur in many documents. Decode and
	// hash it once per export, then reuse the generated asset path.
	const inlineImageCache = new Map<string, { path: string }>();
	for (const document of documents) {
		const documentPath = projectPath(document.relativePath);
		const documentKey = pathKey(documentPath);
		if (documentKey.startsWith('.mdsh/')) throw new Error('Reserved project path');
		if (occupied.has(documentKey)) throw new Error('Duplicate project path');
		const typeInfo = { ...document, name: documentPath };
		const kind = documentKindForFile(typeInfo);
		if (isBinaryDocument(typeInfo)) {
			const { bytes, mime } = await decodeBinaryDataBytes(document.data, {
				expectedKind: kind === 'image' || kind === 'pdf' ? kind : undefined,
				expectedMime: document.mime,
				maxBytes: kind === 'image' ? MAX_IMAGE_BYTES : IMPORT_LIMITS.maxFileBytes
			});
			if (kind === 'image' && imageMime(documentPath) !== mime)
				throw new Error('Project image type does not match its path');
			if (kind === 'pdf' && !/\.pdf$/i.test(documentPath))
				throw new Error('Project PDF type does not match its path');
			occupied.add(documentKey);
			exportedDocuments.push({
				...(document.id ? { id: document.id } : {}),
				relativePath: documentPath,
				content: '',
				kind
			});
			manifestDocuments.push({ path: documentPath, kind, mime });
			zip.file(documentPath, bytes, entryOptions);
			continue;
		}
		const portableContent =
			kind !== 'note'
				? document.content
				: rewriteWikiLinkTargets(document.content, (target) => {
						const id = target.split('#', 1)[0]!;
						const matches = wikiById.get(id) ?? [];
						if (matches.length !== 1) return target;
						const suffix = target.slice(id.length);
						return relativeDestination(documentPath, matches[0]!.relativePath) + suffix;
					});
		validateMarkdownContent(portableContent);
		// UTF-8 byte length is never smaller than the UTF-16 length. Use the
		// cheap bound here and encode the final rewritten text exactly once.
		if (portableContent.length > IMPORT_LIMITS.maxFileBytes)
			throw new Error('Project document size limit');
		occupied.add(documentKey);
		const replacements = new Map<string, string>();
		for (const { source } of projectDestinations(portableContent)) {
			const cached = inlineImageCache.get(source);
			if (cached) {
				replacements.set(source, relativeDestination(documentPath, cached.path));
				continue;
			}
			const match =
				/^data:(image\/(?:png|jpeg|gif|webp|svg\+xml|avif));base64,([a-z\d+/=\s]+)$/i.exec(source);
			if (!match || source.length > MAX_IMAGE_BYTES * 1.5 + 1024) continue;
			let data: Uint8Array;
			try {
				data = Uint8Array.from(atob(match[2]!.replace(/\s/g, '')), (character) =>
					character.charCodeAt(0)
				);
			} catch {
				continue;
			}
			if (data.length > MAX_IMAGE_BYTES) continue;
			const hashInput = new Uint8Array(data).buffer;
			const hash = Array.from(
				new Uint8Array(await crypto.subtle.digest('SHA-256', hashInput)),
				(byte) => byte.toString(16).padStart(2, '0')
			).join('');
			const extension = match[1]!.split('/')[1]!.replace('svg+xml', 'svg').replace('jpeg', 'jpg');
			let path = `${generatedAssetDirectory}/image-${hash}.${extension}`;
			let suffix = 1;
			let key = pathKey(path);
			while (
				occupied.has(key) &&
				!equalBytes(exportedAssets.get(key)?.data ?? new Uint8Array(), data)
			) {
				path = `${generatedAssetDirectory}/image-${hash}-${suffix++}.${extension}`;
				key = pathKey(path);
			}
			const existing = exportedAssets.get(key);
			if (existing) path = existing.path;
			else {
				occupied.add(key);
				exportedAssets.set(key, { path, mime: match[1]!, data });
			}
			inlineImageCache.set(source, { path });
			replacements.set(source, relativeDestination(documentPath, path));
		}
		const content = rewriteProjectDestinations(
			portableContent,
			({ source }) => replacements.get(source) ?? null
		);
		validateMarkdownContent(content);
		if (new TextEncoder().encode(content).length > IMPORT_LIMITS.maxFileBytes)
			throw new Error('Project document size limit');
		exportedDocuments.push({
			...(document.id ? { id: document.id } : {}),
			relativePath: documentPath,
			content,
			kind
		});
		manifestDocuments.push({ path: documentPath, kind });
		zip.file(documentPath, content, entryOptions);
	}
	for (const asset of exportedAssets.values())
		zip.file(projectPath(asset.path), asset.data, entryOptions);
	zip.file(
		PROJECT_MANIFEST_PATH,
		JSON.stringify(
			manifestDocuments.some((document) => document.kind !== 'note')
				? {
						format: PROJECT_MANIFEST_FORMAT,
						schemaVersion: PROJECT_MANIFEST_VERSION,
						name,
						documents: manifestDocuments
					}
				: { format: PROJECT_MANIFEST_FORMAT, schemaVersion: 1, name },
			null,
			2
		),
		entryOptions
	);
	zip.file(
		'.mdsh/link-report.json',
		JSON.stringify(
			{ issues: projectLinkReport(exportedDocuments, [...exportedAssets.keys()]) },
			null,
			2
		),
		entryOptions
	);
	if (options.date) {
		// JSZip adds directory entries with the current time. A fixed date on
		// every entry keeps the archive reproducible.
		for (const entry of Object.values(zip.files)) entry.date = options.date;
	}
	const output = await zip.generateAsync({
		type: 'arraybuffer',
		compression: 'DEFLATE',
		compressionOptions: { level: 6 }
	});
	const bytes = new Uint8Array(output);
	checkZipDirectory(bytes);
	return new Blob([bytes], { type: 'application/zip' });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
