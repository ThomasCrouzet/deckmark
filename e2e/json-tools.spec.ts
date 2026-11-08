import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';
import { createPwaUpdateServer } from './pwa-update-server';
import {
	holdReplies,
	installJsonProbe,
	jsonFixture,
	jsonFixtureHash,
	jsonWorkerHeap,
	probeState
} from './json-worker-probe';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

async function importJson(page: Page, name: string, content: string) {
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name,
		mimeType: 'application/json',
		buffer: Buffer.from(content)
	});
	await expect(page.getByTestId('code-editor')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('json-status')).toBeVisible();
}

async function savedContent(page: Page): Promise<string> {
	return page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const rows = request.result.transaction('drafts').objectStore('drafts').getAll();
					rows.onerror = () => reject(rows.error);
					rows.onsuccess = () => {
						request.result.close();
						const latest = rows.result
							.filter((row) => row.open !== false)
							.sort((a, b) => b.updatedAt - a.updatedAt)[0];
						resolve(latest?.content ?? '');
					};
				};
			})
	);
}

async function fillJson(page: Page, content: string) {
	const editor = page.locator('.cm-content').first();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText(content);
}

async function jsonSelection(page: Page) {
	return page.locator('.cm-content').evaluate((host) => {
		const selection = window.getSelection();
		if (!selection?.anchorNode || !selection.focusNode) return null;
		const lines = [...host.querySelectorAll('.cm-line')];
		const offset = (node: Node, position: number) => {
			const line = (node instanceof Element ? node : node.parentElement)?.closest('.cm-line');
			if (!line || !host.contains(line)) return null;
			const range = document.createRange();
			range.selectNodeContents(line);
			range.setEnd(node, position);
			return (
				lines
					.slice(0, lines.indexOf(line))
					.reduce((length, line) => length + (line.textContent?.length ?? 0) + 1, 0) +
				range.toString().length
			);
		};
		return {
			anchor: offset(selection.anchorNode, selection.anchorOffset),
			head: offset(selection.focusNode, selection.focusOffset)
		};
	});
}

test('validates, formats and minifies JSON without losing data', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	const source = '{"big":12345678901234567890,"text":"cœur 🎉","nested":{"a":1},"list":[1,2]}';
	await importJson(page, 'data.json', source);
	await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+Home');
	for (let index = 0; index < 6; index++) await page.keyboard.press('ArrowRight');
	for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowLeft');
	const selectionBefore = await jsonSelection(page);
	expect(selectionBefore).toEqual({ anchor: 6, head: 3 });

	await page.getByTestId('json-format').click();
	await expect
		.poll(() => savedContent(page))
		.toBe(
			'{\n  "big": 12345678901234567890,\n  "text": "cœur 🎉",\n  "nested": {\n    "a": 1\n  },\n  "list": [\n    1,\n    2\n  ]\n}'
		);
	const selectionAfter = await jsonSelection(page);
	expect(selectionAfter).toEqual(selectionBefore);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => savedContent(page)).toBe(source);

	await page.getByTestId('json-minify').click();
	await expect.poll(() => savedContent(page)).toBe(source);

	await fillJson(page, '{"a": }');
	await expect(page.getByTestId('json-status')).toContainText('JSON invalide');
	await expect(page.getByTestId('json-format')).toBeDisabled();
	await expect
		.poll(() => page.getByTestId('json-status').innerText())
		.toMatch(/ligne \d+, colonne \d+/);

	await info.attach('json-tools.json', {
		body: JSON.stringify({
			source,
			formatted: true,
			selectionBefore,
			selectionAfter,
			minified: await savedContent(page),
			invalidLocated: true
		}),
		contentType: 'application/json'
	});
});

for (const outcome of ['no-op', 'worker-error'] as const) {
	test(`ends revalidation superseded by an unchanged ${outcome} action and permits retry`, async ({
		page
	}, info) => {
		await installJsonProbe(page);
		await resetAppState(page);
		const source = '{"a":1}';
		await importJson(page, 'pending.json', source);
		await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
		try {
			await holdReplies(page, true);
			await page.getByTestId('json-validate').click();
			await expect.poll(async () => (await probeState(page)).held).toBe(1);
			await expect(page.getByTestId('json-pending')).toBeVisible();
			if (outcome === 'worker-error') {
				await page.evaluate(() => {
					(
						window as unknown as { jsonProbe: { failNextAction: boolean } }
					).jsonProbe.failNextAction = true;
				});
			}
			await page.getByTestId('json-minify').click();
			if (outcome === 'no-op') await expect.poll(async () => (await probeState(page)).held).toBe(2);
			await holdReplies(page, false);
			await expect(page.getByTestId('json-progress')).toHaveCount(0);
			if (outcome === 'worker-error')
				await expect(page.getByTestId('json-action-error')).toContainText(
					'Worker JSON indisponible'
				);
			await expect.poll(() => savedContent(page)).toBe(source);
			await expect(page.getByTestId('json-pending')).toHaveCount(0);
			await expect(page.getByTestId('json-validate')).toBeEnabled();
			await page.getByTestId('json-validate').click();
			await expect(page.getByTestId('json-pending')).toHaveCount(0);
			await expect(page.getByTestId('json-validate')).toBeEnabled();
			await expect(page.getByTestId('json-action-error')).toHaveCount(0);
			await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
			await expect.poll(() => savedContent(page)).toBe(source);
		} finally {
			await info.attach(`json-pending-${outcome}.json`, {
				body: JSON.stringify({
					source,
					saved: await savedContent(page),
					sourceSha256: jsonFixtureHash(source),
					pending: await page.getByTestId('json-pending').count(),
					validateEnabled: await page.getByTestId('json-validate').isEnabled(),
					error: await page.getByTestId('json-action-error').allTextContents(),
					injection:
						outcome === 'worker-error' ? 'one action postMessage throws DataCloneError' : null,
					probe: await probeState(page)
				}),
				contentType: 'application/json'
			});
		}
	});
}

test('keeps full JSON diagnostics off the input thread at 1, 5 and 10 MB', async ({
	page
}, info) => {
	test.setTimeout(120_000);
	await installJsonProbe(page);
	await resetAppState(page);
	const cases = [];
	for (const bytes of [1_000_000, 5_000_000, 10_000_000]) {
		const fixture = jsonFixture(bytes);
		await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
			name: `stress-${bytes}.json`,
			mimeType: 'application/json',
			buffer: Buffer.from(fixture.text)
		});
		await expect(page.getByTestId('code-editor')).toBeVisible();
		if (bytes >= 5_000_000) await page.getByTestId('json-validate').click();
		await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
		await page.locator('.cm-content').click();
		await page.keyboard.press('ControlOrMeta+End');
		const samples = [];
		const rawSamples = [];
		for (let index = 0; index < 12; index++) {
			const start = await page.evaluate(() => performance.now());
			await page.keyboard.insertText(' ');
			const inputEnd = await page.evaluate(() => performance.now());
			const paint = await page.evaluate(
				() =>
					new Promise<number>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))
					)
			);
			samples.push(paint - start);
			rawSamples.push({ start, inputEnd, paint, latency: paint - start });
		}
		if (bytes >= 5_000_000) await page.getByTestId('json-validate').click();
		await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
		const probe = await probeState(page);
		const workerMemory = await jsonWorkerHeap(page);
		expect(probe.parses).toEqual([]);
		const requests = probe.requests.filter(
			(request) => request.length >= bytes && request.length < bytes + 100
		);
		expect(requests.length).toBeGreaterThan(0);
		expect(requests.length).toBeLessThanOrEqual(3);
		const sorted = [...samples].sort((a, b) => a - b);
		const diagnostics = requests.map((request) => {
			const reply = probe.replies.find(
				(reply) => reply.documentId === request.documentId && reply.requestId === request.requestId
			);
			return { request, reply, latency: reply ? reply.at - request.at : null };
		});
		expect(diagnostics.every((entry) => entry.reply?.kind === 'analysis')).toBe(true);
		cases.push({
			bytes,
			sha256: fixture.sha256,
			samples,
			rawSamples,
			diagnostics,
			p50: sorted[Math.ceil(samples.length * 0.5) - 1],
			p95: sorted[Math.ceil(samples.length * 0.95) - 1],
			measurement:
				'automation input dispatch to second animation frame, includes protocol overhead',
			probe,
			workerMemory
		});
	}
	await info.attach('json-worker-profile.json', {
		body: JSON.stringify({
			cases,
			browser: page.context().browser()?.version(),
			project: info.project.name,
			instrumentation: 'production static Web build with source-fidelity metrics',
			tailWarning: '12 samples per size, p95 is the maximum sample and is diagnostic only',
			budgetsChanged: false
		}),
		contentType: 'application/json'
	});
});

test('rejects delayed diagnostics and cancelled actions without changing source', async ({
	page
}, info) => {
	await installJsonProbe(page);
	await resetAppState(page);
	const source = '{"big":12345678901234567890,"a":1,"a":2,"escape":"\\u0061"}';
	await importJson(page, 'delayed.json', source);
	await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
	await holdReplies(page, true);
	await fillJson(page, '{"a":}');
	await expect.poll(async () => (await probeState(page)).held).toBe(1);
	await fillJson(page, source);
	await expect(page.getByTestId('json-status')).toHaveCount(0);
	await page.evaluate(() => {
		const probe = (window as unknown as { jsonProbe: { release: (() => void)[] } }).jsonProbe;
		probe.release.shift()?.();
	});
	await expect.poll(async () => (await probeState(page)).held).toBe(1);
	await expect(page.getByTestId('json-status')).toHaveCount(0);
	await holdReplies(page, false);
	await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
	await expect(page.getByTestId('json-duplicates')).toContainText('"a"');
	await holdReplies(page, true);
	await page.getByTestId('json-format').click();
	await expect(page.getByTestId('json-progress')).toBeVisible();
	await expect.poll(async () => (await probeState(page)).held).toBe(1);
	await page.getByTestId('json-cancel').click();
	await holdReplies(page, false);
	await expect(page.getByTestId('json-progress')).toHaveCount(0);
	await expect.poll(() => savedContent(page)).toBe(source);
	await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
	await page.getByTestId('json-format').click();
	await expect.poll(() => savedContent(page)).not.toBe(source);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => savedContent(page)).toBe(source);
	await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
	await holdReplies(page, true);
	await page.getByTestId('json-format').click();
	await expect.poll(async () => (await probeState(page)).held).toBe(1);
	const edited = '{"newer":true}';
	await fillJson(page, edited);
	await holdReplies(page, false);
	await expect.poll(() => savedContent(page)).toBe(edited);
	await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
	await info.attach('json-worker-delays.json', {
		body: JSON.stringify(await probeState(page)),
		contentType: 'application/json'
	});
});

test('handles empty, deep, invalid huge and duplicate-key JSON in the worker', async ({
	page
}, info) => {
	test.setTimeout(90_000);
	await resetAppState(page);
	const fixtures = [
		{ name: 'empty.json', text: '', valid: false },
		{ name: 'deep.json', text: '['.repeat(12_000) + '0' + ']'.repeat(12_000), valid: true },
		{
			name: 'deep-invalid.json',
			text: '['.repeat(12_000) + '!' + ']'.repeat(12_000),
			valid: false
		},
		{ name: 'huge-invalid.json', text: jsonFixture(1_000_000).text.slice(0, -1), valid: false },
		{ name: 'duplicates.json', text: '[' + '{"a":1,"a":2},'.repeat(20_000) + '{}]', valid: true }
	];
	for (const fixture of fixtures) {
		await importJson(page, fixture.name, fixture.text);
		await expect(page.getByTestId('json-status')).toContainText(
			fixture.valid ? 'JSON valide' : 'JSON invalide'
		);
		if (fixture.name === 'duplicates.json')
			await expect(page.getByTestId('json-duplicates')).toContainText('"a"');
	}
	await info.attach('json-worker-corpus.json', {
		body: JSON.stringify(
			fixtures.map(({ name, text, valid }) => ({
				name,
				bytes: Buffer.byteLength(text),
				sha256: jsonFixtureHash(text),
				valid
			}))
		),
		contentType: 'application/json'
	});
});

test('validates and formats JSON after an offline reload', async ({
	browser,
	browserName
}, info) => {
	const server = await createPwaUpdateServer(resolve('build'));
	const context = await browser.newContext({
		baseURL: server.origin,
		locale: 'en-US',
		reducedMotion: 'reduce'
	});
	const page = await context.newPage();
	const source = '{"offline":12345678901234567890,"escape":"\\u0061"}';
	let stopped = false;
	let disconnected = false;
	const events: Record<string, unknown>[] = [];
	context.on('requestfailed', (request) =>
		events.push({
			phase: disconnected ? 'offline' : 'installation',
			event: 'requestfailed',
			url: request.url(),
			error: request.failure()
		})
	);
	context.on('response', (response) =>
		events.push({
			phase: disconnected ? 'offline' : 'installation',
			event: 'response',
			url: response.url(),
			status: response.status(),
			serviceWorker: response.fromServiceWorker()
		})
	);
	try {
		await resetAppState(page);
		await importJson(page, 'offline.json', source);
		await expect(page.locator('.mdsh-local-indicator')).toHaveText('Prêt hors ligne', {
			timeout: 30_000
		});
		await expect.poll(() => savedContent(page)).toBe(source);
		await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
		await page.reload();
		await expect
			.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
			.toBe(true);
		if (browserName === 'webkit') {
			await server.close();
			stopped = true;
			await expect(page.request.get(server.origin, { timeout: 1000 })).rejects.toThrow();
		} else await context.setOffline(true);
		disconnected = true;
		events.push({
			event: 'disconnected',
			controlled: await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
			originStopped: stopped
		});
		await page.reload();
		await expect
			.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
			.toBe(true);
		await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
		await page.getByTestId('json-format').click();
		await expect
			.poll(() => savedContent(page))
			.toBe('{\n  "offline": 12345678901234567890,\n  "escape": "\\u0061"\n}');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => savedContent(page)).toBe(source);
	} finally {
		await info.attach('json-offline-evidence.json', {
			body: JSON.stringify({
				browserName,
				browserVersion: browser.version(),
				source,
				sourceSha256: jsonFixtureHash(source),
				saved: await savedContent(page),
				disruption: browserName === 'webkit' ? 'origin-stopped' : 'browser-offline',
				originStopped: stopped,
				disconnected,
				controlled: await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
				fixture:
					'pwa-update-server serves real production assets with its test root precache revision and release marker',
				events,
				metadata: info.config.metadata
			}),
			contentType: 'application/json'
		});
		await context.close();
		if (!stopped) await server.close();
	}
});

test('reports an unavailable JSON worker and keeps editing usable', async ({ page }, info) => {
	await page.addInitScript(() => {
		const NativeWorker = Worker;
		window.Worker = new Proxy(NativeWorker, {
			construct(target, args) {
				if (args[1]?.name === 'json-tools') throw new Error('Worker blocked for regression proof');
				return Reflect.construct(target, args);
			}
		});
	});
	await resetAppState(page);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name: 'unavailable.json',
		mimeType: 'application/json',
		buffer: Buffer.from('{"a":1}')
	});
	await expect(page.getByTestId('json-action-error')).toContainText('Worker JSON indisponible');
	await fillJson(page, '{"a":2}');
	await expect.poll(() => savedContent(page)).toBe('{"a":2}');
	await expect(page.getByTestId('json-format')).toBeDisabled();
	await info.attach('json-worker-unavailable.txt', {
		body: await savedContent(page),
		contentType: 'text/plain'
	});
});

test('preserves duplicate keys and CRLF output', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	const duplicate = '{"a":1,"a":2}';
	await importJson(page, 'duplicates.json', duplicate);
	await expect(page.getByTestId('json-duplicates')).toContainText('"a"');
	await page.getByTestId('json-format').click();
	await expect
		.poll(() => savedContent(page))
		.toBe('{\r\n  "a": 1,\r\n  "a": 2\r\n}'.replace(/\r\n/g, '\n'));

	await importJson(page, 'crlf.json', '{"a":1,"b":2}\r\n');
	await expect(page.getByTestId('code-eol')).toHaveText('CRLF');
	await page.getByTestId('json-format').click();
	await expect.poll(() => savedContent(page)).toBe('{\r\n  "a": 1,\r\n  "b": 2\r\n}');

	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Exporter', exact: true }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('crlf.json');
	const exported = await readFile((await download.path())!, 'utf8');
	expect(exported).toBe('{\r\n  "a": 1,\r\n  "b": 2\r\n}');

	await info.attach('json-duplicates.txt', {
		body: JSON.stringify({ duplicate, exported }),
		contentType: 'application/json'
	});
});
