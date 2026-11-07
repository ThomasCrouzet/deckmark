import { t } from '#lib/i18n/index.js';

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
