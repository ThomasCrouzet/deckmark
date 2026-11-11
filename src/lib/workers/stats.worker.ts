import { computeSelectionStats, computeStats } from '#lib/stats-count.js';
import type { StatsRequest, StatsResponse } from '#lib/stats-count.js';

// The baseline lets a small edit reuse the source that this Worker already
// holds. A full text replaces it, and a mismatched revision asks for one.
let baseline = '';
let revision = 0;

function reply(message: StatsResponse) {
	(self as unknown as Worker).postMessage(message);
}

self.addEventListener('message', (event: MessageEvent<StatsRequest>) => {
	const { token, text, patch, mode = 'document' } = event.data;
	if (mode === 'selection') {
		reply({ token, selection: computeSelectionStats(text ?? '') });
		return;
	}
	if (patch && patch.baseRevision === revision) {
		baseline =
			baseline.slice(0, patch.start) + patch.insert + baseline.slice(patch.start + patch.remove);
	} else if (typeof text === 'string') {
		baseline = text;
	} else if (patch) {
		reply({ token, needFull: true });
		return;
	}
	revision = token;
	reply({ token, stats: computeStats(baseline), revision });
});
