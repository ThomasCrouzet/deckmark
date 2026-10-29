// §P3.1 - Module managing the lazy-loaded modals.
//
// Groups together:
//   - The open state of each modal (paletteOpen, searchOpen, etc.)
//   - The memoized loaders (dynamic import(), never static)
//   - The `handleOpenHit` handler (SearchPanel → SourceEditor)
//   - The Toc loader (used in EditorPane)
//
// Exposes a `createModals()` factory to call top-level in the parent
// component's `<script>` (Svelte 5 constraint: `$effect`s must be
// created within the component's init scope).
//
// BUNDLE CONSTRAINT: no static import of any modal / rendering lib here.
// All component imports go through memoized dynamic import()s.

import type { EditMode } from '#lib/types.js';
import { reportError } from '#lib/report.js';
import { t, type MessageKey } from '#lib/i18n/index.js';

/**
 * Builds a memoized loader for a lazy modal. An import can fail offline or with
 * a stale PWA cache. Reset the memo to permit a retry, close the modal, and
 * notify the user. Rethrow the error so the template's `{:catch}` does not mount an
 * undefined component. The stale cache case can occur after a deployment.
 *
 * Infer the component type from the dynamic import to preserve lazy loading.
 */
/** Exported for unit tests (failure path: close + report + rethrow). */
export function makeLazyLoader<T>(
	importer: () => Promise<{ default: T }>,
	close: () => void,
	labelKey: MessageKey
): () => Promise<T> {
	let promise: Promise<T> | null = null;
	return () => {
		promise ??= importer()
			.then((m) => m.default)
			.catch((err) => {
				promise = null;
				close();
				const label = t(labelKey);
				reportError(`lazy load (${label})`, err, {
					notifyUser: t('modals.loadFailed', { label })
				});
				throw err;
			});
		return promise;
	};
}

// Structural interface for SourceEditor (avoids the static import of the component).
interface SourceEditorRef {
	openSearch?: () => void;
	goToLine?: (line: number, query: string) => void;
}

export interface ModalsOptions {
	getMode: () => EditMode;
	setMode: (m: EditMode) => void;
	getFilesStoreActive: () => { id: string } | null;
	getFilesStoreSetActive: () => (id: string) => void;
	getSourceEditorRef: () => SourceEditorRef | null;
	// Callback to post a contextual accessibility announcement
	announceContext: (msg: string) => void;
	// Setters for the pendingGoToHit and pendingOpenSearch states
	setPendingGoToHit: (v: { line: number; query: string } | null) => void;
	setPendingOpenSearch: (v: boolean) => void;
}

export function createModals(opts: ModalsOptions) {
	// §A1.1 - Open states of the modals
	let paletteOpen = $state(false);
	let paletteView = $state<'commands' | 'actions'>('commands');
	let libraryOpen = $state(false);
	let searchOpen = $state(false);
	let diskLinksOpen = $state(false);
	let workspacesOpen = $state(false);
	let settingsOpen = $state(false);
	let historyOpen = $state(false);
	let graphOpen = $state(false);
	let presentationOpen = $state(false);

	function closeAll(): void {
		libraryOpen = false;
		paletteOpen = false;
		searchOpen = false;
		diskLinksOpen = false;
		workspacesOpen = false;
		settingsOpen = false;
		historyOpen = false;
		graphOpen = false;
		presentationOpen = false;
	}

	// §A1.1 / A1.2 - Memoized loaders: one loading function per modal.
	// The browser caches the ESM module by URL → instant 2nd open. The memo
	// (internal to `makeLazyLoader`) is reset on an import failure to allow
	// a retry, and closes + notifies instead of failing silently.
	const loadCommandPalette = makeLazyLoader(
		() => import('#lib/components/CommandPalette.svelte'),
		() => {
			paletteOpen = false;
		},
		'modals.labelPalette'
	);
	const loadLibrary = makeLazyLoader(
		() => import('#lib/components/LibraryPanel.svelte'),
		() => {
			libraryOpen = false;
		},
		'library.title'
	);
	const loadSearchPanel = makeLazyLoader(
		() => import('#lib/components/SearchPanel.svelte'),
		() => {
			searchOpen = false;
		},
		'modals.labelSearch'
	);
	const loadDiskLinksPanel = makeLazyLoader(
		() => import('#lib/components/DiskLinksPanel.svelte'),
		() => {
			diskLinksOpen = false;
		},
		'modals.labelDiskLinks'
	);
	const loadWorkspacesPanel = makeLazyLoader(
		() => import('#lib/components/WorkspacesPanel.svelte'),
		() => {
			workspacesOpen = false;
		},
		'modals.labelWorkspaces'
	);
	const loadSettingsPanel = makeLazyLoader(
		() => import('#lib/components/SettingsPanel.svelte'),
		() => {
			settingsOpen = false;
		},
		'modals.labelSettings'
	);
	const loadHistoryPanel = makeLazyLoader(
		() => import('#lib/components/VersionHistoryPanel.svelte'),
		() => {
			historyOpen = false;
		},
		'modals.labelHistory'
	);
	const loadGraphPanel = makeLazyLoader(
		() => import('#lib/components/GraphPanel.svelte'),
		() => {
			graphOpen = false;
		},
		'modals.labelGraph'
	);
	const loadPresentation = makeLazyLoader(
		() => import('#lib/components/PresentationView.svelte'),
		() => {
			presentationOpen = false;
		},
		'modals.labelPresentation'
	);
	// The TOC has no open state of its own (mounted in EditorPane): close is a no-op.
	const loadToc = makeLazyLoader(
		() => import('#lib/components/Toc.svelte'),
		() => {},
		'modals.labelToc'
	);

	// Open actions
	function openPalette() {
		closeAll();
		paletteView = 'commands';
		paletteOpen = true;
	}
	function openActions() {
		closeAll();
		paletteView = 'actions';
		paletteOpen = true;
	}
	function openLibrary() {
		closeAll();
		libraryOpen = true;
	}

	function openSearch() {
		closeAll();
		searchOpen = true;
	}

	function openDiskLinks() {
		closeAll();
		diskLinksOpen = true;
	}

	function openWorkspaces() {
		closeAll();
		workspacesOpen = true;
	}

	function openSettings() {
		closeAll();
		settingsOpen = true;
	}

	function openHistory() {
		closeAll();
		historyOpen = true;
	}

	function openGraph() {
		closeAll();
		graphOpen = true;
	}

	function openPresentation() {
		closeAll();
		presentationOpen = true;
	}

	// §B3.7 - Handler invoked by SearchPanel when a hit is clicked: switches
	// to the target file in source mode, scrolls to the line and preloads
	// the query into the CodeMirror panel. If the SourceEditor is not yet
	// mounted, its own `goToLine` method buffers the request.
	function handleOpenHit(fileId: string, line: number, query: string) {
		const changedFile = opts.getFilesStoreActive()?.id !== fileId;
		opts.getFilesStoreSetActive()(fileId);
		if (opts.getMode() !== 'source' || changedFile) {
			opts.setPendingGoToHit({ line, query });
			opts.setMode('source');
		} else {
			opts.getSourceEditorRef()?.goToLine?.(line, query);
		}
	}

	return {
		get paletteView() {
			return paletteView;
		},
		get libraryOpen() {
			return libraryOpen;
		},
		set libraryOpen(value: boolean) {
			if (value) openLibrary();
			else libraryOpen = false;
		},
		loadLibrary,
		openLibrary,
		openActions,
		get anyOpen() {
			return (
				libraryOpen ||
				paletteOpen ||
				searchOpen ||
				diskLinksOpen ||
				workspacesOpen ||
				settingsOpen ||
				historyOpen ||
				graphOpen ||
				presentationOpen
			);
		},
		// Open states (read/write via getters)
		get paletteOpen() {
			return paletteOpen;
		},
		set paletteOpen(v: boolean) {
			if (v) openPalette();
			else paletteOpen = false;
		},
		get searchOpen() {
			return searchOpen;
		},
		set searchOpen(v: boolean) {
			if (v) openSearch();
			else searchOpen = false;
		},
		get diskLinksOpen() {
			return diskLinksOpen;
		},
		set diskLinksOpen(v: boolean) {
			if (v) openDiskLinks();
			else diskLinksOpen = false;
		},
		get workspacesOpen() {
			return workspacesOpen;
		},
		set workspacesOpen(v: boolean) {
			if (v) openWorkspaces();
			else workspacesOpen = false;
		},
		get settingsOpen() {
			return settingsOpen;
		},
		set settingsOpen(v: boolean) {
			if (v) openSettings();
			else settingsOpen = false;
		},
		get historyOpen() {
			return historyOpen;
		},
		set historyOpen(v: boolean) {
			if (v) openHistory();
			else historyOpen = false;
		},
		get graphOpen() {
			return graphOpen;
		},
		set graphOpen(v: boolean) {
			if (v) openGraph();
			else graphOpen = false;
		},
		get presentationOpen() {
			return presentationOpen;
		},
		set presentationOpen(v: boolean) {
			if (v) openPresentation();
			else presentationOpen = false;
		},
		// Loaders
		loadCommandPalette,
		loadSearchPanel,
		loadDiskLinksPanel,
		loadWorkspacesPanel,
		loadSettingsPanel,
		loadHistoryPanel,
		loadGraphPanel,
		loadPresentation,
		loadToc,
		// Actions
		openPalette,
		openSearch,
		openDiskLinks,
		openWorkspaces,
		openSettings,
		openHistory,
		openGraph,
		openPresentation,
		handleOpenHit
	};
}
