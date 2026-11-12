import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Web edition never mounts the Desktop capture window, so the browser
// suite cannot dispatch a composition sequence against this component. These
// cases replace the native window bridge and the template store with deferred
// promises. See docs/TESTING.md for the retained IME, native WebView, and
// template-race risks.

const bridge = vi.hoisted(() => ({
	hide: vi.fn(async () => {}),
	resetListener: null as null | (() => void),
	files: { createNew: vi.fn(), flushPendingAwait: vi.fn(async () => {}) },
	load: vi.fn(async () => {}),
	resolve: vi.fn(),
	choices: [] as Array<{ id: string; name: string; kind: string }>
}));

vi.mock('#lib/capture.js', () => ({
	captureErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
	hideCaptureWindow: bridge.hide,
	onCaptureReset: async (listener: () => void) => {
		bridge.resetListener = listener;
		return () => {
			bridge.resetListener = null;
		};
	}
}));

vi.mock('#lib/files.svelte.js', () => ({
	filesStore: {
		createNew: bridge.files.createNew,
		flushPendingAwait: bridge.files.flushPendingAwait
	}
}));

vi.mock('#lib/templates.svelte.js', () => ({
	templatesStore: {
		load: bridge.load,
		get choices() {
			return bridge.choices;
		},
		resolve: bridge.resolve
	}
}));

vi.mock('#lib/db.js', () => ({
	db: { projects: { orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }) } }
}));

import QuickCapture from './QuickCapture.svelte';

function keydown(init: KeyboardEventInit & { keyCodeValue?: number }): KeyboardEvent {
	const event = new KeyboardEvent('keydown', {
		bubbles: true,
		cancelable: true,
		...init
	});
	if (init.keyCodeValue !== undefined)
		Object.defineProperty(event, 'keyCode', { value: init.keyCodeValue });
	window.dispatchEvent(event);
	return event;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, refuse) => {
		resolve = accept;
		reject = refuse;
	});
	return { promise, resolve, reject };
}

const templateA = { id: 'template-a', name: 'Template A', kind: 'note' };
const templateB = { id: 'template-b', name: 'Template B', kind: 'note' };

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await Promise.resolve();
}

async function renderCapture(): Promise<{
	content: HTMLTextAreaElement;
	title: HTMLInputElement;
	select: HTMLSelectElement;
}> {
	render(QuickCapture);
	await waitFor(() => expect(bridge.resetListener).not.toBeNull());
	const select = (await screen.findByTestId('capture-template')) as HTMLSelectElement;
	return {
		content: screen.getByTestId('capture-content') as HTMLTextAreaElement,
		title: screen.getByTestId('capture-title') as HTMLInputElement,
		select
	};
}

async function startTemplate(select: HTMLSelectElement, id: string): Promise<void> {
	await fireEvent.change(select, { target: { value: id } });
	await waitFor(() => expect(bridge.resolve).toHaveBeenCalledWith(id));
}

beforeEach(() => {
	bridge.hide.mockClear();
	bridge.files.createNew.mockClear();
	bridge.files.flushPendingAwait.mockClear();
	bridge.resetListener = null;
	bridge.load.mockClear();
	bridge.resolve.mockReset();
	bridge.choices = [templateA, templateB];
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('Quick Capture composition boundary', () => {
	it('keeps the window and the pending text during IME composition', async () => {
		render(QuickCapture);
		const content = screen.getByTestId('capture-content') as HTMLTextAreaElement;
		await fireEvent.input(content, { target: { value: '候補テキスト' } });
		content.focus();
		content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

		const escape = keydown({ key: 'Escape', isComposing: true });
		expect(escape.defaultPrevented).toBe(false);
		const enter = keydown({ key: 'Enter', ctrlKey: true, isComposing: true });
		expect(enter.defaultPrevented).toBe(false);
		keydown({ key: 'Enter', metaKey: true, keyCodeValue: 229 });
		await Promise.resolve();

		expect(bridge.hide).not.toHaveBeenCalled();
		expect(bridge.files.createNew).not.toHaveBeenCalled();
		expect(screen.getByTestId('quick-capture')).toBeInTheDocument();
		expect(content.value).toBe('候補テキスト');
		expect(document.activeElement).toBe(content);

		content.dispatchEvent(
			new CompositionEvent('compositionend', { bubbles: true, data: '候補テキスト' })
		);
	});

	it('keeps normal Escape and Ctrl+Enter outside composition', async () => {
		render(QuickCapture);
		const content = screen.getByTestId('capture-content') as HTMLTextAreaElement;
		await fireEvent.input(content, { target: { value: 'Normal capture' } });

		const escape = keydown({ key: 'Escape' });
		expect(escape.defaultPrevented).toBe(true);
		await waitFor(() => expect(bridge.hide).toHaveBeenCalledTimes(1));
		expect(content.value).toBe('Normal capture');

		const enter = keydown({ key: 'Enter', ctrlKey: true });
		expect(enter.defaultPrevented).toBe(true);
		await waitFor(() => expect(bridge.files.createNew).toHaveBeenCalledTimes(1));
		expect(bridge.files.createNew).toHaveBeenCalledWith('Normal capture.md', 'Normal capture', {
			origin: 'created',
			kind: 'note'
		});
		await waitFor(() => expect(bridge.hide).toHaveBeenCalledTimes(2));
	});
});

describe('Quick Capture template resolution race', () => {
	it('keeps text typed after an empty body started the template load', async () => {
		const pending = deferred<{ name: string; content: string } | null>();
		bridge.resolve.mockReturnValueOnce(pending.promise);
		const { content, title, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		await fireEvent.input(content, { target: { value: 'My unsaved draft' } });
		expect(content.value).toBe('My unsaved draft');

		pending.resolve({ name: 'Late template', content: 'Template body' });
		await settle();

		expect(content.value).toBe('My unsaved draft');
		expect(title.value).toBe('');
	});

	it('publishes only the newest template after out-of-order resolutions', async () => {
		const first = deferred<{ name: string; content: string } | null>();
		const second = deferred<{ name: string; content: string } | null>();
		bridge.resolve.mockImplementation((id: string) =>
			id === templateA.id ? first.promise : second.promise
		);
		const { content, title, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		await startTemplate(select, templateB.id);

		second.resolve({ name: 'Template B', content: 'Body B' });
		await settle();
		expect(content.value).toBe('Body B');
		expect(title.value).toBe('Template B');

		first.resolve({ name: 'Template A', content: 'Body A' });
		await settle();
		expect(content.value).toBe('Body B');
		expect(title.value).toBe('Template B');
	});

	it('invalidates a pending template when the capture window resets', async () => {
		const pending = deferred<{ name: string; content: string } | null>();
		bridge.resolve.mockReturnValueOnce(pending.promise);
		const { content, title, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		bridge.resetListener?.();
		await waitFor(() => expect(content.value).toBe(''));

		pending.resolve({ name: 'Template A', content: 'Body A' });
		await settle();

		expect(content.value).toBe('');
		expect(title.value).toBe('');
		expect(screen.queryByTestId('capture-error')).not.toBeInTheDocument();
	});

	it('invalidates a pending template when the user cancels', async () => {
		const pending = deferred<{ name: string; content: string } | null>();
		bridge.resolve.mockReturnValueOnce(pending.promise);
		const { content, title, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		await fireEvent.click(screen.getByTestId('capture-cancel'));
		await waitFor(() => expect(bridge.hide).toHaveBeenCalledTimes(1));

		pending.resolve({ name: 'Template A', content: 'Body A' });
		await settle();

		expect(content.value).toBe('');
		expect(title.value).toBe('');
	});

	it('does not replace whitespace typed after the template started', async () => {
		const pending = deferred<{ name: string; content: string } | null>();
		bridge.resolve.mockReturnValueOnce(pending.promise);
		const { content, title, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		await fireEvent.input(content, { target: { value: '   ' } });
		pending.resolve({ name: 'Late template', content: 'Template body' });
		await settle();

		expect(content.value).toBe('   ');
		expect(title.value).toBe('');
	});

	it('does not replace an empty body after the user types and clears the draft', async () => {
		const pending = deferred<{ name: string; content: string } | null>();
		bridge.resolve.mockReturnValueOnce(pending.promise);
		const { content, title, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		await fireEvent.input(content, { target: { value: 'My draft' } });
		await fireEvent.input(content, { target: { value: '' } });
		pending.resolve({ name: 'Late template', content: 'Template body' });
		await settle();

		expect(content.value).toBe('');
		expect(title.value).toBe('');
	});

	it('does not apply after a note to snippet to note round trip', async () => {
		const pending = deferred<{ name: string; content: string } | null>();
		bridge.resolve.mockReturnValueOnce(pending.promise);
		const { content, title, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		await fireEvent.change(screen.getByTestId('capture-kind'), {
			target: { value: 'snippet' }
		});
		await fireEvent.change(screen.getByTestId('capture-kind'), {
			target: { value: 'note' }
		});
		pending.resolve({ name: 'Late template', content: 'Template body' });
		await settle();

		expect(content.value).toBe('');
		expect(title.value).toBe('');
	});

	it('does not publish a template after the capture window unmounts', async () => {
		const pending = deferred<{ name: string; content: string } | null>();
		bridge.resolve.mockReturnValueOnce(pending.promise);
		const { content, select } = await renderCapture();
		const focus = vi.spyOn(content, 'focus');

		await startTemplate(select, templateA.id);
		cleanup();
		pending.resolve({ name: 'Late template', content: 'Template body' });
		await settle();

		expect(focus).not.toHaveBeenCalled();
		expect(screen.queryByTestId('quick-capture')).not.toBeInTheDocument();
	});

	it('ignores a note template after the capture kind becomes a snippet', async () => {
		const pending = deferred<{ name: string; content: string } | null>();
		bridge.resolve.mockReturnValueOnce(pending.promise);
		const { content, title, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		await fireEvent.change(screen.getByTestId('capture-kind'), {
			target: { value: 'snippet' }
		});

		pending.resolve({ name: 'Template A', content: 'Body A' });
		await settle();

		expect(content.value).toBe('');
		expect(title.value).toBe('');
	});

	it('applies an unchanged empty form once with title, body, and focus', async () => {
		bridge.resolve.mockResolvedValueOnce({ name: 'Template A.md', content: '# Body A\n' });
		const { content, title, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		await waitFor(() => expect(content.value).toBe('# Body A\n'));

		expect(title.value).toBe('Template A');
		expect(document.activeElement).toBe(content);
		expect(bridge.resolve).toHaveBeenCalledTimes(1);
	});

	it('reports a missing template without changing the note text', async () => {
		bridge.resolve.mockResolvedValueOnce(null);
		const { content, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		const error = await screen.findByTestId('capture-error');

		expect(error).toHaveTextContent(/no longer available/i);
		expect(content.value).toBe('');
	});

	it('keeps typed text and ignores a superseded template rejection', async () => {
		const pending = deferred<{ name: string; content: string } | null>();
		bridge.resolve.mockReturnValueOnce(pending.promise);
		const { content, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		await fireEvent.input(content, { target: { value: 'Typed before failure' } });
		pending.reject(new Error('template index read failed'));
		await settle();

		expect(content.value).toBe('Typed before failure');
		expect(screen.queryByTestId('capture-error')).not.toBeInTheDocument();
	});

	it('reports a rejected template read on an unchanged empty form', async () => {
		const pending = deferred<{ name: string; content: string } | null>();
		bridge.resolve.mockReturnValueOnce(pending.promise);
		const { content, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		pending.reject(new Error('template index read failed'));
		await settle();

		expect(content.value).toBe('');
		expect(await screen.findByTestId('capture-error')).toHaveTextContent(
			'template index read failed'
		);
	});

	it('does not apply a template after the selected template clears', async () => {
		const pending = deferred<{ name: string; content: string } | null>();
		bridge.resolve.mockReturnValueOnce(pending.promise);
		const { content, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		await fireEvent.change(select, { target: { value: '' } });

		pending.resolve({ name: 'Template A', content: 'Body A' });
		await settle();

		expect(content.value).toBe('');
	});
});
