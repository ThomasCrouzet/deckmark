import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SearchPanel from './SearchPanel.svelte';
import SnippetsPanel from './SnippetsPanel.svelte';
import NewDocumentDialog from './NewDocumentDialog.svelte';
import PromptModal from './PromptModal.svelte';

function dispatchEscape(
	target: Element,
	init: { isComposing?: boolean; keyCode?: number } = {}
): KeyboardEvent {
	const event = new KeyboardEvent('keydown', {
		key: 'Escape',
		bubbles: true,
		cancelable: true,
		isComposing: init.isComposing ?? false
	});
	if (init.keyCode !== undefined) {
		Object.defineProperty(event, 'keyCode', { value: init.keyCode });
	}
	target.dispatchEvent(event);
	return event;
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('dialog Escape during IME composition', () => {
	it('keeps Search open for a composing Escape and a legacy key code 229', async () => {
		const onClose = vi.fn();
		render(SearchPanel, { open: true, onClose });
		const input = screen.getByRole('combobox');
		dispatchEscape(input, { isComposing: true });
		await Promise.resolve();
		expect(onClose).not.toHaveBeenCalled();
		dispatchEscape(input, { keyCode: 229 });
		await Promise.resolve();
		expect(onClose).not.toHaveBeenCalled();

		dispatchEscape(input);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('keeps an unsaved Snippets form for a composing Escape', async () => {
		const onClose = vi.fn();
		render(SnippetsPanel, {
			open: true,
			capture: { source: 'selection', code: 'const value = 1;', title: 'Draft snippet' },
			onClose
		});
		const title = (await screen.findByTestId('snippet-title')) as HTMLInputElement;
		await waitFor(() => expect(title).toHaveValue('Draft snippet'));
		const user = userEvent.setup();
		await user.clear(title);
		await user.type(title, 'Unsaved draft');
		dispatchEscape(title, { isComposing: true });
		await Promise.resolve();
		expect(screen.getByTestId('snippet-form')).toBeInTheDocument();
		expect(title).toHaveValue('Unsaved draft');
		expect(onClose).not.toHaveBeenCalled();

		dispatchEscape(title);
		await waitFor(() => expect(screen.queryByTestId('snippet-form')).not.toBeInTheDocument());
		expect(onClose).not.toHaveBeenCalled();
	});

	it('keeps the New Document Code form for a composing Escape', async () => {
		const onClose = vi.fn();
		render(NewDocumentDialog, {
			onCreate: vi.fn(async () => {}),
			onCreateFromTemplate: vi.fn(async () => {}),
			onClose
		});
		const user = userEvent.setup();
		await user.click(screen.getByTestId('create-code'));
		const name = (await screen.findByTestId('create-code-name')) as HTMLInputElement;
		dispatchEscape(name, { isComposing: true });
		await Promise.resolve();
		expect(screen.getByTestId('create-code-name')).toBeInTheDocument();
		expect(screen.getByTestId('create-code')).toHaveAttribute('aria-expanded', 'true');

		dispatchEscape(name);
		await waitFor(() => expect(screen.queryByTestId('create-code-name')).not.toBeInTheDocument());
		expect(onClose).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(screen.getByTestId('create-code')).toHaveAttribute('aria-expanded', 'false')
		);
	});

	it('does not resolve a prompt for composing Escape or legacy key code 229', async () => {
		const onResolve = vi.fn();
		render(PromptModal, {
			open: true,
			mode: 'prompt' as const,
			title: 'Nom du fichier ?',
			onResolve
		});
		const input = screen.getByLabelText('Nom du fichier ?', { selector: 'input' });
		dispatchEscape(input, { isComposing: true });
		await Promise.resolve();
		expect(onResolve).not.toHaveBeenCalled();
		dispatchEscape(input, { keyCode: 229 });
		await Promise.resolve();
		expect(onResolve).not.toHaveBeenCalled();
		dispatchEscape(input);
		expect(onResolve).toHaveBeenCalledWith(null);
	});
});
