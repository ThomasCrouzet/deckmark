import { READING } from './config';
import { t } from '#lib/i18n/index.js';

export interface DocStats {
	chars: number;
	words: number;
	lines: number;
	readMinutes: number;
}

const WPM = READING.wpm;

export function computeStats(markdown: string): DocStats {
	const stripped = markdown
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`[^`]*`/g, ' ')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/^#+\s+/gm, '')
		.replace(/[*_~>]/g, ' ');

	const chars = markdown.length;
	const words = stripped.trim().length === 0 ? 0 : stripped.trim().split(/\s+/).length;
	const lines = markdown.length === 0 ? 0 : markdown.split('\n').length;
	const readMinutes = words === 0 ? 0 : Math.max(1, Math.round(words / WPM));

	return { chars, words, lines, readMinutes };
}

export function formatSaveAge(savedAt: number, now = Date.now()): string {
	if (!savedAt) return t('stats.notSaved');
	const diff = Math.max(0, Math.round((now - savedAt) / 1000));
	if (diff < 2) return t('stats.saved');
	if (diff < 60) return t('stats.savedSecondsAgo', { n: diff });
	const mins = Math.round(diff / 60);
	if (mins < 60) return t('stats.savedMinutesAgo', { n: mins });
	const hours = Math.round(mins / 60);
	return t('stats.savedHoursAgo', { n: hours });
}
