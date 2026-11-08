import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	WidgetType,
	showPanel,
	type DecorationSet
} from '@codemirror/view';
import { t } from './i18n';
export { markdown } from '@codemirror/lang-markdown';

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
