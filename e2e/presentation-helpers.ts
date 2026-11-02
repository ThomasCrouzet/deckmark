import { expect, type Locator, type Page } from '@playwright/test';

export async function waitForPresentation(page: Page): Promise<Locator> {
	const editor = page.getByTestId('presentation-editor');
	await expect(editor).toBeVisible({ timeout: 15_000 });
	return editor;
}

export async function createPresentation(page: Page): Promise<Locator> {
	await page.getByTestId('welcome-new').click();
	await page.getByTestId('create-presentation').click();
	const editor = await waitForPresentation(page);
	await expect(editor.getByTestId('slide-canvas')).toBeVisible();
	return editor;
}

export async function importMarkdown(
	page: Page,
	content: string,
	name = 'Presentation.md'
): Promise<void> {
	await page.locator('input[type=file][accept*="text/markdown"]').setInputFiles({
		name,
		mimeType: 'text/markdown',
		buffer: Buffer.from(content)
	});
	await page.getByRole('button', { name: 'Close import report', exact: true }).click();
}

export async function openPresentationSource(editor: Locator): Promise<void> {
	await editor.getByTestId('slide-advanced').click();
	await editor.getByTestId('slide-source').click();
	await expect(editor.getByTestId('slide-source-editor')).toBeVisible();
}

export async function exportPresentation(
	editor: Locator,
	kind: 'md' | 'html' | 'pdf'
): Promise<void> {
	await editor.getByTestId('slide-export').click();
	await editor.getByTestId(`slide-export-${kind}`).click();
}

export function presentationTitle(page: Page): Locator {
	return page.locator('#app-toolbar').getByRole('textbox', { name: /^File name/ });
}

export async function renamePresentation(page: Page, name: string): Promise<void> {
	const title = presentationTitle(page);
	await title.fill(name);
	await title.press('Enter');
	await expect(title).toBeEnabled();
	await expect(title).toHaveValue(name);
}

/** Build a version 1 file with explicit slide and text identifiers. */
export function presentationFixture(contents: string[]): string {
	const slides = contents.map((content, index) => ({
		id: `slide-${index + 1}`,
		background: '#ffffff',
		notes: '',
		elements: content
			? [
					{
						id: `text-${index + 1}`,
						type: 'text',
						x: 80,
						y: 80,
						width: 1120,
						height: 560,
						rotation: 0,
						fill: 'transparent',
						stroke: 'none',
						strokeWidth: 0,
						color: '#111827',
						fontSize: 30,
						textAlign: 'left',
						content: ''
					}
				]
			: []
	}));
	const body = contents
		.map(
			(content, index) =>
				`<!-- mdsh-slide:slide-${index + 1} -->\n\n` +
				(content ? `<!-- mdsh-element:text-${index + 1} -->\n${content}\n` : '')
		)
		.join('\n---\n\n');
	return `${body}\n\n<!-- mdsh-presentation\n${JSON.stringify({
		version: 1,
		width: 1280,
		height: 720,
		theme: 'default',
		slides
	})}\n-->\n`;
}
