import { computeSelectionStats, computeStats } from '#lib/stats-count.js';

self.addEventListener(
	'message',
	(event: MessageEvent<{ token: number; text: string; mode?: 'document' | 'selection' }>) => {
		const { token, text, mode = 'document' } = event.data;
		(self as unknown as Worker).postMessage(
			mode === 'selection'
				? { token, selection: computeSelectionStats(text) }
				: { token, stats: computeStats(text) }
		);
	}
);
