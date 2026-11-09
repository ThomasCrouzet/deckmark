import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import {
	listProjectRenameJournals,
	removeProjectRenameJournal,
	updateProjectRenameStage,
	writeProjectRenameJournal
} from './project-rename-journal';

beforeEach(async () => {
	await db.metadata.clear();
});

describe('project rename journal', () => {
	it('records stages and removes a completed operation', async () => {
		await writeProjectRenameJournal({
			id: 'op',
			projectId: 'p',
			oldPath: 'old.md',
			newPath: 'new.md',
			stage: 'prepared',
			updatedAt: 1
		});
		await updateProjectRenameStage('op', 'db-rewritten');
		expect(await listProjectRenameJournals()).toMatchObject([
			{ id: 'op', projectId: 'p', newPath: 'new.md', stage: 'db-rewritten' }
		]);
		await removeProjectRenameJournal('op');
		expect(await listProjectRenameJournals()).toEqual([]);
	});

	it('drops a damaged journal instead of blocking recovery', async () => {
		await db.metadata.put({ key: 'project-rename-journal:bad', value: '{' });
		expect(await listProjectRenameJournals()).toEqual([]);
		expect(await db.metadata.count()).toBe(0);
	});
});
