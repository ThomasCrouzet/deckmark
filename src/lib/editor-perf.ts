// Local performance evidence for the editor input path.
//
// The counters and duration events stay inert in a normal build. E2E runs use
// the existing source-fidelity instrumentation flag. A benchmark can also set
// `window.__MDSH_EDITOR_PERF__ = true` before the application starts.

export type EditorPerfEvent =
	{ kind: 'counter'; name: string } | { kind: 'duration'; name: string; value: number };

function enabled(): boolean {
	if (typeof window === 'undefined') return false;
	if (import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1') return true;
	return Boolean((window as { __MDSH_EDITOR_PERF__?: boolean }).__MDSH_EDITOR_PERF__);
}

function emit(event: EditorPerfEvent): void {
	if (!enabled()) return;
	window.dispatchEvent(new CustomEvent('deckmark:editor-perf', { detail: event }));
}

/** Count one path decision without measuring its duration. */
export function recordEditorCounter(name: string): void {
	emit({ kind: 'counter', name });
}

/** Record one completed duration in milliseconds. */
export function recordEditorDuration(name: string, value: number): void {
	emit({ kind: 'duration', name, value });
}

/** Measure one synchronous stage. The callback result is unchanged. */
export function measureEditorStage<T>(name: string, run: () => T): T {
	if (!enabled()) return run();
	const startedAt = performance.now();
	try {
		return run();
	} finally {
		recordEditorDuration(name, performance.now() - startedAt);
	}
}
