import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, seedFiles, writeSourceContent } from './helpers';
import { createHash } from 'node:crypto';
import { baselineStats, statsFixture } from './fixtures/stats';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function seedTwo(page: Page) {
	await seedFiles(page, [
		{ name: 'First', content: 'Premier document.' },
		{ name: 'Second', content: 'Second document.' }
	]);
}

test('the logo opens the start view and keeps tabs and pending edits', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await seedTwo(page);
	const editor = page.locator('.cm-content').first();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' Modification non enregistrée.');

	const logo = page.getByTestId('home-logo');
	await logo.click();
	await expect(page.getByTestId('welcome-new')).toBeVisible();
	await expect(
		page.locator('main').getByRole('button', { name: /Retrouver vos documents/ })
	).toBeVisible();
	await expect(
		page
			.locator('aside')
			.getByRole('button', { name: /^First/ })
			.first()
	).toBeVisible();
	await expect(
		page
			.locator('aside')
			.getByRole('button', { name: /^Second/ })
			.first()
	).toBeVisible();

	await page
		.locator('aside')
		.getByRole('button', { name: /^Second/ })
		.first()
		.click();
	await expect(page.locator('.cm-content').first()).toContainText('Modification non enregistrée.');

	await logo.focus();
	await expect(logo).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('welcome-new')).toBeVisible();

	await info.attach('logo-home.json', {
		body: JSON.stringify({
			welcomeVisible: true,
			libraryCount: await page
				.locator('main')
				.getByRole('button', { name: /Retrouver vos documents/ })
				.innerText(),
			unsavedContentKept: true
		}),
		contentType: 'application/json'
	});
	await info.attach('logo-home.png', { body: await page.screenshot() });
});

test('counts the current selection in Source, Edit and Read', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const content = 'Un cœur 🎉\n\nDeuxième ligne';
	await writeSourceContent(page, content);
	const expected = await page.evaluate((text) => {
		const trimmed = text.trim();
		return {
			chars: Array.from(text).length,
			words: trimmed.split(/\s+/u).length,
			lines: text.split('\n').length
		};
	}, content);

	const status = page.getByTestId('document-stats');
	const selection = page.getByTestId('selection-stats');
	const source = page.locator('.cm-content').first();
	await source.click();
	await page.keyboard.press('ControlOrMeta+a');
	await expect(selection).toBeVisible();
	await expect(status).toContainText(`${expected.words} mots`);
	await expect(status).toContainText(`${expected.chars} car.`);
	await expect(status).toContainText(`${expected.lines} lignes`);

	await page.keyboard.press('ArrowRight');
	await expect(selection).toHaveCount(0);
	await expect(status).toContainText(`${expected.words} mots`);

	await page.locator('button[data-mode="wysiwyg"]').click();
	const visual = page.locator('.ProseMirror');
	await expect(visual).toBeVisible({ timeout: 20_000 });
	await visual.click();
	await page.keyboard.press('ControlOrMeta+a');
	await expect(selection).toBeVisible();
	await expect(status).toContainText(`${expected.words} mots`);

	await page.locator('button[data-mode="read"]').click();
	const paragraph = page.locator('.mdsh-preview p').first();
	await expect(paragraph).toBeVisible();
	await paragraph.selectText();
	await expect(selection).toBeVisible();
	const readText = await page.evaluate(() => window.getSelection()?.toString() ?? '');
	await expect(status).toContainText(`${Array.from(readText).length} car.`);

	await info.attach('selection-stats.json', {
		body: JSON.stringify({ content, expected, readText }, null, 2),
		contentType: 'application/json'
	});
	await info.attach('selection-stats.png', { body: await page.screenshot() });
});

test('stats keep the latest file during coalesced edits and mode changes', async ({
	page
}, info) => {
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Stats first', content: '# First\n\nOne `ignored code` clear word 🎉.' },
		{ name: 'Stats second', content: 'Second note.' }
	]);
	const status = page.getByTestId('document-stats');
	const source = page.locator('.cm-content').first();
	await source.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' More words.');
	await page
		.locator('aside')
		.getByRole('button', { name: /^Stats first/ })
		.first()
		.click();
	await expect(status).toContainText('5 mots');
	await page
		.locator('aside')
		.getByRole('button', { name: /^Stats second/ })
		.first()
		.click();
	await expect(status).toContainText('4 mots');
	for (const mode of ['wysiwyg', 'read', 'source'] as const) {
		await page.locator(`button[data-mode="${mode}"]`).click();
		await expect(status).toContainText('4 mots');
	}
	await source.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' Last.');
	await expect(source).toBeFocused();
	await expect(status).toContainText('5 mots');
	await expect(source).toBeFocused();
	await info.attach('stats-switch.json', {
		body: JSON.stringify({
			status: await status.innerText(),
			focused: true,
			modes: ['source', 'wysiwyg', 'read']
		}),
		contentType: 'application/json'
	});
});

for (const bytes of [1_000_000, 5_000_000]) {
	for (const shape of ['multiline', 'single-line'] as const) {
		test(`stats stay fresh without focus loss for ${bytes} byte ${shape} notes`, async ({
			page
		}, info) => {
			test.setTimeout(120_000);
			await resetAppState(page);
			const content = statsFixture(bytes, shape);
			await page.evaluate(async (text) => {
				await new Promise<void>((resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const db = request.result;
						const tx = db.transaction('drafts', 'readwrite');
						tx.objectStore('drafts').put({
							id: 'stats-large',
							name: 'Stats large.md',
							content: text,
							createdAt: 1_700_000_000_000,
							updatedAt: 1_700_000_000_000,
							order: 0,
							open: true
						});
						tx.oncomplete = () => {
							db.close();
							resolve();
						};
						tx.onerror = () => {
							db.close();
							reject(tx.error);
						};
					};
				});
				localStorage.setItem('mdsh:activeId', 'stats-large');
			}, content);
			await page.reload();
			await page.locator('button[data-mode="source"]').click();
			const source = page.locator('.cm-content').first();
			await expect(source).toBeVisible();
			await source.click();
			await page.keyboard.press('ControlOrMeta+End');
			const status = page.getByTestId('document-stats');
			const cdp = await page.context().newCDPSession(page);
			const samples = [];
			let expected = baselineStats(content);
			for (let sample = 0; sample < 5; sample += 1) {
				await cdp.send('HeapProfiler.collectGarbage');
				const before = await cdp.send('Runtime.getHeapUsage');
				const start = Date.now();
				const input = await page.evaluate(async () => {
					const start = performance.now();
					const inserted = document.execCommand('insertText', false, ' extra');
					const synchronousMs = performance.now() - start;
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
					return { inserted, synchronousMs, inputToFrameMs: performance.now() - start };
				});
				expect(input.inserted).toBe(true);
				expected = baselineStats(content + ' extra'.repeat(sample + 1));
				await expect(status).toContainText(`${expected.chars} car.`);
				await expect(status).toContainText(`${expected.words} mots`);
				await expect(status).toContainText(`${expected.lines} lignes`);
				await expect(source).toBeFocused();
				const publicationWallMs = Date.now() - start;
				const temporary = await cdp.send('Runtime.getHeapUsage');
				await cdp.send('HeapProfiler.collectGarbage');
				samples.push({
					sample,
					...input,
					publicationWallMs,
					before,
					temporary,
					retained: await cdp.send('Runtime.getHeapUsage')
				});
			}
			await cdp.detach();
			await info.attach('stats-large.json', {
				body: JSON.stringify(
					{
						bytes,
						shape,
						sha256: createHash('sha256').update(content).digest('hex'),
						expected,
						status: await status.innerText(),
						samples,
						method:
							'Five in-page execCommand inserts to the next animation frame; no warmup. Publication includes assertion polling. CDP main-page heap is not Worker heap or process RSS.',
						focusRetained: true,
						browser: info.project.name,
						source: info.config.metadata
					},
					null,
					2
				),
				contentType: 'application/json'
			});
		});
	}
}

async function seedStatsFiles(page: Page, files: { name: string; content: string }[]) {
	await page.evaluate(async (files) => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction('drafts', 'readwrite');
				for (const [index, file] of files.entries()) {
					tx.objectStore('drafts').put({
						...file,
						id: `stats-${index}`,
						createdAt: 1_700_000_000_000,
						updatedAt: 1_700_000_000_000,
						order: index,
						open: true
					});
				}
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => {
					db.close();
					reject(tx.error);
				};
			};
		});
		localStorage.setItem('mdsh:activeId', `stats-${files.length - 1}`);
	}, files);
	await page.reload();
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content').first()).toBeVisible();
}

test('stats remain available when Workers are unavailable', async ({ page }, info) => {
	await page.addInitScript(() => Object.defineProperty(window, 'Worker', { value: undefined }));
	await resetAppState(page);
	const content = statsFixture(300_000, 'multiline');
	await seedStatsFiles(page, [{ name: 'Stats fallback', content }]);
	const source = page.locator('.cm-content').first();
	await source.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' extra');
	const status = page.getByTestId('document-stats');
	const expected = baselineStats(content + ' extra');
	await expect(status).toContainText(`${expected.words} mots`);
	await expect(status).toContainText(`${expected.chars} car.`);
	await expect(page.locator('.cm-content').first()).toBeFocused();
	await info.attach('stats-without-worker.json', {
		body: JSON.stringify({
			expected,
			sha256: createHash('sha256').update(content).digest('hex'),
			status: await status.innerText()
		}),
		contentType: 'application/json'
	});
});

test('stats reject superseded large-note edits after a file switch', async ({ page }, info) => {
	test.setTimeout(60_000);
	await resetAppState(page);
	const content = statsFixture(300_000, 'multiline');
	await seedStatsFiles(page, [
		{ name: 'Stats small', content: 'Small note.' },
		{ name: 'Stats pending', content }
	]);
	const source = page.locator('.cm-content').first();
	await source.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' final');
	await page
		.locator('aside')
		.getByRole('button', { name: /^Stats small/ })
		.first()
		.click();
	const status = page.getByTestId('document-stats');
	await expect(status).toContainText('2 mots');
	await page.waitForTimeout(500);
	await expect(status).toContainText('11 car.');
	await page
		.locator('aside')
		.getByRole('button', { name: /^Stats pending/ })
		.first()
		.click();
	const expected = baselineStats(content + ' final');
	await expect(status).toContainText(`${expected.chars} car.`);
	await expect(status).toContainText(`${expected.words} mots`);
	await info.attach('stats-superseded.json', {
		body: JSON.stringify({ expected, status: await status.innerText(), smallNotePreserved: true }),
		contentType: 'application/json'
	});
});

test('scroll controls reach both ends of long notes in every mode', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	const long = Array.from({ length: 160 }, (_, index) => `Ligne ${index + 1}.`).join('\n\n');
	await writeSourceContent(page, long);
	const top = page.getByTestId('scroll-top');
	const bottom = page.getByTestId('scroll-bottom');

	await page.locator('.cm-scroller').evaluate((element) => {
		element.scrollTop = 0;
	});
	await expect(bottom).toBeVisible();
	await expect(top).toBeDisabled();
	await bottom.click();
	await expect
		.poll(() =>
			page.locator('.cm-scroller').evaluate((element) => {
				return element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
			})
		)
		.toBe(true);
	await expect(top).toBeEnabled();
	await top.click();
	await expect
		.poll(() => page.locator('.cm-scroller').evaluate((element) => element.scrollTop))
		.toBe(0);
	await expect(top).toBeDisabled();

	await page.locator('.cm-scroller').evaluate((element) => {
		element.scrollTop = 0;
	});
	await expect(top).toBeDisabled();
	await page.keyboard.press('Alt+End');
	await expect
		.poll(() =>
			page
				.locator('.cm-scroller')
				.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2)
		)
		.toBe(true);
	await page.keyboard.press('Alt+Home');
	await expect
		.poll(() => page.locator('.cm-scroller').evaluate((element) => element.scrollTop))
		.toBe(0);

	for (const mode of ['wysiwyg', 'read'] as const) {
		await page.locator(`button[data-mode="${mode}"]`).click();
		const scroller = mode === 'read' ? '.mdsh-read' : '.mdsh-editor';
		await expect(page.locator(scroller)).toBeVisible({ timeout: 20_000 });
		await expect(bottom).toBeVisible();
		await bottom.click();
		await expect
			.poll(() =>
				page
					.locator(scroller)
					.evaluate(
						(element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2
					)
			)
			.toBe(true);
		await top.click();
		await expect
			.poll(() => page.locator(scroller).evaluate((element) => element.scrollTop))
			.toBe(0);
	}

	await page.setViewportSize({ width: 390, height: 700 });
	await expect(top).toBeVisible();
	const box = await top.boundingBox();
	expect(box?.width ?? 0).toBeGreaterThanOrEqual(36);
	expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);

	await info.attach('scroll-navigation.json', {
		body: JSON.stringify({
			modes: ['source', 'wysiwyg', 'read'],
			keyboard: ['Alt+Home', 'Alt+End']
		}),
		contentType: 'application/json'
	});
	await info.attach('scroll-navigation.png', { body: await page.screenshot() });
});
