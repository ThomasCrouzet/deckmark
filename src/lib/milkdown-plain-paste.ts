import { type Editor, editorViewOptionsCtx } from '@milkdown/kit/core';
import {
	Fragment,
	type Mark,
	type Node as ProseNode,
	type ResolvedPos,
	Slice
} from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';

// A paste event does not carry modifier keys. The keydown handler records the
// shortcut, and the paste handler consumes it. The short window prevents a
// stale request from changing the next paste.
const PLAIN_PASTE_TIMEOUT_MS = 1500;
let plainPasteRequestedAt = 0;

function isPlainPasteShortcut(event: KeyboardEvent): boolean {
	const key = event.key.toLowerCase();
	if (event.shiftKey && key === 'v' && (event.metaKey || event.ctrlKey)) return true;
	return event.shiftKey && key === 'insert' && !event.metaKey && !event.ctrlKey && !event.altKey;
}

function inlineNodes(view: EditorView, value: string, marks: readonly Mark[]): ProseNode[] {
	const { schema } = view.state;
	const nodes: ProseNode[] = [];
	const lines = value.split('\n');
	lines.forEach((line, index) => {
		if (line) nodes.push(schema.text(line, marks));
		if (index < lines.length - 1) {
			const hardbreak = schema.nodes.hardbreak;
			if (hardbreak) nodes.push(hardbreak.create());
		}
	});
	return nodes;
}

interface PlainTextParts {
	paragraphs: ProseNode[];
	slice: Slice;
}

/**
 * Builds paragraphs from literal text.
 *
 * A single newline becomes a hard break. A blank line starts a new paragraph.
 * The open slice lets the first paragraph merge with the destination block and
 * the last paragraph merge with the following content.
 */
function plainTextParts(view: EditorView, text: string): PlainTextParts | null {
	const { schema, selection } = view.state;
	const paragraph = schema.nodes.paragraph;
	if (!paragraph) return null;
	const marks = view.state.storedMarks ?? selection.$from.marks();
	const normalized = text.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
	if (!normalized) return null;
	const paragraphs = normalized
		.split(/\n[ \t]*\n+/)
		.map((value) => paragraph.create(null, inlineNodes(view, value, marks)));
	return { paragraphs, slice: new Slice(Fragment.fromArray(paragraphs), 1, 1) };
}

function findAncestor($pos: ResolvedPos, names: readonly string[]) {
	for (let depth = $pos.depth; depth > 0; depth--) {
		const node = $pos.node(depth);
		if (names.includes(node.type.name)) return { node, depth };
	}
	return null;
}

function newListItems(
	view: EditorView,
	$from: ResolvedPos,
	listItem: { node: ProseNode; depth: number },
	paragraphs: ProseNode[]
): ProseNode[] {
	const listItemType = view.state.schema.nodes.list_item;
	if (!listItemType) return [];
	const list = $from.node(listItem.depth - 1);
	const ordered = list.type.name === 'ordered_list';
	const start = ordered ? Number(list.attrs.order ?? 1) : 1;
	const current = $from.index(listItem.depth - 1);
	return paragraphs.map((paragraph, offset) => {
		const label = ordered ? `${start + current + offset + 1}.` : '•';
		return listItemType.create(
			{
				...listItem.node.attrs,
				label,
				listType: ordered ? 'ordered' : 'bullet',
				checked: listItem.node.attrs.checked == null ? null : false
			},
			paragraph
		);
	});
}

/**
 * Insert literal text at the current selection.
 *
 * A heading keeps the first paragraph. Later paragraphs become body text.
 * A list item keeps the first paragraph and later paragraphs become new items.
 * A table cell keeps every paragraph inside the cell.
 */
export function insertPlainText(view: EditorView, text: string): boolean {
	const { state } = view;
	const { $from } = state.selection;
	// Code blocks have their own editor and paste handling.
	if ($from.parent.type.spec.code || findAncestor($from, ['code_block'])) return false;
	const parts = plainTextParts(view, text);
	if (!parts) return false;

	// The table paste handler must not turn lines into cells.
	if (findAncestor($from, ['table_cell', 'table_header'])) {
		view.dispatch(state.tr.replaceSelection(parts.slice).scrollIntoView());
		return true;
	}

	const heading = findAncestor($from, ['heading']);
	if (heading && parts.paragraphs.length > 1) {
		const first = new Slice(Fragment.from(parts.paragraphs[0]!), 1, 1);
		const tr = state.tr.replaceSelection(first);
		const insertAt = tr.mapping.map($from.after(heading.depth));
		tr.insert(insertAt, Fragment.fromArray(parts.paragraphs.slice(1)));
		view.dispatch(tr.scrollIntoView());
		return true;
	}

	const listItem = findAncestor($from, ['list_item']);
	if (listItem && parts.paragraphs.length > 1) {
		const first = new Slice(Fragment.from(parts.paragraphs[0]!), 1, 1);
		const tr = state.tr.replaceSelection(first);
		const insertAt = tr.mapping.map($from.after(listItem.depth));
		tr.insert(
			insertAt,
			Fragment.fromArray(newListItems(view, $from, listItem, parts.paragraphs.slice(1)))
		);
		view.dispatch(tr.scrollIntoView());
		return true;
	}

	view.dispatch(state.tr.replaceSelection(parts.slice).scrollIntoView());
	return true;
}

/**
 * A true plain-text paste for the visual editor.
 *
 * Milkdown parses clipboard text as Markdown when the clipboard has no HTML.
 * This plugin bypasses that parser and inserts the literal characters. It runs
 * before Milkdown's clipboard plugin and before the table handler.
 */
export function installPlainPaste(editor: Editor): void {
	editor.config((ctx) => {
		ctx.update(editorViewOptionsCtx, (previous) => ({
			...previous,
			handleKeyDown: (view, event) => {
				if (previous.handleKeyDown?.(view, event)) return true;
				if (isPlainPasteShortcut(event)) plainPasteRequestedAt = Date.now();
				else plainPasteRequestedAt = 0;
				return false;
			},
			handlePaste: (view, event, slice) => {
				const requested =
					plainPasteRequestedAt > 0 && Date.now() - plainPasteRequestedAt < PLAIN_PASTE_TIMEOUT_MS;
				if (!requested) return previous.handlePaste?.(view, event, slice) ?? false;
				plainPasteRequestedAt = 0;
				const text = event.clipboardData?.getData('text/plain') ?? '';
				try {
					if (!text || !insertPlainText(view, text))
						return previous.handlePaste?.(view, event, slice) ?? false;
					return true;
				} catch {
					return previous.handlePaste?.(view, event, slice) ?? false;
				}
			}
		}));
	});
}
