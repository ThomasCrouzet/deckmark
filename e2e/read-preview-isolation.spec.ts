import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

test.use({ serviceWorkers: 'block' });

const pixel =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const documents = {
	'alpha/Alpha.md':
		'# Alpha preview\n\n[Alpha child](child.md)\n\n![Remote](https://preview-test.invalid/image.png)',
	'alpha/child.md': '# Alpha child target',
	'beta/Beta.md': `# Beta preview\n\n[Beta child](child.md)\n\n![Local](data:image/png;base64,${pixel})`,
	'beta/child.md': '# Beta child target'
};

async function importFixture(page: Page) {
	const zip = new (await import('jszip')).default();
	for (const [path, source] of Object.entries(documents)) zip.file(path, source);
	const bytes = await zip.generateAsync({ type: 'nodebuffer' });
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name: 'Preview isolation.zip',
		mimeType: 'application/zip',
		buffer: bytes
	});
	await panel.getByRole('button', { name: 'Ouvrir beta/Beta.md', exact: true }).click();
	await page.getByTestId('projects-open').click();
	await panel.getByRole('button', { name: 'Ouvrir alpha/Alpha.md', exact: true }).click();
	return bytes;
}

async function holdImageDecode(page: Page) {
	await page.evaluate(() => {
		const original = window.createImageBitmap;
		let resume!: () => void;
		const gate = new Promise<void>((resolve) => (resume = resolve));
		delete document.documentElement.dataset.readDecode;
		window.createImageBitmap = ((image: ImageBitmapSource) => {
			document.documentElement.dataset.readDecode = 'waiting';
			return gate.then(() => original(image));
		}) as typeof createImageBitmap;
		window.addEventListener(
			'release-read-decode',
			() => {
				window.createImageBitmap = original;
				resume();
			},
			{ once: true }
		);
	});
}

async function releaseImageDecode(page: Page) {
	await page.evaluate(() => window.dispatchEvent(new Event('release-read-decode')));
}

async function selectFile(page: Page, name: string) {
	await page
		.locator('aside')
		.getByRole('button', { name: `${name} (${name.toLowerCase()}/${name}.md)`, exact: true })
		.click();
	await expect(page.locator('#app-toolbar input')).toHaveValue(name);
}

async function activeFileId(page: Page) {
	return page
		.locator('aside button[data-file-id][aria-current="true"]')
		.getAttribute('data-file-id');
}

for (const outcome of ['complete', 'switch back'] as const) {
	test(`a delayed Read preview hides the previous file before ${outcome}`, async ({
		page,
		browser
	}, info) => {
		await resetAppState(page);
		const fixture = await importFixture(page);
		await info.attach('project-input.zip', { body: fixture, contentType: 'application/zip' });
		await page.locator('[data-mode=read]').click();
		await expect(page.locator('.mdsh-preview h1')).toHaveText('Alpha preview');
		await expect(page.locator('.mdsh-remote-images-notice')).toBeVisible();
		const alphaId = await activeFileId(page);
		await holdImageDecode(page);
		try {
			await selectFile(page, 'Beta');
			const betaId = await activeFileId(page);
			await expect(page.locator('html')).toHaveAttribute('data-read-decode', 'waiting');
			await expect(page.locator('.mdsh-read-loading')).toBeVisible();
			const oldLink = page.locator('.mdsh-preview').getByRole('link', { name: 'Alpha child' });
			const oldLinkVisible = await oldLink.isVisible();
			const pendingText = await page.locator('.mdsh-read').innerText();
			const oldImageNoticeVisible = await page.locator('.mdsh-remote-images-notice').isVisible();
			await info.attach('pending-preview.png', {
				body: await page.screenshot(),
				contentType: 'image/png'
			});
			// Exercise the original wrong-directory navigation when the stale link remains.
			if (oldLinkVisible) {
				await oldLink.click();
				await expect(page.locator('.mdsh-preview h1')).toHaveText('Beta child target');
			}
			const afterActivationId = await activeFileId(page);
			await info.attach('pending-state.json', {
				body: JSON.stringify({
					browser: browser.version(),
					documents,
					alphaId,
					betaId,
					pendingText,
					oldLinkVisible,
					oldImageNoticeVisible,
					afterActivationId
				}),
				contentType: 'application/json'
			});
			expect.soft(oldLinkVisible).toBe(false);
			expect.soft(pendingText).not.toContain('Alpha preview');
			expect.soft(afterActivationId).toBe(betaId);
			expect.soft(oldImageNoticeVisible).toBe(false);
			if (outcome === 'switch back') {
				await selectFile(page, 'Alpha');
				await expect(page.locator('.mdsh-preview h1')).toHaveText('Alpha preview');
			} else if (oldLinkVisible) await selectFile(page, 'Beta');
			await releaseImageDecode(page);
			if (outcome === 'complete') {
				await expect(page.locator('.mdsh-preview h1')).toHaveText('Beta preview');
				await page.locator('.mdsh-preview').getByRole('link', { name: 'Beta child' }).click();
				await expect(page.locator('.mdsh-preview h1')).toHaveText('Beta child target');
			} else {
				await expect(page.locator('.mdsh-read-loading')).toHaveCount(0);
				await expect(page.locator('.mdsh-preview h1')).toHaveText('Alpha preview');
				await page
					.locator('.mdsh-preview')
					.getByRole('link', { name: 'Alpha child' })
					.press('Enter');
				await expect(page.locator('.mdsh-preview h1')).toHaveText('Alpha child target');
			}
			await info.attach('final-preview.png', {
				body: await page.screenshot(),
				contentType: 'image/png'
			});
		} finally {
			await releaseImageDecode(page);
		}
	});
}

test('a same-file theme render retains its preview and link context', async ({
	page,
	browser
}, info) => {
	await resetAppState(page);
	await page.emulateMedia({ colorScheme: 'light' });
	await page.keyboard.press('ControlOrMeta+,');
	await page.getByRole('button', { name: 'Système', exact: true }).click();
	await page.keyboard.press('Escape');
	const fixture = await importFixture(page);
	await info.attach('project-input.zip', { body: fixture, contentType: 'application/zip' });
	await selectFile(page, 'Beta');
	await page.locator('[data-mode=read]').click();
	await expect(page.locator('.mdsh-preview h1')).toHaveText('Beta preview');
	await holdImageDecode(page);
	try {
		await page.emulateMedia({ colorScheme: 'dark' });
		await expect(page.locator('html')).toHaveAttribute('data-read-decode', 'waiting');
		await expect(page.locator('.mdsh-read-loading')).toBeVisible();
		await expect(page.locator('.mdsh-preview h1')).toHaveText('Beta preview');
		await info.attach('same-file-pending.png', {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
		await page.locator('.mdsh-preview').getByRole('link', { name: 'Beta child' }).press('Enter');
		await expect(page.locator('.mdsh-preview h1')).toHaveText('Beta child target');
		await releaseImageDecode(page);
		await expect(page.locator('.mdsh-preview h1')).toHaveText('Beta child target');
		await info.attach('same-file-result.json', {
			body: JSON.stringify({
				browser: browser.version(),
				documents,
				activeFileId: await activeFileId(page)
			}),
			contentType: 'application/json'
		});
	} finally {
		await releaseImageDecode(page);
	}
});
