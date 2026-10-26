import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createModals, makeLazyLoader, type ModalsOptions } from './modals.svelte';

vi.mock('#lib/report.js', () => ({
	reportError: vi.fn()
}));

import { reportError } from '#lib/report.js';
import { t } from '#lib/i18n/index.js';

function makeOpts(mode: 'wysiwyg' | 'source' | 'read' = 'wysiwyg') {
	const setActive = vi.fn();
	const goToLine = vi.fn();
	const opts = {
		getMode: vi.fn(() => mode),
		setMode: vi.fn(),
		getFilesStoreActive: vi.fn((): { id: string } | null => null),
		getFilesStoreSetActive: vi.fn(() => setActive),
		getSourceEditorRef: vi.fn(() => ({ goToLine })),
		announceContext: vi.fn(),
		setPendingGoToHit: vi.fn(),
		setPendingOpenSearch: vi.fn()
	} satisfies ModalsOptions;
	return { opts, setActive, goToLine };
}

describe('createModals', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('waits for the new source editor when a search opens another document', () => {
		const { opts, goToLine } = makeOpts('source');
		opts.getFilesStoreActive.mockReturnValue({ id: 'old' });
		createModals(opts).handleOpenHit('next', 12, 'needle');
		expect(goToLine).not.toHaveBeenCalled();
		expect(opts.setPendingGoToHit).toHaveBeenCalledWith({ line: 12, query: 'needle' });
	});
});

describe('makeLazyLoader - failure path', () => {
	beforeEach(() => {
		vi.mocked(reportError).mockClear();
	});

	it('on import() rejection: closes, reports/notifies, rethrows, and allows retry', async () => {
		const close = vi.fn();
		const err = new Error('chunk missing offline');
		const importer = vi
			.fn()
			.mockRejectedValueOnce(err)
			.mockResolvedValueOnce({ default: { name: 'FakeModal' } });

		const load = makeLazyLoader(importer, close, 'modals.labelPalette');

		await expect(load()).rejects.toThrow('chunk missing offline');
		expect(close).toHaveBeenCalledOnce();
		expect(reportError).toHaveBeenCalledOnce();
		const [scope, reportedErr, opts] = vi.mocked(reportError).mock.calls[0]!;
		expect(scope).toMatch(/lazy load/i);
		expect(reportedErr).toBe(err);
		expect(opts?.notifyUser).toBe(t('modals.loadFailed', { label: t('modals.labelPalette') }));

		const Cmp = await load();
		expect(Cmp).toEqual({ name: 'FakeModal' });
		expect(importer).toHaveBeenCalledTimes(2);
		expect(close).toHaveBeenCalledOnce();
	});
});
