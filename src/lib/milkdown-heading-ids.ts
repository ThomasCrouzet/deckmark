import type { Node } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state';
import { headingIdGenerator } from '@milkdown/kit/preset/commonmark';
import { $prose } from '@milkdown/kit/utils';

// An ID update resets the DOM selection. Defer it until text input pauses,
// so the browser does not revisit every offscreen block on each keystroke.
export const incrementalHeadingIds = $prose((ctx) => {
	const key = new PluginKey('mdsh-heading-ids');
	const ids = new WeakMap<Node, string>();
	const sync = (state: EditorState) => {
		const generate = ctx.get(headingIdGenerator.key);
		const counts = new Map<string, number>();
		const tr = state.tr.setMeta('addToHistory', false).setMeta(key, true);
		state.doc.descendants((node, position) => {
			if (node.type.name !== 'heading') return !node.isTextblock;
			if (!node.textContent.trim()) return false;
			let base = ids.get(node);
			if (base === undefined) {
				base = generate(node);
				ids.set(node, base);
			}
			const count = (counts.get(base) ?? 0) + 1;
			counts.set(base, count);
			const id = count === 1 ? base : `${base}-#${count}`;
			if (node.attrs.id !== id) tr.setNodeMarkup(position, undefined, { ...node.attrs, id });
			return false;
		});
		return tr.docChanged ? tr : null;
	};
	const hasHeading = (doc: Node, from: number, to: number) => {
		let found = false;
		doc.nodesBetween(from, to, (node) => {
			if (node.type.name === 'heading') found = true;
			return !found && !node.isTextblock;
		});
		return found;
	};
	return new Plugin({
		key,
		view(view) {
			const tr = sync(view.state);
			if (tr) view.dispatch(tr);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const publish = () => {
				timer = undefined;
				if (view.composing) {
					timer = setTimeout(publish, 200);
					return;
				}
				const update = sync(view.state);
				if (update) view.dispatch(update);
			};
			return {
				update(current, before) {
					const after = current.state;
					if (before.doc === after.doc) return;
					const from = before.doc.content.findDiffStart(after.doc.content);
					const end = before.doc.content.findDiffEnd(after.doc.content);
					if (from === null || !end) return;
					if (
						timer === undefined &&
						!hasHeading(before.doc, from, Math.max(from, end.a)) &&
						!hasHeading(after.doc, from, Math.max(from, end.b))
					)
						return;
					clearTimeout(timer);
					timer = setTimeout(publish, 200);
				},
				destroy() {
					clearTimeout(timer);
				}
			};
		}
	});
});
