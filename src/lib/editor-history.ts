import type { EditorState, Transaction } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import { EDITOR_STATE_CACHE_BYTES } from './editor-history-constants';

const FIXED_OVERHEAD = 4096;
const TRANSACTION_OVERHEAD = 1024;
const SELECTION_RANGE_OVERHEAD = 64;
const CHANGE_OVERHEAD = 1024;
const UNIT_BYTES = 4;
const LINE_BYTES = 64;
const REFUSED = EDITOR_STATE_CACHE_BYTES + 1;

function saturated(value: number): number {
	if (!Number.isFinite(value) || value < 0) return REFUSED;
	return Math.min(value, REFUSED);
}

function retainsUnknownEffects(state: EditorState): boolean {
	try {
		return state.facet(invertedEffects).length > 0;
	} catch {
		return true;
	}
}

/**
 * Estimates the retained bytes of a freshly captured native history.
 *
 * The charge covers the raw string, the native document and fixed overhead.
 * Any nonempty `invertedEffects` provider is refused because its payload has
 * no local byte estimate. The result saturates at the cache budget plus one.
 */
export function initialHistoryBytes(rawLength: number, state: EditorState): number {
	if (!Number.isFinite(rawLength) || rawLength < 0) return REFUSED;
	if (retainsUnknownEffects(state)) return REFUSED;
	return saturated(
		FIXED_OVERHEAD + 2 * rawLength + 2 * state.doc.length + LINE_BYTES * state.doc.lines
	);
}

/**
 * Adds the conservative charge of accepted transactions to a running total.
 *
 * Selection-only events, mappings and removed text all count. The helper never
 * walks old history, so a large resident history cannot make accounting scan it.
 * Unknown effect payloads saturate the total and refuse inactive retention.
 */
export function advanceHistoryBytes(
	previous: number,
	transactions: readonly Transaction[]
): number {
	let total = Number.isSafeInteger(previous) && previous >= 0 ? previous : REFUSED;
	for (const transaction of transactions) {
		if (!transaction || !transaction.state) return REFUSED;
		if (retainsUnknownEffects(transaction.state)) return REFUSED;
		total +=
			TRANSACTION_OVERHEAD + SELECTION_RANGE_OVERHEAD * transaction.state.selection.ranges.length;
		if (transaction.docChanged) {
			const oldDoc = transaction.startState.doc;
			const newDoc = transaction.state.doc;
			transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
				const removedLines = oldDoc.lineAt(toA).number - oldDoc.lineAt(fromA).number;
				const insertedLines = newDoc.lineAt(toB).number - newDoc.lineAt(fromB).number;
				total +=
					CHANGE_OVERHEAD +
					UNIT_BYTES * (toA - fromA + (toB - fromB)) +
					LINE_BYTES * (removedLines + insertedLines);
			});
		}
		if (total > REFUSED) total = REFUSED;
	}
	return saturated(total);
}
