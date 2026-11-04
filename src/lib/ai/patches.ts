// Reviewed, file-targeted patches. Nothing is written until the caller
// applies an approved plan, and every file is checked against its base hash.

export interface AiPatchHunk {
	before: string;
	after: string;
	/** 1-based occurrence when the same text appears several times. */
	occurrence?: number;
}

export interface AiFilePatch {
	path: string;
	baseHash: string;
	hunks: AiPatchHunk[];
}

export interface AiPatchProposal {
	files: AiFilePatch[];
}

export type PatchFileStatus = 'ready' | 'stale' | 'missing' | 'scope' | 'conflict' | 'noop';

export interface PatchFilePlan {
	path: string;
	fileId: string | null;
	status: PatchFileStatus;
	before: string;
	after: string;
	hunks: Array<{
		index: number;
		ok: boolean;
		before: string;
		after: string;
		reason?: 'missing' | 'ambiguous';
	}>;
}

export interface PatchPlan {
	files: PatchFilePlan[];
	rejected: Array<{ path: string; reason: string }>;
}

export interface PatchTarget {
	id: string;
	name: string;
	content: string;
	relativePath?: string;
}

/** Extracts the first JSON patch proposal from a fenced or raw reply. */
export function parsePatchProposal(reply: string): AiPatchProposal | null {
	const candidates: string[] = [];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
	for (const match of reply.matchAll(fenced)) if (match[1]) candidates.push(match[1]);
	candidates.push(reply);
	for (const candidate of candidates) {
		try {
			const value = JSON.parse(candidate.trim()) as Partial<AiPatchProposal>;
			if (!Array.isArray(value.files)) continue;
			const files = value.files.filter(
				(entry): entry is AiFilePatch =>
					!!entry &&
					typeof entry === 'object' &&
					typeof entry.path === 'string' &&
					typeof entry.baseHash === 'string' &&
					Array.isArray(entry.hunks)
			);
			if (files.length > 0) return { files };
		} catch {
			// Keep looking at the next candidate.
		}
	}
	return null;
}

/** Small deterministic revision hash for stale-patch detection. */
export function contentHash(content: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < content.length; index++) {
		hash ^= content.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

export function safePatchPath(path: string): boolean {
	const value = path.trim();
	return (
		value.length > 0 &&
		value.length <= 512 &&
		!value.startsWith('/') &&
		!value.startsWith('\\') &&
		!/^[a-z]:/i.test(value) &&
		!value.split(/[\\/]/).includes('..')
	);
}

function findTarget(files: readonly PatchTarget[], path: string): PatchTarget | undefined {
	return files.find((file) => (file.relativePath ?? file.name) === path || file.name === path);
}

function applyHunk(
	content: string,
	hunk: AiPatchHunk
): { ok: true; content: string } | { ok: false; reason: 'missing' | 'ambiguous' } {
	const positions: number[] = [];
	let offset = 0;
	while (offset <= content.length) {
		const found = content.indexOf(hunk.before, offset);
		if (found < 0) break;
		positions.push(found);
		offset = found + Math.max(1, hunk.before.length);
	}
	if (positions.length === 0) return { ok: false, reason: 'missing' };
	if (positions.length > 1 && !hunk.occurrence) return { ok: false, reason: 'ambiguous' };
	const index = hunk.occurrence ? hunk.occurrence - 1 : 0;
	const position = positions[index];
	if (position === undefined) return { ok: false, reason: 'missing' };
	return {
		ok: true,
		content: content.slice(0, position) + hunk.after + content.slice(position + hunk.before.length)
	};
}

/**
 * Validates a proposal against current files and allowed scope. Only paths in
 * `allowedIds` may change. A stale hash blocks the whole file.
 */
export function planPatch(
	proposal: AiPatchProposal,
	files: readonly PatchTarget[],
	allowedIds: readonly string[]
): PatchPlan {
	const allowed = new Set(allowedIds);
	const seen = new Set<string>();
	const result: PatchPlan = { files: [], rejected: [] };
	if (!Array.isArray(proposal.files) || proposal.files.length > 100)
		return { files: [], rejected: [{ path: '*', reason: 'invalid-proposal' }] };

	for (const patch of proposal.files) {
		const path = typeof patch.path === 'string' ? patch.path.trim() : '';
		if (!safePatchPath(path) || seen.has(path)) {
			result.rejected.push({ path: path || '*', reason: 'invalid-path' });
			continue;
		}
		seen.add(path);
		const target = findTarget(files, path);
		if (!target) {
			result.files.push({
				path,
				fileId: null,
				status: 'missing',
				before: '',
				after: '',
				hunks: []
			});
			continue;
		}
		if (!allowed.has(target.id)) {
			result.rejected.push({ path, reason: 'outside-scope' });
			continue;
		}
		const before = target.content;
		if (patch.baseHash !== contentHash(before)) {
			result.files.push({
				path,
				fileId: target.id,
				status: 'stale',
				before,
				after: '',
				hunks: []
			});
			continue;
		}
		if (!Array.isArray(patch.hunks) || patch.hunks.length > 500) {
			result.rejected.push({ path, reason: 'invalid-hunks' });
			continue;
		}
		let content = before;
		const hunkPlans: PatchFilePlan['hunks'] = [];
		let failed = false;
		patch.hunks.forEach((hunk, index) => {
			if (
				typeof hunk.before !== 'string' ||
				typeof hunk.after !== 'string' ||
				hunk.before.length > 200_000 ||
				hunk.after.length > 200_000
			) {
				hunkPlans.push({ index, ok: false, before: '', after: '', reason: 'missing' });
				failed = true;
				return;
			}
			const applied = applyHunk(content, hunk);
			if (!applied.ok) {
				hunkPlans.push({
					index,
					ok: false,
					before: hunk.before,
					after: hunk.after,
					reason: applied.reason
				});
				failed = true;
				return;
			}
			content = applied.content;
			hunkPlans.push({ index, ok: true, before: hunk.before, after: hunk.after });
		});
		result.files.push({
			path,
			fileId: target.id,
			status: failed ? 'conflict' : content === before ? 'noop' : 'ready',
			before,
			after: failed ? '' : content,
			hunks: hunkPlans
		});
	}
	return result;
}

/**
 * Applies approved files and hunks. Rechecks hashes so a stale plan cannot
 * overwrite later edits. Returns the complete set or a rejection list.
 */
export function applyPatchPlan(
	plan: PatchPlan,
	files: readonly PatchTarget[],
	approvedPaths: readonly string[],
	approvedHunks?: Readonly<Record<string, readonly number[]>>
): { changes: Array<{ id: string; content: string }>; rejected: string[] } {
	const approved = new Set(approvedPaths);
	const changes: Array<{ id: string; content: string }> = [];
	const rejected: string[] = [];
	for (const entry of plan.files) {
		if (!approved.has(entry.path)) continue;
		if (!entry.fileId || entry.status !== 'ready') {
			rejected.push(entry.path);
			continue;
		}
		const target = files.find((file) => file.id === entry.fileId);
		if (!target || contentHash(target.content) !== contentHash(entry.before)) {
			rejected.push(entry.path);
			continue;
		}
		const indexes = approvedHunks?.[entry.path];
		if (!indexes) {
			changes.push({ id: entry.fileId, content: entry.after });
			continue;
		}
		let content = entry.before;
		const selected = new Set(indexes);
		let failed = false;
		for (const hunk of entry.hunks) {
			if (!selected.has(hunk.index) || !hunk.ok) continue;
			const applied = applyHunk(content, { before: hunk.before, after: hunk.after });
			if (!applied.ok) {
				failed = true;
				break;
			}
			content = applied.content;
		}
		if (failed) {
			rejected.push(entry.path);
			continue;
		}
		changes.push({ id: entry.fileId, content });
	}
	return { changes, rejected };
}
