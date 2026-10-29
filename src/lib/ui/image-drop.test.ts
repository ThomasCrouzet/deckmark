import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendImagesToActive, MAX_IMAGE_BYTES, buildDropHandlers } from './image-drop.svelte';
import { notify } from '#lib/notify.svelte.js';
import { i18n } from '#lib/i18n/index.js';

const PNG_BYTES = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDfoAAAAASUVORK5CYII='
	),
	(character) => character.charCodeAt(0)
);

beforeEach(() =>
	vi.stubGlobal(
		'createImageBitmap',
		vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
	)
);
afterEach(() => vi.unstubAllGlobals());

function makeStore(initial = 'corps') {
	const state = {
		active: { id: 'a', content: initial } as { id: string; content: string } | null,
		created: [] as string[]
	};
	const store = {
		get active() {
			return state.active;
		},
		createNew: (name: string) => {
			state.created.push(name);
			state.active = { id: 'new', content: '' };
		},
		updateContent: vi.fn((id: string, content: string) => {
			if (state.active && state.active.id === id) state.active.content = content;
		}),
		importFiles: vi.fn(async (_files: FileList | File[]) => ({
			created: [] as unknown[],
			skipped: 0,
			failed: 0
		}))
	};
	return { store, state };
}

// Create a fake DragEvent with minimal dataTransfer types and files, plus a preventDefault spy.
// Make `files` behave like a FileList with length, indexes, and iteration.
function makeDragEvent(opts: {
	types?: string[];
	files?: File[];
	relatedTarget?: EventTarget | null;
}): DragEvent {
	const arr = opts.files ?? [];
	const fileList = {
		length: arr.length,
		item: (i: number) => arr[i] ?? null,
		[Symbol.iterator]: () => arr[Symbol.iterator]()
	} as unknown as FileList;
	arr.forEach((f, i) => {
		(fileList as unknown as Record<number, File>)[i] = f;
	});
	return {
		dataTransfer: opts.types !== undefined ? { types: opts.types, files: fileList } : undefined,
		relatedTarget: 'relatedTarget' in opts ? (opts.relatedTarget ?? null) : undefined,
		preventDefault: vi.fn()
	} as unknown as DragEvent;
}

describe('appendImagesToActive', () => {
	beforeEach(() => {
		// This file checks French content. Set the locale to French because the application default is English.
		i18n.locale = 'fr';
		vi.spyOn(notify, 'error');
		notify.clear();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		notify.clear();
	});

	it('ignores an oversized image and notifies the user', async () => {
		const { store } = makeStore();
		const big = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'huge.png', { type: 'image/png' });
		await appendImagesToActive([big], store);
		expect(store.updateContent).not.toHaveBeenCalled();
		expect(notify.error).toHaveBeenCalledOnce();
		expect(vi.mocked(notify.error).mock.calls[0]![0]).toMatch(/ignorée|Mo/);
	});

	it('inserts a valid image and reports an oversized image from one drop', async () => {
		const { store } = makeStore();
		const ok = new File([PNG_BYTES], 'ok.png', { type: 'image/png' });
		const big = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'big.png', { type: 'image/png' });
		await appendImagesToActive([ok, big], store);
		expect(store.updateContent).toHaveBeenCalledOnce();
		expect(notify.error).toHaveBeenCalledOnce();
	});

	it('reports an unreadable image and inserts nothing', async () => {
		const { store } = makeStore();
		// Make FileReader fail to exercise the `unreadable++` branch.
		const FakeReader = class {
			result: string | null = null;
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			readAsDataURL() {
				queueMicrotask(() => this.onerror?.());
			}
		};
		vi.stubGlobal('FileReader', FakeReader);
		const img = new File([PNG_BYTES], 'broken.png', { type: 'image/png' });
		await appendImagesToActive([img], store);
		vi.unstubAllGlobals();
		expect(store.updateContent).not.toHaveBeenCalled();
		expect(notify.error).toHaveBeenCalledOnce();
		expect(vi.mocked(notify.error).mock.calls[0]![0]).toMatch(/illisible/);
	});
});

describe('buildDropHandlers', () => {
	beforeEach(() => {
		i18n.locale = 'fr';
		vi.spyOn(notify, 'error');
		vi.spyOn(notify, 'info');
		notify.clear();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		notify.clear();
	});

	it('ignores an internal drag without Files', async () => {
		const { store } = makeStore();
		const setDragOver = vi.fn();
		const { handleDrop } = buildDropHandlers({ store, setDragOver });
		const e = makeDragEvent({ types: ['text/plain'] });
		await handleDrop(e);
		expect(e.preventDefault).not.toHaveBeenCalled();
		expect(setDragOver).not.toHaveBeenCalled();
		expect(store.importFiles).not.toHaveBeenCalled();
	});

	it('imports Markdown and inserts images from one drop', async () => {
		const { store } = makeStore();
		store.importFiles.mockResolvedValueOnce({ created: [{}], skipped: 0, failed: 0 });
		const setDragOver = vi.fn();
		const { handleDrop } = buildDropHandlers({ store, setDragOver });
		const md = new File(['# titre'], 'doc.md', { type: 'text/markdown' });
		const img = new File([PNG_BYTES], 'pic.png', { type: 'image/png' });
		const e = makeDragEvent({ types: ['Files'], files: [md, img] });
		await handleDrop(e);
		expect(setDragOver).toHaveBeenCalledWith(false);
		// Send Markdown files through importFiles.
		expect(store.importFiles).toHaveBeenCalledOnce();
		const [passed] = store.importFiles.mock.calls[0]!;
		expect((passed as File[]).map((f) => f.name)).toEqual(['doc.md']);
		// Insert the image into the active file.
		expect(store.updateContent).toHaveBeenCalledOnce();
		const [, content] = store.updateContent.mock.calls[0]!;
		expect(content).toContain('![pic](data:image/png;base64,');
		// Do not show the "no Markdown" notification because created > 0.
		expect(notify.info).not.toHaveBeenCalled();
	});

	it('reports unreadable Markdown files', async () => {
		const { store } = makeStore();
		store.importFiles.mockResolvedValueOnce({ created: [], skipped: 0, failed: 2 });
		const setDragOver = vi.fn();
		const { handleDrop } = buildDropHandlers({ store, setDragOver });
		const md = new File(['x'], 'a.md', { type: 'text/markdown' });
		const e = makeDragEvent({ types: ['Files'], files: [md] });
		await handleDrop(e);
		expect(notify.error).toHaveBeenCalledOnce();
		expect(vi.mocked(notify.error).mock.calls[0]![0]).toMatch(/illisible/);
		// With failed > 0, do not run the "no Markdown recognized" branch.
		expect(notify.info).not.toHaveBeenCalled();
	});

	it('reports a drop that contains only unrecognized files', async () => {
		const { store } = makeStore();
		const setDragOver = vi.fn();
		const { handleDrop } = buildDropHandlers({ store, setDragOver });
		// A .bin file is not an image or Markdown file because its MIME type is set and its extension differs.
		const bin = new File(['\x00\x01'], 'data.bin', { type: 'application/octet-stream' });
		const e = makeDragEvent({ types: ['Files'], files: [bin] });
		await handleDrop(e);
		expect(store.importFiles).not.toHaveBeenCalled();
		expect(store.updateContent).not.toHaveBeenCalled();
		expect(notify.info).toHaveBeenCalledOnce();
		expect(vi.mocked(notify.info).mock.calls[0]![0]).toMatch(/Aucun fichier markdown/);
	});

	it('does nothing for an internal drag', () => {
		const { store } = makeStore();
		const setDragOver = vi.fn();
		const { handleDragOver } = buildDropHandlers({ store, setDragOver });
		const e = makeDragEvent({ types: ['text/html'] });
		handleDragOver(e);
		expect(e.preventDefault).not.toHaveBeenCalled();
		expect(setDragOver).not.toHaveBeenCalled();
	});
});
