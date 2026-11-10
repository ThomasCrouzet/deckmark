import { isPresentation } from './presentation/detect.js';

export type DocumentKind = 'note' | 'presentation' | 'code' | 'image' | 'pdf';

export interface DocumentTypeInfo {
	name?: string | undefined;
	kind?: DocumentKind | undefined;
	content?: string | undefined;
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);

const CODE_EXTENSIONS = new Set([
	'txt',
	'text',
	'log',
	'csv',
	'json',
	'jsonc',
	'js',
	'mjs',
	'cjs',
	'ts',
	'mts',
	'cts',
	'jsx',
	'tsx',
	'py',
	'rs',
	'go',
	'java',
	'kt',
	'kts',
	'swift',
	'c',
	'h',
	'cc',
	'cpp',
	'hpp',
	'cs',
	'php',
	'rb',
	'sh',
	'bash',
	'zsh',
	'fish',
	'ps1',
	'sql',
	'css',
	'scss',
	'less',
	'html',
	'htm',
	'xml',
	'svg',
	'yaml',
	'yml',
	'toml',
	'ini',
	'conf',
	'env',
	'lua',
	'pl',
	'r',
	'dart',
	'ex',
	'exs',
	'erl',
	'hs',
	'clj',
	'groovy',
	'gradle',
	'mk'
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'ico']);
const PDF_EXTENSIONS = new Set(['pdf']);

const IMAGE_MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	avif: 'image/avif',
	bmp: 'image/bmp',
	ico: 'image/x-icon'
};

export function fileNameExtension(name: string): string {
	const match = /\.([a-z0-9]+)$/i.exec(name.trim());
	return match ? match[1]!.toLowerCase() : '';
}

export function isMarkdownExtension(name: string): boolean {
	return MARKDOWN_EXTENSIONS.has(fileNameExtension(name));
}

export function isCodeExtension(name: string): boolean {
	return CODE_EXTENSIONS.has(fileNameExtension(name));
}

export function isImageExtension(name: string): boolean {
	return IMAGE_EXTENSIONS.has(fileNameExtension(name));
}

export function isPdfExtension(name: string): boolean {
	return PDF_EXTENSIONS.has(fileNameExtension(name));
}

export function imageMimeForName(name: string): string {
	return IMAGE_MIME[fileNameExtension(name)] ?? 'application/octet-stream';
}

/** Content-only legacy classification. Binary documents never reach this. */
export function documentKind(content: string): DocumentKind {
	return isPresentation(content) ? 'presentation' : 'note';
}

/**
 * Classifies a file from its explicit kind, then its extension, then the
 * existing Markdown presentation marker. An explicit kind always wins.
 */
export function documentKindForFile(file: DocumentTypeInfo): DocumentKind {
	if (file.kind) return file.kind;
	const extension = fileNameExtension(file.name ?? '');
	if (PDF_EXTENSIONS.has(extension)) return 'pdf';
	if (IMAGE_EXTENSIONS.has(extension)) return 'image';
	if (CODE_EXTENSIONS.has(extension)) return 'code';
	return documentKind(file.content ?? '');
}

export function isNoteFile(file: DocumentTypeInfo): boolean {
	return documentKindForFile(file) === 'note';
}

export function isPresentationFile(file: DocumentTypeInfo): boolean {
	return documentKindForFile(file) === 'presentation';
}

export type TextDocumentKind = 'note' | 'presentation' | 'code';

export function isTextDocumentKind(kind: DocumentKind): kind is TextDocumentKind {
	return kind === 'note' || kind === 'presentation' || kind === 'code';
}

export function isTextDocument(file: DocumentTypeInfo): boolean {
	return isTextDocumentKind(documentKindForFile(file));
}

export function isBinaryDocument(file: DocumentTypeInfo): boolean {
	const kind = documentKindForFile(file);
	return kind === 'image' || kind === 'pdf';
}

export function documentKindLabelKey(
	kind: DocumentKind
):
	| 'documents.note'
	| 'documents.presentation'
	| 'documents.code'
	| 'documents.image'
	| 'documents.pdf' {
	if (kind === 'presentation') return 'documents.presentation';
	if (kind === 'code') return 'documents.code';
	if (kind === 'image') return 'documents.image';
	if (kind === 'pdf') return 'documents.pdf';
	return 'documents.note';
}

export interface DocumentCapabilities {
	edit: boolean;
	source: boolean;
	read: boolean;
	present: boolean;
	format: boolean;
	annotate: boolean;
}

export function documentCapabilities(kind: DocumentKind): DocumentCapabilities {
	switch (kind) {
		case 'presentation':
			return {
				edit: true,
				source: false,
				read: false,
				present: true,
				format: false,
				annotate: false
			};
		case 'code':
			return {
				edit: true,
				source: true,
				read: false,
				present: false,
				format: false,
				annotate: false
			};
		case 'image':
			return {
				edit: false,
				source: false,
				read: true,
				present: false,
				format: false,
				annotate: true
			};
		case 'pdf':
			return {
				edit: false,
				source: false,
				read: true,
				present: false,
				format: false,
				annotate: false
			};
		default:
			return {
				edit: true,
				source: true,
				read: true,
				present: false,
				format: true,
				annotate: false
			};
	}
}
