/**
 * Web Light boundary for the Git panel. This edition has no native projects,
 * so the panel and its action have no label. No Tauri call and no Git user
 * interface reach the Web bundle.
 */
export function loadGitPanel(): Promise<never> {
	return Promise.reject(new Error('Git is available only in the desktop edition.'));
}

export function gitActionLabel(): null {
	return null;
}
