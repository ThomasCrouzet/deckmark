import {
	EditorState,
	StateEffect,
	StateField,
	Text,
	type ChangeSet,
	type Extension
} from '@codemirror/state';
import {
	Decoration,
	EditorView,
	ViewPlugin,
	WidgetType,
	showPanel,
	type DecorationSet,
	type ViewUpdate
} from '@codemirror/view';
import { t } from './i18n';
export { markdown } from '@codemirror/lang-markdown';
export { externalDocumentChange as patch } from './code/external-changes';
export {
	editorHistoryCache,
	restoreHistoryState,
	captureHistoryState
} from './editor-history-cache';

export function codeMirrorPhrases(): Record<string, string> {
	return {
		Find: t('source.cmFind'),
		Replace: t('source.cmReplace'),
		next: t('source.cmNext'),
		previous: t('source.cmPrevious'),
		all: t('source.cmAll'),
		'match case': t('source.cmMatchCase'),
		regexp: t('source.cmRegexp'),
		'by word': t('source.cmByWord'),
		replace: t('source.cmReplaceAction'),
		'replace all': t('source.cmReplaceAll'),
		close: t('source.cmClose'),
		'Go to line': t('source.cmGoToLine'),
		go: t('source.cmGo'),
		'replaced match on line $': t('source.cmReplacedOne'),
		'replaced $ matches': t('source.cmReplacedMany'),
		'current match': t('source.cmCurrentMatch'),
		'on line': t('source.cmOnLine'),
		'Control character': t('source.cmControlCharacter'),
		'Selection deleted': t('source.cmSelectionDeleted')
	};
}

export function typewriterCentering(): Extension {
	return ViewPlugin.define((currentView) => {
		const win = currentView.dom.ownerDocument.defaultView;
		let active = true;
		let frame: number | null = null;
		let generation = 0;
		const measure = {
			key: {},
			read: (measuredView: EditorView) => {
				if (!active) return null;
				const head = measuredView.state.selection.main.head;
				const caret = measuredView.coordsAtPos(head);
				if (caret) {
					const scroller = measuredView.scrollDOM;
					const bounds = scroller.getBoundingClientRect();
					const center =
						bounds.top + (scroller.clientTop + scroller.clientHeight / 2) * measuredView.scaleY;
					const delta = ((caret.top + caret.bottom) / 2 - center) / measuredView.scaleY;
					const target = Math.max(
						0,
						Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + delta)
					);
					if (Math.abs(target - scroller.scrollTop) <= 2) return null;
				}
				return { head, generation };
			},
			write: (target: { head: number; generation: number } | null) => {
				if (!active || !target) return;
				// CodeMirror does not permit dispatch inside its measure or update phase.
				queueMicrotask(() => {
					if (!active || target.generation !== generation) return;
					currentView.dispatch({
						effects: EditorView.scrollIntoView(target.head, { y: 'center' })
					});
				});
			}
		};
		function schedule() {
			if (!win || frame !== null) return;
			frame = win.requestAnimationFrame(() => {
				frame = null;
				if (active) currentView.requestMeasure(measure);
			});
		}
		schedule();
		return {
			update(update: ViewUpdate) {
				if (!update.selectionSet && !update.docChanged) return;
				generation += 1;
				schedule();
			},
			destroy() {
				active = false;
				if (frame !== null) win?.cancelAnimationFrame(frame);
			}
		};
	});
}

/** Shows the reduced-aids state while a physical line exceeds the guard limit. */
export function longLineStatus(): Extension {
	return showPanel.of(() => {
		const dom = document.createElement('div');
		dom.className = 'mdsh-long-line-status';
		dom.setAttribute('role', 'status');
		dom.dataset.testid = 'source-highlight-status';
		dom.dataset.degraded = 'true';
		dom.textContent = t('code.longLineDegraded');
		return { dom, top: true };
	});
}

// Keep image bytes in the document. Decorations change only their display.
export function imageData(): Extension {
	const reveal = StateEffect.define<number>();
	class ImageDataWidget extends WidgetType {
		toDOM(view: EditorView): HTMLElement {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'mdsh-image-data';
			button.textContent = t('source.imageData');
			button.setAttribute('aria-label', t('source.showImageData'));
			button.onclick = () => {
				const from = view.posAtDOM(button);
				view.dispatch({ effects: reveal.of(from), selection: { anchor: from } });
				view.focus();
			};
			return button;
		}
	}
	const widget = new ImageDataWidget();
	const pattern = /(data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,|blob:)([^\s)"'<>]{32,})/gi;
	interface Span {
		from: number;
		to: number;
	}
	const scanLine = (text: string, from: number, into: Span[]) => {
		for (const match of text.matchAll(pattern)) {
			if (!match[1] || !match[2]) continue;
			const start = from + match.index + match[1].length;
			into.push({ from: start, to: start + match[2].length });
		}
	};
	const scanDocument = (doc: Text): Span[] => {
		const spans: Span[] = [];
		for (let number = 1; number <= doc.lines; number++) {
			const line = doc.line(number);
			scanLine(line.text, line.from, spans);
		}
		return spans;
	};
	const decorationsFor = (doc: Text, spans: readonly Span[], opened: ReadonlySet<number>) => {
		const ranges = [];
		for (const span of spans) {
			if (span.to <= span.from || opened.has(span.from)) continue;
			const to = Math.min(span.to, doc.length);
			if (to <= span.from) continue;
			ranges.push(Decoration.replace({ widget }).range(span.from, to));
		}
		return Decoration.set(ranges, true);
	};
	const field = StateField.define<{
		opened: Set<number>;
		spans: Span[];
		decorations: DecorationSet;
	}>({
		create: (state) => {
			const spans = scanDocument(state.doc);
			return {
				opened: new Set(),
				spans,
				decorations: decorationsFor(state.doc, spans, new Set())
			};
		},
		update: (value, transaction) => {
			const opened = new Set([...value.opened].map((pos) => transaction.changes.mapPos(pos, 1)));
			let revealed = false;
			for (const effect of transaction.effects) {
				if (effect.is(reveal)) {
					opened.add(effect.value);
					revealed = true;
				}
			}
			if (!transaction.docChanged) {
				return revealed
					? {
							opened,
							spans: value.spans,
							decorations: decorationsFor(transaction.state.doc, value.spans, opened)
						}
					: value;
			}
			const doc = transaction.state.doc;
			const changedLines = new Set<number>();
			transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
				const first = doc.lineAt(fromB).number;
				const last = doc.lineAt(Math.min(toB, doc.length)).number;
				for (let number = Math.max(1, first - 1); number <= Math.min(doc.lines, last + 1); number++)
					changedLines.add(number);
			});
			const kept = value.spans
				.map((span) => ({
					from: transaction.changes.mapPos(span.from, -1),
					to: transaction.changes.mapPos(span.to, 1)
				}))
				.filter((span) => {
					if (span.to <= span.from) return false;
					const line = doc.lineAt(Math.min(span.from, doc.length)).number;
					return !changedLines.has(line);
				});
			const rescanned: Span[] = [];
			for (const number of changedLines) {
				const line = doc.line(number);
				scanLine(line.text, line.from, rescanned);
			}
			const byStart = new Map<number, Span>();
			for (const span of [...kept, ...rescanned]) byStart.set(span.from, span);
			const spans = [...byStart.values()].sort((a, b) => a.from - b.from);
			return { opened, spans, decorations: decorationsFor(doc, spans, opened) };
		},
		provide: (self) => [
			EditorView.decorations.from(self, (value) => value.decorations),
			EditorView.atomicRanges.of((view) => view.state.field(self).decorations)
		]
	});
	return field;
}

const endings: Record<string, string> = { l: '\n', c: '\r\n', r: '\r' };

/** Immutable raw-byte snapshot. Import this module with the lazy editor. */
export class SourceText {
	readonly doc: Text;
	/** This counter is local to the buffer. It is not a store revision. */
	readonly revision: number;
	readonly #separators: Text;
	readonly #uniform: string | null;
	#text: string | undefined;

	private constructor(
		doc: Text,
		separators: Text,
		uniform: string | null,
		revision: number,
		text?: string
	) {
		this.doc = doc;
		this.#separators = separators;
		this.#uniform = uniform;
		this.revision = revision;
		this.#text = text;
	}

	static create(source: string, doc: Text): SourceText {
		const codes: string[] = [];
		let uniform: string | null | undefined;
		for (const match of source.matchAll(/\r\n?|\n/g)) {
			const ending = match[0];
			codes.push(ending === '\r\n' ? 'c' : ending === '\r' ? 'r' : 'l');
			if (uniform === undefined) uniform = ending;
			else if (uniform !== ending) uniform = null;
		}
		codes.push('');
		if (codes.length !== doc.lines) throw new Error('Source line map does not match native text');
		return new SourceText(
			doc,
			Text.of(codes),
			uniform ?? (codes.length === 1 ? '\n' : null),
			0,
			source
		);
	}

	apply(changes: ChangeSet, doc: Text): SourceText {
		if (changes.length !== this.doc.length || changes.newLength !== doc.length) {
			throw new Error('Source change does not match native text');
		}
		if (changes.empty) return this;
		let separators = this.#separators;
		let shift = 0;
		changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
			// Most keys change no separator and need no raw offset lookup.
			if (from === to && inserted.lines === 1) return;
			const first = this.doc.lineAt(from).number;
			const last = this.doc.lineAt(to).number;
			if (first === last && inserted.lines === 1) return;
			const code = this.#separators.line(first).text || this.#separators.line(1).text || 'l';
			const added = inserted.lines - 1;
			// Each separator occupies one code and one Text line break. The final
			// empty line makes line-index edits persistent and logarithmic.
			separators = separators.replace(
				(first - 1 + shift) * 2,
				(last - 1 + shift) * 2,
				Text.of([...Array<string>(added).fill(code), ''])
			);
			shift += added - (last - first);
		});
		if (separators.lines !== doc.lines) throw new Error('Source separator update is inconsistent');
		return new SourceText(doc, separators, this.#uniform, this.revision + 1);
	}

	getText(): string {
		if (this.#text !== undefined) return this.#text;
		if (this.#uniform !== null) {
			this.#text = this.doc.sliceString(0, this.doc.length, this.#uniform);
		} else {
			const parts: string[] = [];
			const separators = this.#separators.iterLines();
			for (const part of this.doc.iter()) {
				parts.push(part === '\n' ? endings[separators.next().value]! : part);
			}
			this.#text = parts.join('');
		}
		return this.#text;
	}
}

/** Theme for the source editor. It stays in this lazy module so the boot
 * bundle does not carry CodeMirror theme data. */
export function sourceTheme(): Extension {
	return EditorView.theme({
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
}

/** Localizes the source editor and keeps the accessible name current. */
export function sourceLocaleExtensions(ariaLabel: string): Extension {
	return [
		EditorState.phrases.of({
			Find: t('source.cmFind'),
			Replace: t('source.cmReplace'),
			next: t('source.cmNext'),
			previous: t('source.cmPrevious'),
			all: t('source.cmAll'),
			'match case': t('source.cmMatchCase'),
			regexp: t('source.cmRegexp'),
			'by word': t('source.cmByWord'),
			replace: t('source.cmReplaceAction'),
			'replace all': t('source.cmReplaceAll'),
			close: t('source.cmClose'),
			'Go to line': t('source.cmGoToLine'),
			go: t('source.cmGo'),
			'replaced match on line $': t('source.cmReplacedOne'),
			'replaced $ matches': t('source.cmReplacedMany'),
			'current match': t('source.cmCurrentMatch'),
			'on line': t('source.cmOnLine'),
			'Control character': t('source.cmControlCharacter'),
			'Selection deleted': t('source.cmSelectionDeleted')
		}),
		EditorView.contentAttributes.of({ 'aria-label': ariaLabel })
	];
}

// Physical-line guard for pathological code and source documents. One very
// long line can make grammar parsing, folding, bracket matching and wrapping
// expensive enough to block input. The guard keeps the document editable with
// a reduced extension set until every line is below the limit again.
//
// This module has no runtime CodeMirror import. The editor passes its document
// and change set through the small structural types below, so the source
// editor keeps its lazy CodeMirror chunk boundary.

/** Maximum physical line length in UTF-16 code units before the guard applies. */
export const LONG_LINE_LIMIT = 16_384;

/** Delay before a full recheck after an edit that can restore normal syntax. */
export const LONG_LINE_RECHECK_MS = 120;

interface LineLike {
	readonly length: number;
}

interface DocumentLike {
	iterLines(): Iterable<string>;
}

interface PositionedDocumentLike {
	lineAt(position: number): LineLike;
}

interface InsertedTextLike {
	readonly length: number;
	sliceString(from: number, to: number, lineSeparator: string): string;
}

export interface SourceSupportModule {
	markdown(): import('@codemirror/state').Extension;
	imageData(): import('@codemirror/state').Extension;
	longLineStatus(): import('@codemirror/state').Extension;
	lineWrapping: import('@codemirror/state').Extension;
}

export interface LongLineMonitor {
	readonly initial: boolean;
	track(doc: PositionedDocumentLike, changes: ChangeSetLike): void;
	external(text: string): void;
	dispose(): void;
}

export interface LongLineMonitorOptions {
	initial: string;
	getDocument: () => DocumentLike | null;
	onChange: (degraded: boolean) => void;
}

interface ChangeSetLike {
	iterChangedRanges(
		callback: (fromA: number, toA: number, fromB: number, toB: number) => void
	): void;
	iterChanges(
		callback: (
			fromA: number,
			toA: number,
			fromB: number,
			toB: number,
			inserted: InsertedTextLike
		) => void
	): void;
}

/** A raw string with LF, CRLF or bare CR line endings. */
export function textHasLongLine(text: string, limit = LONG_LINE_LIMIT): boolean {
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code !== 10 && code !== 13) continue;
		if (index - start > limit) return true;
		if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
		start = index + 1;
	}
	return text.length - start > limit;
}

/** Checks every line of a CodeMirror document. Use it only at mount or after a
 * debounced shrink, never for each key. */
export function documentHasLongLine(doc: DocumentLike, limit = LONG_LINE_LIMIT): boolean {
	for (const line of doc.iterLines()) {
		if (line.length > limit) return true;
	}
	return false;
}

/** Builds the source-editor support set or the reduced panel extension. */
export function sourceSupportExtensions(
	degraded: boolean,
	plainText: boolean,
	module: SourceSupportModule
): import('@codemirror/state').Extension {
	if (degraded) return module.longLineStatus();
	return [...(plainText ? [] : [module.markdown()]), module.imageData(), module.lineWrapping];
}

/**
 * Tracks the guard state for one mounted editor. It checks touched lines on
 * each change and runs one debounced full scan after a shrink.
 */
export function createLongLineMonitor(options: LongLineMonitorOptions): LongLineMonitor {
	let degraded = textHasLongLine(options.initial);
	let timer: ReturnType<typeof setTimeout> | null = null;
	const update = (next: boolean) => {
		if (next === degraded) return;
		degraded = next;
		options.onChange(next);
	};
	const recheck = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			const doc = options.getDocument();
			if (doc) update(documentHasLongLine(doc));
		}, LONG_LINE_RECHECK_MS);
	};
	return {
		initial: degraded,
		track(doc, changes) {
			if (changeCreatesLongLine(doc, changes)) update(true);
			else if (degraded) recheck();
		},
		external(text) {
			update(textHasLongLine(text));
		},
		dispose() {
			if (timer) clearTimeout(timer);
			timer = null;
		}
	};
}

/**
 * Checks the lines that a change can make long. Only touched lines and a large
 * inserted block are inspected. The caller must still schedule a full recheck
 * when the document was already degraded and the change can shrink content.
 */
export function changeCreatesLongLine(
	doc: PositionedDocumentLike,
	changes: ChangeSetLike,
	limit = LONG_LINE_LIMIT
): boolean {
	let risky = false;
	changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
		if (risky) return;
		if (doc.lineAt(fromB).length > limit || doc.lineAt(toB).length > limit) risky = true;
	});
	if (risky) return true;
	changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
		if (risky) return;
		if (inserted.length <= limit) return;
		const text = inserted.sliceString(0, inserted.length, '\n');
		if (textHasLongLine(text, limit)) risky = true;
	});
	return risky;
}
