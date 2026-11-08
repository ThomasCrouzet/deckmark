import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

interface Row {
	id: string;
	name: string;
	content: string;
	projectId: string;
	relativePath: string;
	createdAt: number;
	updatedAt: number;
	order: number;
	open: boolean;
	kind: 'note';
}

function row(id: string, relativePath: string, content = `# ${id}\n`): Row {
	return {
		id,
		relativePath,
		name: relativePath.split('/').pop()!,
		content,
		projectId: 'updates',
		createdAt: 1,
		updatedAt: 1,
		order: 0,
		open: true,
		kind: 'note'
	};
}

async function commit(page: Page, row: Row, remove = false, initializeProject = false) {
	await page.evaluate(
		async ({ row, remove, initializeProject }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const tx = db.transaction(
						initializeProject ? ['drafts', 'projects'] : ['drafts'],
						'readwrite'
					);
					if (initializeProject)
						tx.objectStore('projects').put({
							id: row.projectId,
							name: 'Updates',
							createdAt: 1,
							updatedAt: 1
						});
					if (remove) tx.objectStore('drafts').delete(row.id);
					else tx.objectStore('drafts').put(row);
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.onerror = () => reject(tx.error);
				};
			});
			const channel = new BroadcastChannel('mdsh');
			channel.postMessage(
				remove
					? { type: 'removed', id: row.id }
					: { type: 'draft-written', id: row.id, updatedAt: row.updatedAt }
			);
			channel.close();
		},
		{ row, remove, initializeProject }
	);
}

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

test('project backlinks track cross-tab collisions, moves, deletion, restore, and rename', async ({
	page,
	context
}, info) => {
	test.setTimeout(90_000);
	const fixtures = [
		row('target-document', 'docs/target.md'),
		row('root', 'root/target.md'),
		row('source', 'docs/source.md', '# Source\n\n[[target]]\n')
	];
	await resetAppState(page, { mode: 'source' });
	await commit(page, fixtures[0]!, false, true);
	for (const fixture of fixtures.slice(1)) await commit(page, fixture);
	await page.evaluate(() => {
		localStorage.setItem('mdsh:activeId', 'target-document');
		localStorage.setItem('mdsh:locale', 'en');
	});
	await page.reload();
	const editor = page.locator('.cm-content').first();
	const backlinks = page.locator('aside [aria-label="Backlinks"]');
	await expect(editor).toContainText('# target-document');
	await expect(backlinks).toContainText('source');
	const remote = await context.newPage();
	await remote.goto('/');
	const events: unknown[] = [];
	try {
		const collision = row('collision', 'docs/TARGET.md');
		await commit(remote, collision);
		events.push({ action: 'collision', row: collision });
		await expect(backlinks).toHaveCount(0);
		collision.relativePath = 'other/moved.md';
		collision.name = 'moved.md';
		collision.updatedAt++;
		await commit(remote, collision);
		events.push({ action: 'move', row: { ...collision } });
		await expect(backlinks).toContainText('source');
		const source = { ...fixtures[2]!, content: '# Source\n\n[[../root/target]]\n', updatedAt: 2 };
		await commit(remote, source);
		events.push({ action: 'edit', row: { ...source } });
		await expect(backlinks).toHaveCount(0);
		source.relativePath = 'other/source.md';
		source.content = '# Source\n\n[[../docs/target]]\n';
		source.updatedAt++;
		await commit(remote, source);
		events.push({ action: 'move-source', row: { ...source } });
		await expect(backlinks).toContainText('source');
		await commit(remote, source, true);
		events.push({ action: 'remove', id: source.id });
		await expect(backlinks).toHaveCount(0);
		source.updatedAt++;
		await commit(remote, source);
		events.push({ action: 'restore', row: { ...source } });
		await expect(backlinks).toContainText('source');
		const filename = page.locator('input[aria-label^="File name"]');
		await filename.fill('renamed');
		await filename.press('Enter');
		await expect(filename).toHaveAttribute('title', 'renamed');
		await expect(filename).toHaveValue('renamed');
		await expect(backlinks).toContainText('source');
		await backlinks.getByRole('button', { name: /source/ }).click();
		await expect(editor).toContainText('[[../docs/renamed]]');
		await page.locator('button[data-mode="read"]').click();
		await page.locator('.mdsh-preview a.wiki-link').click();
		await expect(filename).toHaveValue('renamed');
		await info.attach('project-wiki-updates.png', {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
	} finally {
		await info.attach('project-wiki-updates.json', {
			body: JSON.stringify(
				{ ...info.config.metadata, fixtures, events, status: info.status },
				null,
				2
			),
			contentType: 'application/json'
		});
		await remote.close();
	}
});
