// §P2.2 - Module managing the global keyboard shortcuts.
//
// Pure logic with no $effect - no factory needed.
// The parent component passes the callbacks and attaches the listener via
// `<svelte:window onkeydown={handleKeydown}>`.
//
// Logic extracted from `+page.svelte` (L630-695).

import { isDiskLinkingAvailable } from '#lib/disk-sync.js';
import { keyboardStore } from './keyboard.svelte';
import type { EditMode } from '#lib/types.js';
import { isMac } from '#lib/platform.js';
import { isDesktop } from '#lib/desktop.js';

export interface ShortcutCallbacks {
	// Files
	onNew: () => void;
	onImport: () => Promise<void> | void;
	onExport: () => void;
	onExportPDF: () => void;
	onSaveToDisk: () => Promise<void> | void;
	// Navigation / modes
	getMode: () => EditMode;
	setMode: (m: EditMode) => void;
	onNavigateFile: (direction: 1 | -1) => void;
	// UI
	onToggleSidebar: () => void;
	onOpenPalette: () => void;
	onOpenSearch: () => void;
	onOpenInFileSearch: () => void;
	onOpenSettings: () => void;
	onToggleFocus: () => void;
	onOpenSlides: () => void;
	// Current file
	getActiveId: () => string | null;
	onClose: (id: string) => void;
}

/**
 * Builds the global `keydown` handler from the injected callbacks.
 * Covers all the application's ⌘ shortcuts.
 *
 * Usage: call this function in the parent component's `<script>`, then
 * wire the result onto `<svelte:window onkeydown={handleKeydown}>`.
 */
export function buildKeydownHandler(cb: ShortcutCallbacks) {
	return function handleKeydown(e: KeyboardEvent) {
		if (e.defaultPrevented || e.isComposing || e.repeat || e.altKey) return;
		const target = e.target as HTMLElement | null;
		const mod = (e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey);
		if (!mod) return;
		const editable =
			target?.tagName === 'INPUT' ||
			target?.tagName === 'TEXTAREA' ||
			target?.tagName === 'SELECT' ||
			target?.isContentEditable;
		if (editable && !target?.closest?.('.cm-editor, .milkdown, .ProseMirror')) return;
		if (
			typeof document !== 'undefined' &&
			document.querySelector('[role="dialog"][aria-modal="true"]')
		) {
			return;
		}
		if (e.ctrlKey && !e.metaKey && e.key === 'Tab' && cb.getActiveId()) {
			e.preventDefault();
			cb.onNavigateFile(e.shiftKey ? -1 : 1);
			return;
		}

		// Control-only keys on macOS belong to native text navigation.
		if (isDesktop() && isMac() && !e.metaKey) return;
		const command = keyboardStore.match(e);
		if (!command) return;
		const activeId = cb.getActiveId();
		if (command.document && !activeId) return;
		if ((command.id === 'sidebar' || command.id === 'close-file') && editable) return;
		if (command.id === 'save-disk' && !isDiskLinkingAvailable()) return;
		e.preventDefault();
		switch (command.id) {
			case 'new':
				cb.onNew();
				break;
			case 'import':
				void cb.onImport();
				break;
			case 'export-md':
				cb.onExport();
				break;
			case 'save-disk':
				void cb.onSaveToDisk();
				break;
			case 'export-pdf':
				cb.onExportPDF();
				break;
			case 'sidebar':
				cb.onToggleSidebar();
				break;
			case 'mode-wysiwyg':
				cb.setMode('wysiwyg');
				break;
			case 'mode-source':
				cb.setMode('source');
				break;
			case 'mode-read':
				cb.setMode('read');
				break;
			case 'palette':
				cb.onOpenPalette();
				break;
			case 'settings':
				cb.onOpenSettings();
				break;
			case 'search':
				cb.onOpenSearch();
				break;
			case 'search-in-file':
				cb.onOpenInFileSearch();
				break;
			case 'focus':
				cb.onToggleFocus();
				break;
			case 'slides':
				cb.onOpenSlides();
				break;
			case 'close-file':
				if (activeId) cb.onClose(activeId);
				break;
		}
	};
}
