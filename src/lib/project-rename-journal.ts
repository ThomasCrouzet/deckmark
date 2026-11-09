import { db } from './db';

export type RenameStage = 'prepared' | 'disk-renamed' | 'db-rewritten';

export interface ProjectRenameJournal {
	id: string;
	projectId: string;
	oldPath: string;
	newPath: string;
	stage: RenameStage;
	updatedAt: number;
}

const PREFIX = 'project-rename-journal:';

export async function writeProjectRenameJournal(journal: ProjectRenameJournal): Promise<void> {
	await db.metadata.put({
		key: `${PREFIX}${journal.id}`,
		value: JSON.stringify(journal)
	});
}

export async function updateProjectRenameStage(id: string, stage: RenameStage): Promise<void> {
	const row = await db.metadata.get(`${PREFIX}${id}`);
	if (!row) return;
	try {
		const journal = JSON.parse(row.value) as ProjectRenameJournal;
		journal.stage = stage;
		journal.updatedAt = Date.now();
		await db.metadata.put({ key: row.key, value: JSON.stringify(journal) });
	} catch {
		/* A damaged journal is removed by recovery. */
	}
}

export async function removeProjectRenameJournal(id: string): Promise<void> {
	await db.metadata.delete(`${PREFIX}${id}`);
}

export async function listProjectRenameJournals(): Promise<ProjectRenameJournal[]> {
	const rows = await db.metadata.where('key').startsWith(PREFIX).toArray();
	const journals: ProjectRenameJournal[] = [];
	for (const row of rows) {
		try {
			const value = JSON.parse(row.value) as ProjectRenameJournal;
			if (value.id && value.projectId) journals.push(value);
		} catch {
			await db.metadata.delete(row.key);
		}
	}
	return journals;
}
