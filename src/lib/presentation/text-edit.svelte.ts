import { tick } from 'svelte';

import { keyboardStore } from '#lib/ui/keyboard.svelte.js';
import type { PresentationEditor } from './editor.svelte';
import type { PresentationElement } from './model';

export interface PresentationTextEdit {
	readonly editingId: string | null;
	readonly element: PresentationElement | undefined;
	begin(id?: string): Promise<void>;
	finish(): void;
	discard(): void;
	update(value: string): void;
	format(marker: string): void;
	handleKey(event: KeyboardEvent, onFinish: () => void): void;
}

/** Elements that cannot hold text. */
const TEXT_BLOCKED = new Set(['image', 'line', 'arrow']);

/**
 * One inline text edit session on the active slide.
 *
 * The session owns the textarea lifecycle and its transaction. It selects the
 * target element, starts one undo entry, and commits that entry exactly once
 * when the session ends. A source replacement discards the session without a
 * commit because the incoming deck replaces the open operation.
 */
export function createPresentationTextEdit(
	editor: PresentationEditor,
	getInput: () => HTMLTextAreaElement | null
): PresentationTextEdit {
	let editingId = $state<string | null>(null);

	function current(): PresentationElement | undefined {
		return editor.slide.elements.find((element) => element.id === editingId);
	}

	function finish(): void {
		if (!editingId) return;
		if (editor.commit(false)) editingId = null;
	}

	function discard(): void {
		editingId = null;
	}

	async function begin(id?: string): Promise<void> {
		const target = editor.slide.elements.find(
			(element) => element.id === (id ?? editor.primary?.id)
		);
		if (!target || TEXT_BLOCKED.has(target.type)) return;
		finish();
		if (editingId) return;
		editor.select(target.id);
		editor.begin();
		editingId = target.id;
		await tick();
		const input = getInput();
		input?.focus();
		input?.select();
	}

	function update(value: string): void {
		const target = current();
		if (!target || target.content === value) return;
		target.content = value;
		editor.markChanged();
	}

	function format(marker: string): void {
		const input = getInput();
		const target = current();
		if (!input || !target) return;
		const start = input.selectionStart;
		const end = input.selectionEnd;
		const content = target.content;
		target.content =
			content.slice(0, start) +
			marker +
			content.slice(start, end) +
			(marker === '- ' ? '' : marker) +
			content.slice(end);
		editor.markChanged();
		void tick().then(() => {
			const field = getInput();
			field?.focus();
			field?.setSelectionRange(start + marker.length, end + marker.length);
		});
	}

	function handleKey(event: KeyboardEvent, onFinish: () => void): void {
		if (event.defaultPrevented || event.isComposing) return;
		if (
			!event.altKey &&
			event.metaKey !== event.ctrlKey &&
			['b', 'i'].includes(event.key.toLowerCase())
		) {
			event.preventDefault();
			event.stopPropagation();
			format(event.key.toLowerCase() === 'b' ? '**' : '*');
			return;
		}
		if (keyboardStore.match(event)) return;
		event.stopPropagation();
		if (event.key === 'Escape') {
			event.preventDefault();
			finish();
			onFinish();
		}
	}

	return {
		get editingId() {
			return editingId;
		},
		get element() {
			return current();
		},
		begin,
		finish,
		discard,
		update,
		format,
		handleKey
	};
}
