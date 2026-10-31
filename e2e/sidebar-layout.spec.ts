import { expect, test } from '@playwright/test';
import { resetAppState } from './helpers';

for (const touch of [false, true]) {
	test.describe(touch ? 'Touch library' : 'Project library', () => {
		test.use({ hasTouch: touch, viewport: { width: 820, height: 900 }, reducedMotion: 'reduce' });

		test('keeps every row reachable in a large sidebar', async ({ page }, testInfo) => {
			await resetAppState(page);
			await page.evaluate(async (touch) => {
				await new Promise<void>((resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const database = request.result;
						const transaction = database.transaction('drafts', 'readwrite');
						for (let index = 0; index < 120; index++) {
							transaction.objectStore('drafts').put({
								id: `sidebar-${index}`,
								name: `Document ${String(index).padStart(3, '0')}.md`,
								content: 'A local draft.',
								createdAt: 1,
								updatedAt: 1,
								order: index,
								open: true,
								...(!touch
									? { projectId: 'sidebar-project', relativePath: `notes/${index}.md` }
									: {})
							});
						}
						transaction.oncomplete = () => {
							database.close();
							resolve();
						};
						transaction.onabort = () => {
							database.close();
							reject(transaction.error);
						};
					};
				});
				localStorage.setItem('mdsh:activeId', 'sidebar-0');
			}, touch);
			await page.reload();
			const sidebar = page.locator('#files-panel');
			const rows = sidebar.locator('.mdsh-file-row');
			await expect(rows.first()).toBeVisible();
			const scroll = sidebar.locator('div.overflow-y-auto').first();
			const firstHeight = await rows.first().evaluate((row) => row.getBoundingClientRect().height);
			expect(firstHeight).toBeGreaterThanOrEqual(touch ? 52 : 48);
			await expect
				.poll(() => scroll.evaluate((element) => element.scrollHeight))
				.toBeGreaterThanOrEqual(firstHeight * 120);
			const observed = new Set<string>();
			const geometry: unknown[] = [];
			for (let step = 0; step < 40; step++) {
				const frame = await scroll.evaluate((element) => {
					const bounds = element.getBoundingClientRect();
					return {
						scrollTop: element.scrollTop,
						scrollHeight: element.scrollHeight,
						clientHeight: element.clientHeight,
						visible: Array.from(element.querySelectorAll<HTMLButtonElement>('[data-file-id]'))
							.filter((button) => {
								const r = button.getBoundingClientRect();
								return r.bottom > bounds.top && r.top < bounds.bottom;
							})
							.map((button) => button.dataset.fileId!)
					};
				});
				geometry.push(frame);
				frame.visible.forEach((id) => observed.add(id));
				if (frame.scrollTop + frame.clientHeight >= frame.scrollHeight - 1) break;
				await scroll.evaluate((element) => {
					element.scrollTop += element.clientHeight / 2;
				});
				await page.waitForTimeout(30);
			}
			expect(observed.size).toBe(120);
			await expect(sidebar.locator('[data-file-id="sidebar-119"]')).toBeInViewport();
			await testInfo.attach('sidebar-layout.json', {
				body: JSON.stringify(
					{
						touch,
						fixture: '120 open drafts with project paths or touch controls',
						firstHeight,
						observed: [...observed],
						geometry
					},
					null,
					2
				),
				contentType: 'application/json'
			});
			await testInfo.attach('sidebar-layout.png', {
				body: await page.screenshot(),
				contentType: 'image/png'
			});
		});
	});
}
