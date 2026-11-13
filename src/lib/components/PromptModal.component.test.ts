import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import PromptModal from './PromptModal.svelte';
import { t } from '#lib/i18n/index.js';

function renderPrompt(overrides: Record<string, unknown> = {}) {
	const onResolve = vi.fn();
	const { rerender, unmount } = render(PromptModal, {
		props: {
			open: true,
			mode: 'prompt' as const,
			title: 'Nom du fichier ?',
			defaultValue: '',
			onResolve,
			...overrides
		}
	});
	return { onResolve, rerender, unmount };
}

function input() {
	return screen.getByLabelText('Nom du fichier ?', { selector: 'input' });
}

it('clears the first passphrase before its confirmation', async () => {
	const { rerender } = renderPrompt({ title: 'Phrase secrète', inputType: 'password' });
	await userEvent.type(screen.getByLabelText('Phrase secrète', { selector: 'input' }), 'secret');
	await rerender({ title: 'Confirmer la phrase' });
	expect(screen.getByLabelText('Confirmer la phrase', { selector: 'input' })).toHaveValue('');
});

it('cancels when Enter activates the focused Cancel button', async () => {
	const { onResolve } = renderPrompt();
	const label = 'Projet annulé';
	await userEvent.type(input(), label);
	const cancel = screen.getByRole('button', { name: t('prompt.cancel') });
	cancel.focus();
	await userEvent.keyboard('{Enter}');
	expect(onResolve).toHaveBeenCalledTimes(1);
	expect(onResolve).toHaveBeenCalledWith(null);
});

it('cancels when Enter activates the focused Close button', async () => {
	const { onResolve } = renderPrompt();
	await userEvent.type(input(), 'Projet fermé');
	screen.getByRole('button', { name: t('prompt.close') }).focus();
	await userEvent.keyboard('{Enter}');
	expect(onResolve).toHaveBeenCalledTimes(1);
	expect(onResolve).toHaveBeenCalledWith(null);
});

it('confirms exactly once when Enter activates the focused Confirm button', async () => {
	const { onResolve } = renderPrompt();
	await userEvent.type(input(), 'Projet confirmé');
	screen.getByRole('button', { name: t('prompt.ok') }).focus();
	await userEvent.keyboard('{Enter}');
	expect(onResolve).toHaveBeenCalledTimes(1);
	expect(onResolve).toHaveBeenCalledWith('Projet confirmé');
});

it('confirms exactly once when Enter is pressed in the text input', async () => {
	const { onResolve } = renderPrompt();
	input().focus();
	await userEvent.keyboard('Projet saisi{Enter}');
	expect(onResolve).toHaveBeenCalledTimes(1);
	expect(onResolve).toHaveBeenCalledWith('Projet saisi');
});

it('keeps Space activation on Cancel and Escape cancellation', async () => {
	const { onResolve } = renderPrompt();
	await userEvent.type(input(), 'Projet');
	const cancel = screen.getByRole('button', { name: t('prompt.cancel') });
	cancel.focus();
	await userEvent.keyboard(' ');
	expect(onResolve).toHaveBeenCalledTimes(1);
	expect(onResolve).toHaveBeenCalledWith(null);

	onResolve.mockClear();
	input().focus();
	await userEvent.keyboard('{Escape}');
	expect(onResolve).toHaveBeenCalledTimes(1);
	expect(onResolve).toHaveBeenCalledWith(null);
});
