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

export type PatchFileStatus =
	'ready' | 'stale' | 'missing' | 'ambiguous' | 'scope' | 'conflict' | 'noop';

export interface PatchFilePlan {
	path: string;
	/** Canonical relative path captured at review time. */
	canonicalPath: string;
	fileId: string | null;
	status: PatchFileStatus;
	before: string;
	after: string;
	hunks: Array<{
		index: number;
		ok: boolean;
		before: string;
		after: string;
		/** 1-based occurrence requested by the provider, if any. */
		occurrence?: number;
		/** Verified range in the reviewed source, used for subset application. */
		sourceStart?: number;
		sourceEnd?: number;
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

/** Hard bound for an untrusted provider reply before any JSON scan. */
export const MAX_PATCH_REPLY_CHARS = 2_000_000;
const MAX_PATCH_FILES = 100;
const MAX_PATCH_HUNKS = 500;

/** Extracts the first JSON patch proposal from a fenced or raw reply. */
export function parsePatchProposal(reply: string): AiPatchProposal | null {
	if (reply.length > MAX_PATCH_REPLY_CHARS) return null;
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
			if (
				files.length > 0 &&
				files.length <= MAX_PATCH_FILES &&
				files.every((file) => file.hunks.length <= MAX_PATCH_HUNKS)
			)
				return { files };
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

type TargetResolution =
	{ kind: 'found'; file: PatchTarget } | { kind: 'missing' } | { kind: 'ambiguous' };

/**
 * Resolves a provider path. An exact canonical relative path wins. A bare
 * basename is only accepted when exactly one file has that name, so a second
 * project folder with the same name is reported instead of guessed.
 */
function findTarget(files: readonly PatchTarget[], path: string): TargetResolution {
	const exact = files.filter((file) => (file.relativePath ?? file.name) === path);
	if (exact.length === 1) return { kind: 'found', file: exact[0]! };
	if (exact.length > 1) return { kind: 'ambiguous' };
	const byName = files.filter((file) => file.name === path);
	if (byName.length === 1) return { kind: 'found', file: byName[0]! };
	if (byName.length > 1) return { kind: 'ambiguous' };
	return { kind: 'missing' };
}

function canonicalPathOf(file: PatchTarget): string {
	return file.relativePath ?? file.name;
}

type HunkResolution =
	{ ok: true; start: number; end: number } | { ok: false; reason: 'missing' | 'ambiguous' };

/**
 * Resolves a hunk against the reviewed source. Occurrence numbers always refer
 * to the original source, so one hunk cannot renumber a later hunk.
 */
function resolveHunk(content: string, hunk: AiPatchHunk): HunkResolution {
	if (hunk.before.length === 0) return { ok: false, reason: 'missing' };
	const wanted = hunk.occurrence;
	if (wanted !== undefined && (!Number.isInteger(wanted) || wanted < 1))
		return { ok: false, reason: 'missing' };
	let offset = 0;
	let count = 0;
	let position = -1;
	while (offset <= content.length) {
		const found = content.indexOf(hunk.before, offset);
		if (found < 0) break;
		count += 1;
		if (wanted !== undefined) {
			if (count === wanted) {
				position = found;
				break;
			}
		} else if (position < 0) {
			position = found;
		} else {
			// Stop at the second occurrence: no full positions array is built.
			return { ok: false, reason: 'ambiguous' };
		}
		offset = found + Math.max(1, hunk.before.length);
	}
	if (position < 0) return { ok: false, reason: 'missing' };
	return { ok: true, start: position, end: position + hunk.before.length };
}

/** Replaces the selected verified ranges, from the end so offsets stay stable. */
function applyRanges(
	content: string,
	edits: ReadonlyArray<{ start: number; end: number; after: string }>
): string {
	let result = content;
	for (const edit of [...edits].sort((a, b) => b.start - a.start))
		result = result.slice(0, edit.start) + edit.after + result.slice(edit.end);
	return result;
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
		const resolution = findTarget(files, path);
		if (resolution.kind === 'ambiguous') {
			result.files.push({
				path,
				canonicalPath: path,
				fileId: null,
				status: 'ambiguous',
				before: '',
				after: '',
				hunks: []
			});
			continue;
		}
		if (resolution.kind === 'missing') {
			result.files.push({
				path,
				canonicalPath: path,
				fileId: null,
				status: 'missing',
				before: '',
				after: '',
				hunks: []
			});
			continue;
		}
		const target = resolution.file;
		if (!allowed.has(target.id)) {
			result.rejected.push({ path, reason: 'outside-scope' });
			continue;
		}
		const before = target.content;
		const canonicalPath = canonicalPathOf(target);
		if (patch.baseHash !== contentHash(before)) {
			result.files.push({
				path,
				canonicalPath,
				fileId: target.id,
				status: 'stale',
				before,
				after: '',
				hunks: []
			});
			continue;
		}
		if (!Array.isArray(patch.hunks) || patch.hunks.length > MAX_PATCH_HUNKS) {
			result.rejected.push({ path, reason: 'invalid-hunks' });
			continue;
		}
		let hunkBudget = 0;
		const hunkPlans: PatchFilePlan['hunks'] = [];
		const edits: Array<{ start: number; end: number; after: string }> = [];
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
			hunkBudget += hunk.before.length + hunk.after.length;
			if (hunkBudget > MAX_PATCH_REPLY_CHARS) {
				hunkPlans.push({ index, ok: false, before: '', after: '', reason: 'missing' });
				failed = true;
				return;
			}
			const resolved = resolveHunk(before, hunk);
			if (!resolved.ok) {
				hunkPlans.push({
					index,
					ok: false,
					before: hunk.before,
					after: hunk.after,
					...(hunk.occurrence !== undefined ? { occurrence: hunk.occurrence } : {}),
					reason: resolved.reason
				});
				failed = true;
				return;
			}
			// Two hunks that target the same reviewed range cannot both apply.
			if (edits.some((edit) => resolved.start < edit.end && resolved.end > edit.start)) {
				hunkPlans.push({
					index,
					ok: false,
					before: hunk.before,
					after: hunk.after,
					...(hunk.occurrence !== undefined ? { occurrence: hunk.occurrence } : {}),
					reason: 'ambiguous'
				});
				failed = true;
				return;
			}
			edits.push({ start: resolved.start, end: resolved.end, after: hunk.after });
			hunkPlans.push({
				index,
				ok: true,
				before: hunk.before,
				after: hunk.after,
				...(hunk.occurrence !== undefined ? { occurrence: hunk.occurrence } : {}),
				sourceStart: resolved.start,
				sourceEnd: resolved.end
			});
		});
		const content = failed ? before : applyRanges(before, edits);
		result.files.push({
			path,
			canonicalPath,
			fileId: target.id,
			status: failed ? 'conflict' : content === before ? 'noop' : 'ready',
			before,
			after: failed ? '' : content,
			hunks: hunkPlans
		});
	}
	return result;
}

export interface AppliedPatchFile {
	id: string;
	canonicalPath: string;
	content: string;
}

/**
 * Plans a revert of a previously applied patch. Every target must keep its
 * exact accepted bytes and canonical path. One changed file rejects the whole
 * set. Exact bytes are authoritative; the 32-bit hash is only a hint.
 */
export function planRevert(
	appliedAfter: readonly AppliedPatchFile[],
	appliedBefore: readonly AppliedPatchFile[],
	files: readonly PatchTarget[]
): { changes: Array<{ id: string; content: string }>; rejected: string[] } {
	const rejected: string[] = [];
	const seen = new Set<string>();
	if (appliedAfter.length === 0 || appliedAfter.length !== appliedBefore.length)
		return { changes: [], rejected: appliedAfter.map((entry) => entry.canonicalPath) };
	for (const entry of appliedAfter) {
		const before = appliedBefore.find((candidate) => candidate.id === entry.id);
		const target = files.find((candidate) => candidate.id === entry.id);
		if (
			seen.has(entry.id) ||
			!before ||
			before.canonicalPath !== entry.canonicalPath ||
			!target ||
			canonicalPathOf(target) !== entry.canonicalPath ||
			target.content !== entry.content
		)
			rejected.push(entry.canonicalPath);
		seen.add(entry.id);
	}
	if (rejected.length > 0) return { changes: [], rejected };
	return {
		changes: appliedBefore.map((entry) => ({ id: entry.id, content: entry.content })),
		rejected: []
	};
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
		if (
			!target ||
			canonicalPathOf(target) !== entry.canonicalPath ||
			contentHash(target.content) !== contentHash(entry.before)
		) {
			rejected.push(entry.path);
			continue;
		}
		const indexes = approvedHunks?.[entry.path];
		if (!indexes) {
			changes.push({ id: entry.fileId, content: entry.after });
			continue;
		}
		const selected = new Set(indexes);
		const chosen = entry.hunks.filter((hunk) => selected.has(hunk.index) && hunk.ok);
		if (chosen.length === 0) {
			changes.push({ id: entry.fileId, content: entry.before });
			continue;
		}
		// A full selection is exactly the reviewed preview, including same-before
		// hunks and explicit occurrences.
		if (chosen.length === entry.hunks.length) {
			changes.push({ id: entry.fileId, content: entry.after });
			continue;
		}
		// A subset uses the verified source ranges captured at review time. This
		// keeps occurrence numbering stable when an earlier hunk is unselected.
		const stable = chosen.every(
			(hunk) => hunk.sourceStart !== undefined && hunk.sourceEnd !== undefined
		);
		if (!stable) {
			rejected.push(entry.path);
			continue;
		}
		const content = applyRanges(
			entry.before,
			chosen.map((hunk) => ({
				start: hunk.sourceStart!,
				end: hunk.sourceEnd!,
				after: hunk.after
			}))
		);
		changes.push({ id: entry.fileId, content });
	}
	return { changes, rejected };
}
