import { expect, test } from '@playwright/test';

test('explains unavailable storage and retries without clearing the library', async ({
	page
}, info) => {
	await page.addInitScript(() => {
		if (sessionStorage.getItem('mdsh:test-allow-idb') === '1') return;
		indexedDB.open = (() => {
			throw new Error('Storage access denied by the test.');
		}) as IDBFactory['open'];
	});
	await page.goto('/');
	const banner = page.getByRole('alert').filter({ hasText: /stockage|storage/i });
	await expect(banner).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId('retry-storage')).toBeVisible();
	await expect(page.locator('.mdsh-shell')).toHaveAttribute('inert', '');

	await page.evaluate(() => sessionStorage.setItem('mdsh:test-allow-idb', '1'));
	await page.getByTestId('retry-storage').click();
	await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible({
		timeout: 15_000
	});
	const rows = await page.evaluate(
		() =>
			new Promise<number>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const count = request.result.transaction('drafts').objectStore('drafts').count();
					count.onsuccess = () => {
						request.result.close();
						resolve(count.result);
					};
					count.onerror = () => reject(count.error);
				};
			})
	);
	expect(rows).toBe(0);
	await info.attach('storage-retry.json', {
		body: JSON.stringify({ retried: true, rows }),
		contentType: 'application/json'
	});
});
