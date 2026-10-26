// §P2.1 - Module managing the editor width.
//
// Exposes a `createEditorWidth()` factory to call top-level in the parent
// component's `<script>` (Svelte 5 constraint: `$effect`s must be
// created within the component's init scope).
//
// Logic extracted from `+page.svelte` (L180-242 + L415-435).

import { browser } from '$app/env';
import { readPreference, writePreference } from '#lib/preferences.js';
import { EDITOR } from '#lib/config.js';
import { PRINT_TEXT_WIDTH_PX } from '#lib/render/print-geometry.js';

const DEFAULT_EDITOR_WIDTH = EDITOR.defaultWidth;
const MIN_EDITOR_WIDTH = EDITOR.minWidth;
const EDITOR_WIDTH_MARGIN = EDITOR.margin;

export type EditorWidth = number | typeof EDITOR.widthPresets.pdf;

export function createEditorWidth(opts: {
	getHydrated: () => boolean;
	getResizing: () => boolean;
}) {
	// Keep the selected width when the viewport becomes smaller.
	let selectedWidth = $state<EditorWidth>(DEFAULT_EDITOR_WIDTH);
	let viewportWidth = $state(
		browser ? window.innerWidth : DEFAULT_EDITOR_WIDTH + EDITOR_WIDTH_MARGIN
	);
	// Edit and Read use 5vw side padding, or 1.25rem on a viewport up to 640px.
	const editorMaxWidth = $derived(
		clampEditorWidth(
			selectedWidth === EDITOR.widthPresets.pdf
				? PRINT_TEXT_WIDTH_PX + (viewportWidth <= 640 ? 40 : viewportWidth * 0.1)
				: selectedWidth
		)
	);
	let resizing = $state(false);

	// Non-reactive drag variables (updated on each pointermove)
	let resizeHandle: HTMLDivElement | null = null;
	let resizeStartX = 0;
	let resizeStartWidth = 0;
	let resizeStartSelection: EditorWidth = DEFAULT_EDITOR_WIDTH;
	let resizePointerId: number | null = null;
	// rAF-throttle of the drag: on a 120 Hz macOS trackpad (and some
	// high-polling mice), pointermove can fire > 60 times/s. Each update of
	// editorMaxWidth forces a full ProseMirror reflow (word wrap). We
	// coalesce to 1 update per paint frame.
	let resizeRafId = 0;
	let resizePendingX = 0;

	function clampEditorWidth(w: number): number {
		if (!browser) return w;
		const maxAllowed = Math.max(MIN_EDITOR_WIDTH, viewportWidth - EDITOR_WIDTH_MARGIN);
		return Math.round(Math.max(MIN_EDITOR_WIDTH, Math.min(maxAllowed, w)));
	}

	function persistEditorWidth() {
		if (!browser) return;
		writePreference('mdsh:editor-width', String(selectedWidth));
	}

	function startResize(e: PointerEvent) {
		if (!resizeHandle || e.button !== 0 || resizing) return;
		resizing = true;
		resizePointerId = e.pointerId;
		resizeStartX = e.clientX;
		resizePendingX = e.clientX;
		resizeStartSelection = selectedWidth;
		resizeStartWidth = Math.min(
			editorMaxWidth,
			resizeHandle.parentElement?.clientWidth ?? editorMaxWidth
		);
		resizeHandle.setPointerCapture(e.pointerId);
		e.preventDefault();
	}

	function applyResize(clientX: number) {
		const deltaX = clientX - resizeStartX;
		selectedWidth =
			deltaX === 0 ? resizeStartSelection : clampEditorWidth(resizeStartWidth + deltaX * 2);
	}

	function onResize(e: PointerEvent) {
		if (!resizing || e.pointerId !== resizePointerId) return;
		resizePendingX = e.clientX;
		if (resizeRafId) return;
		resizeRafId = requestAnimationFrame(() => {
			resizeRafId = 0;
			if (!resizing) return;
			applyResize(resizePendingX);
		});
	}

	function stopResize(e: PointerEvent) {
		if (!resizing || e.pointerId !== resizePointerId) return;
		// Save the last pointer position even if its animation frame has not run.
		if (e.type === 'pointerup') applyResize(e.clientX);
		resizing = false;
		resizePointerId = null;
		if (resizeRafId) {
			cancelAnimationFrame(resizeRafId);
			resizeRafId = 0;
		}
		if (resizeHandle && resizeHandle.hasPointerCapture(e.pointerId)) {
			resizeHandle.releasePointerCapture(e.pointerId);
		}
		persistEditorWidth();
	}

	function resetEditorWidth() {
		selectedWidth = DEFAULT_EDITOR_WIDTH;
		persistEditorWidth();
	}

	function setEditorWidth(w: EditorWidth) {
		if (w !== EDITOR.widthPresets.pdf && (!Number.isFinite(w) || w < MIN_EDITOR_WIDTH)) return;
		selectedWidth = w;
		persistEditorWidth();
	}

	// §A2.5 - Re-clamp the editor width if the window shrinks below the current value.
	// Skip during an active drag so we do not overwrite the value the user is manipulating.
	// rAF-throttle: `resize` can fire >10 times/s during a desktop window
	// drag or a mobile orientation change. We coalesce to 1 per paint.
	// This $effect MUST be called top-level in the parent component.
	$effect(() => {
		if (!browser || !opts.getHydrated()) return;
		let raf = 0;
		const onWindowResize = () => {
			if (opts.getResizing() || raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				if (opts.getResizing()) return;
				viewportWidth = window.innerWidth;
			});
		};
		window.addEventListener('resize', onWindowResize);
		return () => {
			window.removeEventListener('resize', onWindowResize);
			if (raf) cancelAnimationFrame(raf);
		};
	});

	// Load the persisted width from localStorage (to call in onMount).
	function loadPersistedWidth() {
		if (!browser) return;
		viewportWidth = window.innerWidth;
		const savedWidth = readPreference('mdsh:editor-width');
		if (savedWidth === EDITOR.widthPresets.pdf) {
			selectedWidth = savedWidth;
		} else if (savedWidth) {
			const n = Number(savedWidth);
			if (Number.isFinite(n) && n >= MIN_EDITOR_WIDTH) {
				selectedWidth = n;
			}
		}
	}

	return {
		get editorMaxWidth() {
			return editorMaxWidth;
		},
		get resizing() {
			return resizing;
		},
		setResizeHandle(el: HTMLDivElement | null) {
			resizeHandle = el;
		},
		clampEditorWidth,
		isActiveWidth: (width: EditorWidth) => selectedWidth === width,
		loadPersistedWidth,
		startResize,
		onResize,
		stopResize,
		resetEditorWidth,
		setEditorWidth
	};
}
