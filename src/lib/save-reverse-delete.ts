import { db, type DraftRow } from './db';

/** True only when the durable row is exactly the row this write persisted. */
function samePersistedRow(current: DraftRow, expected: DraftRow): boolean {
	return (
		current.id === expected.id &&
		current.name === expected.name &&
		current.content === expected.content &&
		current.projectId === expected.projectId &&
		current.relativePath === expected.relativePath &&
		current.createdAt === expected.createdAt &&
		current.updatedAt === expected.updatedAt &&
		current.order === expected.order &&
		current.kind === expected.kind &&
		current.mime === expected.mime &&
		current.data === expected.data &&
		current.origin === expected.origin &&
		current.sourceFileId === expected.sourceFileId &&
		current.open === expected.open
	);
}

/**
 * Removes the row a discarded write committed, but only while it still matches
 * that write. A newer row from another window, restore or backup branch stays.
 */
/** Applies the conditional cleanup and reports the conflict to the queue. */
export async function handleDiscardedWrite(
	id: string,
	row: DraftRow,
	onError: (error: unknown) => void
): Promise<void> {
	try {
		const outcome = await deleteDiscardedWrite(id, row);
		if (outcome === 'conflict') onError(new Error('save-reverse-delete-conflict'));
	} catch (error) {
		onError(error);
	}
}

export async function deleteDiscardedWrite(
	id: string,
	row: DraftRow
): Promise<'deleted' | 'absent' | 'conflict'> {
	let conflict = false;
	let absent = false;
	await db.transaction('rw', db.drafts, async () => {
		const current = await db.drafts.get(id);
		if (!current) {
			absent = true;
			return;
		}
		if (!samePersistedRow(current, row)) {
			conflict = true;
			return;
		}
		await db.drafts.delete(id);
	});
	return conflict ? 'conflict' : absent ? 'absent' : 'deleted';
}
