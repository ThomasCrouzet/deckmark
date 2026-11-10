export const modeMethods = {
	read: {
		version: 'read-render/1',
		clock: 'performance.now',
		start: 'read-mode-click',
		firstContentMs: 'first article text with the tail sentinel',
		fullRenderMs: 'last expected Mermaid SVG mounted',
		warmups: 0,
		statistic: 'nearest-rank',
		percentiles: [0.5, 0.95],
		decimals: 3
	},
	slide: {
		version: 'textarea-insert/1',
		clock: 'performance.now',
		start: 'target-beforeinput-capture',
		inputToFrameMs: 'second-animation-frame',
		inputDispatchMs: 'queued-microtask',
		saveObservedMs: 'after-exact-indexeddb-observation',
		insertion: 'x',
		positions: [
			{ id: 'start', ratio: 0.02 },
			{ id: 'middle', ratio: 0.5 },
			{ id: 'end', ratio: 0.98 }
		],
		offset: 'Math.round(currentFieldUtf16Length*ratio)',
		warmups: 0,
		framesBeforeInput: 2,
		idleAfterSampleMs: 550,
		statistic: 'nearest-rank',
		percentiles: [0.5, 0.95],
		decimals: 3
	}
};
