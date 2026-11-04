// Web Light boundary for the desktop shell. The native menu, file-association
// listener and close guard do not exist in this edition.

export type DesktopMenuAction =
	| 'new'
	| 'open'
	| 'save-disk'
	| 'export-md'
	| 'export-pdf'
	| 'export-html'
	| 'export-zip'
	| 'settings'
	| 'close-file';

export interface DesktopMenuLabels {
	file: string;
	edit: string;
	newFile: string;
	open: string;
	saveToDisk: string;
	exportMarkdown: string;
	exportPdf: string;
	exportHtml: string;
	exportZip: string;
	settings: string;
}

export interface DesktopShellHandlers {
	onMenuAction: (action: DesktopMenuAction) => void | Promise<void>;
	onOpenPaths: (paths: string[]) => Promise<unknown>;
	onBeforeClose: () => void | Promise<void>;
	getLabels: () => DesktopMenuLabels;
}

export async function initDesktopShell(_handlers: DesktopShellHandlers): Promise<() => void> {
	void _handlers;
	return () => {};
}
