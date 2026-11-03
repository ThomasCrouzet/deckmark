// Optional local search index. It uses word and character n-gram features so
// related forms rank together without a model download or a network request.
// The index is disabled by default and stored only in Dexie.

import type { SemanticIndexRow } from './db';
import { contentHash } from './ai/patches';
import { documentKindForFile } from './document-kind';
import type { FileItem } from './types';

export const SEMANTIC_DIMENSIONS = 384;
const CHUNK_CHARS = 900;
const SECRET = /(^|\/)\.env(\.|$)|(^|\/)id_(rsa|ed25519)|\.(pem|key|p12)$/i;

export interface SemanticHit {
	draftId: string;
	path: string;
	line: number;
	score: number;
	text: string;
}

function features(text: string): string[] {
	const words = text
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length > 1);
	const result: string[] = [...words];
	for (const word of words) {
		if (word.length < 4) continue;
		for (let index = 0; index + 4 <= word.length; index++)
			result.push(`#${word.slice(index, index + 4)}`);
	}
	return result;
}

function hash(value: string): number {
	let result = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		result ^= value.charCodeAt(index);
		result = Math.imul(result, 0x01000193) >>> 0;
	}
	return result % SEMANTIC_DIMENSIONS;
}

export function embed(text: string): number[] {
	const vector = new Array<number>(SEMANTIC_DIMENSIONS).fill(0);
	for (const feature of features(text)) vector[hash(feature)]! += 1;
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
	return vector.map((value) => value / norm);
}

export function cosine(left: readonly number[], right: readonly number[]): number {
	let dot = 0;
	for (let index = 0; index < Math.min(left.length, right.length); index++)
		dot += (left[index] ?? 0) * (right[index] ?? 0);
	return dot;
}

export function chunks(content: string): Array<{ line: number; text: string }> {
	const lines = content.split(/\r?\n/);
	const result: Array<{ line: number; text: string }> = [];
	let buffer: string[] = [];
	let line = 1;
	for (let index = 0; index < lines.length; index++) {
		buffer.push(lines[index]!);
		if (buffer.join('\n').length >= CHUNK_CHARS) {
			result.push({ line, text: buffer.join('\n') });
			buffer = [];
			line = index + 2;
		}
	}
	if (buffer.length) result.push({ line, text: buffer.join('\n') });
	return result;
}

export function indexFile(file: FileItem, projectId: string | null): SemanticIndexRow | null {
	if (!['note', 'code'].includes(documentKindForFile(file))) return null;
	const path = file.relativePath ?? file.name;
	if (SECRET.test(path)) return null;
	const parts = chunks(file.content);
	return {
		id: `${projectId ?? 'library'}:${file.id}`,
		projectId,
		draftId: file.id,
		path,
		contentHash: contentHash(file.content),
		vector: embed(file.content),
		chunks: parts,
		updatedAt: Date.now()
	};
}

/**
 * Builds only rows whose content changed. Existing rows with a matching hash
 * are reused, so indexing stays incremental.
 */
export function indexFiles(
	files: readonly FileItem[],
	existing: readonly SemanticIndexRow[],
	projectId: string | null
): SemanticIndexRow[] {
	const byDraft = new Map(existing.map((row) => [row.draftId, row]));
	const rows: SemanticIndexRow[] = [];
	for (const file of files) {
		if (projectId && file.projectId !== projectId) continue;
		const hash = contentHash(file.content);
		const previous = byDraft.get(file.id);
		if (previous?.contentHash === hash) {
			rows.push(previous);
			continue;
		}
		const next = indexFile(file, projectId);
		if (next) rows.push(next);
	}
	return rows;
}

export function search(
	rows: readonly SemanticIndexRow[],
	query: string,
	limit = 20
): SemanticHit[] {
	if (!query.trim()) return [];
	const queryVector = embed(query);
	const queryTokens = new Set(features(query).filter((feature) => !feature.startsWith('#')));
	return rows
		.map((row) => {
			const best = row.chunks
				.map((chunk) => {
					const score = cosine(queryVector, embed(chunk.text));
					const content = chunk.text.toLowerCase();
					const tokenBonus = [...queryTokens].filter((token) => content.includes(token)).length;
					return { chunk, score: score + tokenBonus * 0.05 };
				})
				.sort((left, right) => right.score - left.score)[0];
			return {
				draftId: row.draftId,
				path: row.path,
				line: best?.chunk.line ?? 1,
				score: best?.score ?? 0,
				text: (best?.chunk.text ?? '').slice(0, 220)
			};
		})
		.filter((hit) => hit.score > 0)
		.sort((left, right) => right.score - left.score)
		.slice(0, limit);
}
