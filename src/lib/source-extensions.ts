import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	ViewPlugin,
	WidgetType,
	type DecorationSet,
	type ViewUpdate
} from '@codemirror/view';
import { t } from './i18n';
export { markdown } from '@codemirror/lang-markdown';
export { externalDocumentChange as patch } from './code/external-changes';

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
	const decorate = (state: EditorState, opened: ReadonlySet<number>) => {
		const ranges = [];
		const pattern = /(data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,|blob:)([^\s)"'<>]{32,})/gi;
		for (const match of state.doc.toString().matchAll(pattern)) {
			if (!match[1] || !match[2]) continue;
			const from = match.index + match[1].length;
			if (!opened.has(from))
				ranges.push(Decoration.replace({ widget }).range(from, from + match[2].length));
		}
		return Decoration.set(ranges);
	};
	const field = StateField.define<{ opened: Set<number>; decorations: DecorationSet }>({
		create: (state) => ({ opened: new Set(), decorations: decorate(state, new Set()) }),
		update: (value, transaction) => {
			const opened = new Set([...value.opened].map((pos) => transaction.changes.mapPos(pos)));
			let changed = transaction.docChanged;
			for (const effect of transaction.effects) {
				if (effect.is(reveal)) {
					opened.add(effect.value);
					changed = true;
				}
			}
			return changed ? { opened, decorations: decorate(transaction.state, opened) } : value;
		},
		provide: (self) => [
			EditorView.decorations.from(self, (value) => value.decorations),
			EditorView.atomicRanges.of((view) => view.state.field(self).decorations)
		]
	});
	return field;
}
