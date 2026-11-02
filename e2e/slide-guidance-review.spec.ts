import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';
import { createPresentation, openPresentationSource } from './presentation-helpers';

const messages = {
	en: {
		present: 'Apply or cancel source changes to present.',
		selection: 'Select an object to edit it.',
		rejected: 'A presentation must keep its presentation data. Restore the data or cancel.'
	},
	fr: {
		present: 'Appliquez ou annulez les modifications de la source pour présenter.',
		selection: 'Sélectionnez un objet pour le modifier.',
		rejected: 'Une présentation doit garder ses données de présentation. Restaurez-les ou annulez.'
	}
};
const selectionActions = ['copy', 'duplicate', 'delete', 'edit-text'];

async function evidence(page: Page, info: TestInfo, state: string) {
	await info.attach(`${state}.png`, {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png'
	});
	await info.attach(`${state}.aria.txt`, {
		body: await page.getByTestId('presentation-editor').ariaSnapshot(),
		contentType: 'text/plain'
	});
}

async function visibleDescription(page: Page, control: Locator, text: string) {
	await expect(control).toHaveAccessibleDescription(text);
	const ids = (await control.getAttribute('aria-describedby'))?.split(/\s+/);
	expect(ids?.length).toBeGreaterThan(0);
	const hint = page.locator(`[id="${ids![0]}"]`);
	await expect(hint).toHaveText(text);
	await expect(hint).toBeVisible();
	await expect(hint).toBeInViewport({ ratio: 1 });
	const geometry = await hint.evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const box = element.getBoundingClientRect();
		return {
			unclipped: element.scrollWidth <= element.clientWidth,
			textFits: Array.from(range.getClientRects()).every(
				(rect) =>
					rect.left >= box.left - 1 &&
					rect.right <= box.right + 1 &&
					rect.top >= box.top - 1 &&
					rect.bottom <= box.bottom + 1
			)
		};
	});
	expect(geometry).toEqual({ unclipped: true, textFits: true });
	return hint;
}

for (const locale of ['en', 'fr'] as const) {
	for (const width of [320, 1440]) {
		test.describe(`${locale} at ${width}px`, () => {
			test.use({ viewport: { width, height: 900 }, locale, reducedMotion: 'reduce' });
			test.beforeEach(async ({ page }) => {
				await resetAppState(page);
				await page.evaluate((value) => localStorage.setItem('mdsh:locale', value), locale);
				await page.reload();
				await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
				await createPresentation(page);
			});
			test.afterEach(async ({ page }, info) => {
				await evidence(page, info, 'final');
				await info.attach('run.json', {
					body: JSON.stringify(
						{
							test: info.title,
							status: info.status,
							locale,
							width,
							browser: page.context().browser()?.version(),
							command: process.env.REVIEW_COMMAND,
							metadata: info.config.metadata,
							fixture:
								'New empty presentation created through the UI; one text object added through the UI.',
							invalidSource: '# Missing presentation data'
						},
						null,
						2
					),
					contentType: 'application/json'
				});
			});

			test('Present explains open and rejected source, then clears after cancel and apply', async ({
				page
			}, info) => {
				const editor = page.getByTestId('presentation-editor');
				const present = editor.getByTestId('slide-present');
				await expect(present).toBeEnabled();
				await expect(present).toHaveAccessibleDescription('');
				await openPresentationSource(editor);
				const draft = editor.getByTestId('slide-source-editor');
				const valid = await draft.inputValue();
				await info.attach('valid-source.md', { body: valid, contentType: 'text/markdown' });
				await expect(present).toBeDisabled();
				const hint = await visibleDescription(page, present, messages[locale].present);
				await evidence(page, info, 'source-open');
				await draft.fill('# Missing presentation data');
				await editor.getByTestId('slide-source-apply').click();
				await expect(editor.getByRole('alert')).toContainText(messages[locale].rejected);
				await expect(draft).toHaveValue('# Missing presentation data');
				await expect(present).toBeDisabled();
				await visibleDescription(page, present, messages[locale].present);
				await evidence(page, info, 'source-rejected');
				await editor.getByTestId('slide-source-cancel').click();
				await expect(present).toBeEnabled();
				await expect(present).toHaveAccessibleDescription('');
				await expect(hint).toHaveCount(0);
				await openPresentationSource(editor);
				await expect(draft).toHaveValue(valid);
				await visibleDescription(page, present, messages[locale].present);
				await editor.getByTestId('slide-source-apply').click();
				await expect(present).toBeEnabled();
				await expect(present).toHaveAccessibleDescription('');
				await expect(hint).toHaveCount(0);
			});

			test('selection actions explain empty and deselected states and clear when selected', async ({
				page
			}, info) => {
				const editor = page.getByTestId('presentation-editor');
				const toolbar = editor.locator('.selection-tools');
				const checkEmpty = async () => {
					for (const action of selectionActions) {
						const control = editor.getByTestId(`slide-${action}`);
						await expect(control).toBeDisabled();
						await visibleDescription(page, control, messages[locale].selection);
					}
					await toolbar.focus();
					await expect(toolbar).toBeFocused();
					await visibleDescription(page, toolbar, messages[locale].selection);
				};
				const checkSelected = async () => {
					for (const action of selectionActions) {
						await expect(editor.getByTestId(`slide-${action}`)).toBeEnabled();
						await expect(editor.getByTestId(`slide-${action}`)).not.toHaveAttribute(
							'aria-describedby'
						);
						await expect(editor.getByTestId(`slide-${action}`)).not.toHaveAccessibleDescription(
							messages[locale].selection
						);
					}
					await expect(toolbar).toHaveAccessibleDescription('');
					await expect(editor.getByText(messages[locale].selection, { exact: true })).toHaveCount(
						0
					);
				};
				await expect(editor.getByTestId('slide-object')).toHaveCount(0);
				await checkEmpty();
				await evidence(page, info, 'empty');
				await editor.getByTestId('slide-add-text').click();
				await checkSelected();
				await evidence(page, info, 'selected');
				await editor.getByTestId('slide-object').press('Escape');
				await checkEmpty();
				await evidence(page, info, 'deselected');
				await editor.getByTestId('slide-object').press('Space');
				await checkSelected();
				await editor.getByTestId('slide-delete').click();
				await expect(editor.getByTestId('slide-object')).toHaveCount(0);
				await checkEmpty();
			});
		});
	}
}
