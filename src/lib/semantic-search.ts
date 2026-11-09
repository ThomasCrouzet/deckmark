// Optional local search models. Both run in the browser, require no download
// and make no network request. The co-occurrence model is trained from the
// selected local corpus, so it captures related terms that appear together.

import type { SemanticIndexRow } from './db';
import { contentHash } from './ai/patches';
import { documentKindForFile } from './document-kind';
import type { FileItem } from './types';

export const FEATURE_DIMENSIONS = 384;
export const COOCCURRENCE_DIMENSIONS = 128;
const CHUNK_CHARS = 900;
const SECRET = /(^|\/)\.env(\.|$)|(^|\/)id_(rsa|ed25519)|\.(pem|key|p12)$/i;

export type SemanticModelId = 'feature-hash-v1' | 'cooccurrence-v1';
export interface SemanticModelOption {
	id: SemanticModelId;
	name: string;
	dims: number;
	description: string;
}

export const SEMANTIC_MODELS: readonly SemanticModelOption[] = [
	{
		id: 'feature-hash-v1',
		name: 'Feature hash v1',
		dims: FEATURE_DIMENSIONS,
		description: 'Word and character features. Works immediately on any corpus.'
	},
	{
		id: 'cooccurrence-v1',
		name: 'Local co-occurrence v1',
		dims: COOCCURRENCE_DIMENSIONS,
		description: 'Trained from the selected documents. Related terms move together.'
	}
];

export interface Embedder {
	modelId: SemanticModelId;
	dims: number;
	embed(text: string): number[];
}

export interface SemanticHit {
	draftId: string;
	path: string;
	line: number;
	score: number;
	text: string;
}

function words(text: string): string[] {
	return text
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length > 1);
}

function features(text: string): string[] {
	const result = words(text);
	for (const word of [...result]) {
		if (word.length < 4) continue;
		for (let index = 0; index + 4 <= word.length; index++)
			result.push(`#${word.slice(index, index + 4)}`);
	}
	return result;
}

function hash(value: string, dims: number): number {
	let result = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		result ^= value.charCodeAt(index);
		result = Math.imul(result, 0x01000193) >>> 0;
	}
	return result % dims;
}

function normalize(vector: number[]): number[] {
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
	return vector.map((value) => value / norm);
}

export function embed(text: string): number[] {
	const vector = new Array<number>(FEATURE_DIMENSIONS).fill(0);
	for (const feature of features(text)) vector[hash(feature, FEATURE_DIMENSIONS)]! += 1;
	return normalize(vector);
}

export const featureModel: Embedder = {
	modelId: 'feature-hash-v1',
	dims: FEATURE_DIMENSIONS,
	embed
};

/** Builds a deterministic co-occurrence model from the selected local text. */
export function trainCooccurrenceModel(texts: readonly string[]): Embedder {
	const counts = new Map<string, number>();
	for (const text of texts) {
		for (const word of words(text)) counts.set(word, (counts.get(word) ?? 0) + 1);
	}
	const vocabulary = [...counts.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, 500)
		.map(([word]) => word);
	const index = new Map(vocabulary.map((word, position) => [word, position]));
	const random = vocabulary.map((word) => {
		const vector = new Array<number>(COOCCURRENCE_DIMENSIONS).fill(0);
		for (let salt = 0; salt < 3; salt++) {
			vector[hash(`${word}:${salt}`, COOCCURRENCE_DIMENSIONS)] = salt % 2 === 0 ? 1 : -1;
		}
		return normalize(vector);
	});
	const semantic = random.map((vector) => [...vector]);
	for (const text of texts) {
		const tokens = words(text)
			.map((word) => index.get(word))
			.filter((position): position is number => position !== undefined);
		for (let position = 0; position < tokens.length; position++) {
			for (let offset = -4; offset <= 4; offset++) {
				if (offset === 0) continue;
				const neighbor = tokens[position + offset];
				if (neighbor === undefined) continue;
				const source = semantic[tokens[position]!]!;
				const target = random[neighbor]!;
				for (let dimension = 0; dimension < COOCCURRENCE_DIMENSIONS; dimension++)
					source[dimension]! += target[dimension]! * 0.2;
			}
		}
	}
	const normalized = semantic.map(normalize);
	return {
		modelId: 'cooccurrence-v1',
		dims: COOCCURRENCE_DIMENSIONS,
		embed(text: string): number[] {
			const tokens = words(text)
				.map((word) => index.get(word))
				.filter((position): position is number => position !== undefined);
			if (tokens.length === 0) return embed(text).slice(0, COOCCURRENCE_DIMENSIONS);
			const vector = new Array<number>(COOCCURRENCE_DIMENSIONS).fill(0);
			for (const token of tokens) {
				const source = normalized[token]!;
				for (let dimension = 0; dimension < COOCCURRENCE_DIMENSIONS; dimension++)
					vector[dimension]! += source[dimension]!;
			}
			return normalize(vector);
		}
	};
}

const cooccurrenceModels = new Map<string, Embedder>();

/** Reuses a trained local model for an unchanged corpus revision. */
export function cachedCooccurrenceEmbedder(corpusKey: string, texts: readonly string[]): Embedder {
	const cached = cooccurrenceModels.get(corpusKey);
	if (cached) return cached;
	const trained = trainCooccurrenceModel(texts);
	cooccurrenceModels.set(corpusKey, trained);
	while (cooccurrenceModels.size > 3)
		cooccurrenceModels.delete(cooccurrenceModels.keys().next().value!);
	return trained;
}

const chunkVectors = new Map<string, number[]>();

function chunkHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

function embedChunk(embedder: Embedder, text: string): number[] {
	const key = `${embedder.modelId}:${chunkHash(text)}`;
	const cached = chunkVectors.get(key);
	if (cached) return cached;
	const vector = embedder.embed(text);
	chunkVectors.set(key, vector);
	while (chunkVectors.size > 5000) chunkVectors.delete(chunkVectors.keys().next().value!);
	return vector;
}

export function modelById(id: string): Embedder {
	return id === 'cooccurrence-v1'
		? { ...featureModel, modelId: 'cooccurrence-v1', dims: COOCCURRENCE_DIMENSIONS }
		: featureModel;
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

export function indexFile(
	file: FileItem,
	projectId: string | null,
	embedder: Embedder = featureModel
): SemanticIndexRow | null {
	if (!['note', 'code'].includes(documentKindForFile(file))) return null;
	const path = file.relativePath ?? file.name;
	if (SECRET.test(path)) return null;
	return {
		id: `${projectId ?? 'library'}:${file.id}`,
		projectId,
		draftId: file.id,
		path,
		contentHash: contentHash(file.content),
		modelId: embedder.modelId,
		vector: embedder.embed(file.content),
		chunks: chunks(file.content),
		updatedAt: Date.now()
	};
}

/** Builds only rows whose content or model changed. */
export function indexFiles(
	files: readonly FileItem[],
	existing: readonly SemanticIndexRow[],
	projectId: string | null,
	embedder: Embedder = featureModel
): SemanticIndexRow[] {
	const byDraft = new Map(existing.map((row) => [row.draftId, row]));
	const rows: SemanticIndexRow[] = [];
	for (const file of files) {
		if (projectId && file.projectId !== projectId) continue;
		const hash = contentHash(file.content);
		const previous = byDraft.get(file.id);
		if (previous?.contentHash === hash && previous.modelId === embedder.modelId) {
			rows.push(previous);
			continue;
		}
		const next = indexFile(file, projectId, embedder);
		if (next) rows.push(next);
	}
	return rows;
}

export function search(
	rows: readonly SemanticIndexRow[],
	query: string,
	embedder: Embedder = featureModel,
	limit = 20
): SemanticHit[] {
	if (!query.trim()) return [];
	const queryVector = embedder.embed(query);
	const queryTokens = new Set(words(query));
	return rows
		.map((row) => {
			const best = row.chunks
				.map((chunk) => {
					const score = cosine(queryVector, embedChunk(embedder, chunk.text));
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
