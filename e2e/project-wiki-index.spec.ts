import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const baseline = process.env.PROJECT_WIKI_BASELINE === '1';
const sizes = process.env.PROJECT_WIKI_SIZES?.split(',').map(Number) ?? [300, 600, 3000];

function fixture(count: number) {
	return Array.from({ length: count }, (_, i) => ({
		id: `wiki-${i}`,
		name: `note-${i}.md`,
		projectId: 'wiki-project',
		relativePath: `notes/note-${i}.md`,
		content: `# Note ${i}\n\n[[wiki-${(i + 1) % count}]]\n`,
		kind: 'note',
		order: i,
		open: true,
		createdAt: 1,
		updatedAt: 1
	}));
}

for (const count of sizes) {
	test(`project wiki documentSwitch and backlinks at ${count} documents`, async ({
		page,
		browser,
		context
	}, info) => {
		test.setTimeout(180_000);
		const rows = fixture(count);
		const evidence: Record<string, unknown> = {
			...info.config.metadata,
			baseline,
			documents: count,
			fixtureSha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
			browser: browser.version(),
			buildMode: 'production-static-instrumented',
			method:
				'Wall clock from a sidebar click to matching editor content. One warmup, five samples. CPU and heap cover these switches. No existing budget is changed.',
			rawMs: [] as number[]
		};
		const session = await context.newCDPSession(page);
		try {
			await resetAppState(page, { mode: 'source' });
			await page.evaluate(async (rows) => {
				await new Promise<void>((resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const db = request.result;
						const tx = db.transaction(['drafts', 'projects'], 'readwrite');
						const drafts = tx.objectStore('drafts');
						drafts.clear();
						for (const row of rows) drafts.put(row);
						tx.objectStore('projects').put({
							id: 'wiki-project',
							name: 'Wiki project',
							createdAt: 1,
							updatedAt: 1
						});
						tx.oncomplete = () => {
							db.close();
							resolve();
						};
						tx.onerror = () => reject(tx.error);
					};
				});
				localStorage.setItem('mdsh:activeId', 'wiki-0');
				localStorage.setItem('mdsh:locale', 'en');
				localStorage.setItem('mdsh:mode', 'source');
			}, rows);
			await page.reload();
			const editor = page.locator('.cm-content').first();
			await expect(editor).toContainText('# Note 0', { timeout: 90_000 });
			const backlinks = page.locator('aside [aria-label="Backlinks"]');
			await expect(backlinks).toContainText(`note-${count - 1}`);
			await session.send('Profiler.enable');
			await session.send('Profiler.start');
			evidence.heapBefore = await session.send('Runtime.getHeapUsage');
			for (let sample = -1; sample < 5; sample++) {
				const target = sample + 2;
				const start = performance.now();
				await page.locator(`aside button[data-file-id="wiki-${target}"]`).click();
				await expect(editor).toContainText(`# Note ${target}`);
				if (sample >= 0) (evidence.rawMs as number[]).push(performance.now() - start);
				await expect(backlinks).toContainText(`note-${target - 1}`);
			}
			evidence.heapAfter = await session.send('Runtime.getHeapUsage');
			const profile = await session.send('Profiler.stop');
			await info.attach('documentSwitch.cpuprofile', {
				body: JSON.stringify(profile.profile),
				contentType: 'application/json'
			});
			const samples = [...(evidence.rawMs as number[])].sort((a, b) => a - b);
			evidence.p50Ms = samples[Math.ceil(samples.length * 0.5) - 1];
			evidence.p95Ms = samples[Math.ceil(samples.length * 0.95) - 1];
			const rebuilds = await page.evaluate(
				() => performance.getEntriesByName('project-wiki-index-rebuild').length
			);
			evidence.rebuilds = rebuilds;
			if (!baseline) {
				expect(rebuilds).toBe(1);
				await editor.click();
				await page.keyboard.press('ControlOrMeta+a');
				await page.keyboard.insertText('# Note 6\n\n[[wiki-8]]\n');
				await expect(page.locator('.title-save')).toHaveText('saved');
				await page.locator('aside button[data-file-id="wiki-7"]').click();
				await expect(editor).toContainText('# Note 7');
				await expect(backlinks).toHaveCount(0);
				await page.locator('aside button[data-file-id="wiki-8"]').click();
				await expect(editor).toContainText('# Note 8');
				await expect(backlinks).toContainText('note-6');
				await expect(backlinks).toContainText('note-7');
				evidence.rebuildsAfterEdit = await page.evaluate(
					() => performance.getEntriesByName('project-wiki-index-rebuild').length
				);
				expect(evidence.rebuildsAfterEdit).toBe(rebuilds);
			}
			await info.attach('project-wiki.png', {
				body: await page.screenshot(),
				contentType: 'image/png'
			});
		} finally {
			evidence.status = info.status;
			await info.attach('project-wiki.json', {
				body: JSON.stringify(evidence, null, 2),
				contentType: 'application/json'
			});
			await session.detach();
		}
	});
}
