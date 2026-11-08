import { computeStats } from '#lib/stats-count.js';

self.addEventListener('message', (event: MessageEvent<{ token: number; text: string }>) => {
	const { token, text } = event.data;
	(self as unknown as Worker).postMessage({ token, stats: computeStats(text) });
});
