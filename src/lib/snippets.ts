// Reusable snippet logic. This module has no Svelte runes and no storage
// access. Search uses metadata only. The exact code bytes stay untouched.

import type { SnippetRow } from './db';
import { CODE_LANGUAGES, codeLanguageForName, type CodeLanguageId } from './code/languages';
import { IMPORT_LIMITS } from './config';
import { t } from '#lib/i18n/index.js';

export const SNIPPET_SEARCH_LIMIT = 100;
export const MAX_SNIPPETS = 5000;
export const MAX_SNIPPET_TAGS = 50;
export const MAX_SNIPPET_TAG_LENGTH = 64;
export const MAX_SNIPPET_TITLE_LENGTH = 200;
export const MAX_SNIPPET_FOLDER_LENGTH = 120;

export type SnippetSort = 'updated' | 'title' | 'language';

export interface SnippetFilter {
	query?: string;
	favoritesOnly?: boolean;
	folder?: string | null;
	projectId?: string | null;
	sort?: SnippetSort;
}

export interface SnippetSearchResult {
	rows: SnippetRow[];
	total: number;
	limited: boolean;
}

export interface SnippetCapture {
	code: string;
	title: string;
	fileName?: string;
	projectId?: string;
	source: 'selection' | 'file';
}

export interface SnippetCopyContext {
	projectId?: string;
	projectName?: string;
	fileName?: string;
	documentTitle?: string;
	now?: Date;
}

export interface SnippetsOpenOptions {
	capture?: SnippetCapture | null;
	context?: SnippetCopyContext;
}

export const SNIPPET_PLACEHOLDERS = [
	'PROJECT_NAME',
	'FILE_NAME',
	'DOCUMENT_TITLE',
	'DATE',
	'TIME'
] as const;

export type SnippetPlaceholderName = (typeof SNIPPET_PLACEHOLDERS)[number];
export type SnippetPlaceholderValues = Partial<Record<SnippetPlaceholderName, string>>;

export interface ResolvedSnippet {
	text: string;
	unresolved: string[];
}

const PLACEHOLDER_PATTERN = /\\?\$\{([A-Z][A-Z0-9_]*)\}/g;

export function isCodeLanguageId(value: unknown): value is CodeLanguageId {
	return (
		typeof value === 'string' &&
		CODE_LANGUAGES.some((language) => language.id === (value as CodeLanguageId))
	);
}

export function snippetLanguage(
	value: string | undefined,
	fileName: string | undefined = undefined
): CodeLanguageId {
	if (isCodeLanguageId(value)) return value;
	if (fileName) return codeLanguageForName(fileName).id;
	return 'plain';
}

export function snippetLanguageLabel(value: string): string {
	return (
		CODE_LANGUAGES.find((language) => language.id === value)?.label ?? CODE_LANGUAGES[0]!.label
	);
}

/** A synthetic file name that makes CodeEditor select the snippet language. */
export function snippetLanguageFileName(value: string): string {
	const language = CODE_LANGUAGES.find((entry) => entry.id === value) ?? CODE_LANGUAGES[0]!;
	return `snippet.${language.extensions[0] ?? 'txt'}`;
}

export function parseSnippetTags(value: string): string[] {
	const tags: string[] = [];
	const seen = new Set<string>();
	for (const part of value.split(',')) {
		const tag = part.trim().replace(/^#+/, '').slice(0, MAX_SNIPPET_TAG_LENGTH);
		if (!tag) continue;
		const key = normalizeText(tag);
		if (seen.has(key)) continue;
		seen.add(key);
		tags.push(tag);
		if (tags.length >= MAX_SNIPPET_TAGS) break;
	}
	return tags;
}

export function normalizeText(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLocaleLowerCase();
}

/**
 * Scores one metadata field. A contiguous match is better than a subsequence.
 * Search never reads the `code` field.
 */
export function fuzzyMetadataScore(text: string, query: string): number | null {
	if (!query) return 0;
	const haystack = normalizeText(text);
	const needle = normalizeText(query);
	if (!needle) return 0;
	const direct = haystack.indexOf(needle);
	if (direct !== -1) {
		return 1000 - Math.min(direct, 400) + (direct === 0 ? 200 : 0);
	}
	let haystackIndex = 0;
	let score = 0;
	let streak = 0;
	for (const character of needle) {
		const found = haystack.indexOf(character, haystackIndex);
		if (found === -1) return null;
		if (found === haystackIndex) {
			streak += 1;
		} else {
			streak = 0;
		}
		score += 1 + streak * 3;
		haystackIndex = found + 1;
	}
	return score;
}

function metadataScore(row: SnippetRow, tokens: string[]): number | null {
	const title = row.title;
	const tags = row.tags.join(' ');
	const folder = row.folder ?? '';
	const language = snippetLanguageLabel(row.language);
	let total = 0;
	for (const token of tokens) {
		const scores = [
			fuzzyMetadataScore(title, token),
			fuzzyMetadataScore(tags, token),
			fuzzyMetadataScore(folder, token),
			fuzzyMetadataScore(language, token)
		].filter((value): value is number => value !== null);
		if (scores.length === 0) return null;
		total += Math.max(...scores);
	}
	return total;
}

function sortRows(rows: SnippetRow[], sort: SnippetSort): SnippetRow[] {
	const byTitle = (left: SnippetRow, right: SnippetRow) =>
		left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
	return rows.toSorted((left, right) => {
		if (sort === 'title') return byTitle(left, right) || right.updatedAt - left.updatedAt;
		if (sort === 'language') {
			const byLanguage = snippetLanguageLabel(left.language).localeCompare(
				snippetLanguageLabel(right.language)
			);
			return byLanguage || byTitle(left, right);
		}
		return right.updatedAt - left.updatedAt || byTitle(left, right);
	});
}

/** Filters and fuzzy-sorts snippet metadata. The result is bounded. */
export function searchSnippets(
	rows: readonly SnippetRow[],
	filter: SnippetFilter = {}
): SnippetSearchResult {
	const query = (filter.query ?? '').trim();
	const tokens = query ? normalizeText(query).split(/\s+/).filter(Boolean) : [];
	const candidates: Array<{ row: SnippetRow; score: number }> = [];
	for (const row of rows) {
		if (filter.favoritesOnly && !row.favorite) continue;
		if (filter.folder && (row.folder ?? '') !== filter.folder) continue;
		if (filter.projectId && row.projectId !== filter.projectId) continue;
		if (tokens.length === 0) {
			candidates.push({ row, score: 0 });
			continue;
		}
		const score = metadataScore(row, tokens);
		if (score !== null) candidates.push({ row, score });
	}
	const sort = filter.sort ?? 'updated';
	// A non-empty query keeps relevance first. The selected sort breaks ties.
	let result: SnippetRow[];
	if (query) {
		const sorted = sortRows(
			candidates.map((entry) => entry.row),
			sort
		);
		const order = new Map(sorted.map((row, index) => [row.id, index]));
		result = candidates
			.toSorted(
				(left, right) =>
					right.score - left.score || (order.get(left.row.id) ?? 0) - (order.get(right.row.id) ?? 0)
			)
			.map((entry) => entry.row);
	} else {
		result = sortRows(
			candidates.map((entry) => entry.row),
			sort
		);
	}
	return {
		rows: result.slice(0, SNIPPET_SEARCH_LIMIT),
		total: result.length,
		limited: result.length > SNIPPET_SEARCH_LIMIT
	};
}

export function findDuplicateSnippet(
	rows: readonly SnippetRow[],
	code: string,
	language: string,
	excludeId: string | null = null
): SnippetRow | null {
	return (
		rows.find((row) => row.id !== excludeId && row.code === code && row.language === language) ??
		null
	);
}

export function snippetCopyVariables(context: SnippetCopyContext = {}): SnippetPlaceholderValues {
	const now = context.now ?? new Date();
	const date = `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
	return {
		PROJECT_NAME: context.projectName ?? '',
		FILE_NAME: context.fileName ?? '',
		DOCUMENT_TITLE: context.documentTitle ?? '',
		DATE: date,
		TIME: time
	};
}

/**
 * Replaces known `${NAME}` placeholders in one pass. A backslash before the
 * placeholder keeps the literal text. Unknown placeholders stay as written.
 * Replacement values are inserted literally, so nested placeholders do not
 * expand again.
 */
export function resolveSnippetPlaceholders(
	code: string,
	values: SnippetPlaceholderValues
): ResolvedSnippet {
	const unresolved: string[] = [];
	const text = code.replace(PLACEHOLDER_PATTERN, (match, rawName: string) => {
		const name = rawName as SnippetPlaceholderName;
		if (match.startsWith('\\')) return match.slice(1);
		const value = values[name];
		if (value === undefined) {
			if (!unresolved.includes(name)) unresolved.push(name);
			return match;
		}
		return value;
	});
	return { text, unresolved };
}

export function resolveSnippetForCopy(
	code: string,
	context: SnippetCopyContext = {}
): ResolvedSnippet {
	return resolveSnippetPlaceholders(code, snippetCopyVariables(context));
}

export const SNIPPET_EXPORT_FORMAT = 'mdsh-snippets';
export const SNIPPET_EXPORT_SCHEMA_VERSION = 1;

export interface SnippetExportFile {
	format: typeof SNIPPET_EXPORT_FORMAT;
	schemaVersion: number;
	exportedAt: number;
	snippets: SnippetRow[];
}

export class SnippetExportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SnippetExportError';
	}
}

export function normalizeSnippetRow(row: SnippetRow): SnippetRow {
	return {
		id: row.id,
		title: row.title,
		code: row.code,
		language: row.language,
		tags: [...row.tags],
		...(row.folder === undefined ? {} : { folder: row.folder }),
		...(row.projectId === undefined ? {} : { projectId: row.projectId }),
		favorite: row.favorite,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function validTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15;
}

export function validSnippetRow(value: unknown): value is SnippetRow {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === 'string' &&
		row.id.length > 0 &&
		typeof row.title === 'string' &&
		row.title.length <= MAX_SNIPPET_TITLE_LENGTH &&
		typeof row.code === 'string' &&
		isCodeLanguageId(row.language) &&
		Array.isArray(row.tags) &&
		row.tags.length <= MAX_SNIPPET_TAGS &&
		row.tags.every(
			(tag) => typeof tag === 'string' && tag.length > 0 && tag.length <= MAX_SNIPPET_TAG_LENGTH
		) &&
		(row.folder === undefined ||
			(typeof row.folder === 'string' && row.folder.length <= MAX_SNIPPET_FOLDER_LENGTH)) &&
		(row.projectId === undefined ||
			(typeof row.projectId === 'string' && row.projectId.length > 0)) &&
		typeof row.favorite === 'boolean' &&
		validTimestamp(row.createdAt) &&
		validTimestamp(row.updatedAt)
	);
}

/** Deterministic JSON. Rows are ordered by creation time and identifier. */
export function serializeSnippetExport(
	rows: readonly SnippetRow[],
	exportedAt = Date.now()
): string {
	const snippets = rows
		.map(normalizeSnippetRow)
		.toSorted((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
	const payload: SnippetExportFile = {
		format: SNIPPET_EXPORT_FORMAT,
		schemaVersion: SNIPPET_EXPORT_SCHEMA_VERSION,
		exportedAt,
		snippets
	};
	return JSON.stringify(payload, null, 2);
}

export function parseSnippetExport(json: string): SnippetRow[] {
	if (json.length > IMPORT_LIMITS.maxBatchBytes) {
		throw new SnippetExportError(t('snippets.exportTooLarge'));
	}
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		throw new SnippetExportError(t('snippets.invalidExport'));
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new SnippetExportError(t('snippets.invalidExport'));
	}
	const payload = raw as Record<string, unknown>;
	if (
		payload.format !== SNIPPET_EXPORT_FORMAT ||
		typeof payload.schemaVersion !== 'number' ||
		!Number.isInteger(payload.schemaVersion) ||
		payload.schemaVersion < 1 ||
		payload.schemaVersion > SNIPPET_EXPORT_SCHEMA_VERSION ||
		!validTimestamp(payload.exportedAt) ||
		!Array.isArray(payload.snippets)
	) {
		throw new SnippetExportError(t('snippets.invalidExport'));
	}
	if (payload.snippets.length > MAX_SNIPPETS) {
		throw new SnippetExportError(t('snippets.exportTooLarge'));
	}
	const rows: SnippetRow[] = [];
	const ids = new Set<string>();
	let totalBytes = 0;
	for (const entry of payload.snippets) {
		if (!validSnippetRow(entry)) {
			throw new SnippetExportError(t('snippets.invalidExport'));
		}
		if (ids.has(entry.id)) {
			throw new SnippetExportError(t('snippets.invalidExport'));
		}
		ids.add(entry.id);
		const size = new TextEncoder().encode(entry.code).byteLength;
		totalBytes += size;
		if (size > IMPORT_LIMITS.maxFileBytes || totalBytes > IMPORT_LIMITS.maxBatchBytes) {
			throw new SnippetExportError(t('snippets.exportTooLarge'));
		}
		rows.push(normalizeSnippetRow(entry));
	}
	return rows;
}
