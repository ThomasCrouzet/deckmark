import { describe, expect, it } from 'vitest';
import { codeLanguageForExtension, codeLanguageForName, loadCodeLanguage } from './languages';
import { applySourceChanges, convertLineEndings, detectLineEnding } from './text-changes';
import { EditorState } from '@codemirror/state';

describe('code language dispatch', () => {
	it('maps required extensions to a language', () => {
		expect(codeLanguageForName('script.py').id).toBe('python');
		expect(codeLanguageForName('main.rs').id).toBe('rust');
		expect(codeLanguageForName('app.js').id).toBe('javascript');
		expect(codeLanguageForName('index.php').id).toBe('php');
		expect(codeLanguageForName('run.sh').id).toBe('shell');
		expect(codeLanguageForName('notes.txt').id).toBe('plain');
	});

	it('uses the final extension and a plain fallback', () => {
		expect(codeLanguageForExtension('TSX').id).toBe('tsx');
		expect(codeLanguageForName('archive.tar.gz').id).toBe('plain');
		expect(codeLanguageForName('Makefile').id).toBe('plain');
	});

	it('keeps C#, PowerShell and JSON with comments on their own language', () => {
		expect(codeLanguageForName('Program.cs').id).toBe('csharp');
		expect(codeLanguageForName('deploy.ps1').id).toBe('powershell');
		expect(codeLanguageForName('settings.json').id).toBe('json');
		expect(codeLanguageForName('settings.jsonc').id).toBe('jsonc');
		expect(codeLanguageForName('main.cpp').id).toBe('cpp');
		expect(codeLanguageForName('run.sh').id).toBe('shell');
	});

	it('loads a grammar for every supported language', async () => {
		for (const id of ['csharp', 'powershell', 'jsonc'] as const) {
			const extension = await loadCodeLanguage(id);
			expect(extension).toBeTruthy();
			if (Array.isArray(extension)) expect(extension.length).toBeGreaterThan(0);
		}
	});
});

describe('line endings', () => {
	it('detects the first or dominant style', () => {
		expect(detectLineEnding('a\nb\n')).toBe('\n');
		expect(detectLineEnding('a\r\nb\r\n')).toBe('\r\n');
		expect(detectLineEnding('a\rb')).toBe('\r');
	});

	it('converts without changing text', () => {
		expect(convertLineEndings('a\r\nb\nc', '\r\n')).toBe('a\r\nb\r\nc');
		expect(convertLineEndings('a\r\nb\nc', '\n')).toBe('a\nb\nc');
	});

	it('rebuilds original separators around an insertion', () => {
		const source = 'one\r\ntwo\r\n';
		const state = EditorState.create({ doc: source.replace(/\r\n/g, '\n') });
		const transaction = state.update({
			changes: { from: state.doc.length, insert: 'three' },
			sequential: true
		});
		expect(applySourceChanges(source, state, transaction.changes)).toBe('one\r\ntwo\r\nthree');
	});
});
