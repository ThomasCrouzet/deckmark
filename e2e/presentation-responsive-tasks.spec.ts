import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resetAppState } from './helpers';
import { createPresentation, openPresentationSource } from './presentation-helpers';
import {
	createDeck,
	createElement,
	createSlide,
	serializePresentation
} from '../src/lib/presentation/model';

const widths = [320, 360, 390, 768, 1024, 1280, 1440];
const productFiles = [
	'src/lib/components/NewDocumentDialog.svelte',
	'src/lib/components/Toolbar.svelte',
	'src/lib/presentation/SlideEditor.svelte',
	'src/routes/+page.svelte'
];

type Locale = 'en' | 'fr';
type Cell = {
	width: number;
	height: number;
	orientation: 'portrait' | 'landscape';
	baseWidth: number;
};
type Evidence = Cell & {
	locale: Locale;
	input: string;
	status: string;
	stage: string;
	controls: unknown[];
	motion: unknown[];
	fixture: { text: string; notes: string; invalidSource: string };
	error?: string;
	export?: { bytes: number; expectedSha256: string; actualSha256: string };
};

test('gesture guides clear at pointer cancel, undo and slide switch', async ({
	page,
	context,
	hasTouch
}, info) => {
	test.setTimeout(60000);
	await resetAppState(page);
	await page.evaluate(() => localStorage.setItem('mdsh:locale', 'en'));
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	const editor = await createPresentation(page);
	const fixture = serializePresentation(
		createDeck({
			slides: [
				createSlide({
					id: 'lifecycle-first',
					elements: [
						createElement('rectangle', { id: 'moving', x: 100, y: 100, width: 160, height: 100 }),
						createElement('rectangle', { id: 'fixed', x: 307, y: 400, width: 80, height: 80 })
					]
				}),
				createSlide({ id: 'lifecycle-second' })
			]
		})
	);
	await openPresentationSource(editor);
	await editor.getByTestId('slide-source-editor').fill(fixture);
	await editor.getByTestId('slide-source-apply').click();
	const target = editor.locator('[data-object-id="moving"]');
	await target.click({ trial: true });
	const client = hasTouch ? await context.newCDPSession(page) : null;
	const guides = editor.locator('.guide');
	const samples: unknown[] = [];
	for (const boundary of ['cancel', 'undo', 'slide'] as const) {
		const box = (await target.boundingBox())!;
		const factor = (await editor.getByTestId('slide-canvas').boundingBox())!.width / 1280;
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;
		const hit = await page.evaluate(
			({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-object-id'),
			{ x, y }
		);
		expect(hit, `${boundary} must start on the object, not a resize handle`).toBe('moving');
		samples.push({ boundary, stage: 'pointer-start', box, factor, hit });
		if (client) {
			await client.send('Input.dispatchTouchEvent', {
				type: 'touchStart',
				touchPoints: [{ x, y }]
			});
			await client.send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [{ x: x + 40 * factor, y: y + 13 * factor }]
			});
		} else {
			await page.mouse.move(x, y);
			await page.mouse.down();
			await page.mouse.move(x + 40 * factor, y + 13 * factor);
		}
		await expect(guides.first()).toBeVisible();
		samples.push({
			boundary,
			guides: await guides.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('style')))
		});
		if (boundary === 'cancel') {
			if (client)
				await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
			else
				await target.dispatchEvent('pointercancel', {
					pointerId: 1,
					pointerType: 'mouse',
					clientX: x,
					clientY: y
				});
		} else if (boundary === 'undo') {
			await page.keyboard.press('ControlOrMeta+z');
		} else {
			await editor.getByTestId('slide-thumbnail').last().dispatchEvent('click');
		}
		await expect(guides).toHaveCount(0);
		if (client && boundary !== 'cancel')
			await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		if (!client) await page.mouse.up();
		await expect(guides).toHaveCount(0);
		if (boundary === 'slide') await editor.getByTestId('slide-thumbnail').first().click();
	}
	await target.press('Enter');
	await expect(target).toHaveAttribute('aria-pressed', 'true');
	const beforeKey = (await target.boundingBox())!;
	await page.keyboard.press('ArrowRight');
	const afterKey = (await target.boundingBox())!;
	expect(afterKey.x - beforeKey.x).toBeCloseTo(
		(await editor.getByTestId('slide-canvas').boundingBox())!.width / 1280,
		1
	);
	await info.attach('gesture-lifecycle.json', {
		body: JSON.stringify(
			{
				fixture,
				fixtureSha256: hash(fixture),
				input: hasTouch
					? 'Trusted Chromium CDP touch'
					: 'Trusted mouse with synthetic pointercancel',
				samples,
				keyboardDelta: afterKey.x - beforeKey.x,
				limits: 'Emulated input, not a physical device.'
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await screenshot(page, info, 'gesture-lifecycle');
});

test.afterEach(async ({ browser }, info) => {
	if (info.status === 'skipped') return;
	await info.attach('run-result.json', {
		body: JSON.stringify(
			{
				command: info.config.metadata.command,
				source: info.config.metadata.source,
				workingDiffSha256: info.config.metadata.workingDiffSha256,
				environment: info.config.metadata.environment,
				browser: browser.version(),
				project: info.project.name,
				status: info.status,
				input: info.project.use.hasTouch ? 'Playwright touch taps' : 'Playwright mouse clicks'
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

function hash(bytes: string | Buffer) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function sourceIdentity() {
	return Object.fromEntries(
		await Promise.all(productFiles.map(async (file) => [file, hash(await readFile(file))]))
	);
}

function viewportPairs(portraits: Array<{ width: number; height: number }>): Cell[] {
	return portraits.flatMap(({ width, height }) => [
		{ baseWidth: width, width, height, orientation: 'portrait' as const },
		{ baseWidth: width, width: height, height: width, orientation: 'landscape' as const }
	]);
}

async function screenshot(page: Page, info: TestInfo, name: string) {
	await info.attach(`${name}.png`, { body: await page.screenshot(), contentType: 'image/png' });
}

async function reach(control: Locator, label: string, evidence: Evidence) {
	await expect(control, label).toBeVisible({ timeout: 5000 });
	await expect(control, label).toBeEnabled();
	await control.scrollIntoViewIfNeeded({ timeout: 5000 });
	const measure = () =>
		control.evaluate((element) => {
			const box = element.getBoundingClientRect();
			const x = box.x + box.width / 2;
			const y = box.y + box.height / 2;
			const top = document.elementFromPoint(x, y);
			const editor = element.closest('[data-testid="presentation-editor"]');
			return {
				name: element.getAttribute('aria-label') ?? element.textContent?.trim(),
				box: { x: box.x, y: box.y, width: box.width, height: box.height },
				viewport: { width: innerWidth, height: innerHeight },
				hit: top === element || (top !== null && element.contains(top)),
				topElement: top
					? {
							tag: top.tagName,
							testId: top.getAttribute('data-testid'),
							text: top.textContent?.slice(0, 160)
						}
					: null,
				editor: editor
					? {
							box: editor.getBoundingClientRect().toJSON(),
							scrollTop: editor.scrollTop,
							clientHeight: editor.clientHeight,
							scrollHeight: editor.scrollHeight
						}
					: null,
				focusedControl: document.activeElement?.getAttribute('data-testid'),
				inert: element.closest('[inert]') !== null,
				active: document.activeElement === element
			};
		});
	try {
		await expect.poll(measure, { message: label, timeout: 5000 }).toMatchObject({ hit: true });
	} finally {
		evidence.controls.push({ label, ...(await measure()) });
	}
	const measurement = await measure();
	expect(measurement.inert, label).toBe(false);
}

async function activate(control: Locator, label: string, evidence: Evidence, touch: boolean) {
	evidence.stage = label;
	await reach(control, label, evidence);
	if (touch) await control.tap({ timeout: 5000 });
	else await control.click({ timeout: 5000 });
}

async function fill(
	control: Locator,
	label: string,
	value: string,
	evidence: Evidence,
	touch: boolean
) {
	evidence.stage = label;
	await reach(control, label, evidence);
	// Edit text focuses its textarea. Enter text without a second pointer action.
	if (!(await control.evaluate((element) => document.activeElement === element))) {
		await activate(control, label, evidence, touch);
	}
	await expect(control).toBeFocused();
	await control.fill(value);
	await expect(control).toHaveValue(value);
}

async function compareMotion(page: Page, evidence: Evidence) {
	const selector = '#app-toolbar input, [data-testid="slide-present"]';
	const fileName =
		evidence.locale === 'en'
			? 'File name (Enter to confirm, Esc to cancel)'
			: 'Nom du fichier (Entrée pour valider, Échap pour annuler)';
	const read = async () => {
		await expect(
			page.locator('#app-toolbar').getByRole('textbox', { name: fileName, exact: true })
		).toBeVisible();
		await expect(page.getByTestId('slide-present')).toBeVisible();
		// Select and measure in one browser task so a detached node cannot enter the sample.
		return page.evaluate(
			(selector) =>
				[...document.querySelectorAll(selector)].map((element) => {
					const style = getComputedStyle(element);
					return {
						name: element.getAttribute('data-testid') ?? element.getAttribute('aria-label'),
						transition: style.transitionDuration,
						animation: style.animationDuration,
						property: style.transitionProperty
					};
				}),
			selector
		);
	};
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	const normal = await read();
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const reduced = await read();
	evidence.motion.push({ normal, reduced });
	for (const sample of [normal, reduced]) {
		expect(sample.map((control) => control.name)).toEqual([fileName, 'slide-present']);
		for (const control of sample) {
			for (const duration of `${control.transition},${control.animation}`.split(',')) {
				const seconds = Number.parseFloat(duration) / (duration.trim().endsWith('ms') ? 1000 : 1);
				expect(Number.isFinite(seconds), `${control.name}: ${duration}`).toBe(true);
				// Short durations can preserve completion events without visible motion.
				if (sample === reduced) expect(seconds, control.name!).toBeLessThanOrEqual(0.001);
			}
		}
	}
}

async function runCell(page: Page, info: TestInfo, evidence: Evidence, touch: boolean, id: string) {
	await page.setViewportSize({ width: evidence.width, height: evidence.height });
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	const click = (control: Locator, label: string) => activate(control, label, evidence, touch);
	const editor = page.getByTestId('presentation-editor');
	const welcome = page.getByTestId('welcome-new');
	if (await welcome.isVisible()) await click(welcome, 'Open creation');
	else {
		const create = page.locator('#files-panel').getByRole('button', {
			name: evidence.locale === 'en' ? /^New file/ : /^Nouveau fichier/
		});
		if (!(await create.isVisible())) {
			await click(
				page.locator('#app-toolbar button[aria-controls="files-panel"]:visible'),
				'Open files panel'
			);
		}
		await click(create, 'Open creation');
	}
	await expect(page.getByRole('dialog')).toHaveAccessibleName(
		evidence.locale === 'en' ? 'Create a document' : 'Créer un document'
	);
	await reach(page.getByTestId('create-note'), 'Note creation card', evidence);
	await reach(page.getByTestId('create-presentation'), 'Presentation creation card', evidence);
	await reach(
		page.getByRole('dialog').getByRole('button', {
			name: evidence.locale === 'en' ? 'Cancel' : 'Annuler',
			exact: true
		}),
		'Creation cancel',
		evidence
	);
	await screenshot(page, info, `${id}-creation`);
	await click(page.getByTestId('create-presentation'), 'Create presentation');
	// The previous editor can stay visible while asynchronous creation is pending.
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(editor).toBeVisible({ timeout: 15000 });
	await expect(page.getByTestId('document-kind')).toHaveText(
		evidence.locale === 'en' ? 'Presentation' : 'Présentation'
	);
	await compareMotion(page, evidence);
	const closeProperties = editor.getByTestId('slide-inspector').getByRole('button', {
		name: evidence.locale === 'en' ? 'Close' : 'Fermer',
		exact: true
	});
	if (await closeProperties.isVisible()) await click(closeProperties, 'Close properties overlay');
	await click(editor.getByTestId('slide-add-text'), 'Add text');
	await click(editor.getByTestId('slide-edit-text'), 'Edit text');
	await fill(
		editor.getByTestId('slide-text-editor'),
		'Write slide text',
		evidence.fixture.text,
		evidence,
		touch
	);
	await click(editor.getByTestId('slide-text-done'), 'Finish text');
	await expect(editor.getByTestId('slide-canvas')).toContainText(`Survey ${id}`);
	if (!(await editor.getByTestId('slide-notes').isVisible())) {
		await click(editor.getByTestId('slide-notes-toggle'), 'Open presenter notes');
	}
	await fill(
		editor.getByTestId('slide-notes'),
		'Write presenter notes',
		evidence.fixture.notes,
		evidence,
		touch
	);
	const openSource = async () => {
		await click(editor.getByTestId('slide-advanced'), 'Open advanced menu');
		await click(editor.getByTestId('slide-source'), 'Open Markdown source');
	};
	await openSource();
	const source = editor.getByTestId('slide-source-editor');
	await reach(source, 'Read source', evidence);
	const before = await source.inputValue();
	expect(before).toContain(evidence.fixture.text);
	expect(before).toContain(evidence.fixture.notes);
	await info.attach(`${id}-before.md`, { body: before, contentType: 'text/markdown' });
	await fill(source, 'Write invalid source', evidence.fixture.invalidSource, evidence, touch);
	await click(editor.getByTestId('slide-source-apply'), 'Reject invalid source');
	await expect(editor.getByRole('alert')).toContainText(
		evidence.locale === 'en'
			? 'must keep its presentation data'
			: 'doit garder ses données de présentation'
	);
	await expect(source).toHaveValue(evidence.fixture.invalidSource);
	await expect(editor.getByTestId('slide-present')).toBeDisabled();
	await screenshot(page, info, `${id}-rejected`);
	const applied = before.replace(`Survey ${id}`, `Survey ${id} applied`);
	await fill(source, 'Write valid source', applied, evidence, touch);
	await click(editor.getByTestId('slide-source-apply'), 'Apply valid source');
	await expect(source).toHaveCount(0);
	await expect(editor.getByTestId('slide-canvas')).toContainText(`Survey ${id} applied`);
	await expect(editor.getByTestId('slide-notes')).toHaveValue(evidence.fixture.notes);
	await click(editor.getByTestId('slide-present'), 'Present');
	await expect(editor).toHaveAttribute('aria-modal', 'true');
	await expect(editor.getByTestId('slide-canvas')).toBeInViewport();
	await expect(editor.getByTestId('slide-canvas')).toContainText(`Survey ${id} applied`);
	await click(editor.getByTestId('slide-present-notes'), 'Show presenter notes');
	await expect(editor.getByTestId('slide-presenter-notes')).toHaveText(evidence.fixture.notes);
	await screenshot(page, info, `${id}-present`);
	await click(editor.getByTestId('slide-present-exit'), 'Exit presentation');
	await expect(editor).not.toHaveAttribute('aria-modal', 'true');
	await openSource();
	await expect(source).toHaveValue(applied);
	await click(editor.getByTestId('slide-source-cancel'), 'Close source without changes');
	await click(editor.getByTestId('slide-export'), 'Open export menu');
	const download = page.waitForEvent('download');
	await click(editor.getByTestId('slide-export-md'), 'Export Markdown');
	const exported = await download;
	expect(await exported.failure()).toBeNull();
	const chunks: Buffer[] = [];
	for await (const chunk of (await exported.createReadStream())!) chunks.push(chunk);
	const bytes = Buffer.concat(chunks);
	evidence.export = {
		bytes: bytes.length,
		expectedSha256: hash(applied),
		actualSha256: hash(bytes)
	};
	await info.attach(`${id}-expected.md`, { body: applied, contentType: 'text/markdown' });
	await info.attach(`${id}-exported.md`, { body: bytes, contentType: 'text/markdown' });
	expect(bytes.equals(Buffer.from(applied)), 'Markdown export must match every source byte').toBe(
		true
	);
	await screenshot(page, info, `${id}-completed`);
	evidence.stage = 'Complete';
	evidence.status = 'passed';
}

for (const locale of ['en', 'fr'] as const) {
	test(`responsive presentation tasks in ${locale}`, async ({
		page,
		browser,
		browserName,
		isMobile,
		hasTouch
	}, info) => {
		test.skip(
			browserName !== 'chromium',
			'The task matrix uses Chromium desktop and mobile emulation.'
		);
		test.setTimeout(isMobile ? 90000 : 240000);
		const originalViewport = page.viewportSize()!;
		const cells = viewportPairs(
			isMobile
				? [originalViewport]
				: widths.map((width) => ({ width, height: Math.max(844, Math.ceil(width * 1.25)) }))
		);
		const evidence: Evidence[] = [];
		const startIdentity = await sourceIdentity();
		await resetAppState(page);
		await page.evaluate((language) => localStorage.setItem('mdsh:locale', language), locale);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		try {
			for (const cell of cells) {
				const id = `${locale}-${cell.width}x${cell.height}-${cell.orientation}`;
				const row: Evidence = {
					...cell,
					locale,
					input: hasTouch
						? 'Playwright touch taps and textarea fill'
						: 'Playwright mouse clicks and textarea fill',
					status: 'running',
					stage: 'Open app',
					controls: [],
					motion: [],
					fixture: {
						text: `# Survey ${id}\n\nA **real edit** with café and français.`,
						notes: `Private speech ${id}: café, français.`,
						invalidSource: '# A note cannot replace this presentation.'
					}
				};
				evidence.push(row);
				await test.step(id, async () => {
					try {
						await runCell(page, info, row, hasTouch, id);
					} catch (error) {
						row.status = 'failed';
						row.error = error instanceof Error ? error.message : String(error);
						await screenshot(page, info, `${id}-failed`);
					}
				});
			}
		} finally {
			await info.attach('responsive-tasks.json', {
				body: JSON.stringify(
					{
						command: info.config.metadata.command,
						source: info.config.metadata.source,
						workingDiffSha256: info.config.metadata.workingDiffSha256,
						environment: info.config.metadata.environment,
						browser: browser.version(),
						project: info.project.name,
						startIdentity,
						endIdentity: await sourceIdentity(),
						viewportMethod:
							'Use each listed portrait width, then swap width and height for landscape.',
						inputLimits:
							'Browser emulation only. No physical device, physical keyboard, virtual keyboard, or touch-drag claim.',
						results: evidence
					},
					null,
					2
				),
				contentType: 'application/json'
			});
		}
		expect(
			evidence
				.filter((row) => row.status !== 'passed')
				.map(({ width, height, stage, error }) => ({ width, height, stage, error }))
		).toEqual([]);
	});
}

for (const locale of ['en', 'fr'] as const) {
	test(`a pointer inside slide text keeps editing active in ${locale}`, async ({
		page,
		browserName,
		hasTouch
	}, info) => {
		test.skip(browserName !== 'chromium', 'Chromium pointer path.');
		await resetAppState(page);
		await page.evaluate((language) => localStorage.setItem('mdsh:locale', language), locale);
		await page.reload();
		await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
		await page.getByTestId('welcome-new')[hasTouch ? 'tap' : 'click']();
		await page.getByTestId('create-presentation')[hasTouch ? 'tap' : 'click']();
		const editor = page.getByTestId('presentation-editor');
		await editor.getByTestId('slide-add-text')[hasTouch ? 'tap' : 'click']();
		await editor.getByTestId('slide-edit-text')[hasTouch ? 'tap' : 'click']();
		const input = editor.getByTestId('slide-text-editor');
		await expect(input).toBeFocused();
		await input.fill('Retain this text when the caret moves.');
		await input[hasTouch ? 'tap' : 'click']();
		await screenshot(page, info, 'direct-text-pointer');
		await expect(input).toBeVisible();
		await expect(input).toBeFocused();
		await expect(input).toHaveValue('Retain this text when the caret moves.');
	});

	for (const fieldName of ['text', 'notes', 'notes-scroll'] as const) {
		test(
			(fieldName === 'notes-scroll'
				? 'trusted notes scrolling after explicit viewport recovery'
				: `${fieldName} field survives a simulated mobile keyboard viewport`) + ` in ${locale}`,
			async ({ page, context, browserName, isMobile, hasTouch }, info) => {
				test.skip(
					browserName !== 'chromium' || !isMobile || !hasTouch,
					'Chromium mobile emulation.'
				);
				test.setTimeout(60000);
				const startIdentity = await sourceIdentity();
				const original = page.viewportSize()!;
				const reduced = { width: original.width, height: Math.max(320, original.height - 300) };
				const text = '# Keyboard-height text café';
				const notes = Array.from(
					{ length: 18 },
					(_, index) => `Speech line ${index + 1}: café.`
				).join('\n');
				const evidence: Evidence = {
					...original,
					baseWidth: original.width,
					orientation: 'portrait',
					locale,
					input:
						fieldName === 'notes-scroll'
							? 'Playwright touch taps, keyboard.insertText, and Chromium CDP touch swipe'
							: 'Playwright touch taps and keyboard.insertText',
					status: 'running',
					stage: 'Open app',
					controls: [],
					motion: [],
					fixture: { text, notes, invalidSource: '' }
				};
				const viewports: unknown[] = [];
				let touchEvents: unknown[] = [];
				let scrollEvidence: unknown;
				const click = (control: Locator, label: string) => activate(control, label, evidence, true);
				const fieldViewport = (field: Locator) =>
					field.evaluate((element) => {
						const rect = element.getBoundingClientRect();
						const viewport = window.visualViewport;
						if (!viewport) throw new Error('visualViewport is unavailable.');
						const left = viewport.offsetLeft;
						const top = viewport.offsetTop;
						const hit = document.elementFromPoint(
							rect.x + rect.width / 2,
							rect.y + rect.height / 2
						);
						return {
							viewport: {
								width: viewport.width,
								height: viewport.height,
								offsetLeft: left,
								offsetTop: top,
								scale: viewport.scale
							},
							layoutViewport: { width: innerWidth, height: innerHeight },
							field: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
							focused: document.activeElement === element,
							visible:
								rect.width > 0 &&
								rect.height > 0 &&
								rect.left >= left &&
								rect.top >= top &&
								rect.right <= left + viewport.width &&
								rect.bottom <= top + viewport.height,
							hit: hit === element || (hit !== null && element.contains(hit)),
							scrollTop: element.scrollTop
						};
					});
				const shrinkFor = async (field: Locator, label: string) => {
					evidence.stage = label;
					const before = await fieldViewport(field);
					await page.setViewportSize(reduced);
					try {
						await expect(field).toBeFocused();
						await expect
							.poll(async () => (await fieldViewport(field)).visible, {
								message: label,
								timeout: 5000
							})
							.toBe(true);
						await expect(field).toBeInViewport({ ratio: 0.95 });
						const after = await fieldViewport(field);
						expect(after.viewport.height).toBeLessThan(before.viewport.height);
						expect(after.viewport.height).toBeCloseTo(reduced.height, 0);
						expect(after.hit).toBe(true);
					} finally {
						viewports.push({ label, before, after: await fieldViewport(field) });
					}
				};
				await resetAppState(page);
				await page.evaluate((language) => localStorage.setItem('mdsh:locale', language), locale);
				await page.reload();
				await page.evaluate(() => {
					const events: Array<{
						type: string;
						trusted: boolean;
						pointerType: string;
						target: string | null;
					}> = [];
					Object.assign(window, { responsiveTouchEvents: events });
					for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
						window.addEventListener(
							type,
							(event) => {
								if (events.length >= 100) return;
								const pointer = event as PointerEvent;
								events.push({
									type,
									trusted: event.isTrusted,
									pointerType: pointer.pointerType,
									target:
										(event.target as Element)
											.closest('[data-testid]')
											?.getAttribute('data-testid') ?? null
								});
							},
							{ capture: true }
						);
					}
				});
				try {
					await click(page.getByTestId('welcome-new'), 'Open creation');
					await click(page.getByTestId('create-presentation'), 'Create presentation');
					const editor = page.getByTestId('presentation-editor');
					await click(editor.getByTestId('slide-add-text'), 'Add text');
					await click(editor.getByTestId('slide-edit-text'), 'Edit text');
					const input = editor.getByTestId('slide-text-editor');
					await expect(input).toBeFocused();
					if (fieldName === 'text') await shrinkFor(input, 'Text field with reduced viewport');
					await input.fill('');
					await page.keyboard.insertText(text);
					await expect(input).toHaveValue(text);
					await screenshot(page, info, 'keyboard-height-text');
					await click(editor.getByTestId('slide-text-done'), 'Finish text in reduced viewport');
					await page.setViewportSize(original);
					const object = editor.getByTestId('slide-object');
					const geometry = await object.getAttribute('style');
					const pan = await editor
						.locator('.slide-positioner')
						.evaluate((element) => (element as HTMLElement).style.transform);
					const notesField = editor.getByTestId('slide-notes');
					await click(notesField, 'Focus presenter notes');
					if (fieldName === 'notes')
						await shrinkFor(notesField, 'Notes field with reduced viewport');
					if (fieldName === 'notes-scroll') {
						const before = await fieldViewport(notesField);
						await page.setViewportSize(reduced);
						const afterResize = await fieldViewport(notesField);
						await reach(notesField, 'Explicit scroll recovery after viewport resize', evidence);
						viewports.push({
							label: 'Manual recovery for the independent scroll check',
							before,
							afterResize,
							afterRecovery: await fieldViewport(notesField)
						});
					}
					await notesField.fill('');
					await page.keyboard.insertText(notes);
					await expect(notesField).toHaveValue(notes);
					await notesField.press('ControlOrMeta+Home');
					await screenshot(page, info, 'keyboard-height-notes');
					if (fieldName === 'notes-scroll') {
						evidence.stage = 'Trusted notes swipe';
						await reach(notesField, 'Notes swipe hit target', evidence);
						const box = (await notesField.boundingBox())!;
						const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
						const beforeScroll = await notesField.evaluate((element) => element.scrollTop);
						const session = await context.newCDPSession(page);
						try {
							await session.send('Input.dispatchTouchEvent', {
								type: 'touchStart',
								touchPoints: [start]
							});
							for (let step = 1; step <= 6; step++) {
								await session.send('Input.dispatchTouchEvent', {
									type: 'touchMove',
									touchPoints: [{ x: start.x, y: start.y - step * 8 }]
								});
								await page.evaluate(
									() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
								);
							}
							await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
						} finally {
							await session.detach();
						}
						await expect
							.poll(() => notesField.evaluate((element) => element.scrollTop))
							.toBeGreaterThan(beforeScroll);
						scrollEvidence = {
							start,
							beforeScroll,
							afterScroll: await notesField.evaluate((element) => element.scrollTop),
							geometryBefore: geometry,
							geometryAfter: await object.getAttribute('style'),
							panBefore: pan,
							panAfter: await editor
								.locator('.slide-positioner')
								.evaluate((element) => (element as HTMLElement).style.transform)
						};
					}
					await expect(object).toHaveAttribute('style', geometry!);
					expect(
						await editor
							.locator('.slide-positioner')
							.evaluate((element) => (element as HTMLElement).style.transform)
					).toBe(pan);
					await page.setViewportSize(original);
					await click(editor.getByTestId('slide-advanced'), 'Open advanced menu');
					await click(editor.getByTestId('slide-source'), 'Read saved source');
					const source = await editor.getByTestId('slide-source-editor').inputValue();
					expect(source).toContain(text);
					const metadata = JSON.parse(/<!-- mdsh-presentation\n([\s\S]*?)\n-->/.exec(source)![1]!);
					expect(metadata.slides[0].notes).toBe(notes);
					await info.attach('keyboard-height-source.md', {
						body: source,
						contentType: 'text/markdown'
					});
					await click(editor.getByTestId('slide-source-cancel'), 'Close source');
					await expect(editor.locator('.save-state')).toHaveText(
						locale === 'en' ? 'saved' : 'enregistré'
					);
					touchEvents = await page.evaluate(
						() => (window as unknown as { responsiveTouchEvents: unknown[] }).responsiveTouchEvents
					);
					expect(touchEvents.length).toBeGreaterThan(0);
					expect(touchEvents.every((event) => (event as { trusted: boolean }).trusted)).toBe(true);
					await page.reload();
					await click(editor.getByTestId('slide-advanced'), 'Reopen advanced menu');
					await click(editor.getByTestId('slide-source'), 'Verify saved source after reload');
					await expect(editor.getByTestId('slide-source-editor')).toHaveValue(source);
					evidence.stage = 'Complete';
					evidence.status = 'passed';
				} catch (error) {
					evidence.status = 'failed';
					evidence.error = error instanceof Error ? error.message : String(error);
					throw error;
				} finally {
					if (!touchEvents.length)
						touchEvents = await page.evaluate(
							() =>
								(window as unknown as { responsiveTouchEvents?: unknown[] })
									.responsiveTouchEvents ?? []
						);
					await screenshot(page, info, 'keyboard-height-final');
					await info.attach('keyboard-height.json', {
						body: JSON.stringify(
							{
								method:
									'Resize the emulated mobile viewport by 300 CSS pixels. This is not a physical virtual keyboard or device.',
								original,
								reduced,
								fieldName,
								startIdentity,
								endIdentity: await sourceIdentity(),
								viewports,
								touchEvents,
								scrollEvidence,
								swipeStatus:
									fieldName === 'notes-scroll'
										? scrollEvidence
											? 'performed'
											: 'not reached'
										: 'not part of this case',
								evidence
							},
							null,
							2
						),
						contentType: 'application/json'
					});
				}
			}
		);
	}
}
