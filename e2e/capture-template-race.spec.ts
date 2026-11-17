import { expect, test } from '@playwright/test';
import { resetAppState } from './helpers';

test.skip(process.env.CAPTURE_REVIEW_DESKTOP !== '1', 'Requires the Desktop edition server.');

test('keeps typed capture text after a delayed template read', async ({ page, context }, info) => {
	await resetAppState(page);
	const template = {
		id: 'held-capture-template',
		name: 'Held template',
		content: '# Template\n\nOld template body.\n',
		builtin: false,
		kind: 'note',
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000
	};
	await page.evaluate(
		(row) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('templates', 'readwrite');
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
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			}),
		template
	);

	const capture = await context.newPage();
	await capture.addInitScript((templateId) => {
		const scope = window as unknown as {
			__captureTemplateHeld?: boolean;
			__captureTemplateDelivered?: boolean;
			__releaseCaptureTemplate?: () => void;
		};
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
			if (this.name !== 'templates' || key !== templateId || scope.__captureTemplateHeld)
				return request;
			let handler: ((event: Event) => void) | null = null;
			request.onsuccess = (event) => {
				scope.__captureTemplateHeld = true;
				scope.__releaseCaptureTemplate = () => {
					handler?.(event);
					scope.__captureTemplateDelivered = true;
				};
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
	}, template.id);
	await capture.goto('/?capture=1');
	const select = capture.getByTestId('capture-template');
	await expect(select.locator(`option[value="${template.id}"]`)).toHaveCount(1);
	await select.selectOption(template.id);
	await capture.waitForFunction(
		() => (window as unknown as { __captureTemplateHeld?: boolean }).__captureTemplateHeld === true
	);
	const content = capture.getByTestId('capture-content');
	await content.fill('My unsaved draft');
	await content.focus();
	await capture.evaluate(() =>
		(window as unknown as { __releaseCaptureTemplate?: () => void }).__releaseCaptureTemplate?.()
	);
	await capture.waitForFunction(
		() =>
			(window as unknown as { __captureTemplateDelivered?: boolean }).__captureTemplateDelivered ===
			true
	);
	await capture.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
	const after = {
		body: await content.inputValue(),
		title: await capture.getByTestId('capture-title').inputValue(),
		focused: await content.evaluate((element) => document.activeElement === element)
	};
	await info.attach('capture-template-race.json', {
		body: JSON.stringify({ template, held: true, delivered: true, after }),
		contentType: 'application/json'
	});
	expect(after.body).toBe('My unsaved draft');
	expect(after.title).toBe('');
	expect(after.focused).toBe(true);
});
