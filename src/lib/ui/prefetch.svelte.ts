// The service worker prepares offline features without evaluating their modules.
// Limit speculative prefetch to the selected mode and an active document.

export interface PrefetchOptions {
	getMode: () => string;
	getFiles: () => Array<{ content: string }>;
}

export function prefetchTarget(
	mode: string,
	hasDocuments: boolean,
	connection?: { saveData?: boolean; effectiveType?: string }
): 'read' | 'source' | null {
	if (
		!hasDocuments ||
		connection?.saveData ||
		connection?.effectiveType === '2g' ||
		connection?.effectiveType === 'slow-2g'
	)
		return null;
	return mode === 'read' || mode === 'source' ? mode : null;
}

export function schedulePrefetch(opts: PrefetchOptions): () => void {
	const nav = navigator as Navigator & {
		connection?: { saveData?: boolean; effectiveType?: string };
	};
	let idle: number | undefined;
	const timer = window.setTimeout(() => {
		const load = () => {
			const target = prefetchTarget(opts.getMode(), opts.getFiles().length > 0, nav.connection);
			if (target === 'read') void import('#lib/render/markdown.js').catch(() => {});
			if (target === 'source') {
				void Promise.all([
					import('@codemirror/state'),
					import('@codemirror/view'),
					import('@codemirror/lang-markdown'),
					import('@codemirror/commands'),
					import('@codemirror/language'),
					import('@codemirror/search')
				]).catch(() => {});
			}
		};
		if (window.requestIdleCallback) idle = window.requestIdleCallback(load);
		else load();
	}, 2500);
	return () => {
		window.clearTimeout(timer);
		if (idle !== undefined) window.cancelIdleCallback?.(idle);
	};
}
