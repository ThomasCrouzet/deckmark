/**
 * Desktop loader for the Git panel. The Web build aliases this module to
 * `src/lib/edition/web/git-panel.ts`, so the panel, its messages, and the
 * native Git module do not enter the Web Light bundle.
 */
import { i18n } from './i18n/index';
import { gitEn } from './i18n/messages/git-en';
import { gitFr } from './i18n/messages/git-fr';

export function loadGitPanel() {
	return import('./components/GitPanel.svelte').then((module) => module.default);
}

export function gitActionLabel(): string {
	return i18n.locale === 'fr' ? gitFr['git.open'] : gitEn['git.open'];
}
