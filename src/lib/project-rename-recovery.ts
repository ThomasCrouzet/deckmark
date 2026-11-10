import { listProjectRenameJournals, removeProjectRenameJournal } from './project-rename-journal';

export interface RenameRecoveryFailure {
	path: string;
	operation: 'open';
	message: string;
}

/**
 * Reconciles disk and IndexedDB after a crash between the native rename and
 * baseline commit. A successful refresh re-reads the disk path and stores the
 * new baseline. A failed refresh keeps the journal for the next start.
 */
export async function recoverPendingProjectRenames(
	refreshProject: (projectId: string) => Promise<unknown>
): Promise<RenameRecoveryFailure[]> {
	const failures: RenameRecoveryFailure[] = [];
	let journals;
	try {
		journals = await listProjectRenameJournals();
	} catch (error) {
		failures.push({
			path: 'project rename recovery',
			operation: 'open',
			message: `Rename recovery unavailable: ${String(error)}`
		});
		return failures;
	}
	if (journals.length === 0) return failures;
	for (const journal of journals) {
		try {
			await refreshProject(journal.projectId);
			await removeProjectRenameJournal(journal.id);
		} catch (error) {
			failures.push({
				path: journal.newPath,
				operation: 'open',
				message: `Rename recovery pending: ${String(error)}`
			});
		}
	}
	return failures;
}
