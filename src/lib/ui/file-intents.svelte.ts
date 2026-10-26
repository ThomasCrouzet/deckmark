// §P3.3 - Module managing file intents at startup and the document title.
//
// Groups together:
//   - handleLaunchQueue: PWA File Handling API integration (launch_handler)
//   - handleShareTarget: PWA Share Target API integration (incoming share)
//   - title $effect: `document.title` derived from the active file
//   - flush $effect: saves drafts when hidden and before closing
//
// Exposes a `createFileIntents()` factory to call top-level in the parent
// component's `<script>` (Svelte 5 constraint: $effect within the init scope).
// The handleLaunchQueue and handleShareTarget functions are exposed to be
// called in onMount (browser only).

import { browser } from '$app/env';
import { registerFileLaunch, type FileLaunchQueue } from '#lib/launch-files.js';
import { t } from '#lib/i18n/index.js';

interface FilesStoreRef {
	active: { id: string } | null;
	displayTitle: (id: string) => string;
	createNew: (name?: string, content?: string) => void;
	flushPending: () => void;
	importFiles: (files: File[]) => Promise<unknown>;
}

export interface FileIntentsOptions {
	getFilesStore: () => FilesStoreRef;
	getHydrated: () => boolean;
	// §2.11 - Non-file PWA shortcuts (`?action=search` / `?action=palette`).
	// The parent opens the matching modal (the modals live in +page).
	onUiAction?: (action: 'search' | 'palette') => void;
}

export function createFileIntents(opts: FileIntentsOptions) {
	// §A2.3 - The document title derives from the active file. `$derived.by` is
	// re-evaluated on every keystroke (active.content tracked by the store) but
	// only writes document.title if the final value changes (99 % of keystrokes
	// → DOM untouched). `$derived` here because we are in a .svelte.ts factory,
	// hence within the init scope of the parent component that calls it top-level.
	const titleString = $derived.by(() => {
		if (!browser) return 'mdsh';
		const store = opts.getFilesStore();
		const active = store.active;
		if (!active) return 'mdsh';
		return `${store.displayTitle(active.id)} - mdsh`;
	});

	$effect(() => {
		if (!browser) return;
		if (document.title !== titleString) document.title = titleString;
	});

	// §A2.8 - Flush pending saves when the page becomes hidden and before exit.
	// This reduces the debounce loss window but cannot guarantee survival after
	// an abrupt browser or operating-system kill.
	$effect(() => {
		if (!browser) return;
		const flush = () => opts.getFilesStore().flushPending();
		const flushWhenHidden = () => {
			if (document.visibilityState === 'hidden') flush();
		};
		document.addEventListener('visibilitychange', flushWhenHidden);
		window.addEventListener('pagehide', flush);
		window.addEventListener('beforeunload', flush);
		return () => {
			document.removeEventListener('visibilitychange', flushWhenHidden);
			window.removeEventListener('pagehide', flush);
			window.removeEventListener('beforeunload', flush);
		};
	});

	// §A - PWA Share Target API integration (incoming share via GET params).
	// Called in onMount (browser only) after filesStore.load().
	function handleShareTarget() {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- one-shot read of URL params (never a $state)
		const params = new URLSearchParams(window.location.search);
		const action = params.get('action');
		const title = params.get('title');
		const text = params.get('text');
		const url = params.get('url');
		const store = opts.getFilesStore();
		if (action === 'new') {
			store.createNew();
		} else if (action === 'search' || action === 'palette') {
			// §2.11 - App shortcuts: open a modal without creating a file.
			opts.onUiAction?.(action);
		} else if (title || text || url) {
			const name = title ? `${title}.md` : t('fileIntents.sharedFilename');
			const body = [title ? `# ${title}` : '', text ?? '', url ? `\n${url}` : '']
				.filter(Boolean)
				.join('\n\n');
			store.createNew(name, body);
		} else {
			return;
		}
		const cleanUrl = window.location.pathname + window.location.hash;
		window.history.replaceState({}, '', cleanUrl);
	}

	// §A - PWA File Handling API integration (opening .md files from the OS).
	// Called in onMount (browser only) after filesStore.load().
	function handleLaunchQueue() {
		if (!browser) return;
		const queue = (window as Window & { launchQueue?: FileLaunchQueue }).launchQueue;
		registerFileLaunch(queue, (files) => opts.getFilesStore().importFiles(files));
	}

	return {
		handleShareTarget,
		handleLaunchQueue
	};
}
