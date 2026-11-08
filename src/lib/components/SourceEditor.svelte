<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { ChangeSet, Transaction } from '@codemirror/state';
	import type { EditorView } from '@codemirror/view';
	import { i18n, t } from '#lib/i18n/index.js';
	import { reportError } from '#lib/report.js';
	import { editorStateCache, type EditorPosition } from '#lib/editor-state.js';
	import { documentKind } from '#lib/document-kind.js';
	import { notify } from '#lib/notify.svelte.js';
	import { SourceText } from '#lib/code/source-text.js';

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
		flushPublish();
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
	let buffer: SourceText | null = null;
	let publishFrame: number | null = null;
	// True when the last accepted source contains the presentation marker
	// substring. A marker-free note can only become a presentation by creating
	// that substring, which the fast path tests locally.
	let sourceHasPresentationMarker = false;
	// Candidate buffer that the change filter computed for an accepted risky
	// transaction. The update listener reuses it when the ChangeSet identity
	// matches, so one accepted risky change converts once.
	let pendingGuard: { changes: ChangeSet; buffer: SourceText | null } | null = null;

	const PRESENTATION_MARKER = '<!-- mdsh-presentation';
	const MAX_GUARD_LINE = 4096;

	function candidateBuffer(transaction: Transaction): SourceText {
		if (!buffer) return SourceText.create(transaction.newDoc.toString(), transaction.newDoc);
		try {
			return buffer.apply(transaction.changes, transaction.newDoc);
		} catch {
			return SourceText.create(transaction.newDoc.toString(), transaction.newDoc);
		}
	}

	function applyBufferChange(
		changes: ChangeSet,
		doc: import('@codemirror/state').Text
	): SourceText {
		if (!buffer) return SourceText.create(doc.toString(), doc);
		try {
			return buffer.apply(changes, doc);
		} catch (error) {
			reportError('source buffer resync', error);
			return SourceText.create(doc.toString(), doc);
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
			onChange(text);
		}
	}

	/**
	 * Coalesces ordinary publication to one raw materialization per animation
	 * frame. Accepted changes still update the immutable buffer immediately.
	 */
	function schedulePublish(): void {
		if (publishFrame !== null || typeof requestAnimationFrame !== 'function') return;
		publishFrame = requestAnimationFrame(() => {
			publishFrame = null;
			publish();
		});
	}

	function cancelPublish(): void {
		if (publishFrame === null) return;
		if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(publishFrame);
		publishFrame = null;
	}

	/** Synchronous boundary: save, export, pagehide, detach or a public snapshot. */
	function flushPublish(): void {
		cancelPublish();
		publish();
	}

	/** Captures the outgoing file before detach. */
	function flushOutgoing(): void {
		if (!view || !buffer) return;
		cancelPublish();
		const text = materialize();
		const changed = text !== lastEmitted;
		lastEmitted = text;
		if (onFlush) onFlush(fileId, text);
		else if (changed) onChange(text);
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
		codeMirrorPhrases: typeof import('../source-extensions').codeMirrorPhrases;
		typewriterCentering: typeof import('../source-extensions').typewriterCentering;
	};

	function localeExtensions(cm: CMModule) {
		return [
			cm.EditorState.phrases.of(cm.codeMirrorPhrases()),
			cm.imageData(),
			cm.EditorView.contentAttributes.of({ 'aria-label': t('editor.ariaLabel') })
		];
	}

	function safePosition(position: EditorPosition | undefined, documentLength: number) {
		if (!position) return undefined;
		return {
			anchor: Math.min(position.anchor, documentLength),
			head: Math.min(position.head, documentLength)
		};
	}

	function saveSourceState(): void {
		if (!view || !activeCM) return;
		flushPublish();
		const selection = view.state.selection.main;
		editorStateCache.setSourceState(
			fileId,
			{
				content: lastEmitted,
				state: view.state.toJSON({ history: activeCM.historyField })
			},
			{
				anchor: selection.anchor,
				head: selection.head,
				scrollTop: view.scrollDOM.scrollTop
			}
		);
	}

	let cmModulePromise: Promise<CMModule> | null = null;
	function loadCM(): Promise<CMModule> {
		if (!cmModulePromise) {
			cmModulePromise = (async () => {
				const [state, viewMod, lang, cmds, language, searchMod] = await Promise.all([
					import('@codemirror/state'),
					import('@codemirror/view'),
					import('../source-extensions'),
					import('@codemirror/commands'),
					import('@codemirror/language'),
					import('@codemirror/search')
				]);
				return {
					EditorState: state.EditorState,
					imageData: lang.imageData,
					codeMirrorPhrases: lang.codeMirrorPhrases,
					typewriterCentering: lang.typewriterCentering,
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
					SearchQuery: searchMod.SearchQuery
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

		// Minimal theme inheriting the project's CSS vars (cf. app.css).
		const theme = cm.EditorView.theme({
			'&': {
				height: '100%',
				fontSize: '14.5px',
				fontFamily: 'var(--font-mono)',
				backgroundColor: 'transparent',
				color: 'var(--color-fg)'
			},
			'.cm-scroller': {
				fontFamily: 'var(--font-mono)',
				lineHeight: '1.7',
				overflow: 'auto'
			},
			'.cm-content': {
				padding: '2rem 5vw 15vh',
				caretColor: 'var(--color-accent)'
			},
			'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
			'.cm-gutters': {
				backgroundColor: 'transparent',
				color: 'var(--color-fg-dim)',
				border: 'none'
			},
			'.cm-activeLine': {
				backgroundColor: 'color-mix(in oklab, var(--color-accent) 5%, transparent)',
				boxShadow: 'inset 1px 0 var(--color-accent-dim)'
			},
			'.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-fg)' },
			'.mdsh-image-data': {
				font: 'inherit',
				color: 'var(--color-fg-muted)',
				backgroundColor: 'var(--color-bg-2)',
				border: '1px solid var(--color-border)',
				borderRadius: '4px',
				padding: '0 0.4em',
				cursor: 'pointer'
			},
			'.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
				backgroundColor: 'rgba(127,127,127,0.25)'
			},
			// Override the native styling of the search/replace panel so it
			// matches the project's dark theme (by default CM uses
			// white/light gray, hard to read on a dark background).
			'.cm-panels': {
				backgroundColor: 'var(--color-bg-1)',
				color: 'var(--color-fg)',
				borderTop: '1px solid var(--color-border)'
			},
			'.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--color-border)' },
			'.cm-panels.cm-panels-top': {
				borderTop: 'none',
				borderBottom: '1px solid var(--color-border)'
			},
			'.cm-search': { padding: '6px 8px' },
			'.cm-search input': {
				backgroundColor: 'var(--color-bg-2)',
				color: 'var(--color-fg)',
				border: '1px solid var(--color-border)',
				borderRadius: '1px',
				padding: '2px 6px'
			},
			'.cm-search input:focus': {
				outline: 'none',
				borderColor: 'var(--color-accent)'
			},
			'.cm-search button': {
				backgroundColor: 'transparent',
				color: 'var(--color-fg-muted)',
				border: '1px solid var(--color-border)',
				borderRadius: '1px',
				padding: '2px 8px',
				marginLeft: '4px',
				cursor: 'pointer'
			},
			'.cm-search button:hover': { color: 'var(--color-fg)' },
			'.cm-search label': { color: 'var(--color-fg-dim)', fontSize: '12px' },
			'.cm-search br': { display: 'none' }
		});

		// The compartment removes the plugin and cancels its work without replacing history.
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
			...(plainText ? [] : [cm.markdown()]),
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
			cm.EditorView.lineWrapping,
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
				if (update.selectionSet || update.docChanged) {
					onCursorLine?.(update.state.doc.lineAt(update.state.selection.main.head).number);
				}
				if (update.viewportChanged || update.docChanged) {
					onViewportLine?.(update.state.doc.lineAt(update.view.viewport.from).number);
				}
				if (update.docChanged && !applyingExternal) {
					const cached = pendingGuard;
					pendingGuard = null;
					if (cached?.changes === update.changes && cached.buffer) {
						buffer = cached.buffer;
						sourceMark('mdsh:source-change-reuse');
					} else {
						buffer = applyBufferChange(update.changes, update.state.doc);
						sourceMark('mdsh:source-buffer-apply');
					}
					schedulePublish();
				}
			}),
			typewriterCompartment.of(pendingTypewriter ? [cm.typewriterCentering()] : []),
			theme
		];
		const cached = editorStateCache.getSourceState(fileId);
		const savedPosition = editorStateCache.getPosition(fileId, 'source');
		let startState: import('@codemirror/state').EditorState | undefined;
		if (cached?.content === content) {
			try {
				startState = cm.EditorState.fromJSON(
					cached.state,
					{ extensions },
					{ history: cm.historyField }
				);
			} catch {
				// Ignore an incompatible cache after a dependency update.
			}
		}
		const initialSelection = safePosition(savedPosition, content.length);
		startState ??= cm.EditorState.create({
			doc: content,
			extensions,
			...(initialSelection ? { selection: initialSelection } : {})
		});

		view = new cm.EditorView({
			state: startState,
			parent: host,
			// Render the restored selection before the first focus or input event.
			...(savedPosition
				? { scrollTo: cm.EditorView.scrollIntoView(startState.selection.main.head) }
				: {})
		});
		view.scrollDOM.tabIndex = 0;
		view.scrollDOM.addEventListener('focus', () => view?.focus());
		activeCM = cm;
		onCursorLine?.(view.state.doc.lineAt(view.state.selection.main.head).number);
		onViewportLine?.(view.state.doc.lineAt(view.viewport.from).number);
		lastEmitted = content;
		buffer = SourceText.create(content, view.state.doc);
		sourceHasPresentationMarker = content.includes(PRESENTATION_MARKER);
		const flushListener = () => flushPublish();
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
				}
			});
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
	 * We keep `lastEmitted` to avoid update loops.
	 */
	$effect(() => {
		const c = content;
		if (view && activeCM && c !== lastEmitted) {
			cancelPublish();
			lastEmitted = c;
			sourceHasPresentationMarker = c.includes(PRESENTATION_MARKER);
			pendingGuard = null;
			applyingExternal = true;
			try {
				view.dispatch({
					changes: { from: 0, to: view.state.doc.length, insert: c },
					annotations: activeCM.Transaction.addToHistory.of(false)
				});
			} finally {
				applyingExternal = false;
			}
			buffer = SourceText.create(c, view.state.doc);
		}
	});

	$effect(() => {
		void i18n.locale;
		const currentView = view;
		const cm = activeCM;
		const compartment = localeCompartmentRef;
		if (!currentView || !cm || !compartment) return;
		const reopenSearch = cm.closeSearchPanel(currentView);
		currentView.dispatch({ effects: compartment.reconfigure(localeExtensions(cm)) });
		if (reopenSearch) cm.openSearchPanel(currentView);
	});

	onMount(() => {
		mount();
	});

	onDestroy(() => {
		flushOutgoing();
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
