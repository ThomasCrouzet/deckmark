import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

/** Export and inspect a real three-slide PDF through the native product command. */
export async function nativePresentationPdf({
	execute,
	click,
	nativeShortcut,
	until,
	nativePdfPath,
	output,
	temp,
	expectedTitle
}) {
	await nativeShortcut('n');
	await until(
		() =>
			execute(
				'const input = document.querySelector(`header input`); return !!input && !input.value.includes(arguments[0])',
				[expectedTitle]
			),
		'temporary presentation document'
	);
	await click('[data-testid="slides-open"]');
	await until(
		() => execute('return !!document.querySelector(`[data-testid="presentation-editor"]`)'),
		'presentation editor open',
		45_000
	);
	assert.equal(
		await execute('return document.querySelectorAll(`[data-testid="slide-thumbnail"]`).length'),
		1,
		'The imported document must start as one slide'
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
	await nativeShortcut('z');
	await until(
		() =>
			execute(
				'return document.querySelectorAll(`[data-testid="slide-object"]`).length === arguments[0]',
				[initialObjectCount]
			),
		'native presentation undo'
	);
	await nativeShortcut('z', true);
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

	const previousModified = statSync(nativePdfPath).mtimeMs;
	await nativeShortcut('p');
	await until(
		() =>
			statSync(nativePdfPath).mtimeMs !== previousModified && statSync(nativePdfPath).size > 1_000,
		'native presentation PDF export',
		45_000
	);
	await until(
		() => execute('return !document.getElementById("mdsh-native-print")'),
		'native presentation print cleanup',
		45_000
	);

	const directory = join(output, 'presentation-pdf');
	mkdirSync(directory, { recursive: true });
	const pdf = readFileSync(nativePdfPath);
	const retainedPdf = join(directory, 'native-presentation.pdf');
	writeFileSync(retainedPdf, pdf);
	assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
	const inspector = join(temp, 'presentation-pdf-inspector');
	execFileSync(
		'swiftc',
		['-O', resolve('scripts/inspect-native-presentation-pdf.swift'), '-o', inspector],
		{ stdio: 'inherit', timeout: 60_000 }
	);
	execFileSync(inspector, [retainedPdf, directory], { stdio: 'inherit', timeout: 30_000 });
	const inspection = JSON.parse(
		readFileSync(join(directory, 'native-presentation-pdf-inspection.json'), 'utf8')
	);
	assert.equal(inspection.pageCount, 3);
	assert.equal(inspection.privateNotesExcluded, true);
	await click('[data-testid="slide-close"]');
	await until(
		() => execute('return !document.querySelector(`[data-testid="presentation-editor"]`)'),
		'presentation editor closed'
	);
	await nativeShortcut('w');
	await until(
		() =>
			execute('return document.querySelector(`header input`)?.value.includes(arguments[0])', [
				expectedTitle
			]),
		'original document restored after presentation'
	);
	return {
		pdf: retainedPdf,
		sha256: createHash('sha256').update(pdf).digest('hex'),
		bytes: pdf.length,
		inspection
	};
}
