import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'fr-FR', reducedMotion: 'reduce' });

const toolbarStatus = (page: Page) => page.locator('#app-toolbar [data-testid^="storage-status-"]');
const editMode = (page: Page) => page.getByTestId('disk-edit-mode');

async function writeOpfsFile(page: Page, name: string, content: string) {
	await page.evaluate(
		async ({ name, content }) => {
			const root = await navigator.storage.getDirectory();
			const handle = await root.getFileHandle(name, { create: true });
			const writer = await handle.createWritable();
			await writer.write(content);
			await writer.close();
		},
		{ name, content }
	);
}

async function readOpfsFile(page: Page, name: string): Promise<string> {
	return page.evaluate(async (name) => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle(name);
		const file = await handle.getFile();
		return file.text();
	}, name);
}

async function mockOpenPicker(page: Page, name: string) {
	await page.evaluate(async (name) => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle(name, { create: true });
		Object.defineProperty(window, 'showOpenFilePicker', {
			configurable: true,
			value: async () => [handle]
		});
	}, name);
}

async function mockSavePicker(page: Page, name: string) {
	await page.evaluate(async (name) => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle(name, { create: true });
		Object.defineProperty(window, 'showSaveFilePicker', {
			configurable: true,
			value: async () => handle
		});
	}, name);
}

async function importLinkedFile(page: Page, name: string, content: string) {
	await writeOpfsFile(page, name, content);
	await mockOpenPicker(page, name);
	await page
		.locator('aside')
		.getByRole('button', { name: /^Importer un fichier markdown/ })
		.click();
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'disk');
}

async function attachWorkflow(
	info: TestInfo,
	name: string,
	payload: Record<string, unknown>,
	page: Page
) {
	await info.attach(`${name}.json`, {
		body: JSON.stringify(payload, null, 2),
		contentType: 'application/json'
	});
	await info.attach(`${name}.png`, { body: await page.screenshot() });
}

test('unsupported File System Access API falls back to a download copy', async ({ page }, info) => {
	await page.addInitScript(() => {
		const target = window as Window & {
			showOpenFilePicker?: unknown;
			showSaveFilePicker?: unknown;
			showDirectoryPicker?: unknown;
		};
		for (const key of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
			try {
				delete (target as unknown as Record<string, unknown>)[key];
				delete (Window.prototype as unknown as Record<string, unknown>)[key];
			} catch {
				/* The property may be non-configurable on this build. */
			}
		}
	});
	await resetAppState(page);
	expect(
		await page.evaluate(() => 'showSaveFilePicker' in window && 'showOpenFilePicker' in window)
	).toBe(false);
	await createFirstFile(page);
	await writeSourceContent(page, '# Local fallback');

	const downloadEvent = page.waitForEvent('download');
	await page.getByTestId('save-as').click();
	const download = await downloadEvent;
	const path = info.outputPath('fallback-copy.md');
	await download.saveAs(path);
	const downloaded = await readFile(path, 'utf8');

	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'draft');
	await expect(editMode(page)).toHaveAttribute('data-mode', 'draft');
	await expect(page.getByTestId('edit-original')).toHaveCount(0);
	expect(downloaded).toContain('Local fallback');

	await attachWorkflow(
		info,
		'unsupported-fallback',
		{
			supported: false,
			origin: await toolbarStatus(page).getAttribute('data-origin'),
			sync: await toolbarStatus(page).getAttribute('data-sync'),
			editMode: await editMode(page).getAttribute('data-mode'),
			downloadContent: downloaded
		},
		page
	);
});

test('a linked file saves in place and detects an external change', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await importLinkedFile(page, 'workflow.md', '# Original\n\nFirst');
	await expect(editMode(page)).toHaveAttribute('data-mode', 'in-place');

	await writeSourceContent(page, '# Local\n\nWritten in place');
	await page.keyboard.press('ControlOrMeta+s');
	await expect.poll(() => readOpfsFile(page, 'workflow.md')).toBe('# Local\n\nWritten in place');
	await expect(toolbarStatus(page)).toHaveAttribute('data-sync', 'saved');

	await writeOpfsFile(page, 'workflow.md', '# External\n\nChanged outside');
	await writeSourceContent(page, '# Local\n\nChanged in the app');
	await page.keyboard.press('ControlOrMeta+s');
	const conflict = page.getByRole('dialog', { name: /Résoudre le conflit disque/ });
	await expect(conflict).toBeVisible();
	await expect(conflict).toContainText('Changed outside');
	await page.keyboard.press('Escape');
	await expect(conflict).toBeHidden();

	expect(await readOpfsFile(page, 'workflow.md')).toBe('# External\n\nChanged outside');
	await expect(page.locator('.cm-content')).toContainText('Changed in the app');
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'disk');
	await expect(toolbarStatus(page)).toHaveAttribute('data-sync', 'pending');

	await attachWorkflow(
		info,
		'in-place-conflict',
		{
			diskAfterSave: await readOpfsFile(page, 'workflow.md'),
			localDraft: await page.locator('.cm-content').innerText(),
			origin: await toolbarStatus(page).getAttribute('data-origin'),
			sync: await toolbarStatus(page).getAttribute('data-sync'),
			editMode: await editMode(page).getAttribute('data-mode'),
			fixture: 'OPFS file with the native picker replaced by the selected handle'
		},
		page
	);
});

test('Edit copy detaches the draft and Edit original returns to the source', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await importLinkedFile(page, 'detach.md', '# Detach\n\nOriginal');

	await page.getByTestId('edit-copy').click();
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'temporary');
	await expect(editMode(page)).toHaveAttribute('data-mode', 'copy');
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveValue(/copie$/);

	await page.getByTestId('edit-original').click();
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'disk');
	await expect(editMode(page)).toHaveAttribute('data-mode', 'in-place');
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveValue('detach');
	expect(await readOpfsFile(page, 'detach.md')).toBe('# Detach\n\nOriginal');

	await attachWorkflow(
		info,
		'edit-copy-original',
		{
			copyOrigin: 'temporary',
			copyMode: 'copy',
			originalOrigin: await toolbarStatus(page).getAttribute('data-origin'),
			originalMode: await editMode(page).getAttribute('data-mode'),
			sourceContent: await readOpfsFile(page, 'detach.md')
		},
		page
	);
});

test('Save As writes a new file and keeps the linked source unchanged', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await importLinkedFile(page, 'source.md', '# Source\n\nOriginal');
	await writeSourceContent(page, '# Source\n\nLocal change');

	await mockSavePicker(page, 'copy.md');
	await page.getByTestId('save-as').click();
	await expect.poll(() => readOpfsFile(page, 'copy.md')).toBe('# Source\n\nLocal change');
	expect(await readOpfsFile(page, 'source.md')).toBe('# Source\n\nOriginal');
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'disk');
	await expect(toolbarStatus(page)).toHaveAttribute('data-sync', 'pending');

	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle('source.md');
		Object.defineProperty(window, 'showSaveFilePicker', {
			configurable: true,
			value: async () => handle
		});
	});
	await page.getByTestId('save-as').click();
	await expect(page.getByText(/ne peut pas choisir la source liée/)).toBeVisible();
	expect(await readOpfsFile(page, 'source.md')).toBe('# Source\n\nOriginal');

	await attachWorkflow(
		info,
		'save-as-source-safe',
		{
			sourceContent: await readOpfsFile(page, 'source.md'),
			copyContent: await readOpfsFile(page, 'copy.md'),
			origin: await toolbarStatus(page).getAttribute('data-origin'),
			sync: await toolbarStatus(page).getAttribute('data-sync'),
			sameTargetRejected: true
		},
		page
	);
});

test('denied disk permission does not write or claim a disk save', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await importLinkedFile(page, 'denied.md', '# Denied\n\nOriginal');
	await writeSourceContent(page, '# Denied\n\nLocal change');

	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle('denied.md');
		const proto = Object.getPrototypeOf(handle) as {
			queryPermission?: () => Promise<string>;
			requestPermission?: () => Promise<string>;
		};
		Object.defineProperty(proto, 'queryPermission', {
			configurable: true,
			value: async () => 'denied'
		});
		Object.defineProperty(proto, 'requestPermission', {
			configurable: true,
			value: async () => 'denied'
		});
	});

	await page.keyboard.press('ControlOrMeta+s');
	await expect(page.getByText(/Autorisation refusée/)).toBeVisible();
	expect(await readOpfsFile(page, 'denied.md')).toBe('# Denied\n\nOriginal');
	await expect(page.locator('.cm-content')).toContainText('Local change');
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'disk');
	await expect(toolbarStatus(page)).toHaveAttribute('data-sync', 'pending');

	await attachWorkflow(
		info,
		'permission-denied',
		{
			sourceContent: await readOpfsFile(page, 'denied.md'),
			localDraft: await page.locator('.cm-content').innerText(),
			origin: await toolbarStatus(page).getAttribute('data-origin'),
			sync: await toolbarStatus(page).getAttribute('data-sync')
		},
		page
	);
});

test('cancelled native dialog keeps the original and the draft intact', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await importLinkedFile(page, 'cancel.md', '# Cancel\n\nOriginal');
	await writeSourceContent(page, '# Cancel\n\nDraft stays');

	await page.evaluate(() => {
		Object.defineProperty(window, 'showSaveFilePicker', {
			configurable: true,
			value: async () => {
				throw new DOMException('The user cancelled the dialog.', 'AbortError');
			}
		});
	});

	await page.getByTestId('save-as').click();
	await expect(page.getByText(/Enregistrer sous pour « cancel.md » annulé/)).toBeVisible();
	expect(await readOpfsFile(page, 'cancel.md')).toBe('# Cancel\n\nOriginal');
	await expect(page.locator('.cm-content')).toContainText('Draft stays');
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'disk');
	await expect(toolbarStatus(page)).toHaveAttribute('data-sync', 'pending');

	await attachWorkflow(
		info,
		'cancelled-dialog',
		{
			sourceContent: await readOpfsFile(page, 'cancel.md'),
			localDraft: await page.locator('.cm-content').innerText(),
			origin: await toolbarStatus(page).getAttribute('data-origin'),
			sync: await toolbarStatus(page).getAttribute('data-sync')
		},
		page
	);
});
