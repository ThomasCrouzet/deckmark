import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';
import { holdReplies, installJsonProbe, probeState } from './json-worker-probe';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

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
