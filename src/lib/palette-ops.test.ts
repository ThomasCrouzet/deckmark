import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	runPaletteCopyActive,
	runPaletteDirectoryImport,
	runPaletteSaveWorkspace
} from './palette-ops';
import { t } from '#lib/i18n/index.js';

describe('runPaletteDirectoryImport', () => {
	const showSpinner = vi.fn(() => vi.fn());
	const notifySuccess = vi.fn();
	const reportError = vi.fn();

	beforeEach(() => {
		showSpinner.mockClear().mockReturnValue(vi.fn());
		notifySuccess.mockClear();
		reportError.mockClear();
	});

	it('reports and rethrows a failed import after dismissing', async () => {
		const dismiss = vi.fn();
		showSpinner.mockReturnValue(dismiss);
		const err = new Error('picker');
		await expect(
			runPaletteDirectoryImport({
				importDirectory: async () => {
					throw err;
				},
				showSpinner,
				notifySuccess,
				reportError,
				t
			})
		).rejects.toThrow('picker');
		expect(reportError).toHaveBeenCalledWith('directory import', err, expect.any(Object));
		expect(dismiss).toHaveBeenCalledOnce();
	});
});

describe('runPaletteCopyActive', () => {
	const copyMarkdown = vi.fn(async () => {});
	const copyRichHtml = vi.fn(async () => {});
	const notifySuccess = vi.fn();
	const notifyError = vi.fn();
	const reportError = vi.fn();

	beforeEach(() => {
		copyMarkdown.mockClear();
		copyRichHtml.mockClear();
		notifySuccess.mockClear();
		notifyError.mockClear();
		reportError.mockClear();
	});

	it('toasts when the clipboard API is missing', async () => {
		const ok = await runPaletteCopyActive('md', {
			getActive: () => ({ content: '# x' }),
			isClipboardSupported: () => false,
			copyMarkdown,
			copyRichHtml,
			notifySuccess,
			notifyError,
			reportError,
			t
		});
		expect(ok).toBe(false);
		expect(notifyError).toHaveBeenCalledOnce();
	});

	it('copies rich HTML and reports a copy failure', async () => {
		const err = new Error('denied');
		copyRichHtml.mockRejectedValueOnce(err);
		const ok = await runPaletteCopyActive('html', {
			getActive: () => ({ content: '# x' }),
			isClipboardSupported: () => true,
			copyMarkdown,
			copyRichHtml,
			notifySuccess,
			notifyError,
			reportError,
			t
		});
		expect(ok).toBe(false);
		expect(reportError).toHaveBeenCalledWith('clipboard copy', err, expect.any(Object));
	});
});

describe('runPaletteSaveWorkspace', () => {
	it('does not toast when save returns a falsy value', async () => {
		const notifySuccess = vi.fn();
		const ok = await runPaletteSaveWorkspace({
			promptName: async () => 'Session',
			save: async () => null,
			notifySuccess,
			t
		});
		expect(ok).toBe(false);
		expect(notifySuccess).not.toHaveBeenCalled();
	});
});
