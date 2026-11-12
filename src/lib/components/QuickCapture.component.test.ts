import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Web edition never mounts the Desktop capture window, so the browser
// suite cannot dispatch a composition sequence against this component. These
// cases replace the native window bridge and the stores. See docs/TESTING.md
// for the retained IME and native WebView risks.

const bridge = vi.hoisted(() => ({
	hide: vi.fn(async () => {}),
	resetListener: null as null | (() => void),
	files: { createNew: vi.fn(), flushPendingAwait: vi.fn(async () => {}) }
}));

vi.mock('#lib/capture.js', () => ({
	captureErrorMessage: (error: unknown) => String(error),
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
		load: async () => {},
		choices: [],
		resolve: async () => null
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

beforeEach(() => {
	bridge.hide.mockClear();
	bridge.files.createNew.mockClear();
	bridge.files.flushPendingAwait.mockClear();
	bridge.resetListener = null;
});

afterEach(() => {
	cleanup();
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
