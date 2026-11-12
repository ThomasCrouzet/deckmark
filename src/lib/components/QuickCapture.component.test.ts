import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Web edition never mounts the Desktop capture window, so the browser
// suite cannot hold a template resolution while the user types. These cases
// replace the native window bridge and the template store with deferred
// promises. See docs/TESTING.md for the retained native and IME risks.

const bridge = vi.hoisted(() => ({
	resetListener: null as null | (() => void),
	hide: vi.fn(async () => {}),
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
	db: {
		projects: {
			orderBy: () => ({
				reverse: () => ({
					toArray: async () => []
				})
			})
		}
	}
}));

import QuickCapture from './QuickCapture.svelte';

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
	bridge.resetListener = null;
	bridge.hide.mockClear();
	bridge.load.mockClear();
	bridge.resolve.mockReset();
	bridge.choices = [templateA, templateB];
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
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

	it('keeps typed text and reports a rejected template read', async () => {
		const pending = deferred<{ name: string; content: string } | null>();
		bridge.resolve.mockReturnValueOnce(pending.promise);
		const { content, select } = await renderCapture();

		await startTemplate(select, templateA.id);
		await fireEvent.input(content, { target: { value: 'Typed before failure' } });
		pending.reject(new Error('template index read failed'));
		await settle();

		expect(content.value).toBe('Typed before failure');
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
