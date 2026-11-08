<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { ChangeSet, Transaction } from '@codemirror/state';
	import type { EditorView } from '@codemirror/view';
	import { i18n, t } from '#lib/i18n/index.js';
	import { reportError } from '#lib/report.js';
	import { editorStateCache } from '#lib/editor-state.js';
	import { documentKind } from '#lib/document-kind.js';
	import { notify } from '#lib/notify.svelte.js';
	import type { SourceText } from '#lib/code/source-text.js';
	import { resolveRejectedNativeChange } from '#lib/code/native-adapter.js';
	import type {
		DocumentChange,
		DocumentRevision,
		DocumentSnapshot
	} from '#lib/document-revisions.js';

	interface Props {
		fileId: string;
		content: string;
		readonly?: boolean;
		fillContainer?: boolean;
		/** Code and plain-text documents skip the Markdown parser and guard. */
		plainText?: boolean;
		onChange: (markdown: string) => void;
		/** Writes the final accepted bytes to the outgoing file before detach. */
		onFlush?: (fileId: string, markdown: string) => void;
		/** Store authority for the next native change. */
		getRevision?: ((fileId: string) => DocumentRevision | null) | undefined;
		applyChange?: ((change: DocumentChange) => DocumentRevision | null) | undefined;
		resyncSnapshot?: ((fileId: string) => DocumentSnapshot | null) | undefined;
		onCursorLine?: (line: number) => void;
		onViewportLine?: (line: number) => void;
	}

	let {
		fileId,
		content,
		readonly = false,
		fillContainer = false,
		plainText = false,
		onChange,
		onFlush,
		getRevision,
		applyChange,
		resyncSnapshot,
		onCursorLine,
		onViewportLine
	}: Props = $props();
	export function getFileId(): string {
		return fileId;
	}

	/** Returns the selected text. The CodeMirror state keeps it after blur. */
	export function getSelectionText(): string {
		if (!view) return '';
		const { from, to } = view.state.selection.main;
		return from === to ? '' : view.state.sliceDoc(from, to);
	}

	/**
	 * Returns the accepted raw bytes for this mounted file. `revision` is local
	 * to the buffer; it is not a store generation. Callers must use `fileId`.
	 */
	export function getSnapshot(): { fileId: string; revision: number; text: string } | null {
		if (!view || !buffer) return null;
		if (!nativeActive()) flushPublish();
		return { fileId, revision: buffer.revision, text: buffer.getText() };
	}

	let host: HTMLDivElement;
	let view: EditorView | null = null;
	let lastEmitted = '';
	// Local compile-time instrumentation. A production build removes it, so the
	// boot budget does not include test counters.
	const SOURCE_METRICS = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';
	function sourceMark(name: string): void {
		if (SOURCE_METRICS) performance.mark(name);
	}
	function sourceMeasure<T>(name: string, run: () => T): T {
		if (!SOURCE_METRICS) return run();
		const startedAt = performance.now();
		try {
			return run();
		} finally {
			performance.measure(name, { start: startedAt, end: performance.now() });
		}
	}

	let applyingExternal = false;
	// Immutable raw bytes for the mounted document. Ordinary changes update this
	// buffer without scanning line endings or materializing the full string.
	let SourceTextImpl: typeof SourceText | null = null;
	let buffer: SourceText | null = null;
	let publishTimer: ReturnType<typeof setTimeout> | null = null;
	let lastPublishAt = Number.NEGATIVE_INFINITY;
	const PUBLISH_THROTTLE_MS = 150;
	// True when the last accepted source contains the presentation marker
	// substring. A marker-free note can only become a presentation by creating
	// that substring, which the fast path tests locally.
	let sourceHasPresentationMarker = false;
	// Candidate buffer that the change filter computed for an accepted risky
	// transaction. The update listener reuses it when the ChangeSet identity
	// matches, so one accepted risky change converts once.
	let pendingGuard: { changes: ChangeSet; buffer: SourceText | null } | null = null;
	// Store authority for the next native change. The buffer revision is a
	// separate, editor-local counter and is never used as this base.
	let acceptedBase: DocumentRevision | null = null;
	let nativeBlocked = false;
	function nativeCapable(): boolean {
		return Boolean(getRevision && applyChange && resyncSnapshot);
	}

	const PRESENTATION_MARKER = '<!-- mdsh-presentation';
	const MAX_GUARD_LINE = 4096;
	// A physical line above the guard limit suspends the Markdown parser, the
	// image-data decoration and line wrapping. Text, history, search and the
	// document-kind guard stay active.
	let degraded = false;
	let monitor: ReturnType<LongLineSupport['createLongLineMonitor']> | null = null;

	function createSourceText(source: string, doc: import('@codemirror/state').Text): SourceText {
		if (!SourceTextImpl) throw new Error('source text module is not loaded');
		return SourceTextImpl.create(source, doc);
	}

	function candidateBuffer(transaction: Transaction): SourceText {
		if (!buffer) return createSourceText(transaction.newDoc.toString(), transaction.newDoc);
		try {
			return buffer.apply(transaction.changes, transaction.newDoc);
		} catch {
			return createSourceText(transaction.newDoc.toString(), transaction.newDoc);
		}
	}

	function applyBufferChange(
		changes: ChangeSet,
		doc: import('@codemirror/state').Text
	): SourceText {
		if (!buffer) return createSourceText(doc.toString(), doc);
		try {
			return buffer.apply(changes, doc);
		} catch (error) {
			reportError('source buffer resync', error);
			return createSourceText(doc.toString(), doc);
		}
	}

	/** Materializes the captured raw bytes. Call only at a publication boundary. */
	function materialize(): string {
		if (!buffer) return lastEmitted;
		return SOURCE_METRICS
			? sourceMeasure('mdsh:source-change', () => buffer!.getText())
			: buffer.getText();
	}

	/** Publishes the latest accepted bytes to the existing string adapter. */
	function publish(): void {
		if (!buffer || !view) return;
		const text = materialize();
		if (text !== lastEmitted) {
			lastEmitted = text;
			sourceMark('mdsh:source-string-publish');
			onChange(text);
		}
	}

	/**
	 * Publishes the first change after a pause immediately, then coalesces a
	 * typing burst to one raw materialization per interval. Accepted changes
	 * still update the immutable buffer immediately.
	 */
	function schedulePublish(): void {
		if (publishTimer !== null) return;
		const wait = Math.max(0, PUBLISH_THROTTLE_MS - (performance.now() - lastPublishAt));
		publishTimer = setTimeout(() => {
			publishTimer = null;
			lastPublishAt = performance.now();
			publish();
		}, wait);
	}

	function cancelPublish(): void {
		if (publishTimer === null) return;
		clearTimeout(publishTimer);
		publishTimer = null;
	}

	/** Synchronous boundary: save, export, pagehide, detach or a public snapshot. */
	function flushPublish(): void {
		cancelPublish();
		publish();
	}

	/** Captures the outgoing file before detach. */
	function flushOutgoing(): void {
		if (!view || !buffer) return;
		// The native path already applied the latest accepted change to the store.
		// Do not publish a string or overwrite a blocked conflict.
		if (nativeActive()) return;
		cancelPublish();
		const text = materialize();
		const changed = text !== lastEmitted;
		lastEmitted = text;
		if (onFlush) onFlush(fileId, text);
		else if (changed) onChange(text);
	}

	function nativeActive(): boolean {
		return nativeCapable() && acceptedBase !== null;
	}

	/**
	 * Applies an accepted external snapshot as one bounded native change.
	 * CodeMirror maps selection, viewport, search and history through it.
	 */
	function applyExternalSource(text: string, cm: CMModule, current: EditorView): void {
		cancelPublish();
		lastEmitted = text;
		sourceHasPresentationMarker = text.includes(PRESENTATION_MARKER);
		pendingGuard = null;
		applyingExternal = true;
		try {
			const change = cm.patch(current.state, text);
			if (change) {
				current.dispatch({
					changes: change,
					annotations: cm.Transaction.addToHistory.of(false)
				});
			}
		} finally {
			applyingExternal = false;
		}
		buffer = createSourceText(text, current.state.doc);
	}

	/**
	 * A rejected native change must not be forced through a fresh base. Adopt an
	 * authoritative snapshot only when its captured text equals the previous
	 * accepted text. Otherwise keep the local work and stop publishing.
	 */
	function handleRejectedChange(
		previous: SourceText | null,
		accepted: SourceText,
		changes: ChangeSet,
		state: import('@codemirror/state').EditorState
	): void {
		if (!applyChange) {
			nativeBlocked = true;
			return;
		}
		const snapshot = resyncSnapshot?.(fileId) ?? null;
		const decision = resolveRejectedNativeChange(
			fileId,
			previous ? previous.getText() : '',
			snapshot
		);
		if (decision.kind === 'block') {
			nativeBlocked = true;
			sourceMark('mdsh:source-native-block');
			notify.error(t('documents.nativeConflict'));
			return;
		}
		acceptedBase = decision.revision;
		const next = applyChange({
			base: decision.revision,
			edits: { kind: 'codemirror', changes, state },
			readText: () => accepted.getText()
		});
		if (next) {
			acceptedBase = next;
			sourceMark('mdsh:source-native-resync');
			return;
		}
		nativeBlocked = true;
		sourceMark('mdsh:source-native-block');
		notify.error(t('documents.nativeConflict'));
	}

	/**
	 * Returns true when the change cannot alter the note/presentation boundary
	 * and does not need a full source rebuild. The check is deliberately
	 * conservative: marker, fence, and escape tokens, paste, drop, undo and
	 * redo, and every document that already contains the presentation marker
	 * still take the full validation path.
	 */
	function ordinarySourceChange(transaction: Transaction): boolean {
		if (sourceHasPresentationMarker) return false;
		if (
			transaction.isUserEvent('undo') ||
			transaction.isUserEvent('redo') ||
			transaction.isUserEvent('input.paste') ||
			transaction.isUserEvent('input.drop')
		)
			return false;
		const doc = transaction.startState.doc;
		let ordinary = true;
		transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
			if (!ordinary) return;
			const insertedText = inserted.sliceString(0, inserted.length, '\n');
			// A new marker, fence, or literal escape needs one of these tokens.
			// Refuse them in inserted text so two insertions in one transaction
			// cannot assemble a token that neither part contains alone.
			if (/[<!`~\\-]/.test(insertedText)) {
				ordinary = false;
				return;
			}
			const lineFrom = doc.lineAt(from).from;
			const lineTo = doc.lineAt(to).to;
			if (lineTo - lineFrom > MAX_GUARD_LINE) {
				ordinary = false;
				return;
			}
			const joined = doc.sliceString(lineFrom, from) + insertedText + doc.sliceString(to, lineTo);
			const fence = /^[ \t]{0,3}(?:`{3,}|~{3,})/m;
			// A deletion can join two line fragments into a marker or fence.
			// A change on an existing fence line can open or close a region.
			if (
				joined.includes('<!--') ||
				fence.test(joined) ||
				fence.test(doc.sliceString(lineFrom, lineTo))
			)
				ordinary = false;
		});
		return ordinary;
	}
	// Failure state of the CodeMirror lazy-load (chunk unavailable: first
	// offline opening, or stale PWA cache after deployment). Shows an in-place
	// message + a "Retry" button instead of a silent blank pane.
	let loadError = $state(false);
	// Buffer for opening the search panel: if the user triggers `⌘F`
	// while CodeMirror is still loading (lazy-load), we remember the
	// intent and open the panel as soon as `view` is ready.
	let pendingOpenSearch = false;
	// Typewriter mode: actively centers the caret line via a CodeMirror
	// Compartment (reconfigurable on the fly without recreating the EditorState).
	// Buffered if the value is set before the lazy-load completes.
	let pendingTypewriter = false;
	let typewriterCompartmentRef: import('@codemirror/state').Compartment | null = null;
	let localeCompartmentRef: import('@codemirror/state').Compartment | null = null;
	let activeCM: CMModule | null = null;
	let removeFlushListener: (() => void) | null = null;
	// Keep the guard outside the boot chunk. The source editor is statically
	// imported by the page, so the guard arrives with the lazy source bundle.
	type LongLineSupport = typeof import('../source-extensions');
	let longLineSupport: LongLineSupport | null = null;
	// Lazy charge tracker for the resident native history.
	let historyTracker: import('../editor-history-cache').HistoryTracker | null = null;

	/*
	 * CodeMirror is heavy (~150 KB). Lazy-loaded on the first mount of source
	 * mode to stay under the page chunk's size budget (60 KB gzip). All runtime
	 * imports are async; at the top of the file, only `type` imports are
	 * allowed (they are erased at build time).
	 */
	type CMModule = {
		EditorState: typeof import('@codemirror/state').EditorState;
		Transaction: typeof import('@codemirror/state').Transaction;
		Compartment: typeof import('@codemirror/state').Compartment;
		EditorView: typeof import('@codemirror/view').EditorView;
		keymap: typeof import('@codemirror/view').keymap;
		lineNumbers: typeof import('@codemirror/view').lineNumbers;
		highlightActiveLine: typeof import('@codemirror/view').highlightActiveLine;
		markdown: typeof import('@codemirror/lang-markdown').markdown;
		indentWithTab: typeof import('@codemirror/commands').indentWithTab;
		defaultKeymap: typeof import('@codemirror/commands').defaultKeymap;
		history: typeof import('@codemirror/commands').history;
		historyField: typeof import('@codemirror/commands').historyField;
		historyKeymap: typeof import('@codemirror/commands').historyKeymap;
		undo: typeof import('@codemirror/commands').undo;
		redo: typeof import('@codemirror/commands').redo;
		syntaxHighlighting: typeof import('@codemirror/language').syntaxHighlighting;
		defaultHighlightStyle: typeof import('@codemirror/language').defaultHighlightStyle;
		search: typeof import('@codemirror/search').search;
		openSearchPanel: typeof import('@codemirror/search').openSearchPanel;
		closeSearchPanel: typeof import('@codemirror/search').closeSearchPanel;
		searchKeymap: typeof import('@codemirror/search').searchKeymap;
		setSearchQuery: typeof import('@codemirror/search').setSearchQuery;
		SearchQuery: typeof import('@codemirror/search').SearchQuery;
		imageData: typeof import('../source-extensions').imageData;
		patch: typeof import('#lib/code/external-changes.js').externalDocumentChange;
		codeMirrorPhrases: typeof import('../source-extensions').codeMirrorPhrases;
		typewriterCentering: typeof import('../source-extensions').typewriterCentering;
		longLineStatus: typeof import('../source-extensions').longLineStatus;
		sourceTheme: typeof import('../source-extensions').sourceTheme;
		sourceLocaleExtensions: typeof import('../source-extensions').sourceLocaleExtensions;
		historyCache: import('../editor-history-cache').EditorHistoryCache;
		support: typeof import('../source-extensions');
		restoreHistoryState: typeof import('../editor-history-cache').restoreHistoryState;
		captureHistoryState: typeof import('../editor-history-cache').captureHistoryState;
	};

	function localeExtensions(cm: CMModule) {
		return [
			cm.sourceLocaleExtensions(t('editor.ariaLabel')),
			...(longLineSupport
				? [
						longLineSupport.sourceSupportExtensions(degraded, plainText, {
							markdown: cm.markdown,
							imageData: cm.imageData,
							longLineStatus: cm.longLineStatus,
							lineWrapping: cm.EditorView.lineWrapping
						})
					]
				: [])
		];
	}

	function reconfigureLocale() {
		if (!view || !activeCM || !localeCompartmentRef) return;
		const reopenSearch = activeCM.closeSearchPanel(view);
		view.dispatch({ effects: localeCompartmentRef.reconfigure(localeExtensions(activeCM)) });
		if (reopenSearch) activeCM.openSearchPanel(view);
	}

	let positionTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingSavedPosition: { anchor: number; head: number; scrollTop: number } | null = null;
	// The first mount reads the saved position. Ignore the view's initial
	// zero scroll and selection until the saved scroll is applied.
	let restoringPosition = false;
	let userInteracted = false;
	let lastPosition: { anchor: number; head: number; scrollTop: number } | null = null;

	function rememberPosition(): void {
		if (!view) return;
		const selection = view.state.selection.main;
		lastPosition = {
			anchor: selection.anchor,
			head: selection.head,
			scrollTop: view.scrollDOM.scrollTop
		};
	}

	function savePosition(): void {
		if (!view || restoringPosition) return;
		// A detached view reports zero selection and scroll. Keep the last
		// connected navigation point instead of erasing it during teardown.
		if (!view.scrollDOM.isConnected) {
			if (lastPosition) editorStateCache.setPosition(fileId, 'source', lastPosition);
			return;
		}
		// A deferred body mounts with empty content before hydration. Keep the
		// last real navigation point instead of overwriting it with offset 0.
		const previous = editorStateCache.getPosition(fileId, 'source');
		if (content.length === 0 && previous) return;
		const selection = view.state.selection.main;
		const scrollTop = view.scrollDOM.scrollTop;
		if (
			!userInteracted &&
			previous &&
			(previous.anchor > 0 || previous.head > 0 || previous.scrollTop > 0) &&
			selection.empty &&
			scrollTop === 0
		)
			return;
		lastPosition = { anchor: selection.anchor, head: selection.head, scrollTop };
		editorStateCache.setPosition(fileId, 'source', lastPosition);
	}

	function schedulePosition(): void {
		clearTimeout(positionTimer);
		positionTimer = setTimeout(savePosition, 100);
	}

	function saveSourceState(): void {
		if (!view || !activeCM || !historyTracker) return;
		clearTimeout(positionTimer);
		savePosition();
		if (content.length === 0 && editorStateCache.getPosition(fileId, 'source')) return;
		if (!nativeActive()) flushPublish();
		const cachedText = buffer ? buffer.getText() : lastEmitted;
		activeCM.historyCache.set(
			fileId,
			activeCM.captureHistoryState(view, activeCM.historyField, cachedText, historyTracker.bytes)
		);
	}

	let cmModulePromise: Promise<CMModule> | null = null;
	function loadCM(): Promise<CMModule> {
		if (!cmModulePromise) {
			cmModulePromise = (async () => {
				const [state, viewMod, lang, cmds, language, searchMod, editorHistory] = await Promise.all([
					import('@codemirror/state'),
					import('@codemirror/view'),
					import('../source-extensions'),
					import('@codemirror/commands'),
					import('@codemirror/language'),
					import('@codemirror/search'),
					import('../editor-history-cache')
				]);
				SourceTextImpl = lang.SourceText;
				return {
					EditorState: state.EditorState,
					imageData: lang.imageData,
					codeMirrorPhrases: lang.codeMirrorPhrases,
					typewriterCentering: lang.typewriterCentering,
					longLineStatus: lang.longLineStatus,
					sourceTheme: lang.sourceTheme,
					sourceLocaleExtensions: lang.sourceLocaleExtensions,
					Transaction: state.Transaction,
					Compartment: state.Compartment,
					EditorView: viewMod.EditorView,
					keymap: viewMod.keymap,
					lineNumbers: viewMod.lineNumbers,
					highlightActiveLine: viewMod.highlightActiveLine,
					markdown: lang.markdown,
					indentWithTab: cmds.indentWithTab,
					defaultKeymap: cmds.defaultKeymap,
					history: cmds.history,
					historyField: cmds.historyField,
					historyKeymap: cmds.historyKeymap,
					undo: cmds.undo,
					redo: cmds.redo,
					syntaxHighlighting: language.syntaxHighlighting,
					defaultHighlightStyle: language.HighlightStyle.define(
						language.defaultHighlightStyle.specs.map((spec) => {
							const colors: Record<string, string> = {
								'#404740': 'var(--syntax-comment)',
								'#708': 'var(--syntax-keyword)',
								'#219': 'var(--syntax-literal)',
								'#164': 'var(--syntax-string)',
								'#a11': 'var(--syntax-name)',
								'#e40': 'var(--syntax-number)',
								'#940': 'var(--syntax-comment)',
								'#f00': 'var(--color-danger)'
							};
							return {
								...spec,
								color:
									typeof spec.color === 'string'
										? (colors[spec.color] ?? 'var(--syntax-title)')
										: 'var(--color-fg)'
							};
						})
					),
					search: searchMod.search,
					openSearchPanel: searchMod.openSearchPanel,
					closeSearchPanel: searchMod.closeSearchPanel,
					searchKeymap: searchMod.searchKeymap,
					setSearchQuery: searchMod.setSearchQuery,
					SearchQuery: searchMod.SearchQuery,
					patch: lang.patch,
					historyCache: editorHistory.editorHistoryCache,
					support: lang,
					restoreHistoryState: editorHistory.restoreHistoryState,
					captureHistoryState: editorHistory.captureHistoryState
				};
			})();
		}
		return cmModulePromise;
	}

	async function mount() {
		if (!host) return;
		let cm: CMModule;
		try {
			cm = await loadCM();
			longLineSupport = cm.support;
			loadError = false;
		} catch (err) {
			// The chunk failed: we discard the memoized promise to allow a
			// retry, surface it to the user (consistent with Editor.svelte and
			// the "never a silent error" stance) and switch to the failure UI.
			cmModulePromise = null;
			loadError = true;
			reportError('source editor load (CodeMirror)', err, {
				notifyUser: t('source.loadErrorNotify')
			});
			return;
		}
		// Double-call protection (mount + onDestroy race possible on HMR / fast switch).
		if (view || !host) return;

		// Theme and phrases load with the CodeMirror chunk, not at boot.
		const theme = cm.sourceTheme();

		// The compartment removes the plugin and cancels its work without replacing history.
		// A physical line above the guard limit selects the reduced-aid layout.
		monitor = cm.support.createLongLineMonitor({
			initial: content,
			getDocument: () => view?.state.doc ?? null,
			onChange: (next) => {
				degraded = next;
				reconfigureLocale();
			}
		});
		degraded = monitor.initial;
		const typewriterCompartment = new cm.Compartment();
		typewriterCompartmentRef = typewriterCompartment;
		const localeCompartment = new cm.Compartment();
		localeCompartmentRef = localeCompartment;
		const extensions = [
			cm.EditorView.domEventHandlers({
				beforeinput: (event, currentView) => {
					if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return false;
					event.preventDefault();
					(event.inputType === 'historyUndo' ? cm.undo : cm.redo)(currentView);
					return true;
				},
				focus: (_event, focusedView) => {
					// Synchronize the native selection before immediate text input.
					focusedView.focus();
				}
			}),
			cm.lineNumbers(),
			cm.highlightActiveLine(),
			cm.history(),
			cm.syntaxHighlighting(cm.defaultHighlightStyle, { fallback: true }),
			// `search()` adds the state fields + the panel widget. The
			// keymap is merged into the `keymap.of()` below (mod-f ->
			// openSearchPanel, F3 -> findNext, etc.).
			cm.search({ top: false }),
			cm.keymap.of([
				cm.indentWithTab,
				...cm.searchKeymap,
				...cm.defaultKeymap,
				...cm.historyKeymap
			]),
			localeCompartment.of(localeExtensions(cm)),
			cm.EditorView.editable.of(!readonly),
			cm.EditorState.readOnly.of(readonly),
			cm.EditorState.changeFilter.of((transaction) => {
				if (plainText || !transaction.docChanged || applyingExternal) return true;
				if (ordinarySourceChange(transaction)) {
					sourceMark('mdsh:source-guard-fast');
					pendingGuard = null;
					return true;
				}
				// Risky change: validate a candidate buffer without mutating the
				// accepted one. Only this guarded path materializes raw text.
				const candidate = candidateBuffer(transaction);
				const source = SOURCE_METRICS
					? sourceMeasure('mdsh:source-guard', () => candidate.getText())
					: candidate.getText();
				if (documentKind(source) === 'note') {
					sourceHasPresentationMarker = source.includes(PRESENTATION_MARKER);
					pendingGuard = { changes: transaction.changes, buffer: candidate };
					return true;
				}
				pendingGuard = null;
				notify.error(t('documents.noConversion'));
				// Reject the change before the document, history, or saved source can diverge.
				return false;
			}),
			cm.EditorView.updateListener.of((update) => {
				if (update.docChanged && !applyingExternal) {
					monitor?.track(update.state.doc, update.changes);
				}
				if (update.selectionSet || update.docChanged) {
					rememberPosition();
					schedulePosition();
					onCursorLine?.(update.state.doc.lineAt(update.state.selection.main.head).number);
				}
				if (update.viewportChanged || update.docChanged) {
					onViewportLine?.(update.state.doc.lineAt(update.view.viewport.from).number);
				}
				if (update.docChanged && !applyingExternal) {
					const cached = pendingGuard;
					pendingGuard = null;
					const previous = buffer;
					if (cached?.changes === update.changes && cached.buffer) {
						buffer = cached.buffer;
						sourceMark('mdsh:source-change-reuse');
					} else {
						buffer = applyBufferChange(update.changes, update.state.doc);
						sourceMark('mdsh:source-buffer-apply');
					}
					if (nativeActive() && applyChange) {
						if (!nativeBlocked) {
							const accepted = buffer!;
							const next = applyChange({
								base: acceptedBase!,
								edits: { kind: 'codemirror', changes: update.changes, state: update.state },
								readText: () => accepted.getText()
							});
							if (next) {
								acceptedBase = next;
								sourceMark('mdsh:source-native-apply');
							} else {
								sourceMark('mdsh:source-native-reject');
								handleRejectedChange(previous, accepted, update.changes, update.state);
							}
						}
					} else {
						schedulePublish();
					}
				}
			}),
			typewriterCompartment.of(pendingTypewriter ? [cm.typewriterCentering()] : []),
			theme
		];
		const cached = cm.historyCache.get(fileId);
		const savedPosition = editorStateCache.getPosition(fileId, 'source');
		// A deferred body mounts empty before its exact text arrives. Applying a
		// saved offset to that empty document would collapse the selection.
		pendingSavedPosition = content.length === 0 ? (savedPosition ?? null) : null;
		restoringPosition = Boolean(savedPosition || pendingSavedPosition);
		const restored = cm.restoreHistoryState({
			EditorState: cm.EditorState,
			historyField: cm.historyField,
			content,
			cached,
			savedPosition: pendingSavedPosition ? undefined : savedPosition,
			extensions
		});
		const startState = restored.state;
		historyTracker = restored.tracker;

		view = new cm.EditorView({
			state: startState,
			parent: host,
			// Render the restored selection before the first focus or input event.
			...(savedPosition
				? { scrollTo: cm.EditorView.scrollIntoView(startState.selection.main.head) }
				: {})
		});
		view.scrollDOM.tabIndex = 0;
		view.contentDOM.addEventListener('pointerdown', () => (userInteracted = true));
		view.contentDOM.addEventListener('keydown', () => (userInteracted = true));
		view.contentDOM.addEventListener('focus', () => {
			restoringPosition = false;
			userInteracted = true;
			const saved = editorStateCache.getPosition(fileId, 'source');
			if (saved && view) {
				const length = view.state.doc.length;
				const anchor = Math.min(saved.anchor, length);
				const head = Math.min(saved.head, length);
				// Re-sync only the restored position. A deliberate navigation
				// (outline, search, undo) already moved the selection.
				const main = view.state.selection.main;
				const restored = main.anchor === anchor && main.head === head;
				const untouched = main.empty && main.from === 0 && (anchor > 0 || head > 0);
				if (restored || untouched) {
					view.dispatch({
						selection: { anchor, head },
						effects: view.scrollDOM.scrollTop === 0 ? cm.EditorView.scrollIntoView(head) : []
					});
				}
			}
			view?.focus();
		});
		view.scrollDOM.addEventListener('scroll', schedulePosition, { passive: true });
		activeCM = cm;
		onCursorLine?.(view.state.doc.lineAt(view.state.selection.main.head).number);
		onViewportLine?.(view.state.doc.lineAt(view.viewport.from).number);
		lastEmitted = content;
		buffer = createSourceText(content, view.state.doc);
		sourceHasPresentationMarker = content.includes(PRESENTATION_MARKER);
		acceptedBase = nativeCapable() ? (getRevision?.(fileId) ?? null) : null;
		nativeBlocked = false;
		const flushListener = (event: Event) => {
			if (nativeActive()) {
				if (nativeBlocked) {
					event.preventDefault();
					notify.error(t('documents.nativeConflict'));
				}
				return;
			}
			flushPublish();
		};
		window.addEventListener('mdsh:flush-editor', flushListener);
		removeFlushListener = () => window.removeEventListener('mdsh:flush-editor', flushListener);
		if (savedPosition?.scrollTop) {
			const mountedView = view;
			mountedView.requestMeasure({
				read: (measuredView) =>
					Math.max(0, measuredView.scrollDOM.scrollHeight - measuredView.scrollDOM.clientHeight),
				write: (maxScrollTop, measuredView) => {
					if (view !== mountedView || measuredView !== mountedView) return;
					measuredView.scrollDOM.scrollTop = Math.min(savedPosition.scrollTop, maxScrollTop);
					restoringPosition = false;
				}
			});
		} else {
			restoringPosition = false;
		}

		// Honor a request to open the search panel issued before the lazy-load
		// completed (typical case: WYSIWYG -> source switch via ⌘F).
		if (pendingOpenSearch) {
			pendingOpenSearch = false;
			cm.openSearchPanel(view);
		}
		// §B3.7 - Honor a buffered goToLine (SearchPanel hit click during lazy-load).
		if (pendingGoTo) {
			const { line, query } = pendingGoTo;
			pendingGoTo = null;
			pendingSavedPosition = null;
			restoringPosition = false;
			const doc = view.state.doc;
			const safeLine = Math.max(1, Math.min(doc.lines, line));
			const target = doc.line(safeLine);
			view.dispatch({
				selection: { anchor: target.from },
				effects: cm.EditorView.scrollIntoView(target.from, { y: 'center' })
			});
			if (query) {
				view.dispatch({
					effects: cm.setSearchQuery.of(new cm.SearchQuery({ search: query }))
				});
				cm.openSearchPanel(view);
			}
		}
		pendingTypewriter = false;
	}

	/*
	 * Sync external content -> editor (tab switch, undo store, etc.).
	 * We keep `lastEmitted` to avoid update loops. A minimal change keeps the
	 * native selection, viewport anchors, search ranges and history mapping.
	 */
	$effect(() => {
		const c = content;
		monitor?.external(c);
		if (!view || !activeCM) return;
		if (nativeActive()) {
			// A blocked conflict keeps the rejected local work. Do not replace it.
			if (nativeBlocked) return;
			const canonical = getRevision?.(fileId) ?? null;
			if (
				canonical &&
				acceptedBase &&
				canonical.fileId === acceptedBase.fileId &&
				canonical.generation === acceptedBase.generation
			) {
				// Own echo: the store published our accepted revision. Adopt its
				// already-materialized text without replacing the document.
				lastEmitted = c;
				return;
			}
			if (c === lastEmitted) return;
			// True external change: apply a bounded patch from the canonical revision.
			acceptedBase = canonical;
		} else if (c === lastEmitted) {
			return;
		}
		applyExternalSource(c, activeCM, view);
		const pending = pendingSavedPosition;
		if (pending) {
			pendingSavedPosition = null;
			const length = view.state.doc.length;
			const anchor = Math.min(pending.anchor, length);
			const head = Math.min(pending.head, length);
			view.dispatch({
				selection: { anchor, head },
				effects: activeCM.EditorView.scrollIntoView(head)
			});
			if (pending.scrollTop) {
				view.requestMeasure({
					read: (measuredView) =>
						Math.max(0, measuredView.scrollDOM.scrollHeight - measuredView.scrollDOM.clientHeight),
					write: (maxScrollTop, measuredView) => {
						measuredView.scrollDOM.scrollTop = Math.min(pending.scrollTop, maxScrollTop);
					}
				});
			}
		}
	});

	$effect(() => {
		void i18n.locale;
		reconfigureLocale();
	});

	onMount(() => {
		mount();
	});

	onDestroy(() => {
		clearTimeout(positionTimer);
		flushOutgoing();
		monitor?.dispose();
		monitor = null;
		saveSourceState();
		removeFlushListener?.();
		removeFlushListener = null;
		view?.destroy();
		view = null;
		buffer = null;
		cancelPublish();
		activeCM = null;
		typewriterCompartmentRef = null;
		localeCompartmentRef = null;
	});

	// Retry after a lazy-load failure ("Retry" button).
	function retryMount(): void {
		loadError = false;
		cmModulePromise = null;
		void mount();
	}

	/**
	 * Public method exposed via `bind:this`: opens CodeMirror's search/replace
	 * panel. If the editor is not yet mounted (lazy-load in progress), the
	 * intent is remembered and executed at the end of `mount()`.
	 */
	export function openSearch(): void {
		if (view) {
			void loadCM()
				.then((cm) => {
					if (view) cm.openSearchPanel(view);
				})
				.catch((err) => reportError('open source-editor search', err));
		} else {
			pendingOpenSearch = true;
		}
	}

	// §B3.7 - Buffer for `goToLine` called during the lazy-load (typical case:
	// cross-file SearchPanel -> switch to a not-yet-mounted file).
	let pendingGoTo: { line: number; query: string } | null = null;

	/**
	 * §B3.7 - Scrolls to a 1-indexed line and optionally prefills CodeMirror's
	 * search panel with the query. Used by SearchPanel (cross-file search)
	 * after switching to source mode: lets the hit be materialized in the
	 * editor without having to redo the search.
	 *
	 * If the component is not yet mounted (lazy), the intent is buffered
	 * and applied at the end of `mount()`.
	 */
	export function goToLine(line: number, query?: string): void {
		pendingSavedPosition = null;
		restoringPosition = false;
		if (!view) {
			pendingGoTo = { line, query: query ?? '' };
			return;
		}
		void loadCM()
			.then((cm) => {
				if (!view) return;
				const doc = view.state.doc;
				const safeLine = Math.max(1, Math.min(doc.lines, line));
				const target = doc.line(safeLine);
				view.dispatch({
					selection: { anchor: target.from },
					effects: cm.EditorView.scrollIntoView(target.from, { y: 'center' })
				});
				if (query) {
					view.dispatch({
						effects: cm.setSearchQuery.of(new cm.SearchQuery({ search: query }))
					});
					cm.openSearchPanel(view);
				}
				view.focus();
			})
			.catch((err) => reportError('navigate to line (source editor)', err));
	}

	/** Scrolls to a source line without changing the document or undo history. */
	export function scrollToLine(line: number, focus = false): void {
		pendingSavedPosition = null;
		restoringPosition = false;
		if (!view) {
			pendingGoTo = { line, query: '' };
			return;
		}
		void loadCM()
			.then((cm) => {
				if (!view) return;
				const doc = view.state.doc;
				const safeLine = Math.max(1, Math.min(doc.lines, line));
				const target = doc.line(safeLine);
				view.dispatch({
					effects: cm.EditorView.scrollIntoView(target.from, { y: 'start' })
				});
				if (focus) view.focus();
			})
			.catch((err) => reportError('scroll source editor', err));
	}

	/**
	 * Public method exposed via `bind:this`: enables or disables typewriter
	 * mode (active centering of the caret line). Uses a Compartment to
	 * dynamically reconfigure the extension without recreating the EditorState
	 * (preserves history, selection, scroll). If the editor is not yet
	 * mounted, stores the state to apply after mount.
	 */
	export function setTypewriter(active: boolean): void {
		if (!view) {
			pendingTypewriter = active;
			return;
		}
		void loadCM()
			.then((cm) => {
				if (!view || !typewriterCompartmentRef) return;
				const ext = active ? [cm.typewriterCentering()] : [];
				view.dispatch({
					effects: typewriterCompartmentRef.reconfigure(ext)
				});
			})
			.catch((err) => reportError('typewriter mode (source editor)', err));
	}
</script>

<svelte:window onpagehide={saveSourceState} />

<div
	bind:this={host}
	class="mdsh-source-cm"
	class:fill-container={fillContainer}
	data-testid="mdsh-source"
>
	{#if loadError}
		<div class="mdsh-source-error" role="alert">
			<p>{t('source.loadErrorTitle')}</p>
			<p class="mdsh-source-error-hint">
				{t('source.loadErrorHint')}
			</p>
			<button type="button" onclick={retryMount}>{t('source.retry')}</button>
		</div>
	{/if}
</div>

<style>
	.mdsh-source-cm {
		display: block;
		width: 100%;
		height: 100%;
		max-width: var(--editor-max-width, 820px);
		margin: 0 auto;
		overflow: hidden;
		/* Isolates resize reflows (cf. milkdown.css). */
		contain: layout style;
	}
	.mdsh-source-cm.fill-container {
		max-width: none;
		margin: 0;
	}
	.mdsh-source-error {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		align-items: flex-start;
		max-width: 38rem;
		margin: 3rem auto;
		padding: 1.25rem 1.5rem;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-bg-1);
		color: var(--color-fg);
	}
	.mdsh-source-error-hint {
		color: var(--color-fg-dim);
		font-size: 0.9em;
	}
	.mdsh-source-error button {
		padding: 0.35rem 0.9rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-bg-2);
		color: var(--color-fg);
		cursor: pointer;
	}
	.mdsh-source-error button:hover {
		border-color: var(--color-accent);
	}
	.mdsh-source-cm :global(.mdsh-long-line-status) {
		padding: 0.35rem 0.65rem;
		border-bottom: 1px solid var(--color-border);
		background: color-mix(in oklab, var(--color-warning, #d19a66) 12%, transparent);
		color: var(--color-warning, #d19a66);
		font: 500 12px/1.4 var(--font-mono);
	}
	.mdsh-source-cm :global(.cm-editor) {
		height: 100%;
		outline: none;
	}
	.mdsh-source-cm :global(.cm-editor.cm-focused) {
		outline: none;
	}
	/* The inner scroller carries the scroll, not the wrapper - otherwise the line-numbers drift. */
	.mdsh-source-cm :global(.cm-scroller) {
		-webkit-font-smoothing: antialiased;
		-moz-osx-font-smoothing: grayscale;
	}
	/* Markdown tokens - muted colors aligned with the dark theme. */
	.mdsh-source-cm :global(.cm-line) {
		padding-inline: 0;
	}
	.mdsh-source-cm :global(.tok-heading1),
	.mdsh-source-cm :global(.tok-heading2),
	.mdsh-source-cm :global(.tok-heading3),
	.mdsh-source-cm :global(.tok-heading4),
	.mdsh-source-cm :global(.tok-heading5),
	.mdsh-source-cm :global(.tok-heading6) {
		color: var(--color-fg);
		font-weight: 600;
	}
	@media (max-width: 640px) {
		.mdsh-source-cm :global(.cm-content) {
			padding: 1.25rem 1rem 30vh !important;
		}
	}
</style>
