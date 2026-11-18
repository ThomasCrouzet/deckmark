import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPalette, resetAppState } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function source(page: Page): Promise<string> {
	return page
		.locator('.cm-content .cm-line')
		.evaluateAll((lines) => lines.map((line) => line.textContent).join('\n'));
}

/**
 * Seed one draft through IndexedDB and reload. A touch project hides the desktop
 * sidebar, so this case does not depend on the welcome screen or the rename input.
 */
async function seedNote(page: Page, content: string) {
	await page.evaluate(async (text) => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('drafts', 'readwrite');
				const now = Date.now();
				transaction.objectStore('drafts').put({
					id: 'touch-number-note',
					name: 'numbers.md',
					content: text,
					createdAt: now,
					updatedAt: now,
					order: 0,
					open: true
				});
				transaction.oncomplete = () => {
					database.close();
					window.localStorage.setItem('mdsh:activeId', 'touch-number-note');
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
		});
	}, content);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
	await expect(page.locator('.cm-content').first()).toContainText('priority:');
}

async function openProperties(page: Page) {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /propriétés du document/i })
		.click();
	await expect(page.getByTestId('frontmatter-panel')).toBeVisible();
}

type Sample = { field: string; step: string; value: string; caret: number | null };

test('retypes two numeric properties with sequential touch keys', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	const initial = '---\npriority: 12\nscore: -2.5\n---\n\n# Body\n\nKeep.\n';
	await seedNote(page, initial);
	await openProperties(page);
	const priority = page.getByTestId('frontmatter-priority').locator('input');
	const score = page.getByTestId('frontmatter-score').locator('input');
	const samples: Sample[] = [];
	// The decimal input mode is what a touch keyboard reads. The text type keeps
	// the DOM from coercing or normalizing an intermediate number.
	await expect(priority).toHaveAttribute('type', 'text');
	await expect(priority).toHaveAttribute('inputmode', 'decimal');
	await expect(score).toHaveAttribute('inputmode', 'decimal');

	async function caretOf(input: typeof priority): Promise<number | null> {
		return input.evaluate((element) => (element as HTMLInputElement).selectionStart);
	}

	async function tapAtEnd(field: string, input: typeof priority, step: string) {
		await input.tap();
		await page.keyboard.press('End');
		samples.push({ field, step, value: await input.inputValue(), caret: await caretOf(input) });
	}

	async function backspace(target: Sample[], field: string, input: typeof priority, count: number) {
		for (let index = 0; index < count; index += 1) {
			await page.keyboard.press('Backspace');
			target.push({
				field,
				step: `backspace ${index + 1}`,
				value: await input.inputValue(),
				caret: await caretOf(input)
			});
		}
	}

	async function typeKeys(target: Sample[], field: string, input: typeof priority, text: string) {
		for (const character of text) {
			await page.keyboard.type(character);
			target.push({
				field,
				step: `type ${character}`,
				value: await input.inputValue(),
				caret: await caretOf(input)
			});
		}
	}

	await expect(priority).toHaveValue('12');
	await expect(score).toHaveValue('-2.5');
	await tapAtEnd('priority', priority, 'tap');
	await backspace(samples, 'priority', priority, 2);
	await typeKeys(samples, 'priority', priority, '-12.75');
	await tapAtEnd('score', score, 'tap');
	await backspace(samples, 'score', score, 4);
	await typeKeys(samples, 'score', score, '0.125');

	expect(samples).toEqual([
		{ field: 'priority', step: 'tap', value: '12', caret: 2 },
		{ field: 'priority', step: 'backspace 1', value: '1', caret: 1 },
		{ field: 'priority', step: 'backspace 2', value: '', caret: 0 },
		{ field: 'priority', step: 'type -', value: '-', caret: 1 },
		{ field: 'priority', step: 'type 1', value: '-1', caret: 2 },
		{ field: 'priority', step: 'type 2', value: '-12', caret: 3 },
		{ field: 'priority', step: 'type .', value: '-12.', caret: 4 },
		{ field: 'priority', step: 'type 7', value: '-12.7', caret: 5 },
		{ field: 'priority', step: 'type 5', value: '-12.75', caret: 6 },
		{ field: 'score', step: 'tap', value: '-2.5', caret: 4 },
		{ field: 'score', step: 'backspace 1', value: '-2.', caret: 3 },
		{ field: 'score', step: 'backspace 2', value: '-2', caret: 2 },
		{ field: 'score', step: 'backspace 3', value: '-', caret: 1 },
		{ field: 'score', step: 'backspace 4', value: '', caret: 0 },
		{ field: 'score', step: 'type 0', value: '0', caret: 1 },
		{ field: 'score', step: 'type .', value: '0.', caret: 2 },
		{ field: 'score', step: 'type 1', value: '0.1', caret: 3 },
		{ field: 'score', step: 'type 2', value: '0.12', caret: 4 },
		{ field: 'score', step: 'type 5', value: '0.125', caret: 5 }
	]);

	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toHaveCount(0);
	const updated = await source(page);
	expect(updated).toContain('priority: -12.75');
	expect(updated).toContain('score: 0.125');
	expect(updated).toContain('# Body\n\nKeep.\n');

	await openProperties(page);
	await expect(page.getByTestId('frontmatter-priority').locator('small')).toHaveText('nombre');
	await expect(page.getByTestId('frontmatter-score').locator('small')).toHaveText('nombre');
	await expect(page.getByTestId('frontmatter-priority').locator('input')).toHaveValue('-12.75');
	await expect(page.getByTestId('frontmatter-score').locator('input')).toHaveValue('0.125');

	await info.attach('frontmatter-number-touch.json', {
		body: JSON.stringify(
			{
				initial,
				updated,
				samples,
				touch: await page.evaluate(() => ({
					hasTouch: navigator.maxTouchPoints > 0,
					pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
					viewport: `${window.innerWidth}x${window.innerHeight}`,
					userAgent: navigator.userAgent
				})),
				limit: 'Emulated touch viewport only. A physical touch keyboard remains a manual check.'
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('refuses an incomplete touch edit and keeps the typed text', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	const initial = '---\npriority: 12\n---\n\n# Body\n\nKeep.\n';
	await seedNote(page, initial);
	await openProperties(page);
	const priority = page.getByTestId('frontmatter-priority').locator('input');
	const numberError = page.getByTestId('frontmatter-number-error-priority');

	await priority.tap();
	await page.keyboard.press('End');
	await page.keyboard.press('Backspace');
	await page.keyboard.press('Backspace');
	await expect(priority).toHaveValue('');
	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toBeVisible();
	await expect(numberError).toContainText('nombre complet');
	await expect(priority).toBeFocused();
	expect(await source(page)).toBe(initial);

	await page.keyboard.type('-');
	await page.getByTestId('frontmatter-save').click();
	await expect(numberError).toContainText('nombre complet');
	await expect(priority).toHaveValue('-');
	await expect(priority).toBeFocused();
	expect(await source(page)).toBe(initial);

	await page.keyboard.type('12');
	await expect(numberError).toHaveCount(0);
	await page.getByTestId('frontmatter-save').click();
	await expect(page.getByTestId('frontmatter-panel')).toHaveCount(0);
	const updated = await source(page);
	expect(updated).toContain('priority: -12');
	expect(updated).toContain('# Body\n\nKeep.\n');

	await info.attach('frontmatter-number-touch-invalid.json', {
		body: JSON.stringify({ initial, updated, blockedValues: ['', '-'] }, null, 2),
		contentType: 'application/json'
	});
});
