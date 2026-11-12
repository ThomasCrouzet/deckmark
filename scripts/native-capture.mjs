// Native verification for the global quick-capture window.
//
// The workflow uses the command API, not an operating-system hotkey. It opens
// the capture window, saves notes into the library and a project, checks the
// durable rows, reopens the window, cancels, and checks that no row was added.
//
// The WebDriver session switches to the capture window instead of creating a
// second session. A second session hangs on WebView2, and one session keeps
// the main and capture checks on the same connection.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const invokeScript = `const done = arguments[arguments.length - 1];
window.__TAURI__.core.invoke(arguments[0], arguments[1]).then(
  value => done({ value }),
  error => done({ rejection: String(error) })
);`;

/**
 * Exercises the capture window through the native WebDriver.
 * @param {{
 *   request: (path: string, body?: unknown, method?: string) => Promise<any>,
 *   executeAsync: (script: string, args?: unknown[]) => Promise<any>,
 *   until: (check: () => Promise<unknown>, label: string, timeout?: number) => Promise<any>,
 *   output: string,
 *   session: string
 * }} context
 */
export async function nativeCapture({ request, executeAsync, until, output, session }) {
	const invoke = (command, args = {}) => executeAsync(invokeScript, [command, args]);
	const evidence = [];
	const record = (scenario, result) => {
		evidence.push({ scenario, result });
		return result;
	};
	const executeIn = (script, args = []) =>
		request(`/session/${session}/execute/sync`, { script, args });
	const switchWindow = (label) =>
		until(
			async () => {
				try {
					const handles = await request(`/session/${session}/window/handles`, undefined, 'GET');
					if (!Array.isArray(handles) || !handles.includes(label)) return false;
					await request(`/session/${session}/window`, { handle: label });
					return true;
				} catch {
					return false;
				}
			},
			`switch to the ${label} window`,
			30_000
		);
	const readSnippets = () =>
		executeAsync(`const done = arguments[arguments.length - 1];
			const request = indexedDB.open('mdsh');
			request.onerror = () => done({ error: String(request.error) });
			request.onsuccess = () => {
				const database = request.result;
				const query = database.transaction('snippets').objectStore('snippets').getAll();
				query.onerror = () => { database.close(); done({ error: String(query.error) }); };
				query.onsuccess = () => { database.close(); done(query.result); };
			};`);
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
	const openCapture = async () => {
		await switchWindow('capture');
		await until(
			() => executeIn('return !!document.querySelector("[data-testid=quick-capture]")'),
			'quick capture window ready',
			45_000
		);
		return executeIn;
	};

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

	const invalidReplacement = record(
		'invalid replacement keeps the working binding',
		await invoke('desktop_capture_register', { shortcut: 'Control+Alt+KeyK+Extra' })
	);
	assert.equal(typeof invalidReplacement.rejection, 'string');
	const statusAfterInvalidReplacement = record(
		'status after an invalid replacement',
		await invoke('desktop_capture_status')
	);
	assert.equal(statusAfterInvalidReplacement.value.shortcut, 'CommandOrControl+Shift+Space');

	const replacement = record(
		'shortcut replacement registers the new binding',
		await invoke('desktop_capture_register', { shortcut: 'Control+Alt+KeyK' })
	);
	assert.equal(replacement.rejection, undefined, replacement.rejection);
	const statusAfterReplacement = record(
		'status after shortcut replacement',
		await invoke('desktop_capture_status')
	);
	assert.deepEqual(statusAfterReplacement.value, {
		registered: true,
		shortcut: 'Control+Alt+KeyK'
	});
	const restored = record(
		'shortcut replacement restores the first binding',
		await invoke('desktop_capture_register', { shortcut: 'CommandOrControl+Shift+Space' })
	);
	assert.equal(restored.rejection, undefined, restored.rejection);
	const statusAfterRestore = record(
		'status after restoring the first binding',
		await invoke('desktop_capture_status')
	);
	assert.equal(statusAfterRestore.value.shortcut, 'CommandOrControl+Shift+Space');

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

	const capture = await openCapture();
	const surface = record(
		'capture window has no full shell',
		await capture(`return {
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
			capture(
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
			capture(
				`const button = document.querySelector('[data-testid=capture-save]');
				if (!button || button.disabled) return false;
				button.click();
				return true;`
			),
		'quick capture save'
	);
	await switchWindow('main');
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

	const beforeCancel = await readDrafts();
	assert.ok(Array.isArray(beforeCancel));
	const reopened = record('show command reopens the window', await invoke('desktop_capture_show'));
	assert.equal(reopened.rejection, undefined, reopened.rejection);
	await openCapture();
	await until(
		() =>
			executeIn(
				`const titleInput = document.querySelector('[data-testid=capture-title]');
				const bodyInput = document.querySelector('[data-testid=capture-content]');
				return !!titleInput && !!bodyInput && titleInput.value === '' && bodyInput.value === '';`
			),
		'quick capture window resets after reuse',
		15_000
	);
	await executeIn(
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
	await switchWindow('main');
	record('hide command after cancel', await invoke('desktop_capture_hide'));
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
		await openCapture();
		await until(
			() =>
				executeIn(
					`const select = document.querySelector('[data-testid=capture-project]');
					return !!select && select.value === '';`
				),
			'quick capture window resets before a project note',
			15_000
		);
		await until(
			() =>
				executeIn(
					`return [...document.querySelectorAll('[data-testid=capture-project] option')]
						.some((option) => option.value === arguments[0]);`,
					[project.id]
				),
			'quick capture project option is available',
			15_000
		);
		await until(
			() =>
				executeIn(
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
				executeIn(
					`const button = document.querySelector('[data-testid=capture-save]');
					if (!button || button.disabled) return false;
					button.click();
					return true;`
				),
			'quick capture project save'
		);
		await switchWindow('main');
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
	} else {
		record('saved project note', { skipped: true, reason: 'No project row is available.' });
	}

	const snippetTitle = `Native snippet ${Date.now()}`;
	const snippetCode = 'const quickCapture = true;\n';
	record('show command for a snippet', await invoke('desktop_capture_show'));
	await openCapture();
	await until(
		() =>
			executeIn(
				`const select = document.querySelector('[data-testid=capture-kind]');
				if (!select || select.value !== 'note') return false;
				select.value = 'snippet';
				select.dispatchEvent(new Event('change', { bubbles: true }));
				return select.value === 'snippet';`
			),
		'quick capture kind switches to a snippet',
		15_000
	);
	await until(
		() =>
			executeIn(
				`const [title, code] = arguments;
				const titleInput = document.querySelector('[data-testid=capture-title]');
				const bodyInput = document.querySelector('[data-testid=capture-content]');
				const languageSelect = document.querySelector('[data-testid=capture-language]');
				if (!titleInput || !bodyInput || !languageSelect) return false;
				languageSelect.value = 'typescript';
				languageSelect.dispatchEvent(new Event('change', { bubbles: true }));
				titleInput.value = title;
				titleInput.dispatchEvent(new Event('input', { bubbles: true }));
				bodyInput.value = code;
				bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
				return titleInput.value === title && bodyInput.value === code;`,
				[snippetTitle, snippetCode]
			),
		'quick capture snippet fields accept input'
	);
	await until(
		() =>
			executeIn(
				`const button = document.querySelector('[data-testid=capture-save]');
				if (!button || button.disabled) return false;
				button.click();
				return true;`
			),
		'quick capture snippet save'
	);
	await switchWindow('main');
	const snippetRow = await until(
		async () => {
			const rows = await readSnippets();
			if (!Array.isArray(rows)) return false;
			return rows.find((row) => row.title === snippetTitle && row.code === snippetCode);
		},
		'capture snippet reaches IndexedDB',
		30_000
	);
	record('saved snippet', {
		id: snippetRow.id,
		title: snippetRow.title,
		language: snippetRow.language,
		code: snippetRow.code
	});
	record('hide command after snippet save', await invoke('desktop_capture_hide'));

	record('show command for a template note', await invoke('desktop_capture_show'));
	await openCapture();
	const templateApplied = await until(
		() =>
			executeIn(
				`const select = document.querySelector('[data-testid=capture-template]');
				if (!select || select.options.length < 2) return false;
				select.value = select.options[1].value;
				select.dispatchEvent(new Event('change', { bubbles: true }));
				return true;`
			),
		'quick capture template selector is available',
		15_000
	);
	assert.equal(templateApplied, true);
	const templateBody = await until(
		() =>
			executeIn(
				`const body = document.querySelector('[data-testid=capture-content]')?.value ?? '';
				return body.trim().length > 0 ? body : false;`
			),
		'quick capture template fills the note body',
		15_000
	);
	record('template applied', { bodyPreview: String(templateBody).slice(0, 60) });
	await executeIn(`document.querySelector('[data-testid=capture-cancel]').click(); return true;`);
	await switchWindow('main');
	record('hide command after template cancel', await invoke('desktop_capture_hide'));

	// A programmatic value assignment and input event after the template change
	// run before the dynamic import and the IndexedDB read can resume. This is
	// not physical typing. A late template result must not replace this value or
	// set the title.
	record('show command for a programmatic template race', await invoke('desktop_capture_show'));
	await openCapture();
	await until(
		() =>
			executeIn(
				`const select = document.querySelector('[data-testid=capture-template]');
				return !!select && select.options.length > 1;`
			),
		'quick capture template selector is available for the programmatic race',
		15_000
	);
	const raceTyped = await executeIn(
		`const select = document.querySelector('[data-testid=capture-template]');
		const titleInput = document.querySelector('[data-testid=capture-title]');
		const bodyInput = document.querySelector('[data-testid=capture-content]');
		if (!select || !titleInput || !bodyInput) return null;
		select.value = select.options[1].value;
		select.dispatchEvent(new Event('change', { bubbles: true }));
		titleInput.value = '';
		titleInput.dispatchEvent(new Event('input', { bubbles: true }));
		bodyInput.value = 'Typed while the template loaded';
		bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
		return { body: bodyInput.value, title: titleInput.value };`
	);
	assert.deepEqual(raceTyped, { body: 'Typed while the template loaded', title: '' });
	await delay(1500);
	const raceAfter = record('programmatic input survives a late template resolution', {
		...(await executeIn(
			`const titleInput = document.querySelector('[data-testid=capture-title]');
				const bodyInput = document.querySelector('[data-testid=capture-content]');
				return { body: bodyInput?.value ?? null, title: titleInput?.value ?? null };`
		)),
		inputMethod: 'programmatic value and input event; not physical typing'
	});
	assert.deepEqual(
		{ body: raceAfter.body, title: raceAfter.title },
		{ body: 'Typed while the template loaded', title: '' }
	);
	await executeIn(`document.querySelector('[data-testid=capture-cancel]').click(); return true;`);
	await switchWindow('main');
	record('hide command after programmatic template race', await invoke('desktop_capture_hide'));

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
