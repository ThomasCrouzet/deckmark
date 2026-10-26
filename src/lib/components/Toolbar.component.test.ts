import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Toolbar from './Toolbar.svelte';
import { filesStore } from '#lib/files.svelte.js';
import type { EditMode } from '#lib/types.js';

function defaultProps(mode: EditMode = 'wysiwyg') {
	return {
		mode,
		sidebarOpen: true,
		onToggleSidebar: vi.fn(),
		onSetMode: vi.fn(),
		onExport: vi.fn(),
		onExportPDF: vi.fn(),
		onOpenPalette: vi.fn(),
		onSaveToDisk: vi.fn()
	};
}

beforeEach(() => {
	filesStore.files = [];
	filesStore.activeId = null;
});

describe('Toolbar - radio group keyboard navigation', () => {
	it('calls onSetMode with source after ArrowRight from wysiwyg', async () => {
		const user = userEvent.setup();
		const props = defaultProps('wysiwyg');
		render(Toolbar, { props });

		const radioGroup = screen.getByRole('radiogroup', { name: /mode d'édition/i });
		radioGroup.focus();
		await user.keyboard('{ArrowRight}');

		expect(props.onSetMode).toHaveBeenCalledWith('source');
	});

	it('wraps to read mode after ArrowLeft from wysiwyg', async () => {
		const user = userEvent.setup();
		const props = defaultProps('wysiwyg');
		render(Toolbar, { props });

		const radioGroup = screen.getByRole('radiogroup', { name: /mode d'édition/i });
		radioGroup.focus();
		await user.keyboard('{ArrowLeft}');

		expect(props.onSetMode).toHaveBeenCalledWith('read');
	});
});
