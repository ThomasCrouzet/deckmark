import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, seedFiles, writeSourceContent } from './helpers';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { baselineSelection, baselineStats, statsFixture } from './fixtures/stats';
import { enableTypewriter, installTypewriterProbe } from './typewriter-helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

test('typewriter coalesces caret bursts and cancels work on mode exit', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(
		page,
		Array.from({ length: 80 }, () => 'wrapped text '.repeat(40)).join('\n')
	);
	await page.locator('.cm-content').press('ControlOrMeta+Home');
	await enableTypewriter(page);
	await installTypewriterProbe(page);
	await page.evaluate(async () => {
		await window.typewriterProbe.ready();
		window.typewriterProbe.burst(30, true);
		await window.typewriterProbe.settle();
	});
	const burst = await page.evaluate(() => window.typewriterProbe.sample());
	await info.attach('typewriter-burst.json', {
		body: JSON.stringify(burst, null, 2),
		contentType: 'application/json'
	});
	expect.soft(burst.head - burst.anchor).toBe(30);
	expect
		.soft(burst.maxPending, 'one CodeMirror measure frame, no per-key frames')
		.toBeLessThanOrEqual(2);
	expect
		.soft(burst.centerHeads.length, 'the coalescing burst must centre at least once')
		.toBeGreaterThanOrEqual(1);
	expect.soft(burst.centerHeads.length).toBeLessThanOrEqual(1);
	expect.soft(burst.centerHeads.every((head) => head === burst.head)).toBe(true);
	await page.evaluate(async () => {
		await window.typewriterProbe.ready();
		window.typewriterProbe.burst(1, false);
		await window.typewriterProbe.settle();
	});
	const centered = await page.evaluate(() => window.typewriterProbe.sample());
	await info.attach('typewriter-centered.json', {
		body: JSON.stringify(centered, null, 2),
		contentType: 'application/json'
	});
	expect.soft(centered.centerHeads, 'collapsing a centered selection needs no scroll').toEqual([]);
	await page.evaluate(async () => {
		window.typewriterProbe.burst(30, false);
		(document.querySelector('button[data-mode="read"]') as HTMLButtonElement).click();
		await window.typewriterProbe.settle();
	});
	await expect(page.locator('.cm-content')).toHaveCount(0);
	const exited = await page.evaluate(() => window.typewriterProbe.sample());
	await info.attach('typewriter-exit.json', {
		body: JSON.stringify(exited, null, 2),
		contentType: 'application/json'
	});
	expect(exited.detachedDispatches).toBe(0);
});

async function seedTwo(page: Page) {
	await seedFiles(page, [
		{ name: 'First', content: 'Premier document.' },
		{ name: 'Second', content: 'Second document.' }
	]);
}

test('typewriter cancels queued centering on disable and file switch', async ({ page }, info) => {
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Other', content: 'Other document.' },
		{ name: 'Typewriter', content: 'wrapped text '.repeat(400) }
	]);
	await page.locator('.cm-content').press('ControlOrMeta+Home');
	const results = [];
	for (let cycle = 0; cycle < 3; cycle += 1) {
		await enableTypewriter(page);
		await installTypewriterProbe(page);
		await page.getByRole('button', { name: 'Palette de commandes', exact: true }).click();
		await page.getByRole('dialog').getByRole('combobox').fill('typewriter');
		const disable = page.getByRole('option', { name: /Désactiver le mode typewriter/ });
		await disable.evaluate(async (element) => {
			window.typewriterProbe.burst(30, true);
			(element as HTMLElement).click();
			await window.typewriterProbe.settle();
		});
		await expect(page.locator('body')).not.toHaveClass(/typewriter-mode/);
		const disabled = await page.evaluate(() => window.typewriterProbe.sample());
		results.push(disabled);
		expect.soft(disabled.centerHeads).toEqual([]);
	}
	await enableTypewriter(page);
	await installTypewriterProbe(page);
	await page
		.locator('aside')
		.getByRole('button', { name: /^Other/ })
		.first()
		.evaluate(async (element) => {
			window.typewriterProbe.burst(30, false);
			(element as HTMLElement).click();
			await window.typewriterProbe.settle();
		});
	await expect(page.locator('.cm-content')).toContainText('Other document.');
	const switched = await page.evaluate(() => window.typewriterProbe.sample());
	await info.attach('typewriter-lifecycle.json', {
		body: JSON.stringify({ disabled: results, switched }, null, 2),
		contentType: 'application/json'
	});
	expect(switched.detachedDispatches).toBe(0);
	expect(switched.centerHeads).toEqual([]);
});

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
			page,
			browserName
		}, info) => {
			test.skip(
				browserName !== 'chromium',
				'CDP HeapProfiler sampling is available only in Chromium.'
			);
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

type StatsWorkerPost = {
	url: string;
	mode: string;
	text: number | null;
	hasImage: boolean;
	patch: number | null;
	at: number;
};

// Record statistics Worker messages. A test can hold a document message, so the
// pending state and the Worker round trip are observable without a timing budget.
async function installStatsWorkerProbe(page: Page) {
	await page.addInitScript(() => {
		const posts: StatsWorkerPost[] = [];
		const held: Array<() => void> = [];
		const probe = { posts, hold: false, release: () => {} };
		(
			window as unknown as {
				__statsWorkerProbe: { posts: StatsWorkerPost[]; hold: boolean; release: () => void };
			}
		).__statsWorkerProbe = probe;
		probe.release = () => {
			probe.hold = false;
			for (const send of held.splice(0)) send();
		};
		const NativeWorker = window.Worker;
		class ProbedWorker extends NativeWorker {
			workerUrl = '';

			constructor(url: string | URL, options?: WorkerOptions) {
				super(url, options);
				this.workerUrl = String(url);
			}

			postMessage(message: unknown, transfer?: Transferable[]) {
				const data = message as { text?: unknown; patch?: unknown; mode?: unknown };
				const isDocument = !data || typeof data.mode !== 'string';
				if (data && typeof data === 'object' && ('text' in data || 'patch' in data)) {
					posts.push({
						url: this.workerUrl,
						mode: isDocument ? 'document' : (data.mode as string),
						text: typeof data.text === 'string' ? data.text.length : null,
						hasImage: typeof data.text === 'string' && data.text.includes('data:image'),
						patch:
							data.patch && typeof (data.patch as { insert?: unknown }).insert === 'string'
								? (data.patch as { insert: string }).insert.length
								: null,
						at: performance.now()
					});
				}
				const send = () => {
					try {
						if (transfer) NativeWorker.prototype.postMessage.call(this, message, transfer);
						else NativeWorker.prototype.postMessage.call(this, message);
					} catch {
						// A terminated Worker rejects a late message.
					}
				};
				if (probe.hold && isDocument && this.workerUrl.includes('stats.worker')) held.push(send);
				else send();
			}
		}
		Object.defineProperty(window, 'Worker', { value: ProbedWorker, configurable: true });
	});
}

async function holdStatsWorkerMessages(page: Page, hold: boolean) {
	await page.evaluate((hold) => {
		const probe = (
			window as unknown as {
				__statsWorkerProbe: { hold: boolean; release: () => void };
			}
		).__statsWorkerProbe;
		if (hold) probe.hold = true;
		else probe.release();
	}, hold);
}

async function statsWorkerPosts(page: Page): Promise<StatsWorkerPost[]> {
	return page.evaluate(() => {
		const probe = (window as unknown as { __statsWorkerProbe?: { posts: StatsWorkerPost[] } })
			.__statsWorkerProbe;
		return (probe?.posts ?? []).filter((post) => post.url.includes('stats.worker'));
	});
}

function imageHeavyFixture(bytes: number): string {
	const prose = Array.from(
		{ length: Math.ceil(bytes / 90) },
		(_, index) => `Paragraph ${index} has ordinary words for the counter.`
	).join('\n\n');
	const imageBytes = 120_000;
	const images = Array.from(
		{ length: 6 },
		(_, index) => `![shot ${index}](data:image/png;base64,${'A'.repeat(imageBytes)})`
	).join('\n\n');
	return `# Image note\n\n${prose}\n\n${images}\n`;
}

test('large note switches wait for the statistics Worker', async ({ page }, info) => {
	test.setTimeout(120_000);
	await installStatsWorkerProbe(page);
	await resetAppState(page);
	const first = statsFixture(1_000_000, 'multiline');
	const second = statsFixture(1_000_000, 'single-line');
	await seedStatsFiles(page, [
		{ name: 'Stats first large', content: first },
		{ name: 'Stats second large', content: second }
	]);
	const status = page.getByTestId('document-stats');
	await expect(status).toContainText(`${baselineStats(second).words} mots`, { timeout: 30_000 });
	const before = await statsWorkerPosts(page);
	await holdStatsWorkerMessages(page, true);
	await page
		.locator('aside')
		.getByRole('button', { name: /^Stats first large/ })
		.first()
		.click();
	await expect(status.locator('[aria-busy="true"]')).toBeVisible();
	const during = await statsWorkerPosts(page);
	expect(during.length).toBeGreaterThan(before.length);
	const posted = during.at(-1)!;
	expect(posted.mode).toBe('document');
	expect(posted.text).toBe(first.length);
	const expected = baselineStats(first);
	await holdStatsWorkerMessages(page, false);
	await expect(status).toContainText(`${expected.words} mots`, { timeout: 30_000 });
	await expect(status).toContainText(`${expected.chars} car.`);
	await info.attach('stats-switch-worker.json', {
		body: JSON.stringify(
			{
				expected,
				posts: during,
				status: await status.innerText(),
				method:
					'The probe holds the switch document message in window.Worker; the pending status is read before release. No timing budget is asserted.'
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('image-heavy edits send only the changed span to the statistics Worker', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	await installStatsWorkerProbe(page);
	await resetAppState(page);
	const content = imageHeavyFixture(400_000);
	await seedStatsFiles(page, [{ name: 'Stats images', content }]);
	const status = page.getByTestId('document-stats');
	await expect(status).toContainText(`${baselineStats(content).words} mots`, { timeout: 30_000 });
	const source = page.locator('.cm-content').first();
	await source.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' extra words');
	const edited = content + ' extra words';
	const expected = baselineStats(edited);
	await expect(status).toContainText(`${expected.chars} car.`, { timeout: 30_000 });
	await expect(status).toContainText(`${expected.words} mots`);
	await expect(status).toContainText(`${expected.lines} lignes`);
	const posts = await statsWorkerPosts(page);
	const documents = posts.filter((post) => post.mode === 'document');
	expect(documents.length).toBeGreaterThanOrEqual(2);
	const first = documents[0]!;
	expect(first.text).toBe(content.length);
	expect(first.hasImage).toBe(true);
	const updates = documents.slice(1);
	expect(
		updates.every((post) => post.text === null),
		'no full document copy after the baseline'
	).toBe(true);
	expect(
		updates.every((post) => post.hasImage === false),
		'no Base64 image payload after the baseline'
	).toBe(true);
	expect(
		updates.every((post) => (post.patch ?? Number.POSITIVE_INFINITY) < 1024),
		'only the edited span is transferred'
	).toBe(true);
	await info.attach('stats-image-delta.json', {
		body: JSON.stringify(
			{
				contentBytes: content.length,
				base64Bytes: content.length - content.replace(/data:image[^)]*/g, '').length,
				expected,
				posts,
				status: await status.innerText()
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('selection storms read a long selection once per frame', async ({ page }, info) => {
	test.setTimeout(120_000);
	await page.addInitScript(() => {
		const probe = { toStringCalls: 0 };
		(window as unknown as { __selectionProbe: { toStringCalls: number } }).__selectionProbe = probe;
		const original = Selection.prototype.toString;
		Selection.prototype.toString = function () {
			probe.toStringCalls += 1;
			return original.call(this);
		};
	});
	await resetAppState(page);
	const content = statsFixture(400_000, 'single-line');
	await seedStatsFiles(page, [{ name: 'Stats selection', content }]);
	await page.locator('button[data-mode="read"]').click();
	await page
		.getByRole('button', { name: 'Afficher le document' })
		.click({ timeout: 5000 })
		.catch(() => {});
	const paragraph = page.locator('.mdsh-preview p').first();
	await expect(paragraph).toBeVisible({ timeout: 30_000 });
	const text = await paragraph.evaluate((element) => element.textContent ?? '');
	expect(text.length).toBeGreaterThan(256 * 1024);
	const sample = await page.evaluate((length) => {
		const probe = (window as unknown as { __selectionProbe: { toStringCalls: number } })
			.__selectionProbe;
		const node = document.querySelector('.mdsh-preview p')?.firstChild;
		if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error('No preview text node');
		const selection = window.getSelection();
		if (!selection) throw new Error('No selection');
		const range = document.createRange();
		const before = probe.toStringCalls;
		const limit = Math.min(length, node.length);
		let lastEnd = 0;
		for (let index = 0; index < 200; index += 1) {
			lastEnd = limit - (index % 2);
			range.setStart(node, 0);
			range.setEnd(node, lastEnd);
			selection.removeAllRanges();
			selection.addRange(range);
			document.dispatchEvent(new Event('selectionchange'));
		}
		return {
			before,
			during: probe.toStringCalls,
			lastEnd,
			expectedText: node.textContent?.slice(0, lastEnd) ?? ''
		};
	}, text.length);
	await expect(page.getByTestId('selection-stats')).toBeVisible({ timeout: 30_000 });
	const after = await page.evaluate(
		() =>
			(window as unknown as { __selectionProbe: { toStringCalls: number } }).__selectionProbe
				.toStringCalls
	);
	const expected = baselineSelection(sample.expectedText);
	const status = page.getByTestId('document-stats');
	await expect(status).toContainText(`${expected.words} mots`);
	await expect(status).toContainText(`${expected.chars} car.`);
	await expect(status).toContainText(`${expected.lines} lignes`);
	expect(
		after - sample.before,
		'one Selection.toString per frame, not one per raw selectionchange event'
	).toBeLessThanOrEqual(3);
	await info.attach('stats-selection-storm.json', {
		body: JSON.stringify(
			{
				selectionChars: sample.lastEnd,
				toStringCallsDuringStorm: sample.during - sample.before,
				toStringCallsAfterFrame: after - sample.before,
				expected,
				status: await status.innerText()
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test.describe('stats module lifecycle', () => {
	test.use({ serviceWorkers: 'block' });

	function runtimeRoute(): string {
		const directory = 'build/_app/immutable/chunks';
		const candidates = readdirSync(directory).filter(
			(name) =>
				name.endsWith('.js') &&
				/export\s*\{[^}]*\bcreateStatsRuntime\b/.test(readFileSync(join(directory, name), 'utf8'))
		);
		expect(candidates).toHaveLength(1);
		return `**/_app/immutable/chunks/${candidates[0]}`;
	}

	test('stats wait for their deferred module and keep the latest file', async ({ page }, info) => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let requested = false;
		const asset = runtimeRoute();
		await page.route(asset, async (route) => {
			requested = true;
			await held;
			await route.continue();
		});
		try {
			await resetAppState(page);
			expect(requested).toBe(false);
			await seedStatsFiles(page, [
				{ name: 'Stats delayed first', content: 'First only.' },
				{ name: 'Stats delayed second', content: 'Second has three.' }
			]);
			await expect.poll(() => requested, { timeout: 2000 }).toBe(true);
			const status = page.getByTestId('document-stats');
			await expect(status.locator('[aria-busy="true"]')).toBeVisible();
			await page
				.locator('aside')
				.getByRole('button', { name: /^Stats delayed first/ })
				.first()
				.click();
			release();
			await expect(status).toContainText('2 mots');
			await expect(status).toContainText('11 car.');
			const source = page.locator('.cm-content').first();
			await source.click();
			await page.keyboard.press('ControlOrMeta+End');
			await page.keyboard.insertText(' final');
			await expect(status).toContainText('3 mots');
			await expect(source).toBeFocused();
			await info.attach('stats-deferred.json', {
				body: JSON.stringify({ requested, latestFileKept: true, status: await status.innerText() }),
				contentType: 'application/json'
			});
		} finally {
			release();
		}
	});

	test('stats load failure keeps edits recoverable after reload', async ({
		page,
		browserName
	}, info) => {
		test.skip(
			browserName !== 'chromium',
			'WebKit reuses the failed statistics module after reload.'
		);
		const asset = runtimeRoute();
		await page.route(asset, (route) => route.abort());
		await resetAppState(page);
		await seedStatsFiles(page, [{ name: 'Stats recovery', content: 'One two.' }]);
		await expect(page.getByTestId('stats-load-error')).toBeVisible();
		const source = page.locator('.cm-content').first();
		await source.click();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.insertText(' final');
		await expect(source).toBeFocused();
		await page.waitForTimeout(600);
		await page.unroute(asset);
		await page.reload();
		await page.locator('button[data-mode="source"]').click();
		await expect(source).toContainText('final');
		await expect(page.getByTestId('document-stats')).toContainText('3 mots');
		await info.attach('stats-load-recovery.json', {
			body: JSON.stringify({
				editedWhileUnavailable: true,
				recovered: true,
				status: await page.getByTestId('document-stats').innerText()
			}),
			contentType: 'application/json'
		});
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

test('split navigation discards the outgoing file geometry during rapid jumps', async ({
	page
}, info) => {
	// Two 340 and 370 heading notes exceed the default 30 s budget while WebKit
	// inserts the fixture through real keyboard input. The navigation assertions
	// below stay unchanged.
	test.setTimeout(90_000);
	await resetAppState(page);
	const first = Array.from(
		{ length: 340 },
		(_, index) => `## First heading ${index + 1}\n\nFirst paragraph.`
	).join('\n\n');
	const second = Array.from(
		{ length: 370 },
		(_, index) => `## Second heading ${index + 1}\n\nSecond paragraph.`
	).join('\n\n');
	await seedFiles(page, [
		{ name: 'Geometry First', content: first },
		{ name: 'Geometry Second', content: second }
	]);
	await page.getByRole('button', { name: 'Afficher l’aperçu' }).click();
	const split = page.getByTestId('split-view');
	for (const [name, prefix, count] of [
		['Geometry Second', 'Second', 370],
		['Geometry First', 'First', 340],
		['Geometry Second', 'Second', 370]
	] as const) {
		await page
			.locator('aside')
			.getByRole('button', { name: new RegExp(`^${name}`) })
			.first()
			.click();
		await expect(split.locator('.mdsh-preview h2')).toHaveCount(count);
		for (let index = 0; index < 3; index++) {
			await split.locator('.cm-content').focus();
			await page.waitForTimeout(420);
			await page.keyboard.press('ControlOrMeta+End');
			await expect(
				split.getByRole('heading', { name: `${prefix} heading ${count}`, exact: true })
			).toBeInViewport();
			await page.waitForTimeout(420);
			await split.locator('.mdsh-read').evaluate((element) => {
				element.scrollTop = 0;
			});
			await expect
				.poll(() => split.locator('.cm-scroller').evaluate((element) => element.scrollTop))
				.toBeLessThan(150);
		}
		await expect(split.locator('.cm-content')).toBeFocused();
	}
	await info.attach('split-file-switch.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
	await info.attach('split-files.json', {
		body: JSON.stringify({ first, second }),
		contentType: 'application/json'
	});
});
