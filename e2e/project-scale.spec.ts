import { expect, test, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });
test.setTimeout(120_000);

test('opens a 1500-document project within the scale budget', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await page.evaluate(async () => {
		const request = indexedDB.open('mdsh');
		await new Promise<void>((resolve, reject) => {
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction(['drafts', 'projects'], 'readwrite');
				const drafts = transaction.objectStore('drafts');
				drafts.clear();
				for (let index = 0; index < 1500; index++) {
					const folder = `section-${String(index % 50).padStart(2, '0')}`;
					const nested = `part-${Math.floor(index / 50) % 4}`;
					const name = `note-${String(index).padStart(4, '0')}.md`;
					drafts.put({
						id: `scale-${index}`,
						name,
						content: `# Note ${index}\n\n` + 'Representative project content. '.repeat(40),
						projectId: 'scale-project',
						relativePath: `${folder}/${nested}/${name}`,
						createdAt: 1 + index,
						updatedAt: 1 + index,
						order: index,
						open: index === 0
					});
				}
				const projects = transaction.objectStore('projects');
				projects.clear();
				projects.put({
					id: 'scale-project',
					name: 'Scale project',
					createdAt: 1,
					updatedAt: 1
				});
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
		});
		localStorage.setItem('mdsh:activeId', 'scale-0');
	});
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();

	const started = Date.now();
	await page.getByTestId('projects-open').click();
	await expect
		.poll(
			() =>
				page.evaluate(
					() => document.querySelectorAll('[role="dialog"] [data-project-document]').length
				),
			{ timeout: 60_000 }
		)
		.toBe(1500);
	const elapsed = Date.now() - started;
	expect(elapsed).toBeLessThan(30_000);
	await expect(page.getByRole('dialog')).toContainText('Scale project');

	await info.attach('project-scale.json', {
		body: JSON.stringify({ documents: 1500, elapsedMs: elapsed, limitMs: 30_000 }, null, 2),
		contentType: 'application/json'
	});
	await info.attach('project-scale.png', { body: await page.screenshot() });
});
