import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'fr-FR', reducedMotion: 'reduce' });

const toolbarStatus = (page: Page) => page.locator('#app-toolbar [data-testid^="storage-status-"]');

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

async function importLinkedFile(page: Page, name: string, content: string, drafts = 2) {
	await writeOpfsFile(page, name, content);
	await page.evaluate(async (name) => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle(name, { create: true });
		Object.defineProperty(window, 'showOpenFilePicker', {
			configurable: true,
			value: async () => [handle]
		});
	}, name);
	await page
		.locator('aside')
		.getByRole('button', { name: /^Importer un fichier markdown/ })
		.click();
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'disk');
	await waitForDraftCount(page, drafts);
}

async function waitForDraftCount(page: Page, count: number) {
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					new Promise<number>((resolve, reject) => {
						const request = indexedDB.open('mdsh');
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const database = request.result;
							const read = database.transaction('drafts', 'readonly').objectStore('drafts').count();
							read.onerror = () => reject(read.error);
							read.onsuccess = () => {
								database.close();
								resolve(read.result);
							};
						};
					})
			)
		)
		.toBeGreaterThanOrEqual(count);
}

async function attachWorkflow(info: TestInfo, name: string, payload: unknown, page: Page) {
	await info.attach(`${name}.json`, {
		body: JSON.stringify(payload, null, 2),
		contentType: 'application/json'
	});
	await info.attach(`${name}.png`, { body: await page.screenshot() });
}

test('a late old-path health failure does not unlink a repaired handle', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await importLinkedFile(page, 'old-health.md', '# Health\n\nOriginal');

	// Hold the first health read of the old handle, then reload so the scan
	// starts against the linked draft.
	await page.addInitScript(() => {
		const original = FileSystemFileHandle.prototype.getFile;
		const originalQuery = FileSystemFileHandle.prototype.queryPermission;
		let held = false;
		const target = window as unknown as {
			__mdshHealthGate?: { reached: boolean; release?: (ok: boolean) => void };
		};
		target.__mdshHealthGate = { reached: false };
		FileSystemFileHandle.prototype.queryPermission = function (
			this: FileSystemFileHandle,
			...args: Parameters<FileSystemFileHandle['queryPermission']>
		) {
			if (this.name === 'old-health.md') return Promise.resolve('granted');
			return originalQuery.apply(this, args);
		};
		FileSystemFileHandle.prototype.getFile = function (this: FileSystemFileHandle) {
			if (!held && this.name === 'old-health.md') {
				held = true;
				target.__mdshHealthGate!.reached = true;
				return new Promise<File>((resolve, reject) => {
					target.__mdshHealthGate!.release = (ok) => {
						if (ok) void original.call(this).then(resolve, reject);
						else reject(new DOMException('Injected missing file', 'NotFoundError'));
					};
				});
			}
			return original.call(this);
		};
	});
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
	await expect
		.poll(() =>
			page.evaluate(() =>
				Boolean((window as { __mdshHealthGate?: { reached: boolean } }).__mdshHealthGate?.reached)
			)
		)
		.toBe(true);

	const content = '# Health\n\nRepaired';
	const state = await page.evaluate(
		async ({ content }) => {
			const readOne = <T>(request: IDBRequest<T>): Promise<T> =>
				new Promise((resolve, reject) => {
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
			const openDb = (name: string): Promise<IDBDatabase> =>
				new Promise((resolve, reject) => {
					const request = indexedDB.open(name);
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
			const drafts = await openDb('mdsh');
			const epochRow = await readOne<{ value?: string } | undefined>(
				drafts.transaction('metadata', 'readonly').objectStore('metadata').get('disk-link-epoch')
			);
			drafts.close();
			const epoch = epochRow?.value ?? 'legacy';

			const links = await openDb('mdsh-fs');
			const keys = await readOne<IDBValidKey[]>(
				links.transaction('handles', 'readonly').objectStore('handles').getAllKeys()
			);
			const records = await readOne<unknown[]>(
				links.transaction('handles', 'readonly').objectStore('handles').getAll()
			);
			const linkedIndex = records.findIndex((record) => {
				const stored = record as { handle?: { name?: string } };
				return stored.handle?.name === 'old-health.md';
			});
			if (linkedIndex < 0) throw new Error('The linked draft is missing');
			const id = String(keys[linkedIndex]);

			const root = await navigator.storage.getDirectory();
			const handle = await root.getFileHandle('repaired.md', { create: true });
			const writer = await handle.createWritable();
			await writer.write(content);
			await writer.close();
			const file = await handle.getFile();
			const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
			const revision = `sha256:${Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, '0')
			).join('')}`;

			await new Promise<void>((resolve, reject) => {
				const tx = links.transaction('handles', 'readwrite');
				tx.objectStore('handles').put({ kind: 'fsa', handle, revision, epoch }, id);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			links.close();
			return { id, epoch, revision };
		},
		{ content }
	);

	await page.evaluate(() =>
		(
			window as { __mdshHealthGate?: { release?: (ok: boolean) => void } }
		).__mdshHealthGate?.release?.(false)
	);
	await expect(toolbarStatus(page)).toHaveAttribute('data-origin', 'disk');
	await expect(page.getByTestId('disk-edit-mode')).toHaveAttribute('data-mode', 'in-place');

	await writeSourceContent(page, content);
	await page.keyboard.press('ControlOrMeta+s');
	await expect
		.poll(() =>
			page.evaluate(async () => {
				const root = await navigator.storage.getDirectory();
				const handle = await root.getFileHandle('repaired.md');
				return (await handle.getFile()).text();
			})
		)
		.toBe(content);
	await expect(toolbarStatus(page)).toHaveAttribute('data-sync', 'saved');

	await attachWorkflow(
		info,
		'late-old-health',
		{
			draftId: state.id,
			epoch: state.epoch,
			oldLink: 'old-health.md',
			repairedLink: 'repaired.md',
			repairedRevision: state.revision,
			origin: await toolbarStatus(page).getAttribute('data-origin'),
			sync: await toolbarStatus(page).getAttribute('data-sync'),
			mode: await page.getByTestId('disk-edit-mode').getAttribute('data-mode')
		},
		page
	);
});
