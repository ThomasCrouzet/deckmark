import Dexie from 'dexie';
import { db, newId, type DraftRow } from './db';
import { documentKind } from './document-kind';
import { pruneVersions } from './version-history';

export interface ReplacementCommitInput {
	id: string;
	name: string;
	before: string;
	after: string;
	updatedAt: number;
	relativePath: string | undefined;
}

export type ReplacementCommitResult =
	{ status: 'committed'; rows: DraftRow[] } | { status: 'stale' };

/**
 * Compare durable drafts, save their checkpoints, and write replacements in
 * one transaction. A stale input leaves all drafts and versions unchanged.
 */
export async function commitReplacements(
	inputs: readonly ReplacementCommitInput[],
	now = Date.now()
): Promise<ReplacementCommitResult> {
	if (inputs.length === 0) return { status: 'committed', rows: [] };
	if (
		inputs.some(
			(input) =>
				documentKind(input.before) === 'presentation' ||
				documentKind(input.after) === 'presentation'
		)
	)
		return { status: 'stale' };
	if (new Set(inputs.map((input) => input.id)).size !== inputs.length) {
		throw new Error('Replacement input contains duplicate document IDs');
	}

	return db.transaction('rw', db.drafts, db.versions, async () => {
		const currentRows = await db.drafts.bulkGet(inputs.map((input) => input.id));
		const stale = inputs.some((input, index) => {
			const current = currentRows[index];
			return (
				!current ||
				current.name !== input.name ||
				current.content !== input.before ||
				current.updatedAt !== input.updatedAt ||
				current.relativePath !== input.relativePath
			);
		});
		if (stale) return { status: 'stale' };

		for (const current of currentRows as DraftRow[]) {
			const latest = await db.versions
				.where('[draftId+createdAt]')
				.between([current.id, Dexie.minKey], [current.id, Dexie.maxKey])
				.last();
			if (latest?.content !== current.content || latest.name !== current.name) {
				await db.versions.put({
					id: newId(),
					draftId: current.id,
					name: current.name,
					content: current.content,
					createdAt: now
				});
			}
			await pruneVersions(current.id, now);
		}

		const rows = currentRows.map((current, index) => ({
			...current!,
			content: inputs[index]!.after,
			updatedAt: Math.max(now, current!.updatedAt + 1)
		}));
		await db.drafts.bulkPut(rows);
		return { status: 'committed', rows };
	});
}
