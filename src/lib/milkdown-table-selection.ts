import { TableNodeView, tableBlockView } from '@milkdown/kit/component/table-block';
import type { Editor } from '@milkdown/kit/core';
import { tableSchema } from '@milkdown/kit/preset/gfm';
import { $view } from '@milkdown/kit/utils';
import { t, type MessageKey } from './i18n';

type ControlLabels = { selector: string; keys: MessageKey[] };

// The table node view renders icon-only controls without accessible names.
// The hidden variants also stay in the tab order, so Tab after the last cell
// can land on an invisible button. Label visible controls and remove hidden
// ones from the tab order.
const controlLabels: ControlLabels[] = [
	{
		selector: '[data-role="col-drag-handle"] button',
		keys: [
			'editor.tableAlignLeft',
			'editor.tableAlignCenter',
			'editor.tableAlignRight',
			'editor.tableDeleteColumn'
		]
	},
	{ selector: '[data-role="row-drag-handle"] button', keys: ['editor.tableDeleteRow'] },
	{ selector: '[data-role="x-line-drag-handle"] button', keys: ['editor.tableAddRow'] },
	{ selector: '[data-role="y-line-drag-handle"] button', keys: ['editor.tableAddColumn'] }
];

class TableTextNodeView extends TableNodeView {
	private readonly observer = new MutationObserver(() => this.refreshControls());

	constructor(...args: ConstructorParameters<typeof TableNodeView>) {
		super(...args);
		this.dom.addEventListener('focusin', this.refreshControls);
		window.addEventListener('mdsh:locale-change', this.refreshControls);
		this.observer.observe(this.dom, {
			subtree: true,
			attributes: true,
			attributeFilter: ['data-show', 'data-display-type']
		});
		this.refreshControls();
	}

	private readonly refreshControls = () => {
		for (const { selector, keys } of controlLabels)
			this.dom.querySelectorAll<HTMLElement>(selector).forEach((control, index) => {
				const key = keys[index];
				if (key) {
					control.setAttribute('aria-label', t(key));
					control.title = t(key);
				}
				control.tabIndex = this.isShown(control) ? 0 : -1;
			});
	};

	private isShown(element: Element): boolean {
		for (
			let current: Element | null = element;
			current && current !== this.dom;
			current = current.parentElement
		) {
			if (current.getAttribute('data-show') === 'false') return false;
			if (current.getAttribute('data-display-type') === 'indicator') return false;
			if (getComputedStyle(current).opacity === '0') return false;
		}
		return true;
	}

	override update(node: Parameters<TableNodeView['update']>[0]): boolean {
		const changed = super.update(node);
		if (changed) this.refreshControls();
		return changed;
	}

	override destroy(): void {
		this.observer.disconnect();
		this.dom.removeEventListener('focusin', this.refreshControls);
		window.removeEventListener('mdsh:locale-change', this.refreshControls);
		super.destroy();
	}

	override stopEvent(event: Event): boolean {
		if (
			(event.type === 'mousedown' || event.type === 'pointerdown') &&
			event.target instanceof Node &&
			this.contentDOM.contains(event.target)
		)
			return false;
		return super.stopEvent(event);
	}
}

const tableTextView = $view(tableSchema.node, (ctx) => (node, view, getPos) => {
	return new TableTextNodeView(ctx, node, view, getPos);
});

export async function configureTableTextSelection(editor: Editor): Promise<void> {
	await editor.remove(tableBlockView);
	editor.use(tableTextView);
}
