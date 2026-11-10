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
	},
	wysiwyg: {
		version: 'wysiwyg-insert/1',
		clock: 'performance.now',
		start: 'prosemirror-beforeinput-capture',
		inputToFrameMs: 'second-animation-frame',
		inputDispatchMs: 'queued-microtask',
		saveObservedMs: 'after-exact-indexeddb-observation',
		insertion: 'x',
		positions: [
			{ id: 'start', ratio: 0 },
			{ id: 'end', ratio: 1 }
		],
		warmups: 0,
		framesBeforeInput: 2,
		idleAfterSampleMs: 550,
		statistic: 'nearest-rank',
		percentiles: [0.5, 0.95],
		decimals: 3
	},
	canvas: {
		version: 'slide-canvas-drag/1',
		clock: 'performance.now',
		start: 'target-pointerdown-capture',
		pointerToFrameMs: 'second-animation-frame',
		saveObservedMs: 'after-exact-indexeddb-observation',
		delta: { x: 12, y: 8 },
		warmups: 0,
		framesBeforePointer: 2,
		idleAfterSampleMs: 550,
		statistic: 'nearest-rank',
		percentiles: [0.5, 0.95],
		decimals: 3
	},
	annotation: {
		version: 'read-ink-stroke/1',
		clock: 'performance.now',
		start: 'canvas-pointerdown-capture',
		pointerToFrameMs: 'second-animation-frame',
		paintedPixels: 'non-transparent-pixels-after-stroke',
		strokeCount: 'number of completed strokes',
		warmups: 0,
		framesBeforePointer: 2,
		statistic: 'nearest-rank',
		percentiles: [0.5, 0.95],
		decimals: 3
	},
	slideSource: {
		version: 'presentation-source-insert/1',
		clock: 'performance.now',
		start: 'target-beforeinput-capture',
		inputToFrameMs: 'second-animation-frame',
		inputDispatchMs: 'queued-microtask',
		applyObservedMs: 'after-apply-and-indexeddb-observation',
		insertion: 'x',
		positions: [{ id: 'end', ratio: 1 }],
		warmups: 0,
		framesBeforeInput: 2,
		statistic: 'nearest-rank',
		percentiles: [0.5, 0.95],
		decimals: 3
	}
};
