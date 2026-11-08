import { READING } from '../../src/lib/config';

// This oracle preserves the statistics rules at 7d992dce, not CommonMark rules.
export function baselineStats(markdown: string) {
	const stripped = markdown
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`[^`]*`/g, ' ')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/^#+\s+/gm, '')
		.replace(/[*_~>]/g, ' ');
	const words = stripped.trim().length === 0 ? 0 : stripped.trim().split(/\s+/).length;
	return {
		chars: markdown.length,
		words,
		lines: markdown.length === 0 ? 0 : markdown.split('\n').length,
		readMinutes: words === 0 ? 0 : Math.max(1, Math.round(words / READING.wpm))
	};
}

export function baselineSelection(text: string) {
	const trimmed = text.trim();
	return {
		chars: Array.from(text).length,
		words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length,
		lines: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length
	};
}

export function statsFixture(bytes: number, shape: 'multiline' | 'single-line'): string {
	const unit =
		shape === 'multiline'
			? '# Stats\n\nalpha beta **gamma** [delta](local.md) `code` $x$\n'
			: 'alpha beta gamma delta epsilon ';
	return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}
