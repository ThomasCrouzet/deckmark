import { type Editor, editorViewOptionsCtx, pasteRulesCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import {
	tableCellSchema,
	tableHeaderSchema,
	tableRowSchema,
	tableHeaderRowSchema,
	tablePasteRule
} from '@milkdown/kit/preset/gfm';
import { Fragment, Slice, type Node } from '@milkdown/kit/prose/model';
import {
	CellSelection,
	handlePaste as handleTablePaste,
	isInTable,
	selectedRect
} from '@milkdown/kit/prose/tables';
import type { EditorView } from '@milkdown/kit/prose/view';

function fitCellTypes(ctx: Ctx, view: EditorView, slice: Slice): Slice {
	const { top, bottom } = selectedRect(view.state);
	const selectedRows = view.state.selection instanceof CellSelection ? bottom - top : undefined;
	function cells(content: Fragment, header: boolean): Fragment {
		const type = (header ? tableHeaderSchema : tableCellSchema).type(ctx);
		const nodes: Node[] = [];
		content.forEach((cell) => nodes.push(type.create(cell.attrs, cell.content, cell.marks)));
		return Fragment.from(nodes);
	}
	function fit(content: Fragment): Fragment {
		const first = content.firstChild;
		if (!first) return content;
		if (content.childCount === 1 && first.type.spec.tableRole === 'table') {
			return Fragment.from(first.copy(fit(first.content)));
		}
		if (first.type.spec.tableRole === 'row') {
			const rows: Node[] = [];
			// Tile before conversion so a header cell is never repeated into a body row.
			for (let i = 0; i < (selectedRows ?? content.childCount); i++) {
				const row = content.child(i % content.childCount);
				const header = top + i === 0;
				const type = (header ? tableHeaderRowSchema : tableRowSchema).type(ctx);
				rows.push(type.create(row.attrs, cells(row.content, header), row.marks));
			}
			return Fragment.from(rows);
		}
		if (first.type.spec.tableRole === 'cell' || first.type.spec.tableRole === 'header_cell') {
			return cells(content, top === 0);
		}
		return content;
	}
	return new Slice(fit(slice.content), slice.openStart, slice.openEnd);
}

export function installTableClipboard(editor: Editor): void {
	editor.config((ctx) => {
		ctx.update(editorViewOptionsCtx, (previous) => ({
			...previous,
			transformPastedHTML: (html, view) => {
				html = previous.transformPastedHTML?.(html, view) ?? html;
				if (!isInTable(view.state) || !/<br\b/i.test(html)) return html;
				const template = view.dom.ownerDocument.createElement('template');
				template.innerHTML = html;
				template.content
					.querySelectorAll('br.ProseMirror-trailingBreak')
					.forEach((br) => br.remove());
				for (const br of template.content.querySelectorAll('br')) {
					if (br.nextSibling) continue;
					// The clipboard parser drops a final BR under a block parent.
					const inline = view.dom.ownerDocument.createElement('span');
					br.replaceWith(inline);
					inline.append(br);
				}
				return template.innerHTML;
			},
			transformPasted: (slice, view, plain) => {
				if (previous.transformPasted) return previous.transformPasted(slice, view, plain);
				const rules = [...ctx.get(pasteRulesCtx)].sort(
					(a, b) => (b.priority ?? 50) - (a.priority ?? 50)
				);
				for (const rule of rules) {
					// Copied rows need no whole-table header repair inside a table.
					if (isInTable(view.state) && rule === tablePasteRule.pasteRule) continue;
					slice = rule.run(slice, view, plain);
				}
				return slice;
			},
			handlePaste: (view, event, slice) =>
				// Table paste must run before Milkdown's generic HTML replacement.
				(view.editable &&
					isInTable(view.state) &&
					slice.content.firstChild?.type.spec.tableRole &&
					handleTablePaste(view, event, fitCellTypes(ctx, view, slice))) ||
				previous.handlePaste?.(view, event, slice) ||
				false
		}));
	});
}
