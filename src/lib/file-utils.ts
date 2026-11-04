import { t } from '#lib/i18n/index.js';
import { stripMdExtension } from './file-names';

export { escapeHTML } from './html-escape';
export { stripFileExtension, stripMdExtension } from './file-names';

export function isMarkdownFile(f: { name: string; type?: string }): boolean {
	const name = f.name.toLowerCase();
	return (
		name.endsWith('.md') ||
		name.endsWith('.markdown') ||
		name.endsWith('.mdx') ||
		name.endsWith('.txt') ||
		f.type === 'text/markdown' ||
		f.type === 'text/plain' ||
		f.type === ''
	);
}

/** Localized untitled filename: `Untitled.md` or `Sans titre.md`. */
export function untitledFilename(): string {
	return t('files.untitledFilename');
}

/** Untitled basename without the markdown extension. */
export function untitledBasename(): string {
	return stripMdExtension(untitledFilename());
}

export function uniqueName(existing: string[], base: string): string {
	if (!existing.includes(base)) return base;
	const dot = base.lastIndexOf('.');
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : '';
	let n = 2;
	while (existing.includes(`${stem} (${n})${ext}`)) n++;
	return `${stem} (${n})${ext}`;
}

export function normalizeRename(raw: string): string {
	const clean = raw.trim() || untitledFilename();
	return /\.[a-z0-9]{1,10}$/i.test(clean) ? clean : `${clean}.md`;
}
