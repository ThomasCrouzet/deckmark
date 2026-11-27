import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileItem } from '#lib/types.js';

// The edition is a build-time constant, so a browser workflow cannot select the
// Desktop budget. This isolated test is the only way to observe review finding
// DATA-04: the library ZIP used the Web Light budget (300 documents, 64 MiB) in
// every edition, against docs/USER_GUIDE.md. It checks the documented budget
// of each edition at its boundary.

const saved = vi.hoisted(() => vi.fn(async () => true));

vi.mock('./services/export', async (importOriginal) => ({
	...(await importOriginal<typeof import('./services/export')>()),
	triggerDownload: saved
}));

const MIB = 1024 * 1024;

function note(index: number, content: string): FileItem {
	return { id: `note-${index}`, name: `note-${index}.md`, content } as FileItem;
}

async function exportFor(edition: 'web' | 'desktop', files: FileItem[]): Promise<boolean> {
	vi.resetModules();
	vi.stubEnv('VITE_EDITION', edition);
	const { exportZip } = await import('./export-zip');
	return exportZip(files, 'library.zip');
}

afterEach(() => {
	vi.unstubAllEnvs();
	saved.mockClear();
});

describe('library ZIP export budget', () => {
	const manyNotes = Array.from({ length: 301 }, (_, index) => note(index, `# ${index}\n`));
	// Five notes of 13 MiB are 65 MiB. Each one stays below the 16 MiB file limit.
	const largeNotes = Array.from({ length: 5 }, (_, index) =>
		note(index, `# ${index}\n${'x'.repeat(13 * MIB)}`)
	);

	it('stops at 300 documents in Web Light', async () => {
		await expect(exportFor('web', manyNotes)).rejects.toThrow('Library export document limit');
		expect(saved).not.toHaveBeenCalled();
	});

	it('accepts 301 documents in Desktop Complete', async () => {
		await expect(exportFor('desktop', manyNotes)).resolves.toBe(true);
		expect(saved).toHaveBeenCalledOnce();
	});

	it('stops above 64 MiB in Web Light', async () => {
		await expect(exportFor('web', largeNotes)).rejects.toThrow('Library export size limit');
		expect(saved).not.toHaveBeenCalled();
	});

	it('accepts 65 MiB in Desktop Complete', async () => {
		await expect(exportFor('desktop', largeNotes)).resolves.toBe(true);
		expect(saved).toHaveBeenCalledOnce();
	});
});
