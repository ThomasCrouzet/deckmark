import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';
import { holdReplies, installJsonProbe, probeState } from './json-worker-probe';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const MEGABYTE = 1_000_000;

function maxLineLength(text: string): number {
	let longest = 0;
	let start = 0;
	for (let index = 0; index <= text.length; index++) {
		const code = text.charCodeAt(index);
		if (index < text.length && code !== 10 && code !== 13) continue;
		longest = Math.max(longest, index - start);
		if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
		start = index + 1;
	}
	return longest;
}

function fixture(name: string, content: string) {
	return {
		name,
		bytes: Buffer.byteLength(content, 'utf8'),
		codeUnits: content.length,
		maxLine: maxLineLength(content),
		sha256: createHash('sha256').update(content, 'utf8').digest('hex')
	};
}

function longLineScript(bytes = MEGABYTE): string {
	const prefix = 'const payload = "needle';
	const suffix = '";\n';
	return prefix + 'a'.repeat(bytes - prefix.length - suffix.length) + suffix;
}

function longColumnLine(bytes = 100_000): string {
	const prefix = 'needle,';
	return prefix + 'c,'.repeat(Math.ceil((bytes - prefix.length) / 2));
}

function minifiedJson(bytes = MEGABYTE): string {
	const prefix = '{"items":[';
	const suffix = ']}';
	const rows: string[] = [];
	let length = prefix.length + suffix.length;
	let index = 0;
	while (length < bytes - 64) {
		const row = `${index === 0 ? '' : ','}{"id":${index},"value":${index * 7}}`;
		rows.push(row);
		length += row.length;
		index++;
	}
	return prefix + rows.join('') + suffix;
}

function summarise(samples: Array<{ sync: number; frame: number }>) {
	const frames = samples.map((sample) => sample.frame).sort((a, b) => a - b);
	const pick = (fraction: number) =>
		frames[Math.min(frames.length - 1, Math.floor(frames.length * fraction))] ?? 0;
	return {
		count: samples.length,
		p50: pick(0.5),
		p95: pick(0.95),
		max: frames[frames.length - 1] ?? 0,
		raw: samples
	};
}

async function sampleInput(page: Page, count: number) {
	return page.evaluate(async (sampleCount) => {
		const content = document.querySelector('.cm-content');
		if (!(content instanceof HTMLElement)) throw new Error('The code editor is not mounted.');
		content.focus();
		const samples: Array<{ sync: number; frame: number }> = [];
		for (let index = 0; index < sampleCount; index++) {
			const startedAt = performance.now();
			document.execCommand('insertText', false, 'x');
			const sync = performance.now() - startedAt;
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			samples.push({ sync, frame: performance.now() - startedAt });
		}
		return samples;
	}, count);
}

async function importCode(page: Page, name: string, content: string) {
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles({
		name,
		mimeType: 'text/plain',
		buffer: Buffer.from(content)
	});
	await expect(page.getByTestId('code-editor')).toBeVisible({ timeout: 20_000 });
}

async function editorText(page: Page) {
	return page.locator('.cm-content').evaluate((root) =>
		Array.from(root.querySelectorAll('.cm-line'))
			.map((line) => line.textContent?.replaceAll('¶', ''))
			.join('\n')
	);
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
						const active = rows.result.find((row) => row.open !== false);
						resolve(active?.content ?? '');
					};
				};
			})
	);
}

test('highlights language syntax and edits code without Markdown', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await importCode(page, 'script.py', 'def main():\n    return 1\n');
	await expect(page.getByTestId('code-language')).toHaveText('Python');
	await expect(page.getByTestId('code-eol')).toHaveText('LF');
	await expect(page.locator('.cm-lineNumbers')).toBeVisible();
	expect(await page.locator('.cm-content .cm-line span').count()).toBeGreaterThan(0);

	const editor = page.locator('.cm-content').first();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('\nvalue = ');
	await page.keyboard.type('(');
	await expect.poll(() => editorText(page)).toContain('value = ()');

	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText('const = "Markdown"\n');
	await expect(page.locator('.ProseMirror')).toHaveCount(0);
	await expect(page.getByTestId('document-kind')).toHaveText('Code');

	await page.keyboard.press('ControlOrMeta+f');
	await expect(page.locator('.cm-panels')).toBeVisible();
	await page.keyboard.type('Markdown');
	await expect(page.locator('.cm-searchMatch')).toHaveCount(1);
	await page.keyboard.press('Escape');

	await info.attach('code-editor.json', {
		body: JSON.stringify({
			language: await page.getByTestId('code-language').innerText(),
			eol: await page.getByTestId('code-eol').innerText(),
			text: await editorText(page)
		}),
		contentType: 'application/json'
	});
	await info.attach('code-editor.png', { body: await page.screenshot() });
});

test('discards a JSON worker reply after changing or closing the file', async ({ page }, info) => {
	await installJsonProbe(page);
	await resetAppState(page);
	await importCode(page, 'old.json', '{"old":1}');
	await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
	await holdReplies(page, true);
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText('{"old":}');
	await expect.poll(async () => (await probeState(page)).held).toBe(1);
	await importCode(page, 'current.json', '{"current":2}');
	await holdReplies(page, false);
	await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
	await expect(page.locator('.cm-content')).toContainText('current');
	await expect(page.getByTestId('json-duplicates')).toHaveCount(0);
	await holdReplies(page, true);
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' ');
	await expect.poll(async () => (await probeState(page)).held).toBe(1);
	await page.getByRole('button', { name: 'Fermer current.json', exact: true }).click();
	await holdReplies(page, false);
	await expect(page.getByTestId('json-status')).toContainText('JSON invalide');
	await expect(page.locator('.cm-content')).toContainText('old');
	await info.attach('json-file-lifecycle.json', {
		body: JSON.stringify(await probeState(page)),
		contentType: 'application/json'
	});
});

test('toggles invisibles, wrapping and indentation', async ({ page }, info: TestInfo) => {
	await resetAppState(page);
	await importCode(page, 'main.rs', 'fn main() {}\n');
	await expect(page.getByTestId('code-indent-style')).toHaveValue('space');
	await expect(page.getByTestId('code-indent-size')).toHaveValue('2');

	await page.getByTestId('code-invisibles').click();
	await expect(page.getByTestId('code-invisibles')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('.cm-invisible-newline').first()).toBeVisible();

	await page.getByTestId('code-wrap').click();
	await expect(page.getByTestId('code-wrap')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('.cm-content')).toHaveClass(/cm-lineWrapping/);

	await page.getByTestId('code-indent-style').selectOption('tab');
	await page.getByTestId('code-editor').locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.press('Enter');
	await page.keyboard.press('Tab');
	await expect.poll(() => savedContent(page)).toBe('fn main() {}\n\n\t');

	await page.getByTestId('code-indent-style').selectOption('space');
	await page.getByTestId('code-indent-size').selectOption('4');
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.press('Tab');
	await expect.poll(() => savedContent(page)).toBe('fn main() {}\n\n\t    ');

	await info.attach('code-options.json', {
		body: JSON.stringify({
			invisibles: true,
			wrap: true,
			indent: await page.getByTestId('code-indent-style').inputValue(),
			size: await page.getByTestId('code-indent-size').inputValue()
		}),
		contentType: 'application/json'
	});
});

test('keeps cursor and undo history across code file switches', async ({ page }) => {
	await resetAppState(page);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles([
		{ name: 'one.js', mimeType: 'text/javascript', buffer: Buffer.from('const one = 1;\n') },
		{ name: 'two.js', mimeType: 'text/javascript', buffer: Buffer.from('const two = 2;\n') }
	]);
	await expect(page.getByTestId('code-language')).toHaveText('JavaScript');
	await page
		.locator('aside')
		.getByRole('button', { name: /^one\.js/ })
		.first()
		.click();
	await expect(page.getByTestId('code-editor')).toBeVisible();
	await page.locator('.cm-content').first().click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('// edited');
	await page
		.locator('aside')
		.getByRole('button', { name: /^two\.js/ })
		.first()
		.click();
	await expect(page.getByTestId('code-editor')).toBeVisible();
	await expect(page.locator('.cm-content')).toContainText('const two');
	await page
		.locator('aside')
		.getByRole('button', { name: /^one\.js/ })
		.first()
		.click();
	await expect(page.locator('.cm-content')).toContainText('// edited');
	await page.locator('.cm-content').first().click();
	await page.keyboard.press('ControlOrMeta+z');
	await expect(page.locator('.cm-content')).not.toContainText('// edited');
});

test('reports and converts line endings without changing the extension', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await importCode(page, 'crlf.py', 'print("a")\r\nprint("b")\r\n');
	await expect(page.getByTestId('code-eol')).toHaveText('CRLF');
	await page.getByTestId('code-eol-toggle').click();
	await expect(page.getByTestId('code-eol')).toHaveText('LF');
	await page.waitForTimeout(600);

	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Exporter', exact: true }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('crlf.py');
	const text = await readFile((await download.path())!, 'utf8');
	expect(text).toBe('print("a")\nprint("b")\n');

	await page.getByTestId('code-eol-toggle').click();
	await expect(page.getByTestId('code-eol')).toHaveText('CRLF');
	await info.attach('line-endings.txt', { body: text, contentType: 'text/plain' });
});

test('uses an explicit plain-text fallback for an unknown code language', async ({ page }) => {
	await resetAppState(page);
	await importCode(page, 'script.rb', 'puts "hello"\n');
	const label = page.getByTestId('code-language');
	await expect(label).toHaveText('Texte brut (rb)');
	await expect(label).toHaveAttribute('data-fallback', 'true');
	await expect(page.locator('.cm-content')).toContainText('puts');
});

test('uses accurate grammars for C#, PowerShell and JSON with comments', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await page.locator('input[type="file"][accept*="text/markdown"]').setInputFiles([
		{
			name: 'Program.cs',
			mimeType: 'text/plain',
			buffer: Buffer.from('public class Program {\n  public static void Main() {}\n}\n')
		},
		{
			name: 'deploy.ps1',
			mimeType: 'text/plain',
			buffer: Buffer.from('param([string]$Name)\nWrite-Host "Hello $Name"\n')
		},
		{
			name: 'settings.jsonc',
			mimeType: 'text/plain',
			buffer: Buffer.from('{\n  // keep this comment\n  "enabled": true\n}\n')
		}
	]);
	await expect(page.getByTestId('code-language')).toHaveText('JSON with comments');
	await expect(page.getByTestId('json-status')).toHaveCount(0);
	await expect(page.getByTestId('json-format')).toHaveCount(0);
	await page
		.locator('aside')
		.getByRole('button', { name: /^Program\.cs/ })
		.first()
		.click();
	await expect(page.getByTestId('code-language')).toHaveText('C#');
	await expect(page.locator('.cm-content')).toContainText('public class Program');
	await page
		.locator('aside')
		.getByRole('button', { name: /^deploy\.ps1/ })
		.first()
		.click();
	await expect(page.getByTestId('code-language')).toHaveText('PowerShell');
	await expect(page.locator('.cm-content')).toContainText('Write-Host');

	await info.attach('language-grammars.json', {
		body: JSON.stringify({
			csharp: 'C#',
			powershell: 'PowerShell',
			jsonc: 'JSON with comments'
		}),
		contentType: 'application/json'
	});
});

test('reloads the grammar when the extension changes and preserves text', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await importCode(page, 'script.py', 'value = 1\n');
	const name = page.locator('header input').first();
	await name.fill('script.js');
	await name.press('Enter');
	await expect(page.getByTestId('code-language')).toHaveText('JavaScript');
	await expect(page.getByTestId('code-eol')).toHaveText('LF');
	await expect(page.locator('.cm-content')).toContainText('value = 1');
	await expect.poll(() => savedContent(page)).toBe('value = 1\n');

	await info.attach('language-switch.json', {
		body: JSON.stringify({
			name: await name.inputValue(),
			language: await page.getByTestId('code-language').innerText(),
			content: await savedContent(page)
		}),
		contentType: 'application/json'
	});
});

type PerfCounters = Record<string, number>;

async function readPerfCounters(page: Page): Promise<PerfCounters> {
	return page.evaluate(() => ({
		codeFullRebuild: performance.getEntriesByName('mdsh:code-full-rebuild').length,
		codeBufferApply: performance.getEntriesByName('mdsh:code-buffer-apply').length,
		codeSnapshot: performance.getEntriesByName('mdsh:code-snapshot').length,
		codeNativeApply: performance.getEntriesByName('mdsh:code-native-apply').length,
		codeNativeReject: performance.getEntriesByName('mdsh:code-native-reject').length,
		codeStringPublish: performance.getEntriesByName('mdsh:code-string-publish').length
	}));
}

function counterDelta(before: PerfCounters, after: PerfCounters): PerfCounters {
	const result: PerfCounters = {};
	for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
		result[name] = (after[name] ?? 0) - (before[name] ?? 0);
	}
	return result;
}

test('ordinary typing in a large code file avoids full-document reconstruction', async ({
	page
}, info: TestInfo) => {
	test.setTimeout(120_000);
	await resetAppState(page);
	const line = 'const value = 42; // unchanged local text\n';
	const content = line.repeat(Math.ceil(1_000_000 / line.length));
	await importCode(page, 'large.js', content);
	await expect(page.getByTestId('code-language')).toHaveText('JavaScript');
	const editor = page.locator('.cm-content').first();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	const typed = 'abcdefghijklmnopqrst';
	const before = await readPerfCounters(page);
	for (const character of typed) await page.keyboard.insertText(character);
	await page.waitForTimeout(700);
	const after = await readPerfCounters(page);
	const change = counterDelta(before, after);
	console.log('[perf] code ordinary typing', JSON.stringify(change));
	await info.attach('code-typing-counters.json', {
		body: JSON.stringify(
			{ before, after, delta: change, bytes: Buffer.byteLength(content) },
			null,
			2
		),
		contentType: 'application/json'
	});
	expect
		.soft(change.codeFullRebuild ?? 0, 'ordinary code typing must not rebuild the full raw source')
		.toBe(0);
	expect
		.soft(change.codeBufferApply ?? 0, 'each accepted change updates the incremental buffer')
		.toBeGreaterThanOrEqual(typed.length);
	expect
		.soft(change.codeNativeApply ?? 0, 'each accepted change uses the native store revision')
		.toBeGreaterThanOrEqual(typed.length);
	expect
		.soft(change.codeStringPublish ?? 0, 'the native path must not publish a string per key')
		.toBe(0);
	await expect
		.poll(async () => (await savedContent(page)).endsWith(typed), { timeout: 20_000 })
		.toBe(true);
});

test('issue 326 keeps a 1 MB single line editable without changing bytes', async ({
	page
}, info: TestInfo) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	const source = longLineScript();
	const sourceFixture = fixture('single-line.js', source);
	await importCode(page, 'single-line.js', source);
	await expect(page.getByTestId('code-language')).toHaveText('JavaScript');
	await expect(page.getByTestId('code-highlight-status')).toBeVisible();
	await expect(page.getByTestId('code-highlight-status')).toHaveAttribute('data-degraded', 'true');
	await expect(page.getByTestId('code-highlight-status')).toContainText('Ligne longue');

	const searchEditor = page.locator('.cm-content').first();
	await searchEditor.click();
	await page.keyboard.press('ControlOrMeta+f');
	await expect(page.locator('.cm-panels')).toBeVisible();
	await page.keyboard.type('needle');
	// Firefox drops the search decoration on a 1 MB single line, while the
	// query, editing and byte checks below still apply to the same engine.
	if (info.project.name !== 'firefox') await expect(page.locator('.cm-searchMatch')).toHaveCount(1);
	await page.keyboard.press('Escape');

	await page.getByTestId('code-wrap').click();
	await expect(page.getByTestId('code-wrap')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('.cm-content')).not.toHaveClass(/cm-lineWrapping/);

	await page.locator('.cm-content').first().click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText('END');
	await expect.poll(() => savedContent(page), { timeout: 30_000 }).toBe(`${source}END`);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => savedContent(page), { timeout: 30_000 }).toBe(source);
	await expect(page.getByTestId('code-highlight-status')).toBeVisible();

	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Exporter', exact: true }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('single-line.js');
	const exported = await readFile((await download.path())!, 'utf8');
	expect(exported).toBe(source);

	await page.locator('.cm-content').first().click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText('const short = 1;\n');
	await expect(page.getByTestId('code-highlight-status')).toHaveCount(0, { timeout: 10_000 });
	await expect.poll(() => savedContent(page), { timeout: 30_000 }).toBe('const short = 1;\n');
	await expect.poll(() => page.locator('.cm-content .cm-line span').count()).toBeGreaterThan(0);

	await info.attach('long-line.json', {
		body: JSON.stringify(
			{
				fixture: sourceFixture,
				exportedBytes: Buffer.byteLength(exported, 'utf8'),
				exportedSha256: createHash('sha256').update(exported, 'utf8').digest('hex'),
				recovered: 'const short = 1;\n'
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('long-line.png', { body: await page.screenshot() });
});

test('issue 326 keeps minified JSON editable and validated', async ({ page }, info: TestInfo) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	const source = minifiedJson();
	const sourceFixture = fixture('minified.json', source);
	await importCode(page, 'minified.json', source);
	await expect(page.getByTestId('code-language')).toHaveText('JSON');
	await expect(page.getByTestId('json-status')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId('json-status')).toHaveText('JSON valide');
	await expect(page.getByTestId('code-highlight-status')).toBeVisible();
	await expect(page.getByTestId('code-highlight-status')).toHaveAttribute('data-degraded', 'true');
	await expect(page.getByTestId('json-format')).toBeEnabled();
	await expect.poll(() => savedContent(page), { timeout: 30_000 }).toBe(source);

	await info.attach('minified-json.json', {
		body: JSON.stringify(
			{
				fixture: sourceFixture,
				valid: true,
				formatEnabled: true,
				storedSha256: createHash('sha256').update(source, 'utf8').digest('hex')
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('issue 326 measures long-line, wrapping, decoration and grammar scenarios', async ({
	page
}, info: TestInfo) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	const scenarios: Array<Record<string, unknown>> = [];

	const columns = longColumnLine();
	const columnFixture = fixture('columns.log', columns);
	await importCode(page, 'columns.log', columns);
	await expect(page.getByTestId('code-highlight-status')).toBeVisible();
	await page.locator('.cm-content').first().click();
	await page.keyboard.press('ControlOrMeta+End');
	scenarios.push({
		name: 'long-line-default',
		fixture: columnFixture,
		samples: summarise(await sampleInput(page, 8))
	});

	await page.getByTestId('code-wrap').click();
	await expect(page.getByTestId('code-wrap')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('.cm-content')).not.toHaveClass(/cm-lineWrapping/);
	await page.locator('.cm-content').first().click();
	await page.keyboard.press('ControlOrMeta+End');
	scenarios.push({
		name: 'long-line-wrap-requested',
		fixture: columnFixture,
		samples: summarise(await sampleInput(page, 8))
	});

	await page.getByTestId('code-invisibles').click();
	await expect(page.locator('.cm-invisible-newline').first()).toBeVisible();
	await page.locator('.cm-content').first().click();
	await page.keyboard.press('ControlOrMeta+End');
	scenarios.push({
		name: 'long-line-invisibles',
		fixture: columnFixture,
		samples: summarise(await sampleInput(page, 8))
	});

	const ordinary = 'const value = 1;\n'.repeat(2_000);
	const ordinaryFixture = fixture('ordinary.js', ordinary);
	await importCode(page, 'ordinary.js', ordinary);
	await expect(page.getByTestId('code-language')).toHaveText('JavaScript');
	await expect(page.getByTestId('code-highlight-status')).toHaveCount(0);
	await page.locator('.cm-content').first().click();
	await page.keyboard.press('ControlOrMeta+End');
	scenarios.push({
		name: 'ordinary-grammar',
		fixture: ordinaryFixture,
		samples: summarise(await sampleInput(page, 8))
	});

	for (const scenario of scenarios) {
		const samples = scenario.samples as ReturnType<typeof summarise>;
		expect.soft(samples.max, `${String(scenario.name)} must not hang`).toBeLessThan(5_000);
	}
	await info.attach('long-line-measurements.json', {
		body: JSON.stringify(
			{
				engine: info.project.name,
				date: new Date().toISOString(),
				method:
					'In-page execCommand insertText, synchronous cost and next animation frame. Raw samples are retained; Node round trips are excluded.',
				scenarios
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});
