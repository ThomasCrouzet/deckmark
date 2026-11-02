import { type Editor, editorViewOptionsCtx, remarkPluginsCtx } from '@milkdown/kit/core';
import { tableCellSchema, tableHeaderSchema } from '@milkdown/kit/preset/gfm';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { MarkdownNode, RemarkPlugin, SerializerState } from '@milkdown/kit/transformer';
import type { Nodes, PhrasingContent } from 'mdast';

function parseCellContent(children: PhrasingContent[]): PhrasingContent[] {
	return children.map((node) => {
		if (node.type === 'html' && /^<br[ \t\r\n\f]*\/?>$/i.test(node.value)) {
			return { type: 'break' };
		}
		if ('children' in node) node.children = parseCellContent(node.children);
		return node;
	});
}

function parseCellBreaks(node: Nodes): void {
	if (node.type === 'tableCell') {
		node.children = parseCellContent(node.children);
	} else if ('children' in node) {
		node.children.forEach(parseCellBreaks);
	}
}

const tableBreakRemark: RemarkPlugin = {
	plugin: () => parseCellBreaks,
	options: {}
};

function encodeCellBreaks(nodes: MarkdownNode[]): void {
	nodes.forEach((node, index) => {
		if (node.type === 'break') {
			nodes[index] = { type: 'html', value: '<br>' };
		} else if (node.children) {
			encodeCellBreaks(node.children);
		}
	});
}

function serializeCell(state: SerializerState, node: ProseNode): void {
	state.openNode('tableCell');
	const cell = state.top();
	// The cell schema requires one paragraph. Keep its full inline content.
	state.next(node.child(0).content);
	if (cell) {
		cell.children ??= [];
		encodeCellBreaks(cell.children);
	}
	state.closeNode();
}

function handleTableEnter(view: EditorView, event: KeyboardEvent): boolean {
	if (
		event.key !== 'Enter' ||
		event.altKey ||
		event.ctrlKey ||
		event.metaKey ||
		event.isComposing ||
		view.composing ||
		!view.editable
	)
		return false;

	const { selection } = view.state;
	if (!(selection instanceof TextSelection)) return false;
	const { $from, $to } = selection;
	if ($from.parent.type.name !== 'paragraph' || !$from.sameParent($to) || $from.depth < 2)
		return false;
	const cell = $from.node(-1);
	if (cell.type.name !== 'table_cell' && cell.type.name !== 'table_header') return false;

	// The upstream filter rejects table transactions with hardbreak metadata.
	view.dispatch(
		view.state.tr.replaceSelectionWith(view.state.schema.node('hardbreak'), false).scrollIntoView()
	);
	return true;
}

export function installTableBreaks(editor: Editor): void {
	editor.config((ctx) => {
		for (const schema of [tableCellSchema, tableHeaderSchema]) {
			ctx.update(schema.key, (previous) => (ctx) => {
				const spec = previous(ctx);
				return {
					...spec,
					toMarkdown: { ...spec.toMarkdown, runner: serializeCell }
				};
			});
		}
		// Convert a sole cell break before the empty-line plugin deletes it.
		ctx.update(remarkPluginsCtx, (plugins) => [tableBreakRemark, ...plugins]);
		ctx.update(editorViewOptionsCtx, (previous) => ({
			...previous,
			handleKeyDown: (view, event) =>
				handleTableEnter(view, event) || previous.handleKeyDown?.(view, event) || false
		}));
	});
}
