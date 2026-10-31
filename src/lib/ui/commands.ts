import type { MessageKey } from '#lib/i18n/index.js';
import { formatKbd } from '#lib/platform.js';

// Shared metadata for shortcuts, the command palette, and shortcut help.
export const coreCommands = [
	{ id: 'new', label: 'palette.newFile', key: 'n', shift: false, shortcut: '⌘N', document: false },
	{
		id: 'import',
		label: 'palette.importMd',
		key: 'o',
		shift: false,
		shortcut: '⌘O',
		document: false
	},
	{
		id: 'export-md',
		label: 'palette.exportMarkdown',
		key: 's',
		shift: false,
		shortcut: '⌘S',
		document: true
	},
	{
		id: 'save-disk',
		label: 'palette.saveToDisk',
		key: 's',
		shift: true,
		shortcut: '⌘⇧S',
		document: true
	},
	{
		id: 'export-pdf',
		label: 'palette.exportPdf',
		key: 'p',
		shift: false,
		shortcut: '⌘P',
		document: true
	},
	{
		id: 'sidebar',
		label: 'toolbar.panel',
		key: 'b',
		shift: false,
		shortcut: '⌘B',
		document: false
	},
	{
		id: 'mode-wysiwyg',
		label: 'toolbar.modeEdit',
		key: 'e',
		shift: false,
		shortcut: '⌘E',
		document: true
	},
	{
		id: 'mode-read',
		label: 'toolbar.modeRead',
		key: 'r',
		shift: false,
		shortcut: '⌘R',
		document: true
	},
	{
		id: 'mode-source',
		label: 'toolbar.modeSource',
		key: '/',
		shift: false,
		shortcut: '⌘/',
		document: true
	},
	{
		id: 'palette',
		label: 'toolbar.commands',
		key: 'p',
		shift: true,
		shortcut: '⌘⇧P',
		document: false
	},
	{
		id: 'settings',
		label: 'palette.settings',
		key: ',',
		shift: false,
		shortcut: '⌘,',
		document: false
	},
	{
		id: 'search',
		label: 'palette.searchCrossFiles',
		key: 'f',
		shift: true,
		shortcut: '⌘⇧F',
		document: false
	},
	{
		id: 'search-in-file',
		label: 'palette.searchInFile',
		key: 'f',
		shift: false,
		shortcut: '⌘F',
		document: true
	},
	{
		id: 'focus',
		label: 'settings.focusMode',
		key: '.',
		shift: true,
		shortcut: '⌘⇧.',
		document: false
	},
	{
		id: 'slides',
		label: 'slides.open',
		key: 'l',
		shift: true,
		shortcut: '⌘⇧L',
		document: false
	},
	{
		id: 'close-file',
		label: 'palette.closeFile',
		key: 'w',
		shift: false,
		shortcut: '⌘W',
		document: true
	}
] satisfies {
	id: string;
	label: MessageKey;
	key: string;
	shift: boolean;
	shortcut: string;
	document: boolean;
}[];

export function commandShortcut(id: string): string | undefined {
	const command = coreCommands.find((entry) => entry.id === id);
	return command ? formatKbd(command.shortcut) : undefined;
}

export function normalizeCommandSearch(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLocaleLowerCase();
}
