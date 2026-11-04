import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view';

class LineEndWidget extends WidgetType {
	toDOM(): HTMLElement {
		const marker = document.createElement('span');
		marker.className = 'cm-invisible-newline';
		marker.textContent = '¶';
		marker.setAttribute('aria-hidden', 'true');
		return marker;
	}

	eq(): boolean {
		return true;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

const lineEnd = new LineEndWidget();

function build(view: EditorView): DecorationSet {
	const marks = [];
	for (const range of view.visibleRanges) {
		let position = range.from;
		while (position <= range.to) {
			const line = view.state.doc.lineAt(position);
			marks.push(Decoration.widget({ widget: lineEnd, side: 1 }).range(line.to));
			position = line.to + 1;
		}
	}
	return Decoration.set(marks, true);
}

/** Shows a paragraph mark at each visible line end. */
export const invisibleLineEnds = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = build(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
		}
	},
	{ decorations: (instance) => instance.decorations }
);
