import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
	blockPreferenceStorage,
	openPalette,
	resetAppState,
	seedFiles,
	writeSourceContent
} from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function openSemantic(page: Page) {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /index de recherche local/i })
		.click();
	await expect(page.getByTestId('semantic-panel')).toBeVisible();
}

async function closeSemantic(page: Page) {
	await page.getByTestId('semantic-panel').getByRole('button', { name: 'Fermer' }).click();
	await expect(page.getByTestId('semantic-panel')).toHaveCount(0);
}

async function importProject(page: Page, name: string, files: Record<string, string>) {
	const zip = new (await import('jszip')).default();
	for (const [path, content] of Object.entries(files)) zip.file(path, content);
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
		name: `${name}.zip`,
		mimeType: 'application/zip',
		buffer: await zip.generateAsync({ type: 'nodebuffer' })
	});
	await panel.getByRole('button', { name: 'Fermer les projets' }).click();
}

async function openProjectDocument(page: Page, project: string, path: string) {
	const root = page.locator(`[data-project-root-name="${project}"]`);
	const details = root.locator('details').first();
	if ((await details.getAttribute('open')) === null) await root.locator('summary').first().click();
	await expect(details).toHaveAttribute('open', '');
	await root.locator(`[data-project-document="${path}"] button[data-file-id]`).click();
}

async function semanticRows(page: Page): Promise<
	Array<{
		id: string;
		projectId: string | null;
		path: string;
		modelId: string;
		contentHash: string;
	}>
> {
	return page.evaluate(
		() =>
			new Promise<
				Array<{
					id: string;
					projectId: string | null;
					path: string;
					modelId: string;
					contentHash: string;
				}>
			>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					if (!database.objectStoreNames.contains('semanticIndex')) {
						database.close();
						resolve([]);
						return;
					}
					const transaction = database.transaction(['semanticIndex']);
					const rows = transaction.objectStore('semanticIndex').getAll();
					transaction.oncomplete = () => {
						database.close();
						resolve(rows.result);
					};
					transaction.onerror = () => reject(transaction.error);
				};
			})
	);
}

test('builds, searches and clears a local index without network access', async ({
	page
}, info: TestInfo) => {
	let external = 0;
	// The preview port changes between environments: compare host names only.
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
		if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) external++;
	});
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Guide', content: '# Guide\n\nDocumentation for the editor.\n' },
		{ name: 'Recipe', content: '# Recipe\n\nCooking instructions.\n' }
	]);
	await openSemantic(page);
	await expect(page.getByTestId('semantic-enabled')).not.toBeChecked();
	await page.getByTestId('semantic-enabled').check();
	await page.getByTestId('semantic-model').selectOption('cooccurrence-v1');
	await expect(page.getByTestId('semantic-panel')).toContainText('co-occurrence');
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('2 document');
	await page.getByTestId('semantic-query').fill('document');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Guide');
	await page.getByTestId('semantic-hit').first().click();
	await expect(page.getByTestId('semantic-panel')).toHaveCount(0);
	await expect(page.locator('.cm-content')).toContainText('Documentation');

	await openSemantic(page);
	await expect(page.getByTestId('semantic-enabled')).toBeChecked();
	await page.getByTestId('semantic-clear').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('0 document');
	expect(external).toBe(0);

	await info.attach('semantic-search.json', {
		body: JSON.stringify({ indexed: 2, query: 'document', externalRequests: external }),
		contentType: 'application/json'
	});
});

test('clears only the selected library or project index', async ({ page }, info: TestInfo) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Library', content: '# Library\n\nDocumentation for the library.\n' }
	]);
	await importProject(page, 'Alpha', { 'alpha.md': '# Alpha\n\nDocumentation for alpha.\n' });
	await importProject(page, 'Beta', { 'beta.md': '# Beta\n\nDocumentation for beta.\n' });

	// Build the three scopes in turn. The panel takes the active project as its
	// initial scope on each open.
	await openSemantic(page);
	await page.getByTestId('semantic-enabled').check();
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('1 document');
	await closeSemantic(page);

	await openProjectDocument(page, 'Alpha', 'alpha.md');
	await openSemantic(page);
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('1 document');
	await closeSemantic(page);

	await openProjectDocument(page, 'Beta', 'beta.md');
	await openSemantic(page);
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('1 document');
	await closeSemantic(page);

	// Clearing Project Alpha must keep the library and Project Beta rows.
	await openProjectDocument(page, 'Alpha', 'alpha.md');
	await openSemantic(page);
	await page.getByTestId('semantic-clear').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('0 document');
	await page.getByTestId('semantic-query').fill('alpha');
	await expect(page.getByTestId('semantic-hit')).toHaveCount(0);
	let rows = await semanticRows(page);
	expect(rows.map((row) => row.path).sort()).toEqual(['Library.md', 'beta.md']);
	expect(rows.some((row) => row.projectId === null)).toBe(true);

	// The library scope still queries and clears on its own.
	await page.getByTestId('semantic-scope').selectOption({ label: 'Documents de la bibliothèque' });
	await expect(page.getByTestId('semantic-panel')).toContainText('1 document');
	await page.getByTestId('semantic-query').fill('library');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Library');
	await page.getByTestId('semantic-clear').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('0 document');
	rows = await semanticRows(page);
	expect(rows.map((row) => row.path)).toEqual(['beta.md']);
	await closeSemantic(page);

	// Project Beta is still usable and clears without touching another scope.
	await openProjectDocument(page, 'Beta', 'beta.md');
	await openSemantic(page);
	await expect(page.getByTestId('semantic-panel')).toContainText('1 document');
	await page.getByTestId('semantic-query').fill('beta');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('beta.md');
	await page.getByTestId('semantic-clear').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('0 document');
	expect(await semanticRows(page)).toHaveLength(0);

	await info.attach('semantic-scoped-clear.json', {
		body: JSON.stringify({ selectedScope: 'project-alpha', remainingScopes: ['library', 'beta'] }),
		contentType: 'application/json'
	});
});

test('keeps the opt-in and model usable when preferences are blocked', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Guide', content: '# Guide\n\nDocumentation for the editor.\n' },
		{ name: 'Recipe', content: '# Recipe\n\nCooking instructions.\n' }
	]);
	await blockPreferenceStorage(page, ['mdsh:semantic-enabled', 'mdsh:semantic-model']);
	await openSemantic(page);
	await expect(page.getByTestId('semantic-enabled')).not.toBeChecked();
	await page.getByTestId('semantic-enabled').check();
	await expect(page.getByTestId('semantic-enabled')).toBeChecked();
	await expect(page.getByTestId('semantic-preference-note')).toBeVisible();
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('2 document');
	await page.getByTestId('semantic-query').fill('document');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Guide');

	// A blocked model preference must still switch the query and the index.
	await page.getByTestId('semantic-model').selectOption('cooccurrence-v1');
	await expect(page.getByTestId('semantic-panel')).toContainText('autre modèle');
	await expect(page.getByTestId('semantic-hit')).toHaveCount(0);
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Guide');
	const rows = await semanticRows(page);
	expect(rows).toHaveLength(2);
	expect(rows.every((row) => row.modelId === 'cooccurrence-v1')).toBe(true);
	await info.attach('semantic-blocked-preference.json', {
		body: JSON.stringify({ rows: rows.length, model: 'cooccurrence-v1', hits: 1 }, null, 2),
		contentType: 'application/json'
	});
});

test('drops changed source rows and another model until a rebuild', async ({
	page
}, info: TestInfo) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Guide', content: '# Guide\n\nDocumentation for the editor.\n' },
		{ name: 'Recipe', content: '# Recipe\n\nCooking instructions.\n' }
	]);
	await openSemantic(page);
	await page.getByTestId('semantic-enabled').check();
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('2 document');
	await page.getByTestId('semantic-query').fill('documentation');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Guide');
	await closeSemantic(page);

	// Edit one indexed document. Its saved row still holds the old bytes.
	await page.locator('aside button[data-file-id]').filter({ hasText: 'Guide' }).click();
	await writeSourceContent(page, '# Guide\n\nDocumentation for the editor.\nA new line.\n');

	await openSemantic(page);
	await page.getByTestId('semantic-query').fill('documentation');
	await expect(page.getByTestId('semantic-panel')).toContainText(
		'Certains documents indexés ont changé'
	);
	// The edited document keeps its old bytes in the index, so it is counted as
	// stale and left out of the ranking.
	await expect(page.getByTestId('semantic-hit').filter({ hasText: 'Guide' })).toHaveCount(0);
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Recipe.md');

	// The old feature vectors are not scored with the co-occurrence model.
	await page.getByTestId('semantic-model').selectOption('cooccurrence-v1');
	await expect(page.getByTestId('semantic-panel')).toContainText('autre modèle');
	await expect(page.getByTestId('semantic-hit')).toHaveCount(0);

	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Guide.md');
	await expect(page.getByTestId('semantic-panel')).not.toContainText(
		'documents indexés ont changé'
	);
	const rows = await semanticRows(page);
	expect(rows.every((row) => row.modelId === 'cooccurrence-v1')).toBe(true);
	expect(rows.map((row) => row.path).sort()).toEqual(['Guide.md', 'Recipe.md']);

	await info.attach('semantic-stale-index.json', {
		body: JSON.stringify({ staleBeforeRebuild: 1, model: 'cooccurrence-v1', rows: rows.length }),
		contentType: 'application/json'
	});
});

test('rebuilds two sources that share one 32-bit digest', async ({ page }, info: TestInfo) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	await seedFiles(page, [{ name: 'Collision', content: '4c6d3c14' }]);
	await openSemantic(page);
	await page.getByTestId('semantic-enabled').check();
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-panel')).toContainText('1 document');
	await page.getByTestId('semantic-query').fill('4c6d3c14');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('4c6d3c14');
	const before = await semanticRows(page);
	expect(before[0]?.contentHash).toBe('b8012ee5');
	await closeSemantic(page);

	// Both sources have the same 32-bit digest. The wide source revision must
	// still tell them apart on the next Build Index action.
	await page.locator('aside button[data-file-id]').filter({ hasText: 'Collision' }).click();
	await writeSourceContent(page, '34749a0f');
	await openSemantic(page);
	await page.getByTestId('semantic-query').fill('34749a0f');
	await expect(page.getByTestId('semantic-panel')).toContainText('1 document');
	const stale = await semanticRows(page);
	expect(stale[0]?.contentHash).toBe('b8012ee5');
	await page.getByTestId('semantic-index').click();
	await expect(page.getByTestId('semantic-hit').first()).toContainText('34749a0f');
	await expect(page.getByTestId('semantic-hit').filter({ hasText: '4c6d3c14' })).toHaveCount(0);
	const rebuilt = await semanticRows(page);
	expect(rebuilt[0]?.contentHash).toBe('b8012ee5');

	await info.attach('semantic-collision.json', {
		body: JSON.stringify({
			contentHash: rebuilt[0]?.contentHash,
			preview: rebuilt[0]?.path,
			rows: rebuilt.length
		}),
		contentType: 'application/json'
	});
});

interface SemanticFaultScope {
	read?: { mode: 'delay-success' | 'delay-error'; gate: Promise<void> };
	writeFail?: boolean;
	writeHold?: { armed: boolean; active: boolean; held: boolean; aborted: boolean; cycles: number };
}

/**
 * Reject or delay IndexedDB work on the semantic index. The patch wraps the
 * real request, so only the store and the selected operation change.
 */
async function installSemanticFaults(page: Page): Promise<void> {
	await page.evaluate(() => {
		const scope = window as unknown as {
			__mdshSemanticFault?: SemanticFaultScope;
			__mdshSemanticFaultInstalled?: boolean;
			__mdshSemanticRelease?: () => void;
			__mdshSemanticReads?: number;
		};
		if (scope.__mdshSemanticFaultInstalled) return;
		scope.__mdshSemanticFaultInstalled = true;
		scope.__mdshSemanticFault = {};
		scope.__mdshSemanticReads = 0;

		const storeOf = (source: IDBObjectStore | IDBIndex): string =>
			source instanceof IDBIndex ? source.objectStore.name : source.name;

		for (const proto of [IDBObjectStore.prototype, IDBIndex.prototype] as unknown as Array<{
			getAll: (...args: never[]) => IDBRequest;
		}>) {
			const original = proto.getAll;
			proto.getAll = function (this: IDBObjectStore | IDBIndex, ...args: never[]) {
				const request = original.apply(this, args);
				if (storeOf(this) === 'semanticIndex') {
					request.addEventListener('success', () => {
						scope.__mdshSemanticReads = (scope.__mdshSemanticReads ?? 0) + 1;
					});
				}
				const fault = scope.__mdshSemanticFault?.read;
				if (storeOf(this) !== 'semanticIndex' || !fault) return request;
				// One shot so a retry reads normally.
				if (scope.__mdshSemanticFault) scope.__mdshSemanticFault.read = undefined;
				const mode = fault.mode;
				let successHandler: ((event: Event) => void) | null = null;
				let errorHandler: ((event: Event) => void) | null = null;
				const proxy = new Proxy(request, {
					get(target, property) {
						if (property === 'onsuccess') return successHandler;
						if (property === 'onerror') return errorHandler;
						const value = Reflect.get(target, property, target);
						return typeof value === 'function' ? value.bind(target) : value;
					},
					set(target, property, value) {
						if (property === 'onsuccess') {
							successHandler = value as (event: Event) => void;
							return true;
						}
						if (property === 'onerror') {
							errorHandler = value as (event: Event) => void;
							return true;
						}
						return Reflect.set(target, property, value, target);
					}
				});
				request.onsuccess = (event) => {
					void fault.gate.then(() => {
						if (mode === 'delay-success') {
							successHandler?.(event);
							return;
						}
						errorHandler?.({
							target: {
								error: new DOMException('Injected semantic read', 'UnknownError')
							},
							stopPropagation() {},
							preventDefault() {}
						} as unknown as Event);
					});
				};
				request.onerror = () => {};
				return proxy;
			};
		}

		const storePrototype = IDBObjectStore.prototype as unknown as {
			put: (value: unknown, key?: IDBValidKey) => IDBRequest;
		};
		const originalPut = storePrototype.put;
		storePrototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
			if (this.name === 'semanticIndex' && scope.__mdshSemanticFault?.writeFail) {
				throw new DOMException('Injected semantic write', 'QuotaExceededError');
			}
			const request = originalPut.call(this, value, key);
			const hold = scope.__mdshSemanticFault?.writeHold;
			if (this.name !== 'semanticIndex' || !hold?.armed) return request;
			hold.armed = false;
			this.transaction.addEventListener('abort', () => (hold.aborted = true));
			let successHandler: ((event: Event) => void) | null = null;
			const store = request.transaction!.objectStore('semanticIndex');
			request.onsuccess = (event) => {
				hold.held = true;
				const keepAlive = () => {
					if (!hold.active) {
						successHandler?.(event);
						return;
					}
					hold.cycles += 1;
					const next = store.count();
					next.onsuccess = keepAlive;
				};
				keepAlive();
			};
			return new Proxy(request, {
				get(target, property) {
					if (property === 'onsuccess') return successHandler;
					const result = Reflect.get(target, property, target);
					return typeof result === 'function' ? result.bind(target) : result;
				},
				set(target, property, next) {
					if (property === 'onsuccess') {
						successHandler = next as (event: Event) => void;
						return true;
					}
					return Reflect.set(target, property, next, target);
				}
			});
		};
	});
}

async function armReadFault(page: Page, mode: 'delay-success' | 'delay-error'): Promise<void> {
	await page.evaluate((nextMode) => {
		const scope = window as unknown as {
			__mdshSemanticFault?: SemanticFaultScope;
			__mdshSemanticRelease?: () => void;
		};
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		scope.__mdshSemanticFault = {
			...(scope.__mdshSemanticFault ?? {}),
			read: { mode: nextMode, gate }
		};
		scope.__mdshSemanticRelease = release;
	}, mode);
}

async function releaseReadFault(page: Page): Promise<void> {
	await page.evaluate(() => {
		const scope = window as unknown as { __mdshSemanticRelease?: () => void };
		scope.__mdshSemanticRelease?.();
		scope.__mdshSemanticRelease = undefined;
	});
}

async function setWriteFault(page: Page, fail: boolean): Promise<void> {
	await page.evaluate((value) => {
		const scope = window as unknown as { __mdshSemanticFault?: SemanticFaultScope };
		scope.__mdshSemanticFault = { ...(scope.__mdshSemanticFault ?? {}), writeFail: value };
	}, fail);
}

test('ignores an index failure after the model changes', async ({ page, browser }, info) => {
	await resetAppState(page);
	await seedFiles(page, [{ name: 'Guide', content: '# Guide\n\nDocumentation for the editor.\n' }]);
	await installSemanticFaults(page);
	await openSemantic(page);
	await page.getByTestId('semantic-enabled').check();
	await expect(page.getByTestId('semantic-panel')).toContainText('0 document');
	await page.waitForFunction(
		() => ((window as unknown as { __mdshSemanticReads?: number }).__mdshSemanticReads ?? 0) > 0
	);
	await armReadFault(page, 'delay-error');
	const indexButton = page.getByTestId('semantic-index');
	await indexButton.click();
	await expect(indexButton).toBeDisabled();
	await page.waitForFunction(
		() =>
			(window as unknown as { __mdshSemanticFault?: SemanticFaultScope }).__mdshSemanticFault
				?.read === undefined
	);
	await page.getByTestId('semantic-model').selectOption('cooccurrence-v1');
	await releaseReadFault(page);
	await expect(indexButton).toBeEnabled();
	const errorVisible = await page.getByTestId('semantic-index-error').isVisible();
	await info.attach('stale-index-error.json', {
		body: JSON.stringify({ browser: browser.version(), model: 'cooccurrence-v1', errorVisible }),
		contentType: 'application/json'
	});
	expect(errorVisible).toBe(false);
});

test('does not publish an obsolete index after the model changes', async ({
	page,
	browser
}, info) => {
	await resetAppState(page);
	await seedFiles(page, [{ name: 'Guide', content: '# Guide\n\nDocumentation for the editor.\n' }]);
	await installSemanticFaults(page);
	await openSemantic(page);
	await page.getByTestId('semantic-enabled').check();
	await expect(page.getByTestId('semantic-panel')).toContainText('0 document');
	await page.waitForFunction(
		() => ((window as unknown as { __mdshSemanticReads?: number }).__mdshSemanticReads ?? 0) > 0
	);
	await armReadFault(page, 'delay-success');
	const indexButton = page.getByTestId('semantic-index');
	await indexButton.click();
	await expect(indexButton).toBeDisabled();
	await page.waitForFunction(
		() =>
			(window as unknown as { __mdshSemanticFault?: SemanticFaultScope }).__mdshSemanticFault
				?.read === undefined
	);
	await page.getByTestId('semantic-model').selectOption('cooccurrence-v1');
	await releaseReadFault(page);
	await expect(indexButton).toBeEnabled();
	const rows = await semanticRows(page);
	await info.attach('stale-index-success.json', {
		body: JSON.stringify({ browser: browser.version(), model: 'cooccurrence-v1', rows }),
		contentType: 'application/json'
	});
	expect(rows).toHaveLength(0);
});

test('rolls back an index write if the model changes in the transaction', async ({
	page,
	browser
}, info) => {
	await resetAppState(page);
	await seedFiles(page, [{ name: 'Guide', content: '# Guide\n\nDocumentation for the editor.\n' }]);
	await installSemanticFaults(page);
	await openSemantic(page);
	await page.getByTestId('semantic-enabled').check();
	await page.getByTestId('semantic-model').selectOption('cooccurrence-v1');
	const indexButton = page.getByTestId('semantic-index');
	await indexButton.click();
	await expect(page.getByTestId('semantic-panel')).toContainText('1 document');
	await expect(indexButton).toBeEnabled();
	const before = await semanticRows(page);
	expect(before).toHaveLength(1);
	expect(before[0]?.modelId).toBe('cooccurrence-v1');
	await page.getByTestId('semantic-model').selectOption('feature-hash-v1');
	await page.evaluate(() => {
		const scope = window as unknown as { __mdshSemanticFault: SemanticFaultScope };
		scope.__mdshSemanticFault.writeHold = {
			armed: true,
			active: true,
			held: false,
			aborted: false,
			cycles: 0
		};
	});
	await indexButton.click();
	await expect(indexButton).toBeDisabled();
	await page.waitForFunction(
		() =>
			(window as unknown as { __mdshSemanticFault?: SemanticFaultScope }).__mdshSemanticFault
				?.writeHold?.held === true
	);
	await page.getByTestId('semantic-model').selectOption('cooccurrence-v1');
	await page.evaluate(() => {
		const scope = window as unknown as { __mdshSemanticFault: SemanticFaultScope };
		scope.__mdshSemanticFault.writeHold!.active = false;
	});
	await expect(indexButton).toBeEnabled();
	const after = await semanticRows(page);
	const held = await page.evaluate(
		() =>
			(window as unknown as { __mdshSemanticFault: SemanticFaultScope }).__mdshSemanticFault
				.writeHold
	);
	await info.attach('stale-index-transaction.json', {
		body: JSON.stringify({ browser: browser.version(), held, before, after }),
		contentType: 'application/json'
	});
	expect(held?.cycles).toBeGreaterThan(0);
	expect(after).toEqual(before);
	expect(held?.aborted).toBe(true);
	await expect(page.getByTestId('semantic-index-error')).toHaveCount(0);
});

test('shows recoverable errors for rejected index, count and query operations', async ({
	page
}, info: TestInfo) => {
	test.setTimeout(180_000);
	await page.addInitScript(() => {
		const scope = window as unknown as { __mdshUnhandled?: string[] };
		scope.__mdshUnhandled = [];
		window.addEventListener('unhandledrejection', (event) => {
			scope.__mdshUnhandled?.push(String(event.reason));
		});
	});
	await resetAppState(page);
	await seedFiles(page, [
		{ name: 'Guide', content: '# Guide\n\nDocumentation for the editor.\n' },
		{ name: 'Recipe', content: '# Recipe\n\nCooking instructions.\n' }
	]);
	await installSemanticFaults(page);
	await openSemantic(page);
	const panel = page.getByTestId('semantic-panel');
	const countError = page.getByTestId('semantic-count-error');
	const indexError = page.getByTestId('semantic-index-error');
	const searchError = page.getByTestId('semantic-search-error');

	await page.getByTestId('semantic-enabled').check();
	await expect(panel).toContainText('0 document');

	// A rejected scoped read must announce a count error and stay retryable.
	await armReadFault(page, 'delay-error');
	await page.getByTestId('semantic-enabled').uncheck();
	await page.getByTestId('semantic-enabled').check();
	await expect(countError).toHaveCount(0);
	await releaseReadFault(page);
	await expect(countError).toBeVisible();
	await expect(countError).toHaveAttribute('role', 'alert');
	await expect(countError).toContainText('Le nombre de documents indexés');
	await page.getByTestId('semantic-count-retry').click();
	await expect(countError).toHaveCount(0);
	await expect(panel).toContainText('0 document');

	// A rejected write must keep the committed rows and permit a retry.
	await page.getByTestId('semantic-index').click();
	await expect(panel).toContainText('2 document');
	const committed = await semanticRows(page);
	expect(committed).toHaveLength(2);

	await setWriteFault(page, true);
	await page.getByTestId('semantic-index').click();
	await expect(indexError).toBeVisible();
	await expect(indexError).toHaveAttribute('role', 'alert');
	await expect(indexError).toContainText('Les données existantes sont inchangées');
	await expect(panel).toContainText('2 document');
	expect(await semanticRows(page)).toHaveLength(2);
	await expect(page.getByTestId('semantic-index')).toBeEnabled();

	await setWriteFault(page, false);
	await page.getByTestId('semantic-index').click();
	await expect(indexError).toHaveCount(0);
	await expect(panel).toContainText('2 document');

	// A rejected query keeps the last usable result visible.
	await page.getByTestId('semantic-query').fill('document');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Guide');
	await armReadFault(page, 'delay-error');
	await page.getByTestId('semantic-query').fill('recipe');
	await expect(searchError).toHaveCount(0);
	await releaseReadFault(page);
	await expect(searchError).toBeVisible();
	await expect(searchError).toHaveAttribute('role', 'alert');
	await expect(searchError).toContainText('Les résultats précédents sont inchangés');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Guide');

	await page.getByTestId('semantic-query').fill('cooking');
	await expect(searchError).toHaveCount(0);
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Recipe');

	// An obsolete failure must not replace a newer successful result.
	await armReadFault(page, 'delay-error');
	await page.getByTestId('semantic-query').fill('document');
	await page.getByTestId('semantic-query').fill('cooking');
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Recipe');
	await releaseReadFault(page);
	await page.waitForTimeout(150);
	await expect(searchError).toHaveCount(0);
	await expect(page.getByTestId('semantic-hit').first()).toContainText('Recipe');

	const unhandled = await page.evaluate(
		() => (window as unknown as { __mdshUnhandled?: string[] }).__mdshUnhandled ?? []
	);
	expect(unhandled).toEqual([]);
	const rows = await semanticRows(page);
	expect(rows).toHaveLength(2);
	await info.attach('semantic-rejection-recovery.json', {
		body: JSON.stringify(
			{
				countErrorRecovered: true,
				indexRowsBefore: committed.length,
				indexRowsAfterFailedWrite: 2,
				queryErrorRecovered: true,
				staleFailureIgnored: true,
				unhandledRejections: unhandled.length
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});
