import {
	computeSelectionStats,
	computeStats,
	incrementalStats,
	plainStatisticsSource
} from '#lib/stats-count.js';
import type { DocStats, StatsRequest, StatsResponse } from '#lib/stats-count.js';

// The baseline lets a small edit reuse the source that this Worker already
// holds. A full text replaces it, and a mismatched revision asks for one.
// The accepted span also lets an ordinary plain edit reuse the unchanged
// counting ranges. Every ambiguous structure runs the exact full count.
let baseline = '';
let revision = 0;
let baselineStats: DocStats | null = null;
let plainSource = false;

function reply(message: StatsResponse) {
	(self as unknown as Worker).postMessage(message);
}

function remember(text: string): DocStats {
	baseline = text;
	baselineStats = computeStats(text);
	plainSource = plainStatisticsSource(text);
	return baselineStats;
}

function applySpans(
	text: string,
	spans: ReadonlyArray<{ start: number; remove: number; insert: string }>
) {
	let content = text;
	let delta = 0;
	for (const span of spans) {
		const start = span.start + delta;
		const end = start + span.remove;
		if (
			!Number.isInteger(start) ||
			!Number.isInteger(span.remove) ||
			start < 0 ||
			span.remove < 0 ||
			end > content.length
		)
			return null;
		content = content.slice(0, start) + span.insert + content.slice(end);
		delta += span.insert.length - span.remove;
	}
	return content;
}

self.addEventListener('message', (event: MessageEvent<StatsRequest>) => {
	const { token, text, patch, mode = 'document' } = event.data;
	if (mode === 'selection') {
		reply({ token, selection: computeSelectionStats(text ?? '') });
		return;
	}
	let next: string | null = null;
	if (patch && patch.baseRevision === revision) {
		next = applySpans(baseline, patch.spans);
	} else if (typeof text === 'string') {
		next = text;
	} else if (patch) {
		reply({ token, needFull: true });
		return;
	}
	if (next === null) {
		reply({ token, needFull: true });
		return;
	}
	const previous = baselineStats;
	const previousToken = revision;
	// A single accepted span can reuse the unchanged ranges when the note has
	// no construct that can cross a plain region.
	if (
		patch &&
		previous &&
		plainSource &&
		patch.spans.length === 1 &&
		patch.baseRevision === previousToken
	) {
		const result = incrementalStats(baseline, next, previous, patch.spans[0]!);
		if (result.stats) {
			baseline = next;
			baselineStats = result.stats;
			revision = token;
			reply({ token, stats: result.stats, revision, count: 'incremental' });
			return;
		}
		revision = token;
		reply({
			token,
			stats: remember(next),
			revision,
			count: 'full',
			reason: result.reason ?? 'ambiguous-syntax'
		});
		return;
	}
	const reason = !patch
		? 'full-source'
		: !previous
			? 'no-baseline'
			: !plainSource
				? 'markup-source'
				: 'multiple-spans';
	revision = token;
	reply({ token, stats: remember(next), revision, count: 'full', reason });
});
