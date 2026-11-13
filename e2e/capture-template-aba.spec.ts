import { expect, test } from '@playwright/test';
import { resetAppState } from './helpers';

test.skip(process.env.CAPTURE_REVIEW_DESKTOP !== '1', 'Requires the Desktop edition server.');

test('discards the old A read after A to B to A template choices', async ({
	page,
	context
}, info) => {
	await resetAppState(page);
	const fixtures = [
		{
			id: 'held-a',
			name: 'Template A',
			content: '# A\n\nA body.\n',
			builtin: false,
			kind: 'note',
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000
		},
		{
			id: 'held-b',
			name: 'Template B',
			content: '# B\n\nB body.\n',
			builtin: false,
			kind: 'note',
			createdAt: 1_700_000_000_001,
			updatedAt: 1_700_000_000_001
		}
	];
	await page.evaluate(
		(rows) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('templates', 'readwrite');
					for (const row of rows) {
						transaction.objectStore('templates').put({
							...row,
							manifest: JSON.stringify([
								1,
								row.id,
								row.name,
								0,
								row.kind,
								row.createdAt,
								row.updatedAt,
								row.content.length
							])
						});
					}
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			}),
		fixtures
	);

	const capture = await context.newPage();
	await capture.addInitScript(() => {
		const scope = window as unknown as {
			held?: Array<{ key: IDBValidKey | IDBKeyRange; release: () => void }>;
			delivered?: number[];
		};
		scope.held = [];
		scope.delivered = [];
		Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
			value: { unregisterListener: () => {} }
		});
		Object.defineProperty(window, '__TAURI_INTERNALS__', {
			value: {
				transformCallback: () => 1,
				invoke: async (command: string) => {
					if (command === 'plugin:event|listen') return 1;
					if (command === 'plugin:event|unlisten' || command === 'desktop_capture_hide') return;
					throw new Error(`Unexpected native command: ${command}`);
				}
			}
		});
		const original = IDBObjectStore.prototype.get;
		IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
			const request = original.call(this, key);
			if (this.name !== 'templates' || (key !== 'held-a' && key !== 'held-b')) return request;
			let handler: ((event: Event) => void) | null = null;
			request.onsuccess = (event) => {
				const index = scope.held!.length;
				scope.held!.push({
					key,
					release: () => {
						handler?.(event);
						scope.delivered!.push(index);
					}
				});
			};
			return new Proxy(request, {
				get(target, property) {
					if (property === 'onsuccess') return handler;
					const value = Reflect.get(target, property, target);
					return typeof value === 'function' ? value.bind(target) : value;
				},
				set(target, property, value) {
					if (property === 'onsuccess') {
						handler = value as (event: Event) => void;
						return true;
					}
					return Reflect.set(target, property, value, target);
				}
			});
		};
	});
	await capture.goto('/?capture=1');
	const select = capture.getByTestId('capture-template');
	for (const row of fixtures)
		await expect(select.locator(`option[value="${row.id}"]`)).toHaveCount(1);
	for (const [index, id] of ['held-a', 'held-b', 'held-a'].entries()) {
		await select.selectOption(id);
		await capture.waitForFunction(
			(count) => (window as unknown as { held: unknown[] }).held.length === count,
			index + 1
		);
	}
	const heldKeys = await capture.evaluate(() =>
		(window as unknown as { held: Array<{ key: string }> }).held.map((entry) => entry.key)
	);
	expect(heldKeys).toEqual(['held-a', 'held-b', 'held-a']);
	const body = capture.getByTestId('capture-content');
	const title = capture.getByTestId('capture-title');
	const release = async (index: number) => {
		await capture.evaluate(
			(i) => (window as unknown as { held: Array<{ release: () => void }> }).held[i]!.release(),
			index
		);
		await capture.waitForFunction(
			(i) => (window as unknown as { delivered: number[] }).delivered.includes(i),
			index
		);
		await capture.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
	};
	await release(0);
	const afterOldA = { body: await body.inputValue(), title: await title.inputValue() };
	expect(afterOldA).toEqual({ body: '', title: '' });
	await release(1);
	const afterOldB = { body: await body.inputValue(), title: await title.inputValue() };
	expect(afterOldB).toEqual({ body: '', title: '' });
	await release(2);
	await expect(body).toHaveValue(fixtures[0]!.content);
	await expect(title).toHaveValue(fixtures[0]!.name);
	await info.attach('capture-template-aba.json', {
		body: JSON.stringify({
			fixtures,
			heldKeys,
			afterOldA,
			afterOldB,
			final: { body: await body.inputValue(), title: await title.inputValue() }
		}),
		contentType: 'application/json'
	});
});
