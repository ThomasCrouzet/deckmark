import { type Editor } from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose as prosePlugin } from '@milkdown/kit/utils';
import { t } from '#lib/i18n/index.js';

const key = new PluginKey<'table' | 'paragraph' | null>('mdsh-table-paragraph');

/**
 * Milkdown parses a trailing table with an empty paragraph after it. The
 * serializer omits that paragraph, so the file still ends with the table.
 */
function trailingTableState(doc: ProseNode): 'table' | 'paragraph' | null {
	const last = doc.lastChild;
	if (last?.type.name === 'table') return 'table';
	if (last?.type.name !== 'paragraph' || last.content.size !== 0) return null;
	if (doc.childCount < 2) return null;
	return doc.child(doc.childCount - 2)?.type.name === 'table' ? 'paragraph' : null;
}

function appendParagraph(view: EditorView): boolean {
	if (trailingTableState(view.state.doc) !== 'table') return false;
	const paragraph = view.state.schema.nodes.paragraph;
	if (!paragraph) return false;
	const at = view.state.doc.content.size;
	const tr = view.state.tr.insert(at, paragraph.create());
	tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView();
	view.dispatch(tr);
	view.focus();
	return true;
}

/** Focuses the paragraph that follows the table, or creates it. */
function continueBelowTable(view: EditorView): boolean {
	if (trailingTableState(view.state.doc) === 'table') return appendParagraph(view);
	if (trailingTableState(view.state.doc) !== 'paragraph') return false;
	const at = view.state.doc.content.size - 1;
	const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, at)).scrollIntoView();
	view.dispatch(tr);
	view.focus();
	return true;
}

function createWidget(view: () => EditorView | null): HTMLElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.tabIndex = 0;
	button.contentEditable = 'false';
	button.className = 'mdsh-add-paragraph';
	button.dataset.testid = 'add-paragraph-after-table';
	const label = t('table.addParagraph');
	button.textContent = label;
	button.setAttribute('aria-label', label);
	button.title = label;
	button.addEventListener('mousedown', (event) => event.preventDefault());
	const activate = () => {
		const current = view();
		if (current) continueBelowTable(current);
	};
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		activate();
	});
	button.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		event.stopPropagation();
		activate();
	});
	return button;
}

function nearTrailingTable(view: EditorView, event: MouseEvent): boolean {
	if (!trailingTableState(view.state.doc)) return false;
	const tables = view.dom.querySelectorAll('table');
	const table = tables[tables.length - 1];
	if (!table) return false;
	const rect = table.getBoundingClientRect();
	// The editable blank space starts at the table bottom. A larger gap is
	// unrelated editor padding.
	return event.clientY >= rect.bottom - 2 && event.clientY <= rect.bottom + 120;
}

export function installTableParagraph(editor: Editor): void {
	editor.use(
		prosePlugin(() => {
			let currentView: EditorView | null = null;
			// Keep one widget node: rebuilding it on each state update would
			// remove the focused button during keyboard activation.
			const widget = createWidget(() => currentView);
			return new Plugin<'table' | 'paragraph' | null>({
				key,
				state: {
					init: (_config, state) => trailingTableState(state.doc),
					apply: (tr, previous) => (tr.docChanged ? trailingTableState(tr.doc) : previous)
				},
				view: (view) => {
					currentView = view;
					const parent = view.dom.parentElement;
					const onDoubleClick = (event: MouseEvent) => {
						// The ProseMirror handler covers events inside the editable
						// area. This listener only reaches the surrounding scroll box.
						if (event.target instanceof Element && event.target.closest('.ProseMirror')) return;
						if (event.target instanceof Element && event.target.closest('table')) return;
						if (!nearTrailingTable(view, event)) return;
						continueBelowTable(view);
					};
					parent?.addEventListener('dblclick', onDoubleClick);
					return {
						destroy: () => {
							parent?.removeEventListener('dblclick', onDoubleClick);
							currentView = null;
						}
					};
				},
				props: {
					decorations: (state) =>
						key.getState(state)
							? DecorationSet.create(state.doc, [
									Decoration.widget(state.doc.content.size, () => widget, {
										key: 'mdsh-add-paragraph'
									})
								])
							: null,
					handleDOMEvents: {
						dblclick: (view, event) => {
							const mouse = event as MouseEvent;
							if (mouse.target instanceof Element && mouse.target.closest('table')) return false;
							if (!nearTrailingTable(view, mouse)) return false;
							return continueBelowTable(view);
						}
					}
				}
			});
		})
	);
}
