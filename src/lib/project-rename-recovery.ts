import { listProjectRenameJournals, removeProjectRenameJournal } from './project-rename-journal';
import type { NativeProjectFailure } from './projects-native';

/**
 * Reconciles disk and IndexedDB after a crash between the native rename and
 * baseline commit. A successful refresh re-reads the disk path and stores the
 * new baseline. A failed refresh keeps the journal for the next start.
 */
export async function recoverPendingProjectRenames(): Promise<NativeProjectFailure[]> {
	const failures: NativeProjectFailure[] = [];
	let journals;
	try {
		journals = await listProjectRenameJournals();
	} catch {
		return failures;
	}
	if (journals.length === 0) return failures;
	const { refreshNativeProjectFromDisk } = await import('./projects-native');
	for (const journal of journals) {
		try {
			await refreshNativeProjectFromDisk(journal.projectId);
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
