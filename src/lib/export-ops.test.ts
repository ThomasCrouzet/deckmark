import { describe, it, expect, beforeEach, vi } from 'vitest';
import { notify } from './notify.svelte';
import type { FileItem } from './types';
import { promptStore } from './prompt.svelte';
import { MediaPreparationError } from './render/image-media';

// Test notification orchestration. Mock export services and the spinner to avoid actual rendering.
vi.mock('./services/export', () => ({
	exportMarkdown: vi.fn(),
	exportHTML: vi.fn(),
	exportPDF: vi.fn(),
	exportZip: vi.fn()
}));
vi.mock('./spinner.svelte', () => ({
	spinnerStore: { show: () => () => {} }
}));

import * as services from './services/export';
import {
	exportHTML,
	exportPDF,
	exportAllZip,
	exportSelectionZip,
	exportMarkdown
} from './export-ops';

function file(id: string): FileItem {
	return {
		id,
		name: `${id}.md`,
		content: 'x',
		createdAt: 0,
		updatedAt: 0,
		dirty: true,
		linkedToDisk: false
	};
}
const deps = {
	getFiles: () => [file('a'), file('b')] as readonly FileItem[],
	scheduleSave: () => {}
};

describe('export-ops - notification feedback (§J3)', () => {
	beforeEach(() => {
		notify.clear();
		vi.clearAllMocks();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('shows an error toast when exportHTML fails', async () => {
		vi.mocked(services.exportHTML).mockRejectedValue(new Error('boom'));
		await exportHTML('a', deps);
		expect(notify.toasts.some((t) => t.level === 'error')).toBe(true);
	});

	it('shows an error toast when exportPDF fails', async () => {
		vi.mocked(services.exportPDF).mockRejectedValue(new Error('boom'));
		await exportPDF('a', deps);
		expect(notify.toasts.some((t) => t.level === 'error')).toBe(true);
	});

	it('shows an error toast when exportAllZip fails', async () => {
		vi.mocked(services.exportZip).mockRejectedValue(new Error('boom'));
		await exportAllZip(deps);
		expect(notify.toasts.some((t) => t.level === 'error')).toBe(true);
	});

	it('keeps dirty state and hides success after desktop exportMarkdown cancellation', async () => {
		const files = [file('a')];
		const scheduleSave = vi.fn();
		const localDeps = {
			getFiles: () => files as readonly FileItem[],
			scheduleSave
		};
		vi.mocked(services.exportMarkdown).mockResolvedValue(false);
		await exportMarkdown('a', localDeps);
		expect(files[0]!.dirty).toBe(true);
		expect(scheduleSave).not.toHaveBeenCalled();
		expect(notify.toasts).toHaveLength(0);
	});

	it('does not report success after desktop exportHTML cancellation', async () => {
		vi.mocked(services.exportHTML).mockResolvedValue(false);
		await exportHTML('a', deps);
		expect(notify.toasts.some((t) => t.level === 'success')).toBe(false);
	});

	it('does not mark a concurrent edit as exported', async () => {
		const files = [file('a')];
		let finish: (value: boolean) => void = () => {};
		vi.mocked(services.exportMarkdown).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const scheduleSave = vi.fn();
		const pending = exportMarkdown('a', { getFiles: () => files, scheduleSave });
		files[0]!.content = 'nouvelle saisie';
		finish(true);
		await pending;
		expect(files[0]!.dirty).toBe(true);
		expect(scheduleSave).not.toHaveBeenCalled();
	});

	it('keeps dirty state and hides success after desktop exportAllZip cancellation', async () => {
		const files = [file('a'), file('b')];
		const scheduleSave = vi.fn();
		const localDeps = {
			getFiles: () => files as readonly FileItem[],
			scheduleSave
		};
		vi.mocked(services.exportZip).mockResolvedValue(false);
		await exportAllZip(localDeps);
		expect(notify.toasts.some((t) => t.level === 'success')).toBe(false);
		expect(files.every((f) => f.dirty)).toBe(true);
		expect(scheduleSave).not.toHaveBeenCalled();
	});
});

describe('exports during errors and concurrent changes', () => {
	beforeEach(() => {
		notify.clear();
		vi.clearAllMocks();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('shows unreadable sources without a network consent request', async () => {
		vi.spyOn(promptStore, 'confirm').mockResolvedValue(true);
		vi.mocked(services.exportHTML).mockRejectedValue(
			new MediaPreparationError([{ source: 'figure.png', reason: 'unreadable' }])
		);
		await exportHTML('a', deps);
		expect(promptStore.confirm).not.toHaveBeenCalled();
		expect(notify.toasts.find((toast) => toast.level === 'error')?.message).toContain('figure.png');
	});

	it('reports Markdown and selection ZIP errors without success', async () => {
		vi.mocked(services.exportMarkdown).mockRejectedValue(new Error('write failed'));
		vi.mocked(services.exportZip).mockRejectedValue(new Error('zip failed'));
		await exportMarkdown('a', deps);
		await exportSelectionZip(new Set(['a']), deps);
		expect(notify.toasts.filter((toast) => toast.level === 'error')).toHaveLength(2);
		expect(notify.toasts.some((toast) => toast.level === 'success')).toBe(false);
	});

	it.each(['rename', 'remove'])('keeps changes during a Markdown export: %s', async (change) => {
		const files = [file('a')];
		const scheduleSave = vi.fn();
		vi.mocked(services.exportMarkdown).mockImplementation(async () => {
			if (change === 'rename') files[0]!.name = 'new.md';
			else files.pop();
			return true;
		});
		await exportMarkdown('a', { getFiles: () => files, scheduleSave });
		expect(scheduleSave).not.toHaveBeenCalled();
	});

	it('confirms only unchanged snapshots after a ZIP export', async () => {
		const files = [file('a'), file('b'), file('c'), file('d')];
		const scheduleSave = vi.fn();
		vi.mocked(services.exportZip).mockImplementation(async (snapshot) => {
			files[0]!.content = 'new';
			files[1]!.name = 'new.md';
			files.splice(2, 1);
			expect(snapshot[0]?.content).toBe('x');
			return true;
		});
		await exportAllZip({ getFiles: () => files, scheduleSave });
		expect(scheduleSave).toHaveBeenCalledExactlyOnceWith('d');
		expect(files.slice(0, 2).every((item) => item.dirty)).toBe(true);
	});

	it('keeps a binary document dirty when its payload changes during export', async () => {
		const files: FileItem[] = [
			{
				...file('a'),
				name: 'photo.png',
				content: '',
				kind: 'image',
				mime: 'image/png',
				data: 'data:image/png;base64,AAAA'
			}
		];
		const scheduleSave = vi.fn();
		vi.mocked(services.exportMarkdown).mockImplementation(async () => {
			files[0]!.data = 'data:image/png;base64,BBBB';
			return true;
		});
		await exportMarkdown('a', { getFiles: () => files, scheduleSave });
		expect(files[0]!.dirty).toBe(true);
		expect(scheduleSave).not.toHaveBeenCalled();
	});

	it('keeps a binary document dirty after a ZIP when its kind changes', async () => {
		const files: FileItem[] = [
			{
				...file('a'),
				name: 'photo.png',
				content: '',
				kind: 'image',
				mime: 'image/png',
				data: 'data:image/png;base64,AAAA'
			}
		];
		const scheduleSave = vi.fn();
		vi.mocked(services.exportZip).mockImplementation(async () => {
			files[0]!.kind = 'pdf';
			return true;
		});
		await exportAllZip({ getFiles: () => files, scheduleSave });
		expect(files[0]!.dirty).toBe(true);
		expect(scheduleSave).not.toHaveBeenCalled();
	});

	it('does not report success after selection ZIP cancellation', async () => {
		vi.mocked(services.exportZip).mockResolvedValue(false);
		await exportSelectionZip(new Set(['a']), deps);
		expect(notify.toasts).toHaveLength(0);
	});
});
