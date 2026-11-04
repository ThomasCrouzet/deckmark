// Desktop Complete loader for the lazy quick capture surface.
// The Web Light build aliases this module to `capture-surface.web.ts`, so the
// capture component never enters the Web bundle or the offline precache.

export function loadQuickCapture() {
	return import('#lib/components/QuickCapture.svelte');
}
