<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { readPreference, writePreference } from '#lib/preferences.js';
	import { browser } from '$app/env';
	import { t, i18n } from '#lib/i18n/index.js';
	import { IS_DESKTOP_EDITION } from '#lib/edition.js';
	import { captureSettings } from '#lib/capture-settings.svelte.js';
	import { loadQuickCapture } from '#lib/capture-surface.js';
	import SourceEditor from '#lib/components/SourceEditor.svelte';
	import { keyboardStore } from '#lib/ui/keyboard.svelte.js';
	import ImportProgress from '#lib/components/ImportProgress.svelte';
	import Sidebar from '#lib/components/Sidebar.svelte';
	import Toolbar from '#lib/components/Toolbar.svelte';
	import StatusBar from '#lib/components/StatusBar.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import SpinnerToast from '#lib/components/SpinnerToast.svelte';
	import Toasts from '#lib/components/Toasts.svelte';
	import PromptModal from '#lib/components/PromptModal.svelte';
	import Modals from '#lib/components/Modals.svelte';
	import EditorPane from '#lib/components/EditorPane.svelte';
	import { promptStore } from '#lib/prompt.svelte.js';
	import { notify } from '#lib/notify.svelte.js';
	import { reportError } from '#lib/report.js';
	import { createModals } from '#lib/ui/modals.svelte.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { templatesStore } from '#lib/templates.svelte.js';
	import { aiStore } from '#lib/ai/store.svelte.js';
	import { requestPersistentStorage, checkStoragePressure } from '#lib/storage.js';
	import { isDiskLinkingAvailable } from '#lib/disk-linking.js';
	import { isDesktop } from '#lib/desktop.js';
	import { shouldFallThroughToFileInput } from '#lib/import-intent.js';
	import type { EditMode } from '#lib/types.js';
	import { createEditorWidth } from '#lib/ui/editor-width.svelte.js';
	import { buildKeydownHandler } from '#lib/ui/shortcuts.svelte.js';
	import { createUiPrefs } from '#lib/ui/prefs.svelte.js';
	import { themeStore } from '#lib/ui/theme.svelte.js';
	import { requestEditorFocus } from '#lib/ui/editor-focus.js';
	import { registerPwaUpdates } from '#lib/ui/pwa-update.js';
	import { buildDropHandlers } from '#lib/ui/image-drop.svelte.js';
	import { schedulePrefetch } from '#lib/ui/prefetch.svelte.js';
	import { createFileIntents } from '#lib/ui/file-intents.svelte.js';
	import { initDesktopShell, type DesktopMenuAction } from '#lib/desktop-shell.js';
	import { diskConflictStore } from '#lib/disk-conflict.svelte.js';
	import { documentKind, documentKindForFile, type DocumentKind } from '#lib/document-kind.js';
	import type { SnippetCapture } from '#lib/snippets.js';
	const kind = $derived(
		filesStore.active ? documentKindForFile(filesStore.active) : ('note' as DocumentKind)
	);
	// §234 - the native capture window loads this page with `?capture=1`.
	// The Web Light build never exposes the capture component.
	const captureRequested = IS_DESKTOP_EDITION && page.url.searchParams.get('capture') === '1';

	let mode = $state<EditMode>('wysiwyg');
	let projectsOpen = $state(false);
	let documentTool = $state<'find' | 'outline' | null>(null);
	function openDocumentTool(kind: 'find' | 'outline') {
		if (!filesStore.active || documentKindForFile(filesStore.active) !== 'note') return;
		documentTool = kind;
		void tick().then(() =>
			document
				.querySelector<HTMLElement>(
					'[data-document-navigation] input, [data-document-navigation] button'
				)
				?.focus()
		);
	}
	function snippetCapture(source: 'selection' | 'file'): SnippetCapture | null {
		const active = filesStore.active;
		if (!active) {
			notify.info(t('snippets.fileMissing'));
			return null;
		}
		let code = active.content;
		if (source === 'selection') {
			const selected =
				codeEditorRef?.getSelectionText?.() ||
				sourceEditorRef?.getSelectionText?.() ||
				window.getSelection()?.toString() ||
				'';
			if (selected.trim()) code = selected;
			else notify.info(t('snippets.selectionMissing'));
		}
		return {
			code,
			title: '',
			fileName: active.name,
			...(active.projectId ? { projectId: active.projectId } : {}),
			source
		};
	}

	function openSnippetPanel(capture: SnippetCapture | null = null) {
		const active = filesStore.active;
		modals.openSnippets({
			capture,
			context: {
				...(active?.projectId ? { projectId: active.projectId } : {}),
				...(active
					? { fileName: active.name, documentTitle: filesStore.documentTitle(active.id) }
					: {})
			}
		});
	}

	function openOutline() {
		openDocumentTool('outline');
	}
	async function requestMode(nextMode: EditMode): Promise<void> {
		if (kind !== 'note' && kind !== 'code') return;
		if (kind === 'code') {
			mode = 'source';
			return;
		}
		documentTool = null;
		const activeId = filesStore.activeId;
		if (nextMode !== 'source' && activeId && filesStore.requiresRenderConfirmation(activeId)) {
			const accepted = await promptStore.confirm({
				title: t('page.largeDocumentTitle'),
				message: t('page.largeDocumentMessage'),
				confirmLabel: t('page.renderDocument')
			});
			if (!accepted || filesStore.activeId !== activeId) return;
			filesStore.allowDocumentRendering(activeId);
		}
		filesStore.flushDocumentEdits();
		mode = nextMode;
	}
	$effect(() => {
		const activeId = filesStore.activeId;
		if (kind === 'note' && activeId && filesStore.requiresRenderConfirmation(activeId))
			mode = 'source';
	});
	// §B1.10 / B2.2 - Text announced to SRs on each mode switch + one-off
	// contextual announcement (e.g. "⌘F switched to source mode for search").
	// `contextAnnounce` is cleared after 2 s to free the live region (otherwise a
	// focus return would read it again).
	const modeAnnounce = $derived(
		kind === 'presentation'
			? t('documents.presentation')
			: mode === 'wysiwyg'
				? t('page.modeWysiwyg')
				: mode === 'source'
					? t('page.modeSourceMarkdown')
					: t('page.modeReading')
	);
	let contextAnnounce = $state('');
	let contextTimer: ReturnType<typeof setTimeout> | null = null;
	function announceContext(msg: string) {
		contextAnnounce = msg;
		if (contextTimer) clearTimeout(contextTimer);
		contextTimer = setTimeout(() => {
			contextAnnounce = '';
			contextTimer = null;
		}, 2000);
	}
	let sidebarOpen = $state(false);
	let viewportWidth = $state(1024);
	let previousMobile = false;
	$effect(() => {
		const mobile = viewportWidth < 768;
		if (mobile && !previousMobile) sidebarOpen = false;
		previousMobile = mobile;
	});
	let dragOver = $state(false);
	let fileInput: HTMLInputElement | null = $state(null);
	let hydrated = $state(false);
	const canInteract = $derived(hydrated && !filesStore.loadError);
	// §P2.3 - UI preferences (focus mode, typewriter, TOC) delegated to the ui/prefs module.
	// The factory is called top-level (Svelte 5 constraint: $effect in the init scope).
	// tocEmpty stays local: it is a value pushed by Toc via onEmpty, not a pref.
	let tocEmpty = $state(true);
	const prefs = createUiPrefs({
		getNoteActive: () => kind === 'note',
		getHydrated: () => hydrated,
		getMode: () => mode,
		getTocVisible: () => prefs.tocVisible,
		getTocEmpty: () => tocEmpty,
		getActiveId: () => filesStore.activeId,
		getSourceEditorRef: () => sourceEditorRef
	});

	// §P2.1 - Editor width management delegated to the ui/editor-width module.
	// The factory is called top-level (Svelte 5 constraint: $effect in the init scope).
	const editorWidth = createEditorWidth({
		getHydrated: () => hydrated,
		getResizing: () => editorWidth.resizing
	});

	// Reference to the `<article>` rendered by ReadView (passed by EditorPane via onArticleRef).
	// Needed for the TOC scrollspy, handled in EditorPane.
	let articleRef = $state<HTMLElement | null>(null);

	// Reference to the SourceEditor component to drive its search panel
	// (`openSearch()` method) and its typewriter mode (`setTypewriter()`),
	// both exposed via `bind:this`.
	let sourceEditorRef = $state<SourceEditor | null>(null);
	let codeEditorRef = $state<{ getSelectionText?: () => string } | null>(null);
	// Search panel open-request flag: set when `⌘F` is pressed while in WYSIWYG /
	// reading mode. We switch to `source` then the `$effect` below opens the
	// panel as soon as the component is mounted.
	let pendingOpenSearch = $state(false);
	// Request to navigate to a line in SourceEditor from a search hit.
	let pendingGoToHit = $state<{ line: number; query: string } | null>(null);

	// §P3.1 - Lazy-loaded modals delegated to the ui/modals module.
	// The factory is called top-level (Svelte 5 constraint: no $effect in this
	// module for now, but consistency with the other modules requires it). The
	// memoized loaders and the open state live here.
	const modals = createModals({
		getMode: () => mode,
		setMode: (m) => void requestMode(m),
		getFilesStoreActive: () => filesStore.active,
		getFilesStoreSetActive: () => filesStore.openDocument.bind(filesStore),
		getSourceEditorRef: () => sourceEditorRef,
		announceContext,
		setPendingGoToHit: (v) => (pendingGoToHit = v),
		setPendingOpenSearch: (v) => (pendingOpenSearch = v)
	});

	let hadDialog = false;
	let dialogTrigger: HTMLElement | null = null;
	let dialogSearchControl: { editor: Element; selector: string } | null = null;
	$effect.pre(() => {
		if (!browser) return;
		const open = modals.anyOpen || promptStore.open || projectsOpen || !!diskConflictStore.pending;
		if (open && !hadDialog) {
			dialogTrigger = document.activeElement as HTMLElement | null;
			const editor = dialogTrigger?.closest('.cm-search')?.closest('.cm-editor');
			const name = dialogTrigger?.getAttribute('name');
			const tagName = dialogTrigger?.localName;
			const type = dialogTrigger?.getAttribute('type') ?? null;
			dialogSearchControl =
				editor && name && tagName
					? {
							editor,
							selector: `.cm-search ${CSS.escape(tagName)}[name="${CSS.escape(name)}"]${
								type === null ? ':not([type])' : `[type="${CSS.escape(type)}"]`
							}`
						}
					: null;
		}
		if (!open && hadDialog) {
			void tick().then(() => {
				const focused = document.activeElement;
				if (
					focused &&
					focused !== document.body &&
					focused !== document.documentElement &&
					!focused.closest('[inert]')
				)
					return;
				// Locale changes replace CodeMirror search controls. Restore the same control.
				const trigger = dialogTrigger?.isConnected
					? dialogTrigger
					: dialogSearchControl?.editor.querySelector<HTMLElement>(dialogSearchControl.selector);
				if (trigger?.isConnected && !trigger.closest('[inert]') && trigger.getClientRects().length)
					trigger.focus({ preventScroll: true });
				else document.querySelector<HTMLElement>('[data-actions-trigger]')?.focus();
			});
		}
		hadDialog = open;
	});

	// §P3.3 - File intents (launchQueue, shareTarget, title, flush) delegated to
	// the ui/file-intents module. Top-level factory: the $effects (document title
	// + pagehide flush) register in the init scope.
	const fileIntents = createFileIntents({
		getFilesStore: () => filesStore,
		getHydrated: () => hydrated,
		// §2.11 - PWA shortcuts `?action=search` / `?action=palette`.
		onUiAction: (action) => (action === 'search' ? modals.openSearch() : modals.openPalette())
	});

	onMount(() => {
		keyboardStore.load();
		if (!browser) return;
		// The capture window has its own light surface and must not boot the
		// workspace, the editor, or the desktop shell.
		if (captureRequested) return;
		let disposeDesktop: (() => void) | undefined;
		let disposed = false;

		void (async () => {
			// §J1 - Request the persistent bucket AS EARLY AS POSSIBLE (before any IDB
			// write), to reduce the window during which the browser may evict
			// storage. Best-effort, fire-and-forget.
			void requestPersistentStorage();

			// §2.1 - Theme applied early (before loading files) to limit the flash
			// on light/system preferences.
			themeStore.load();
			aiStore.load();
			// Locale applied on mount (after hydration: the prerendered render and
			// the first client render are in English by default, no mismatch).
			i18n.load();
			const saved = readPreference('mdsh:sidebar');
			sidebarOpen = window.innerWidth >= 768 && saved !== 'closed';
			const savedMode = readPreference('mdsh:mode') as EditMode | null;
			if (savedMode === 'wysiwyg' || savedMode === 'source' || savedMode === 'read') {
				mode = savedMode;
			}
			editorWidth.loadPersistedWidth();
			prefs.loadPersistedPrefs();
			await filesStore.load();
			fileIntents.handleLaunchQueue();
			fileIntents.handleShareTarget();
			hydrated = true;

			// Desktop Complete: restore the saved local backup schedule.
			if (import.meta.env.VITE_EDITION === 'desktop') {
				void import('#lib/desktop-backup.js').then((module) =>
					module.startDesktopBackupScheduler()
				);
			}

			// §J1 - Preemptive warning if the quota is nearly reached (reading
			// `estimate`, after the load to reflect real usage). The persistent
			// bucket has already been requested at the top of onMount. Best-effort.
			void checkStoragePressure();

			// §P2.5 - Adaptive prefetch delegated to the ui/prefetch module.
			schedulePrefetch({
				getMode: () => mode,
				getFiles: () => filesStore.files
			});

			// §1.2 - Registers the SW + wires the "Reload" toast to updates.
			registerPwaUpdates();

			// §234 - the global capture shortcut stays unregistered unless the
			// user enabled it in Settings. The Web Light build has no capture code.
			if (IS_DESKTOP_EDITION) void captureSettings.applyStartup();

			// Desktop shell: native menu + argv / file-association open.
			const dispose = await initDesktopShell({
				onMenuAction: handleDesktopMenuAction,
				onOpenPaths: async (paths) => {
					try {
						return await filesStore.openPathsFromDesktop(paths);
					} catch (err) {
						reportError('open from desktop shell', err, {
							notifyUser: t('page.openFromDiskError')
						});
						throw err;
					}
				},
				onBeforeClose: () => filesStore.flushPendingAwait(),
				getLabels: () => ({
					file: t('desktopMenu.file'),
					edit: t('desktopMenu.edit'),
					newFile: t('desktopMenu.new'),
					open: t('desktopMenu.open'),
					save: t('desktopMenu.save'),
					saveAs: t('desktopMenu.saveAs'),
					saveToDisk: t('desktopMenu.saveToDisk'),
					exportMarkdown: t('desktopMenu.exportMarkdown'),
					exportPdf: t('desktopMenu.exportPdf'),
					exportHtml: t('desktopMenu.exportHtml'),
					exportZip: t('desktopMenu.exportZip'),
					settings: t('desktopMenu.settings')
				})
			});
			if (disposed) dispose();
			else disposeDesktop = dispose;
		})();

		return () => {
			disposed = true;
			disposeDesktop?.();
		};
	});

	$effect(() => {
		if (!hydrated) return;
		writePreference('mdsh:sidebar', sidebarOpen ? 'open' : 'closed');
		writePreference('mdsh:mode', mode);
	});

	function toggleSidebar() {
		sidebarOpen = !sidebarOpen;
	}

	function handleNew() {
		if (!canInteract) return;
		modals.openNewDocument();
	}
	async function handleCreate(
		kind: DocumentKind,
		options?: { language?: import('#lib/code/languages.js').CodeLanguageId; name?: string }
	) {
		try {
			await filesStore.createDocument(kind, options);
			modals.newDocumentOpen = false;
			if (window.innerWidth < 768) sidebarOpen = false;
			const type =
				kind === 'code'
					? 'documents.code'
					: kind === 'presentation'
						? 'documents.presentation'
						: 'documents.note';
			announceContext(t('documents.created', { type: t(type) }));
		} catch (error) {
			reportError('create document', error, { notifyUser: t('page.saveToDiskError') });
		}
	}

	// A user-created note opens in Edit with a ready caret, whatever the prior
	// mode. Existing notes keep the selected mode. The request is keyed by file
	// id because the visual editor mounts only after its lazy import.
	$effect(() => {
		const id = filesStore.newDocumentFocusId;
		if (!id) return;
		filesStore.newDocumentFocusId = null;
		if (!filesStore.files.some((file) => file.id === id)) return;
		if (kind === 'code') {
			mode = 'source';
			requestEditorFocus(id);
			return;
		}
		if (kind !== 'note') return;
		documentTool = null;
		mode = 'wysiwyg';
		requestEditorFocus(id);
	});

	async function handleCreateFromTemplate(templateId: string): Promise<void> {
		const document = await templatesStore.resolve(templateId);
		if (!document) return;
		// Keep the last keystroke of the outgoing document before the new one
		// replaces the active tab.
		filesStore.flushPending();
		filesStore.createNew(document.name, document.content, {
			focusEditor: document.kind === 'note',
			origin: 'template'
		});
		modals.newDocumentOpen = false;
		if (window.innerWidth < 768) sidebarOpen = false;
		announceContext(
			t('documents.created', {
				type: t(document.kind === 'presentation' ? 'documents.presentation' : 'documents.note')
			})
		);
	}

	function handleDemo() {
		if (!canInteract) return;
		void filesStore.loadDemo();
		sidebarOpen = true;
	}

	function presentationAction(action: string) {
		if (kind === 'presentation')
			window.dispatchEvent(new CustomEvent('mdsh:presentation-action', { detail: action }));
	}

	async function handleImport() {
		if (!canInteract) return;
		const diskLinkingAvailable = isDiskLinkingAvailable();
		const desktop = isDesktop();
		let createdCount = 0;
		let openThrew = false;
		if (diskLinkingAvailable) {
			try {
				const created = await filesStore.openFromDisk();
				createdCount = created.length;
				if (createdCount > 0 && window.innerWidth < 768) sidebarOpen = false;
			} catch (err) {
				// User cancellation (AbortError) is already absorbed in fsa/disk-tauri;
				// here it is a real failure (permission, security, read).
				openThrew = true;
				reportError('open from disk', err, {
					notifyUser: t('page.openFromDiskError')
				});
			}
		}
		// Desktop (incl. Chromium WebView on Windows): never fall through to
		// <input type="file"> - that path skips path-based disk links.
		// Cancellation ends the action; only an unavailable API uses the HTML picker.
		if (
			!shouldFallThroughToFileInput({
				diskLinkingAvailable,
				isDesktop: desktop,
				createdCount,
				openThrew
			})
		) {
			return;
		}
		fileInput?.click();
	}

	async function handleDesktopMenuAction(action: DesktopMenuAction) {
		if (
			!canInteract ||
			modals.anyOpen ||
			promptStore.open ||
			projectsOpen ||
			!!diskConflictStore.pending
		)
			return;
		if (
			kind === 'presentation' &&
			['export-md', 'export-html', 'export-pdf', 'save', 'save-as', 'save-disk'].includes(action)
		) {
			window.dispatchEvent(new CustomEvent('mdsh:presentation-action', { detail: action }));
			return;
		}
		switch (action) {
			case 'new':
				handleNew();
				break;
			case 'close-file':
				if (filesStore.activeId) filesStore.close(filesStore.activeId);
				break;
			case 'open':
				await handleImport();
				break;
			case 'save':
				await handleSave();
				break;
			case 'save-as':
				await handleSaveAs();
				break;
			case 'save-disk':
				await handleSaveToDisk();
				break;
			case 'export-md':
				handleExport();
				break;
			case 'export-pdf':
				await handleExportPDF();
				break;
			case 'export-html':
				await handleExportHTML();
				break;
			case 'export-zip':
				await handleExportAll();
				break;
			case 'settings':
				modals.openSettings();
				break;
		}
	}

	async function handleFileInput(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		if (!canInteract) {
			input.value = '';
			return;
		}
		if (!input.files || input.files.length === 0) return;
		const { created, skipped, failed } = await filesStore.importFiles(input.files);
		if (created.length > 0 && window.innerWidth < 768) sidebarOpen = false;
		// §#6 - User feedback on the import result: an unreadable file (read
		// rejected) is reported as an error, and the total absence of recognized
		// markdown (only .pdf/.docx/binaries) is notified so it does not look like
		// a bug. We distinguish the two cases.
		if (failed > 0) {
			notify.error(t('page.importFailed', { n: failed }));
		}
		if (created.length === 0 && failed === 0 && skipped > 0) {
			notify.info(t('page.importNoneRecognized'));
		}
		input.value = '';
	}

	function handleEditorChange(id: string, text: string) {
		const file = filesStore.library.find((entry) => entry.id === id);
		if (!file) return;
		const fileKind = documentKindForFile(file);
		if (fileKind === 'note' && documentKind(text) !== 'note') {
			notify.error(t('documents.noConversion'));
			return;
		}
		if (fileKind === 'note' || fileKind === 'code') filesStore.queueEditorContent(id, text);
	}

	// §C1 - WYSIWYG flush: explicitly writes to the file `id` provided by the
	// outgoing editor (!= current active file). Avoids losing the last keystroke
	// when switching tabs right after typing (Milkdown's markdownUpdated is
	// asynchronous). `updateContent` ignores identical content.
	function handleEditorFlush(id: string, markdown: string) {
		const file = filesStore.library.find((entry) => entry.id === id);
		if (!file) return;
		const fileKind = documentKindForFile(file);
		if (fileKind !== 'note' && fileKind !== 'code') return;
		if (fileKind === 'note' && documentKind(markdown) !== 'note') return;
		filesStore.updateContent(id, markdown);
	}

	function editorRevision(id: string) {
		return filesStore.documentRevision(id);
	}

	let rejectNextNative = false;

	function editorApplyChange(change: import('#lib/document-revisions.js').DocumentChange) {
		if (rejectNextNative) {
			rejectNextNative = false;
			return null;
		}
		return filesStore.applyDocumentChange(change);
	}

	function editorSnapshot(id: string) {
		return filesStore.documentSnapshot(id);
	}

	// Test-build-only seam for the deterministic native conflict E2E. The
	// compile-time flag removes this block from production.
	if (import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1' && typeof window !== 'undefined') {
		(window as unknown as { __mdshTest?: unknown }).__mdshTest = {
			forceNativeConflict(external: string, fileId?: string) {
				const id = fileId ?? filesStore.active?.id;
				if (!id) return false;
				const base = filesStore.documentRevision(id);
				if (!base) return false;
				const applied = filesStore.applyDocumentChange({
					base,
					edits: { kind: 'text' },
					readText: () => external
				});
				if (!applied) return false;
				rejectNextNative = true;
				return true;
			}
		};
	}

	function handleExport() {
		filesStore.exportActive();
	}

	// §#6 - Double-submission guards: a 2nd click (or shortcut) while an export /
	// disk save is in progress is ignored. Avoids two stacked print dialogs or
	// two ZIPs generated in parallel.
	let busyExport = $state(false);
	let busyDisk = $state(false);

	async function handleExportHTML() {
		if (busyExport) return;
		busyExport = true;
		try {
			await filesStore.exportActiveHTML();
		} finally {
			busyExport = false;
		}
	}

	async function handleExportPDF() {
		if (busyExport) return;
		busyExport = true;
		try {
			await filesStore.exportActivePDF();
		} finally {
			busyExport = false;
		}
	}

	async function handleExportAll() {
		if (busyExport) return;
		busyExport = true;
		try {
			await filesStore.exportAll();
		} finally {
			busyExport = false;
		}
	}

	async function handleSaveToDisk() {
		if (busyDisk) return;
		busyDisk = true;
		try {
			await filesStore.saveActiveToDisk();
		} catch (err) {
			reportError('save to disk', err, {
				notifyUser: t('page.saveToDiskError')
			});
		} finally {
			busyDisk = false;
		}
	}

	function openDocsCheckIssue(fileId: string, line: number): void {
		modals.docsCheckOpen = false;
		modals.handleOpenHit(fileId, line, '');
	}

	async function handleSave() {
		if (busyDisk) return;
		busyDisk = true;
		try {
			await filesStore.saveActive();
		} catch (err) {
			reportError('save document', err, { notifyUser: t('page.saveToDiskError') });
		} finally {
			busyDisk = false;
		}
	}

	async function handleSaveAs() {
		if (busyDisk) return;
		busyDisk = true;
		try {
			await filesStore.saveActiveAs();
		} catch (err) {
			reportError('save document as', err, { notifyUser: t('page.saveToDiskError') });
		} finally {
			busyDisk = false;
		}
	}

	function handleEditCopy() {
		const active = filesStore.active;
		if (active) filesStore.editCopy(active.id);
	}

	async function handleEditOriginal() {
		const active = filesStore.active;
		if (!active) return;
		try {
			await filesStore.editOriginal(active.id);
		} catch (err) {
			reportError('edit original', err, { notifyUser: t('page.openFromDiskError') });
		}
	}

	// Honors the pendingGoToHit as soon as SourceEditor is mounted in source mode.
	$effect(() => {
		if (mode !== 'source' || !pendingGoToHit) return;
		const ref = sourceEditorRef;
		if (!ref) return;
		if (ref.getFileId() !== filesStore.activeId) return;
		const { line, query } = pendingGoToHit;
		pendingGoToHit = null;
		ref.goToLine?.(line, query);
	});

	/** Keep visual find in the current mode. Source uses CodeMirror search and replace. */
	function openInFileSearch() {
		if (!filesStore.active || kind !== 'note') return;
		if (mode === 'source') {
			sourceEditorRef?.openSearch();
		} else {
			openDocumentTool('find');
		}
	}

	// Once in source mode AND with the component mounted, honors the intent to
	// open the search panel. If the component is still lazy-loading CodeMirror,
	// its own `openSearch()` method memorizes the request and runs it after mount.
	$effect(() => {
		if (mode !== 'source' || !pendingOpenSearch) return;
		const ref = sourceEditorRef;
		if (!ref) return;
		pendingOpenSearch = false;
		ref.openSearch();
	});

	// §P2.2 - Keyboard handler delegated to the ui/shortcuts module.
	// buildKeydownHandler is a pure function: no $effect, called top-level.
	const handleKeydown = buildKeydownHandler({
		onNew: handleNew,
		onImport: handleImport,
		onExport: handleExport,
		onExportPDF: handleExportPDF,
		onSave: handleSave,
		onSaveAs: handleSaveAs,
		onNavigateFile: (direction) => filesStore.navigateFile(direction),
		getMode: () => mode,
		setMode: (m) => void requestMode(m),
		onToggleSidebar: toggleSidebar,
		onOpenPalette: modals.openPalette,
		onOpenSearch: modals.openSearch,
		onOpenInFileSearch: openInFileSearch,
		onOpenSettings: modals.openSettings,
		onToggleFocus: () => {
			if (kind === 'note' && mode === 'read') prefs.toggleFocusMode();
		},
		onPresent: () => presentationAction('present'),
		getActiveId: () => filesStore.activeId,
		onClose: (id) => filesStore.close(id)
	});

	// §P2.4 - Drag & drop handlers delegated to the ui/image-drop module.
	// dragOver stays local: reactive template state (visual overlay).
	const { handleDrop, handleDragOver, handleDragLeave } = buildDropHandlers({
		store: filesStore,
		setDragOver: (v) => (dragOver = v)
	});

	function handleWindowKeydown(event: KeyboardEvent) {
		if (captureRequested) return;
		if (modals.anyOpen || promptStore.open || projectsOpen || diskConflictStore.pending) return;
		if (!canInteract) {
			if (
				!event.isComposing &&
				!event.altKey &&
				event.metaKey !== event.ctrlKey &&
				keyboardStore.match(event)
			) {
				event.preventDefault();
			}
			return;
		}
		handleKeydown(event);
	}

	function handleWindowDrag(event: DragEvent, handler: (event: DragEvent) => void | Promise<void>) {
		if (captureRequested || event.defaultPrevented) return;
		if (
			!canInteract ||
			modals.anyOpen ||
			promptStore.open ||
			projectsOpen ||
			diskConflictStore.pending
		) {
			// Keep file drops outside startup and modal workflows.
			event.preventDefault();
			dragOver = false;
			return;
		}
		void handler(event);
	}
</script>

<svelte:window
	bind:innerWidth={viewportWidth}
	onkeydown={handleWindowKeydown}
	ondrop={(event) => {
		// A child drop handler may call preventDefault before the event reaches the
		// window. Clear the overlay anyway so it never stays after a drop.
		dragOver = false;
		handleWindowDrag(event, handleDrop);
	}}
	ondragover={(event) => handleWindowDrag(event, handleDragOver)}
	ondragleave={(event) => {
		if (event.relatedTarget === null) dragOver = false;
		handleWindowDrag(event, handleDragLeave);
	}}
/>

{#if captureRequested}
	{#await loadQuickCapture() then module}
		{#if module}
			<module.default />
		{/if}
	{:catch _error}
		<div role="alert" class="fixed inset-0 z-[80] bg-bg p-6 text-fg">
			{t('capture.loadFailed')}
		</div>
	{/await}
{:else}
	<!-- §J1 - Blocking banner if IndexedDB is inaccessible at startup (private mode,
	 storage disabled). Without it, the app would show a misleading "no file"
	 screen, suggesting data loss. -->
	{#if filesStore.loadError}
		<div
			class="fixed inset-x-0 top-0 z-[70] flex items-center justify-center border-b border-danger bg-bg-1 px-4 py-2 text-center text-sm text-danger"
			role="alert"
		>
			<span>{filesStore.loadError}</span>
			<button
				type="button"
				class="ml-3 underline"
				data-testid="retry-storage"
				onclick={() => filesStore.retryLoad()}>{t('files.retryLoad')}</button
			>
		</div>
	{/if}

	<div
		inert={!canInteract ||
			(modals.anyOpen && !modals.presenting) ||
			promptStore.open ||
			projectsOpen ||
			!!diskConflictStore.pending}
		aria-busy={!hydrated}
		class="mdsh-shell flex h-[100dvh] w-full overflow-hidden bg-bg text-fg"
	>
		<div class="contents" inert={modals.presenting}>
			<Sidebar
				open={sidebarOpen}
				focusMode={prefs.focusMode && kind === 'note'}
				onClose={() => (sidebarOpen = false)}
				onNew={handleNew}
				onImport={handleImport}
				onOpenLibrary={modals.openLibrary}
				onOpenProjects={() => (projectsOpen = true)}
				onHome={() => filesStore.showHome()}
			/>
		</div>

		<div
			inert={sidebarOpen && viewportWidth < 768}
			class="mdsh-workspace flex min-w-0 flex-1 flex-col"
		>
			<div class="contents" inert={modals.presenting}>
				<Toolbar
					{kind}
					{mode}
					{sidebarOpen}
					onToggleSidebar={toggleSidebar}
					onSetMode={(m) => void requestMode(m)}
					onExport={handleExport}
					onExportPDF={handleExportPDF}
					onOpenPalette={modals.openPalette}
					onOpenActions={modals.openActions}
					onSave={handleSave}
					onSaveAs={handleSaveAs}
					onEditCopy={handleEditCopy}
					onEditOriginal={handleEditOriginal}
					onSaveToDisk={handleSaveToDisk}
					focusMode={prefs.focusMode}
					onToggleFocus={prefs.toggleFocusMode}
				/>
			</div>

			<!-- §P3.2 - The editing pane (3 modes + resize + drag + TOC) is delegated
		     to EditorPane.svelte to reduce the markup of +page.svelte. -->
			<main
				id="main"
				class="relative flex min-h-0 flex-1 flex-row"
				style:--editor-max-width="{editorWidth.editorMaxWidth}px"
				tabindex="-1"
			>
				<EditorPane
					{kind}
					libraryCount={filesStore.library.length}
					{documentTool}
					onCloseTool={() => {
						documentTool = null;
					}}
					activeFile={filesStore.active}
					{mode}
					{editorWidth}
					{modals}
					{dragOver}
					{tocEmpty}
					tocVisible={prefs.tocVisible}
					focusMode={prefs.focusMode}
					{articleRef}
					onSourceEditorRef={(ref) => (sourceEditorRef = ref)}
					onCodeEditorRef={(ref) => (codeEditorRef = ref)}
					onArticleRef={(el) => (articleRef = el)}
					onTocEmpty={(empty) => (tocEmpty = empty)}
					onEditorChange={handleEditorChange}
					onEditorFlush={handleEditorFlush}
					getRevision={editorRevision}
					applyChange={editorApplyChange}
					resyncSnapshot={editorSnapshot}
					onNew={handleNew}
					onImport={handleImport}
					onDemo={handleDemo}
				/>
			</main>

			<div class="contents" inert={modals.presenting}>
				<StatusBar {kind} onOpenSettings={modals.openSettings} />
			</div>
		</div>
	</div>

	{#if prefs.focusMode && kind === 'note'}
		<button
			inert={modals.anyOpen || promptStore.open || projectsOpen || !!diskConflictStore.pending}
			type="button"
			class="fixed top-2 right-2 z-[75] min-h-10 rounded border border-accent bg-bg-1 px-3 text-xs font-medium text-accent shadow-lg"
			onclick={prefs.toggleFocusMode}
		>
			{t('page.exitFocusMode')}
		</button>
	{/if}

	<ImportProgress
		blocked={modals.anyOpen || promptStore.open || projectsOpen || !!diskConflictStore.pending}
	/>

	{#if diskConflictStore.pending}
		{#await import('#lib/components/DiskConflictPanel.svelte') then module}
			<module.default />
		{:catch _error}
			<div role="alert" class="fixed inset-0 z-[80] bg-bg p-6 text-fg">
				{t('projects.operationFailed')}<button onclick={() => diskConflictStore.choose('cancel')}
					>{t('diskConflict.cancel')}</button
				>
			</div>
		{/await}
	{/if}

	{#if projectsOpen}
		{#await import('#lib/components/ProjectsPanel.svelte') then module}
			<module.default
				onClose={() => {
					projectsOpen = false;
					void tick().then(() =>
						document.querySelector<HTMLButtonElement>('[data-testid="projects-open"]')?.focus()
					);
				}}
				onOpenDocsCheck={(projectId) => modals.openDocsCheck(projectId)}
				onOpenDocsSite={(projectId) => modals.openDocsSite(projectId)}
			/>
		{:catch _error}
			<div role="alert" class="fixed inset-0 z-50 bg-bg p-6 text-fg">
				{t('projects.operationFailed')}
				<button onclick={() => (projectsOpen = false)}>{t('projects.close')}</button>
			</div>
		{/await}
	{/if}

	<!-- Live regions to announce mode switches to screen readers
	 (WCAG 4.1.3 Status Messages). A distinct region per mode so announcements
	 do not merge during a close switch. The text changes only when the
	 corresponding state toggles. -->
	<div class="sr-only" role="status" aria-live="polite">
		{#if hydrated}{prefs.focusMode ? t('page.focusModeOn') : t('page.focusModeOff')}{/if}
	</div>
	<div class="sr-only" role="status" aria-live="polite">
		{#if hydrated}{prefs.typewriterMode
				? t('page.typewriterModeOn')
				: t('page.typewriterModeOff')}{/if}
	</div>
	<!-- §B1.10 - 3rd region: announces the current editing mode (WYSIWYG / source /
	 reading). The text updates only when `mode` toggles. -->
	<div class="sr-only" role="status" aria-live="polite">
		{#if hydrated}{modeAnnounce}{/if}
	</div>
	<!-- §B2.2 - One-off contextual announcement (auto WYSIWYG->source switch via ⌘F,
	 etc.). Cleared 2s later so the announcement is not re-triggered on focus return. -->
	<div class="sr-only" role="status" aria-live="polite">{contextAnnounce}</div>

	<Toast />
	<SpinnerToast />
	{#if !modals.presenting && !modals.libraryOpen}<Toasts />{/if}

	<!-- §B1.3 - Singleton prompt/confirm modal, driven by `promptStore`.
     Replaces the native `window.prompt` / `window.confirm` (CommandPalette +
     WorkspacesPanel). Always mounted because it is lightweight; the component
     handles its own internal `{#if open}`. -->
	{#if promptStore.config}
		<PromptModal
			showNotices={modals.libraryOpen}
			open={promptStore.open}
			mode={promptStore.config.mode}
			title={promptStore.config.title}
			message={promptStore.config.message}
			defaultValue={promptStore.config.defaultValue}
			placeholder={promptStore.config.placeholder}
			confirmLabel={promptStore.config.confirmLabel}
			cancelLabel={promptStore.config.cancelLabel}
			alternateLabel={promptStore.config.alternateLabel}
			inputType={promptStore.config.inputType}
			danger={promptStore.config.danger}
			onResolve={(v) => promptStore.resolve(v)}
		/>
	{/if}

	<!-- §P3.1 - Mounting of lazy-loaded modals delegated to Modals.svelte.
     The open state and memoized loaders live in `modals` (createModals).
     Lazy-load is preserved: no modal bytes are pulled before the 1st opening. -->
	<Modals
		{kind}
		{mode}
		onCreate={handleCreate}
		onCreateFromTemplate={handleCreateFromTemplate}
		onOpenProperties={modals.openProperties}
		onOpenComments={modals.openComments}
		onOpenExportProfiles={modals.openExportProfiles}
		onOpenLinkedBlocks={modals.openLinkedBlocks}
		onOpenSemantic={modals.openSemantic}
		onOpenCollection={modals.openCollection}
		onOpenOutline={openOutline}
		{modals}
		{editorWidth}
		{prefs}
		onNew={handleNew}
		onImport={handleImport}
		onExport={handleExport}
		onExportHTML={handleExportHTML}
		onExportPDF={handleExportPDF}
		onExportAll={handleExportAll}
		onSave={handleSave}
		onSaveAs={handleSaveAs}
		onEditCopy={handleEditCopy}
		onEditOriginal={handleEditOriginal}
		onSaveToDisk={handleSaveToDisk}
		onToggleSidebar={toggleSidebar}
		onSetMode={(m) => void requestMode(m)}
		onOpenInFileSearch={openInFileSearch}
		onOpenDocsCheck={() => modals.openDocsCheck(filesStore.active?.projectId ?? null)}
		onOpenDocsSite={() => modals.openDocsSite(filesStore.active?.projectId ?? null)}
		onOpenDocsCheckIssue={openDocsCheckIssue}
		onOpenSnippets={() => openSnippetPanel()}
		onSaveSnippetSelection={() => {
			const capture = snippetCapture('selection');
			if (capture) openSnippetPanel(capture);
		}}
		onSaveSnippetFile={() => {
			const capture = snippetCapture('file');
			if (capture) openSnippetPanel(capture);
		}}
		onPresent={() => presentationAction('present')}
		onAdvancedSource={() => presentationAction('source')}
	/>

	<input
		bind:this={fileInput}
		type="file"
		accept=".md,.markdown,.mdx,.txt,text/markdown,text/plain"
		multiple
		class="hidden"
		onchange={handleFileInput}
	/>
{/if}
