import { expect, type Page } from '@playwright/test';

/**
 * Delete all app IndexedDB databases before a test to get a clean state.
 * Select source mode in localStorage by default. This prevents the Milkdown Crepe
 * lazy load and makes tests faster and deterministic.
 */
export async function resetAppState(
	page: Page,
	opts: { mode?: 'wysiwyg' | 'source' | 'read' } = {}
) {
	const mode = opts.mode ?? 'source';
	// The service worker fallback excludes /api. A controlled context must still open
	// this neutral document without running the app.
	const resetPath = '/api/__mdsh_e2e_reset__';
	const resetRoute = '**' + resetPath;
	await page.route(resetRoute, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<!doctype html><html><head><title>Reset</title></head><body></body></html>'
		})
	);
	try {
		await page.goto(resetPath);
		await page.evaluate(async (forcedMode) => {
			await Promise.all(
				['mdsh', 'mdsh-fs'].map(
					(name) =>
						new Promise<void>((resolve, reject) => {
							const request = indexedDB.deleteDatabase(name);
							request.onsuccess = () => resolve();
							request.onerror = () =>
								reject(request.error ?? new Error(`Deletion failed: ${name}`));
							request.onblocked = () =>
								reject(new Error(`Deletion blocked by an open connection: ${name}`));
						})
				)
			);
			localStorage.clear();
			localStorage.setItem('mdsh:mode', forcedMode);
			localStorage.setItem('mdsh:locale', 'fr');
		}, mode);
	} finally {
		await page.unroute(resetRoute);
	}
	await page.goto('/');
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
}

/**
 * Create the first note from the Welcome screen button in `<main>`.
 * Wait until the toolbar rename input shows the active file.
 */
export async function createFirstFile(page: Page) {
	// Prefer data-testid (locale-stable). Fallback: FR label in <main>.
	const byTestId = page.locator('main [data-testid="welcome-new"]');
	if (await byTestId.count()) {
		await byTestId.click();
	} else {
		await page
			.locator('main')
			.getByRole('button', { name: /Nouveau fichier/ })
			.click();
	}
	await page.getByTestId('create-note').click();
	// §B1.7/B1.8 - The accessible name includes keyboard hints. Match its prefix.
	await expect(page.locator('input[aria-label^="Nom du fichier"]')).toBeVisible({
		timeout: 10_000
	});
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						new Promise<number>((resolve) => {
							const request = indexedDB.open('mdsh');
							request.onerror = () => resolve(0);
							request.onsuccess = () => {
								const database = request.result;
								if (!database.objectStoreNames.contains('drafts')) {
									database.close();
									resolve(0);
									return;
								}
								const count = database.transaction('drafts').objectStore('drafts').count();
								count.onerror = () => {
									database.close();
									resolve(0);
								};
								count.onsuccess = () => {
									database.close();
									resolve(count.result);
								};
							};
						})
				),
			{ timeout: 10_000 }
		)
		.toBeGreaterThan(0);
}

/** Open the command palette from the toolbar button. */
export async function openPalette(page: Page) {
	await page.getByRole('button', { name: 'Palette de commandes' }).click();
	await expect(page.getByRole('dialog', { name: 'Palette de commandes' })).toBeVisible();
}

/** Select source mode from the toolbar for deterministic CodeMirror behavior. */
export async function switchToSource(page: Page) {
	// The mode control has `role="radio"`. Use its unique and stable `data-mode` value.
	await page.locator('button[data-mode="source"]').click();
	await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Rename the active file through the toolbar input. The sidebar shows this name
 * unless a YAML `title` value has priority.
 */
export async function renameActiveFile(page: Page, newName: string) {
	const input = page.locator('input[aria-label^="Nom du fichier"]');
	await input.waitFor({ timeout: 10_000 });
	await input.fill(newName);
	await input.press('Enter');
	// Wait for the 800 ms success flash and for the store to update the sidebar.
	await page.waitForTimeout(900);
}

/**
 * Replace all CodeMirror content in source mode. Select all text, then insert text.
 * resetAppState must already have selected source mode.
 */
export async function writeSourceContent(page: Page, content: string) {
	// Select source mode explicitly. Async restoration of `mdsh:mode` can finish after
	// automation creates a file and leave the app in WYSIWYG mode without `.cm-content`.
	// The click is idempotent when source mode is already active.
	const sourceBtn = page.locator('button[data-mode="source"]');
	if (await sourceBtn.count()) await sourceBtn.click();
	const editor = page.locator('.cm-content').first();
	await editor.waitFor({ timeout: 10_000 });
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('Delete');
	await page.keyboard.insertText(content);
	// Wait for the 400 ms save delay and a margin so persistence can finish.
	await page.waitForTimeout(600);
}

export interface SeedFile {
	name: string;
	content: string;
}

/**
 * Seed `n` files through the UI: create, rename, and write each file.
 * This is slower than direct IndexedDB insertion, but it uses the user APIs and
 * supports Dexie schema migrations. The last file stays active.
 */
export async function seedFiles(page: Page, files: SeedFile[]) {
	if (files.length === 0) return;
	const [first, ...rest] = files;
	// Create the first file from the Welcome screen.
	await page
		.locator('main')
		.getByRole('button', { name: /Nouveau fichier/ })
		.click();
	await page.getByTestId('create-note').click();
	await renameActiveFile(page, first.name);
	await writeSourceContent(page, first.content);
	// Create later files from the sidebar button.
	for (const f of rest) {
		await page.locator('aside button[aria-label^="Nouveau fichier"]').first().click();
		await page.getByTestId('create-note').click();
		await renameActiveFile(page, f.name);
		await writeSourceContent(page, f.content);
	}
}
