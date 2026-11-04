import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resetAppState } from './helpers';

const code = 'console.log("capture review");\n';
const template = {
	id: 'capture-review-note',
	name: 'Capture review note',
	content: '# Capture review\n\nTemplate body.\n',
	kind: 'note',
	builtin: false,
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_000_000
};

async function openSnippets(page: Page) {
	await page.keyboard.press('ControlOrMeta+Shift+P');
	const palette = page.getByRole('dialog', { name: 'Palette de commandes' });
	await palette.locator('input[type="text"]').fill('extraits');
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('snippets-dialog')).toBeVisible();
}

async function storedSnippetCount(page: Page) {
	return page.evaluate(
		() =>
			new Promise<number>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const count = database.transaction('snippets').objectStore('snippets').count();
					count.onsuccess = () => {
						database.close();
						resolve(count.result);
					};
					count.onerror = () => {
						database.close();
						reject(count.error);
					};
				};
			})
	);
}

async function openCapture(page: Page, title: string) {
	await page.addInitScript(() => {
		Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
			value: { unregisterListener: () => {} }
		});
		Object.defineProperty(window, '__TAURI_INTERNALS__', {
			value: {
				transformCallback: () => 1,
				invoke: async (command: string) => {
					if (command === 'desktop_capture_hide') return;
					if (command === 'plugin:event|listen') return 1;
					if (command === 'plugin:event|unlisten') return;
					throw new Error(`Unexpected native command: ${command}`);
				}
			}
		});
	});
	await page.goto('/?capture=1');
	await expect(page.getByTestId('quick-capture')).toBeVisible();
	await page.getByTestId('capture-kind').selectOption('snippet');
	await page.getByTestId('capture-language').selectOption('javascript');
	await page.getByTestId('capture-title').fill(title);
	await page.getByTestId('capture-content').fill(code);
}

test.afterEach(async ({ context }, info) => {
	await info.attach('capture-review-evidence.json', {
		body: JSON.stringify(
			{
				command:
					process.env.CAPTURE_REVIEW_COMMAND ??
					'npx playwright test e2e/capture-snippets-review.spec.ts --project=chromium',
				revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
				diff: execFileSync(
					'git',
					['diff', '--', 'src/lib/snippets.svelte.ts', 'src/lib/components/QuickCapture.svelte'],
					{ encoding: 'utf8' }
				),
				environment: {
					node: process.version,
					platform: process.platform,
					browser: context.browser()?.version(),
					baseURL: info.project.use.baseURL,
					desktop: process.env.CAPTURE_REVIEW_DESKTOP === '1',
					nativeBridge: 'hide and event listener fixture'
				},
				fixtures: { code, template },
				test: info.title,
				status: info.status,
				errors: info.errors,
				pages: context.pages().map((page) => page.url())
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	for (const [index, page] of context.pages().entries()) {
		await info.attach(`capture-review-${index}.png`, {
			body: await page.screenshot(),
			contentType: 'image/png'
		});
	}
});

test('an open snippet panel receives another window save', async ({ page, context }) => {
	await resetAppState(page);
	await openSnippets(page);
	await expect(page.getByTestId('snippet-row')).toHaveCount(0);
	const other = await context.newPage();
	await other.goto('/');
	await expect(other.locator('.mdsh-shell[aria-busy="false"]')).toBeVisible();
	await openSnippets(other);
	await other.getByTestId('snippet-new').click();
	await other.getByTestId('snippet-title').fill('Other window snippet');
	await other.getByTestId('snippet-code').locator('.cm-content').fill(code);
	await other.getByTestId('snippet-save').click();
	await expect(other.getByTestId('snippet-detail-title')).toHaveText('Other window snippet');
	await expect(page.getByTestId('snippet-row')).toHaveCount(1);
	await expect(page.getByTestId('snippet-row')).toContainText('Other window snippet');
	await page.keyboard.press('Escape');
	await openSnippets(page);
	await expect(page.getByTestId('snippet-row')).toHaveCount(1);
});

test.describe('Desktop capture browser workflow', () => {
	test.skip(process.env.CAPTURE_REVIEW_DESKTOP !== '1', 'Requires the Desktop edition server.');

	test('loads saved note templates on the first mount', async ({ page, context }) => {
		await resetAppState(page);
		await page.evaluate(
			(row) =>
				new Promise<void>((resolve, reject) => {
					const request = indexedDB.open('mdsh');
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						const database = request.result;
						const tx = database.transaction('templates', 'readwrite');
						tx.objectStore('templates').put(row);
						tx.objectStore('templates').put({
							...row,
							id: 'capture-review-deck',
							name: 'Capture review deck',
							kind: 'presentation'
						});
						tx.oncomplete = () => {
							database.close();
							resolve();
						};
						tx.onerror = () => {
							database.close();
							reject(tx.error);
						};
					};
				}),
			template
		);
		const capture = await context.newPage();
		await capture.goto('/?capture=1');
		await expect(capture.getByTestId('capture-template')).toBeVisible();
		await expect(
			capture.getByTestId('capture-template').locator('option[value="capture-review-deck"]')
		).toHaveCount(0);
		await capture.getByTestId('capture-template').selectOption(template.id);
		await expect(capture.getByTestId('capture-content')).toHaveValue(template.content);
		await expect(capture.getByTestId('capture-title')).toHaveValue(template.name);
	});

	test('rejects a saved duplicate from a fresh capture window and updates the main list', async ({
		page,
		context
	}) => {
		await resetAppState(page);
		await openSnippets(page);
		const first = await context.newPage();
		await openCapture(first, 'First capture');
		await first.getByTestId('capture-save').click();
		await expect(first.getByTestId('capture-status')).toBeVisible();
		const second = await context.newPage();
		await openCapture(second, 'Duplicate capture');
		await second.getByTestId('capture-save').click();
		await expect(second.getByTestId('capture-error')).toContainText('existe déjà');
		await expect(second.getByTestId('capture-content')).toHaveValue(code);
		expect(await storedSnippetCount(page)).toBe(1);
		await expect(page.getByTestId('snippet-row')).toHaveCount(1);
		await expect(page.getByTestId('snippet-row')).toContainText('First capture');
	});

	test('serializes concurrent duplicate saves across capture windows', async ({
		page,
		context
	}) => {
		await resetAppState(page);
		const first = await context.newPage();
		const second = await context.newPage();
		await Promise.all([
			openCapture(first, 'Concurrent one'),
			openCapture(second, 'Concurrent two')
		]);
		await Promise.all([
			first.getByTestId('capture-save').click(),
			second.getByTestId('capture-save').click()
		]);
		await expect
			.poll(
				async () =>
					(await first.getByTestId('capture-status').count()) +
					(await second.getByTestId('capture-status').count())
			)
			.toBe(1);
		await expect
			.poll(
				async () =>
					(await first.getByTestId('capture-error').count()) +
					(await second.getByTestId('capture-error').count())
			)
			.toBe(1);
		expect(await storedSnippetCount(page)).toBe(1);
	});

	test('reports a failed snippet write and keeps capture input', async ({ page, context }) => {
		await resetAppState(page);
		const capture = await context.newPage();
		await openCapture(capture, 'Failed capture');
		await capture.evaluate(() => {
			const put = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function (...args) {
				if (this.name === 'snippets')
					throw new DOMException('Capture review write failure', 'QuotaExceededError');
				return put.apply(this, args);
			};
		});
		await capture.getByTestId('capture-save').click();
		await expect(capture.getByTestId('capture-error')).toContainText(
			'Capture review write failure'
		);
		await expect(capture.getByTestId('capture-content')).toHaveValue(code);
		await expect(capture.getByTestId('capture-save')).toBeEnabled();
		expect(await storedSnippetCount(page)).toBe(0);
	});
});
