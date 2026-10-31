import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildKeydownHandler, type ShortcutCallbacks } from './shortcuts.svelte';

function makeCallbacks(overrides: Partial<ShortcutCallbacks> = {}) {
	const cb = {
		onNew: vi.fn(),
		onImport: vi.fn(),
		onExport: vi.fn(),
		onExportPDF: vi.fn(),
		onSaveToDisk: vi.fn(),
		getMode: vi.fn(() => 'wysiwyg' as const),
		setMode: vi.fn(),
		onNavigateFile: vi.fn(),
		onToggleSidebar: vi.fn(),
		onOpenPalette: vi.fn(),
		onOpenSearch: vi.fn(),
		onOpenInFileSearch: vi.fn(),
		onOpenSettings: vi.fn(),
		onToggleFocus: vi.fn(),
		onOpenSlides: vi.fn(),
		getActiveId: vi.fn(() => 'file1' as string | null),
		onClose: vi.fn(),
		...overrides
	};
	return cb as unknown as ShortcutCallbacks & typeof cb;
}

function fire(
	key: string,
	opts: { shift?: boolean; target?: Partial<HTMLElement> | null; code?: string } = {}
) {
	let prevented = false;
	const e = {
		key,
		metaKey: true,
		ctrlKey: false,
		shiftKey: opts.shift ?? false,
		code: opts.code ?? '',
		target: opts.target ?? null,
		preventDefault: () => {
			prevented = true;
		}
	};
	return { event: e as unknown as KeyboardEvent, isPrevented: () => prevented };
}

describe('buildKeydownHandler', () => {
	let cb: ReturnType<typeof makeCallbacks>;
	let handler: (e: KeyboardEvent) => void;

	beforeEach(() => {
		cb = makeCallbacks();
		handler = buildKeydownHandler(cb);
	});

	it('intercepts ⌘P only with an active file', () => {
		handler(fire('p').event);
		expect(cb.onExportPDF).toHaveBeenCalledOnce();

		const c = makeCallbacks({ getActiveId: vi.fn(() => null) });
		const { event, isPrevented } = fire('p');
		buildKeydownHandler(c)(event);
		expect(c.onExportPDF).not.toHaveBeenCalled();
		expect(isPrevented()).toBe(false); // laisse l'impression native
	});

	it('toggles focus mode with ⌘⇧. and the Period code', () => {
		handler(fire('.', { shift: true }).event);
		expect(cb.onToggleFocus).toHaveBeenCalledOnce();
		const c = makeCallbacks();
		buildKeydownHandler(c)(fire('Dead', { shift: true, code: 'Period' }).event);
		expect(c.onToggleFocus).toHaveBeenCalledOnce();
	});

	it('opens the slide editor with ⌘⇧L', () => {
		handler(fire('l', { shift: true }).event);
		expect(cb.onOpenSlides).toHaveBeenCalledOnce();
		expect(cb.onToggleFocus).not.toHaveBeenCalled();
	});

	it('closes the active file with ⌘W outside an editable field', () => {
		handler(fire('w', { target: { tagName: 'DIV' } as Partial<HTMLElement> }).event);
		expect(cb.onClose).toHaveBeenCalledWith('file1');

		const c = makeCallbacks();
		buildKeydownHandler(c)(
			fire('w', { target: { tagName: 'INPUT' } as Partial<HTMLElement> }).event
		);
		expect(c.onClose).not.toHaveBeenCalled();
	});
});

describe('Windows keyboard priority and composition', () => {
	it.each([
		{ isComposing: true },
		{ defaultPrevented: true },
		{ repeat: true },
		{ altKey: true },
		{ metaKey: true }
	])('ignore une nouvelle note dans le contexte %o', (context) => {
		const cb = makeCallbacks();
		const { event } = fire('n');
		Object.assign(event, { metaKey: false, ctrlKey: true }, context);
		buildKeydownHandler(cb)(event);
		expect(cb.onNew).not.toHaveBeenCalled();
	});

	it('leaves bold to the editor and allows the command palette', () => {
		const editor = document.createElement('div');
		editor.className = 'ProseMirror';
		Object.defineProperty(editor, 'isContentEditable', { value: true });
		const cb = makeCallbacks();
		const handler = buildKeydownHandler(cb);
		handler(fire('b', { target: editor }).event);
		handler(fire('p', { shift: true, target: editor }).event);
		expect(cb.onToggleSidebar).not.toHaveBeenCalled();
		expect(cb.onOpenPalette).toHaveBeenCalledOnce();
	});
});
