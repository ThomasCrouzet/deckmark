// Native verification for the global quick-capture window.
//
// The workflow uses the command API, not an operating-system hotkey. It opens
// the capture window, saves notes into the library and a project, checks the
// durable rows, reopens the window, cancels, and checks that no row was added.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const invokeScript = `const done = arguments[arguments.length - 1];
window.__TAURI__.core.invoke(arguments[0], arguments[1]).then(
  value => done({ value }),
  error => done({ rejection: String(error) })
);`;
const captureSessionOptions = {
	capabilities: { alwaysMatch: { 'wdio:tauriServiceOptions': { windowLabel: 'capture' } } }
};

/**
 * Exercises the capture window through the native WebDriver.
 * @param {{
 *   request: (path: string, body?: unknown, method?: string) => Promise<any>,
 *   executeAsync: (script: string, args?: unknown[]) => Promise<any>,
 *   until: (check: () => Promise<unknown>, label: string, timeout?: number) => Promise<any>,
 *   output: string
 * }} context
 */
export async function nativeCapture({ request, executeAsync, until, output }) {
	const invoke = (command, args = {}) => executeAsync(invokeScript, [command, args]);
	const evidence = [];
	const record = (scenario, result) => {
		evidence.push({ scenario, result });
		return result;
	};
	const readDrafts = () =>
		executeAsync(`const done = arguments[arguments.length - 1];
			const request = indexedDB.open('mdsh');
			request.onerror = () => done({ error: String(request.error) });
			request.onsuccess = () => {
				const database = request.result;
				const query = database.transaction('drafts').objectStore('drafts').getAll();
				query.onerror = () => { database.close(); done({ error: String(query.error) }); };
				query.onsuccess = () => { database.close(); done(query.result); };
			};`);
	const openCaptureSession = async () => {
		// The window reports its label before the webview finishes the first load.
		// A script sent during that navigation can lose its reply and wait for the
		// client timeout. Let the page settle before the first evaluate call.
		await delay(1_500);
		const created = await request('/session', captureSessionOptions);
		const session = created.sessionId;
		await delay(800);
		const executeCapture = (script, args = []) =>
			request(`/session/${session}/execute/sync`, { script, args });
		try {
			await until(
				() => executeCapture('return !!document.querySelector("[data-testid=quick-capture]")'),
				'quick capture window ready',
				60_000
			);
		} catch (error) {
			const state = await executeCapture(`return {
				url: location.href,
				ready: document.readyState,
				title: document.title,
				shell: !!document.querySelector('.mdsh-shell'),
				capture: !!document.querySelector('[data-testid=quick-capture]'),
				alert: document.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
				text: document.body?.innerText?.slice(0, 600) ?? null,
				html: document.body?.innerHTML?.slice(0, 600) ?? null
			};`).catch((cause) => ({ error: String(cause) }));
			throw new Error(`${String(error)}; captureState=${JSON.stringify(state)}`, { cause: error });
		}
		return { session, executeCapture };
	};
	const closeCaptureSession = (session) => request(`/session/${session}`, undefined, 'DELETE');

	const initialStatus = record('status before enable', await invoke('desktop_capture_status'));
	assert.equal(initialStatus.rejection, undefined, initialStatus.rejection);
	assert.deepEqual(initialStatus.value, { registered: false, shortcut: null });

	const invalid = record(
		'invalid accelerator rejected',
		await invoke('desktop_capture_register', { shortcut: 'NotAKey' })
	);
	assert.equal(typeof invalid.rejection, 'string');

	const registered = record(
		'opt-in registration command',
		await invoke('desktop_capture_register', { shortcut: 'CommandOrControl+Shift+Space' })
	);
	const statusAfterRegister = record(
		'status after registration command',
		await invoke('desktop_capture_status')
	);
	assert.equal(statusAfterRegister.rejection, undefined, statusAfterRegister.rejection);
	assert.equal(statusAfterRegister.value.registered, registered.rejection === undefined);

	const unregistered = record('unregister command', await invoke('desktop_capture_unregister'));
	assert.equal(unregistered.rejection, undefined, unregistered.rejection);
	const statusAfterUnregister = record(
		'status after unregister',
		await invoke('desktop_capture_status')
	);
	assert.deepEqual(statusAfterUnregister.value, { registered: false, shortcut: null });

	const title = `Native capture ${Date.now()}`;
	const content = `# ${title}\n\nQuick capture body.\n`;
	const shown = record('show command opens the window', await invoke('desktop_capture_show'));
	assert.equal(shown.rejection, undefined, shown.rejection);

	const first = await openCaptureSession();
	const surface = record(
		'capture window has no full shell',
		await first.executeCapture(`return {
			shell: !!document.querySelector('.mdsh-shell'),
			sidebar: !!document.querySelector('aside'),
			editor: !!document.querySelector('.cm-content, .ProseMirror'),
			dialog: !!document.querySelector('[role="dialog"]'),
			textareas: document.querySelectorAll('textarea').length
		};`)
	);
	assert.deepEqual(surface, {
		shell: false,
		sidebar: false,
		editor: false,
		dialog: false,
		textareas: 1
	});

	await until(
		() =>
			first.executeCapture(
				`const [title, body] = arguments;
				const titleInput = document.querySelector('[data-testid=capture-title]');
				const bodyInput = document.querySelector('[data-testid=capture-content]');
				if (!titleInput || !bodyInput) return false;
				titleInput.value = title;
				titleInput.dispatchEvent(new Event('input', { bubbles: true }));
				bodyInput.value = body;
				bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
				return titleInput.value === title && bodyInput.value === body;`,
				[title, content]
			),
		'quick capture fields accept input'
	);
	await until(
		() =>
			first.executeCapture(
				`const button = document.querySelector('[data-testid=capture-save]');
				if (!button || button.disabled) return false;
				button.click();
				return true;`
			),
		'quick capture save'
	);
	const saved = await until(
		async () => {
			const rows = await readDrafts();
			if (!Array.isArray(rows)) return false;
			return rows.find(
				(row) => row.name === `${title}.md` && row.content === content && !row.projectId
			);
		},
		'capture note reaches IndexedDB',
		30_000
	);
	record('saved library note', {
		id: saved.id,
		name: saved.name,
		content: saved.content,
		projectId: saved.projectId ?? null,
		open: saved.open ?? null
	});
	record('hide command after save', await invoke('desktop_capture_hide'));
	await closeCaptureSession(first.session);

	const beforeCancel = await readDrafts();
	assert.ok(Array.isArray(beforeCancel));
	const reopened = record('show command reopens the window', await invoke('desktop_capture_show'));
	assert.equal(reopened.rejection, undefined, reopened.rejection);
	const second = await openCaptureSession();
	await until(
		() =>
			second.executeCapture(
				`const titleInput = document.querySelector('[data-testid=capture-title]');
				const bodyInput = document.querySelector('[data-testid=capture-content]');
				return !!titleInput && !!bodyInput && titleInput.value === '' && bodyInput.value === '';`
			),
		'quick capture window resets after reuse',
		15_000
	);
	await second.executeCapture(
		`const [title, body] = arguments;
		const titleInput = document.querySelector('[data-testid=capture-title]');
		const bodyInput = document.querySelector('[data-testid=capture-content]');
		titleInput.value = title;
		titleInput.dispatchEvent(new Event('input', { bubbles: true }));
		bodyInput.value = body;
		bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
		const cancel = document.querySelector('[data-testid=capture-cancel]');
		cancel.click();
		return true;`,
		[`${title} cancelled`, `${content}Cancelled body.\n`]
	);
	record('hide command after cancel', await invoke('desktop_capture_hide'));
	await closeCaptureSession(second.session);
	await delay(750);
	const afterCancel = await readDrafts();
	assert.ok(Array.isArray(afterCancel));
	assert.deepEqual(
		afterCancel.map((row) => row.id).sort(),
		beforeCancel.map((row) => row.id).sort()
	);
	record('cancel created no draft', {
		before: beforeCancel.length,
		after: afterCancel.length,
		cancelledRow: afterCancel.some((row) => row.name === `${title} cancelled.md`)
	});

	const projectRows = await executeAsync(`const done = arguments[arguments.length - 1];
		const request = indexedDB.open('mdsh');
		request.onerror = () => done({ error: String(request.error) });
		request.onsuccess = () => {
			const database = request.result;
			const query = database.transaction('projects').objectStore('projects').getAll();
			query.onerror = () => { database.close(); done({ error: String(query.error) }); };
			query.onsuccess = () => { database.close(); done(query.result); };
		};`);
	assert.ok(Array.isArray(projectRows), JSON.stringify(projectRows));
	if (projectRows.length > 0) {
		const project = projectRows[0];
		const projectTitle = `Native capture project ${Date.now()}`;
		const projectContent = `# ${projectTitle}\n\nProject capture body.\n`;
		record('show command for a project note', await invoke('desktop_capture_show'));
		const third = await openCaptureSession();
		await until(
			() =>
				third.executeCapture(
					`const select = document.querySelector('[data-testid=capture-project]');
					return !!select && select.value === '';`
				),
			'quick capture window resets before a project note',
			15_000
		);
		await until(
			() =>
				third.executeCapture(
					`return [...document.querySelectorAll('[data-testid=capture-project] option')]
						.some((option) => option.value === arguments[0]);`,
					[project.id]
				),
			'quick capture project option is available',
			15_000
		);
		await until(
			() =>
				third.executeCapture(
					`const [projectId, title, body] = arguments;
					const select = document.querySelector('[data-testid=capture-project]');
					const titleInput = document.querySelector('[data-testid=capture-title]');
					const bodyInput = document.querySelector('[data-testid=capture-content]');
					if (!select || !titleInput || !bodyInput) return false;
					select.value = projectId;
					select.dispatchEvent(new Event('change', { bubbles: true }));
					titleInput.value = title;
					titleInput.dispatchEvent(new Event('input', { bubbles: true }));
					bodyInput.value = body;
					bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
					return select.value === projectId;`,
					[project.id, projectTitle, projectContent]
				),
			'quick capture project fields accept input'
		);
		await until(
			() =>
				third.executeCapture(
					`const button = document.querySelector('[data-testid=capture-save]');
					if (!button || button.disabled) return false;
					button.click();
					return true;`
				),
			'quick capture project save'
		);
		const projectRow = await until(
			async () => {
				const rows = await readDrafts();
				if (!Array.isArray(rows)) return false;
				return rows.find((row) => row.projectId === project.id && row.content === projectContent);
			},
			'project capture note reaches IndexedDB',
			30_000
		);
		record('saved project note', {
			id: projectRow.id,
			name: projectRow.name,
			relativePath: projectRow.relativePath,
			projectId: projectRow.projectId,
			content: projectRow.content
		});
		record('hide command after project save', await invoke('desktop_capture_hide'));
		await closeCaptureSession(third.session);
	} else {
		record('saved project note', { skipped: true, reason: 'No project row is available.' });
	}

	writeFileSync(
		join(output, 'native-capture.json'),
		JSON.stringify(
			{
				recordedAt: new Date().toISOString(),
				platform: process.platform,
				commands: [
					'desktop_capture_show',
					'desktop_capture_hide',
					'desktop_capture_register',
					'desktop_capture_unregister',
					'desktop_capture_status'
				],
				shortcut: 'CommandOrControl+Shift+Space',
				fixture: { title, content },
				evidence
			},
			null,
			2
		)
	);
	return evidence;
}
