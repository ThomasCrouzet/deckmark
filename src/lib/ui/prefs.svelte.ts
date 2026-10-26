// §P2.3 - Module managing the persisted UI preferences.
//
// Groups together focus mode, typewriter mode and TOC visibility:
// reactive state + localStorage persistence + DOM $effects.
//
// Exposes a `createUiPrefs()` factory to call top-level in the parent
// component's `<script>` (Svelte 5 constraint: `$effect`s must be
// created within the component's init scope).
//
// Logic extracted from `+page.svelte` (L352-398, L458-467).

import { browser } from '$app/env';
import { readPreference, writePreference } from '#lib/preferences.js';

// Structural interface matching the exports of SourceEditor.svelte
// (avoids importing the component, incompatible with InstanceType in Svelte 5).
interface SourceEditorRef {
	setTypewriter?: (active: boolean) => void;
}

export interface UiPrefsOptions {
	getHydrated: () => boolean;
	// Extra signals so the focus-inert $effect re-runs when the
	// header/aside/footer DOM is remounted (mode switch, TOC, etc.)
	getMode: () => unknown;
	getTocVisible: () => unknown;
	getTocEmpty: () => unknown;
	getActiveId: () => unknown;
	// Reference to the SourceEditor to propagate typewriterMode
	getSourceEditorRef: () => SourceEditorRef | null;
}

export function createUiPrefs(opts: UiPrefsOptions) {
	let focusMode = $state(false);
	// §5.6 - Typewriter mode (centered caret). Limited to source mode in v1:
	// CodeMirror actively centers the line via an extension dispatched
	// into a Compartment. WYSIWYG (Milkdown / ProseMirror) inherits the
	// 50vh padding defined in app.css, without active centering (a dedicated
	// ProseMirror plugin is deferred to v2).
	let typewriterMode = $state(false);
	// `mdsh:toc`: '1' = visible, '0' = hidden; absent => visible by default.
	let tocVisible = $state(true);

	// Focus mode: toggle body class + persistence. Attentional cost of UI
	// elements (Mark 2008) → hide toolbar/sidebar/statusbar during a long
	// session, reappearing on hover.
	//
	// §B1.1 - Sets `inert` on header/aside/footer when focus mode is active.
	// Without it, Tab visited invisible elements (opacity:0 but still in the
	// DOM) and focus visually disappeared. `inert` removes the element and
	// its subtree from the tab order AND the a11y tree. On hover/focus, the
	// CSS makes it visible but Tab keeps skipping - this is intended: focus
	// mode is driven by the mouse (or ⌘⇧.). To reintegrate these elements,
	// disable focus mode.
	//
	// Dependencies: `mode`, `tocVisible`, `tocEmpty`, `filesStore.active`
	// trigger the mount/unmount of `<aside class="mdsh-toc-col">` when the
	// mode changes; without them, inert is not re-applied to the new aside
	// when switching to read mode while focus mode is active.
	$effect(() => {
		if (!browser || !opts.getHydrated()) return;
		// Explicit tracking: the effect must re-run on these signals to
		// re-apply `inert` to the newly mounted header/aside/footer.
		// `activeId` (and not `active`) to avoid re-triggering on every
		// keystroke (which mutates the file object but not its id).
		void opts.getMode();
		void opts.getTocVisible();
		void opts.getTocEmpty();
		void opts.getActiveId();
		document.body.classList.toggle('focus-mode', focusMode);
		writePreference('mdsh:focus', focusMode ? '1' : '0');
		const periph = document.querySelectorAll<HTMLElement>(
			'#app-toolbar, #app-statusbar, .mdsh-toc-col'
		);
		for (const el of periph) {
			if (focusMode) el.setAttribute('inert', '');
			else el.removeAttribute('inert');
		}
	});

	// §5.6 - Typewriter mode: toggle body class + persistence. The 50vh
	// padding applied via the `body.typewriter-mode` class (cf. app.css)
	// pushes the content so that every line can be reached at the center.
	// Active centering in source mode goes through
	// `sourceEditorRef.setTypewriter()` via the $effect below.
	$effect(() => {
		if (!browser || !opts.getHydrated()) return;
		document.body.classList.toggle('typewriter-mode', typewriterMode);
		writePreference('mdsh:typewriter', typewriterMode ? '1' : '0');
	});

	// Propagates the mode state to the SourceEditor (CodeMirror Compartment).
	// We go through a method rather than a prop to avoid recreating the
	// EditorState on each toggle (loss of history, selection, scroll).
	$effect(() => {
		if (!browser || !opts.getHydrated()) return;
		opts.getSourceEditorRef()?.setTypewriter?.(typewriterMode);
	});

	// Load from localStorage (to call in onMount, before hydrated = true).
	function loadPersistedPrefs() {
		if (!browser) return;
		focusMode = readPreference('mdsh:focus') === '1';
		typewriterMode = readPreference('mdsh:typewriter') === '1';
		tocVisible = readPreference('mdsh:toc') !== '0';
	}

	function toggleFocusMode() {
		focusMode = !focusMode;
	}

	function toggleTypewriterMode() {
		typewriterMode = !typewriterMode;
	}

	function toggleToc() {
		tocVisible = !tocVisible;
		writePreference('mdsh:toc', tocVisible ? '1' : '0');
	}

	return {
		get focusMode() {
			return focusMode;
		},
		get typewriterMode() {
			return typewriterMode;
		},
		get tocVisible() {
			return tocVisible;
		},
		loadPersistedPrefs,
		toggleFocusMode,
		toggleTypewriterMode,
		toggleToc
	};
}
