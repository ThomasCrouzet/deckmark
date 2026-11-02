import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Set a form value through its native setter and dispatch the user-facing events. */
async function setControl(execute, selector, value) {
	const changed = await execute(
		`const control = document.querySelector(arguments[0]);
		if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) return false;
		const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, 'value').set.call(control, arguments[1]);
		control.dispatchEvent(new Event('input', { bubbles: true }));
		control.dispatchEvent(new Event('change', { bubbles: true }));
		return true;`,
		[selector, value]
	);
	assert.equal(changed, true, `Presentation control is unavailable: ${selector}`);
}

/** Check the presentation workflow in the native WebView and retain both exports. */
export async function nativePresentationPdf({
	execute,
	click,
	nativeShortcut,
	until,
	nativePdfPath,
	output,
	temp,
	expectedTitle,
	capturePdf
}) {
	const mac = process.platform === 'darwin';
	const shortcut = mac
		? nativeShortcut
		: (key, shift = false) =>
				execute(
					`const target = document.activeElement ?? document.body;
					target.dispatchEvent(new KeyboardEvent('keydown', {
						key: arguments[0], code: 'Key' + arguments[0].toUpperCase(),
						ctrlKey: true, shiftKey: arguments[1], bubbles: true, cancelable: true
					}));`,
					[key, shift]
				);
	await shortcut('n');
	await click('[data-testid="create-presentation"]');
	await until(
		() =>
			execute(
				'const input = document.querySelector(`#app-toolbar input`); return !!input && !input.value.includes(arguments[0])',
				[expectedTitle]
			),
		'temporary presentation document'
	);
	await until(
		() => execute('return !!document.querySelector(`[data-testid="presentation-editor"]`)'),
		'inline presentation editor open',
		45_000
	);
	assert.equal(
		await execute('return document.querySelectorAll(`[data-testid="slide-thumbnail"]`).length'),
		1,
		'The new presentation must start as one slide'
	);
	await execute('document.querySelector("#app-toolbar input").focus();');
	await setControl(execute, '#app-toolbar input', 'Native presentation');
	await execute('document.querySelector("#app-toolbar input").blur();');
	await until(
		() =>
			execute(
				'return document.querySelector("#app-toolbar input")?.value === "Native presentation" && !document.querySelector("#app-toolbar input")?.disabled'
			),
		'presentation filename committed'
	);

	await setControl(execute, '[data-testid="slide-background"]', '#dbeafe');
	const initialObjectCount = await execute(
		'return document.querySelectorAll(`[data-testid="slide-object"]`).length'
	);
	await click('[data-testid="slide-add-rectangle"]');
	await until(
		() =>
			execute(
				'return document.querySelectorAll(`[data-testid="slide-object"]`).length === arguments[0] + 1',
				[initialObjectCount]
			),
		'native presentation shape creation'
	);
	await shortcut('z');
	await until(
		() =>
			execute(
				'return document.querySelectorAll(`[data-testid="slide-object"]`).length === arguments[0]',
				[initialObjectCount]
			),
		'native presentation undo'
	);
	await shortcut('z', true);
	await until(
		() =>
			execute(
				'return document.querySelectorAll(`[data-testid="slide-object"]`).length === arguments[0] + 1',
				[initialObjectCount]
			),
		'native presentation redo'
	);
	await click('[data-testid="slide-add"]');
	await setControl(execute, '[data-testid="slide-background"]', '#dcfce7');
	await click('[data-testid="slide-add-ellipse"]');
	await click('[data-testid="slide-add"]');
	await setControl(execute, '[data-testid="slide-background"]', '#fef3c7');
	await click('[data-testid="slide-add-arrow"]');
	await setControl(execute, '[data-testid="slide-notes"]', 'NATIVE_PRESENTATION_PRIVATE_NOTE');
	assert.equal(
		await execute('return document.querySelectorAll(`[data-testid="slide-thumbnail"]`).length'),
		3,
		'The native fixture must contain three slides'
	);
	await click('[data-testid="slide-advanced"]');
	await click('[data-testid="slide-source"]');
	const source = await execute(
		'return document.querySelector(`[data-testid="slide-source-editor"]`).value'
	);
	assert.ok(source.includes('<!-- mdsh-presentation'));
	await setControl(execute, '[data-testid="slide-source-editor"]', '# Canceled source draft');
	await click('[data-testid="slide-source-cancel"]');
	await click('[data-testid="slide-advanced"]');
	await click('[data-testid="slide-source"]');
	assert.equal(
		await execute('return document.querySelector(`[data-testid="slide-source-editor"]`).value'),
		source,
		'Cancel must keep the presentation source'
	);
	const appliedSource = source.replace(
		'NATIVE_PRESENTATION_PRIVATE_NOTE',
		'NATIVE_PRESENTATION_PRIVATE_NOTE Applied'
	);
	await setControl(execute, '[data-testid="slide-source-editor"]', appliedSource);
	await click('[data-testid="slide-source-apply"]');
	await until(
		() => execute('return !document.querySelector(`[data-testid="slide-source-editor"]`)'),
		'advanced source applied'
	);
	await click('[data-testid="slide-advanced"]');
	await click('[data-testid="slide-source"]');
	assert.equal(
		await execute('return document.querySelector(`[data-testid="slide-source-editor"]`).value'),
		appliedSource,
		'Apply must retain the changed presentation source'
	);
	await click('[data-testid="slide-source-cancel"]');

	const directory = join(output, 'presentation-pdf');
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, 'native-presentation.md'), appliedSource);
	const inspector = join(temp, 'presentation-pdf-inspector');
	const evidence = {
		platform: process.platform,
		shortcutMethod: mac ? 'AppKit menu action' : 'WebView keyboard event',
		printMethod: mac
			? 'product AppKit print operation'
			: 'WebDriver PDF capture of product print DOM',
		fixture: { source: join(directory, 'native-presentation.md'), slides: 3, aspect: '16:9' },
		projectsMenuGuard: {
			status: mac ? 'pending' : 'not run',
			reason: mac ? '' : 'AppKit menu bridge is macOS-only'
		},
		exports: []
	};
	const record = () =>
		writeFileSync(join(directory, 'results.json'), JSON.stringify(evidence, null, 2));
	record();
	if (mac) {
		execFileSync(
			'swiftc',
			['-O', resolve('scripts/inspect-native-presentation-pdf.swift'), '-o', inspector],
			{ stdio: 'inherit', timeout: 60_000 }
		);
		await click('[data-testid="projects-open"]');
		await until(
			() =>
				execute(
					'return !!document.querySelector(`[aria-labelledby="projects-title"] header button:not(:disabled)`)'
				),
			'Projects ready before native menu action'
		);
		const before = statSync(nativePdfPath).mtimeMs;
		await execute(`window.__presentationGuardActions = [];
			window.__presentationGuardListener = event => window.__presentationGuardActions.push(event.detail);
			window.addEventListener('mdsh:presentation-action', window.__presentationGuardListener);`);
		try {
			await nativeShortcut('p');
			await delay(1000);
			const observed = await execute(`return {
				projectsOpen: !!document.querySelector('[aria-labelledby="projects-title"]'),
				printOpen: !!document.getElementById('mdsh-native-print'),
				actions: window.__presentationGuardActions
			};`);
			const after = statSync(nativePdfPath).mtimeMs;
			Object.assign(evidence.projectsMenuGuard, { observed, before, after, observationMs: 1000 });
			record();
			assert.equal(observed.projectsOpen, true);
			assert.equal(observed.printOpen, false);
			assert.deepEqual(observed.actions, []);
			assert.equal(after, before, 'Projects must block the actual native PDF menu');
			evidence.projectsMenuGuard.status = 'blocked';
		} finally {
			await execute(`window.removeEventListener('mdsh:presentation-action', window.__presentationGuardListener);
				delete window.__presentationGuardListener; delete window.__presentationGuardActions;`);
		}
		await click('[aria-labelledby="projects-title"] header button:not(:disabled)');
		await until(
			() => execute('return !document.querySelector(`[aria-labelledby="projects-title"]`)'),
			'Projects closed before native export resumes'
		);
	}

	for (const action of ['menu', 'shortcut']) {
		const actionDirectory = join(directory, action);
		mkdirSync(actionDirectory, { recursive: true });
		const retainedPdf = join(actionDirectory, 'native-presentation.pdf');
		const previousModified = mac ? statSync(nativePdfPath).mtimeMs : null;
		let prepared;
		let pdf;
		if (!mac) {
			await execute(`window.__presentationOriginalPrint = window.print;
				window.__presentationPrintCalled = false;
				window.print = () => { window.__presentationPrintCalled = true; };`);
		}
		try {
			if (action === 'menu') {
				await click('[data-testid="slide-export"]');
				await click('[data-testid="slide-export-pdf"]');
			} else {
				await execute('document.querySelector(`[data-testid="presentation-editor"]`).focus();');
				await shortcut('p');
			}
			if (mac) {
				await until(
					() =>
						statSync(nativePdfPath).mtimeMs !== previousModified &&
						statSync(nativePdfPath).size > 1_000,
					`native presentation PDF ${action}`,
					45_000
				);
				await until(
					() => execute('return !document.getElementById("mdsh-native-print")'),
					`native presentation ${action} cleanup`,
					45_000
				);
				pdf = readFileSync(nativePdfPath);
			} else {
				await until(
					() => execute('return window.__presentationPrintCalled === true'),
					`native presentation ${action} print preparation`,
					45_000
				);
				prepared =
					await execute(`const root = document.getElementById('mdsh-native-print')?.shadowRoot;
					return { html: root?.innerHTML ?? '', slides: Array.from(root?.querySelectorAll('section.mdsh-slide[data-slide-index]') ?? [], slide => ({
						index: slide.dataset.slideIndex, background: slide.style.getPropertyValue('--slide-background')
					})) };`);
				writeFileSync(join(actionDirectory, 'prepared.html'), prepared.html);
				assert.equal(prepared.slides.length, 3);
				assert.deepEqual(
					prepared.slides.map((slide) => slide.background),
					['#dbeafe', '#dcfce7', '#fef3c7']
				);
				assert.ok(!prepared.html.includes('NATIVE_PRESENTATION_PRIVATE_NOTE'));
				// Keep the product print media and page rules. Only replace the final OS dialog.
				pdf = Buffer.from(await capturePdf(), 'base64');
			}
			writeFileSync(retainedPdf, pdf);
			assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
			assert.ok(pdf.length > 1_000);
			let inspection;
			if (mac) {
				execFileSync(inspector, [retainedPdf, actionDirectory], {
					stdio: 'inherit',
					timeout: 30_000
				});
				inspection = JSON.parse(
					readFileSync(join(actionDirectory, 'native-presentation-pdf-inspection.json'), 'utf8')
				);
				assert.equal(inspection.pageCount, 3);
				assert.equal(inspection.privateNotesExcluded, true);
			} else {
				const structure = pdf.toString('latin1');
				const pageCount = structure.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
				const pageRatios = [
					...structure.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g)
				].map(
					(match) => (Number(match[3]) - Number(match[1])) / (Number(match[4]) - Number(match[2]))
				);
				inspection = {
					pageCount,
					pageRatios,
					privateNotesExcludedFromPrintDom: true,
					slides: prepared.slides
				};
				writeFileSync(
					join(actionDirectory, 'native-presentation-pdf-inspection.json'),
					JSON.stringify(inspection, null, 2)
				);
				assert.equal(pageCount, 3);
				assert.ok(pageRatios.length > 0);
				for (const ratio of pageRatios) assert.ok(Math.abs(ratio - 16 / 9) < 0.02);
			}
			evidence.exports.push({
				action,
				pdf: retainedPdf,
				sha256: createHash('sha256').update(pdf).digest('hex'),
				bytes: pdf.length,
				inspection
			});
			record();
		} finally {
			if (!mac) {
				await execute(`window.print = window.__presentationOriginalPrint;
					delete window.__presentationOriginalPrint; delete window.__presentationPrintCalled;
					window.dispatchEvent(new Event('afterprint'));`);
			}
		}
		await until(
			() => execute('return !document.getElementById("mdsh-native-print")'),
			`presentation ${action} export cleanup`
		);
	}
	if (mac) evidence.projectsMenuGuard.status = 'blocked then resumed';
	await shortcut('w');
	await until(
		() =>
			execute(
				'return !document.querySelector(`[data-testid="presentation-editor"]`) && document.querySelector(`#app-toolbar input`)?.value.includes(arguments[0])',
				[expectedTitle]
			),
		'original document restored after presentation'
	);
	record();
	return evidence;
}
