// Pure decisions for a binary viewer that can receive new bytes under the same
// file id. The module does not decode, draw, or touch storage.
//
// A metadata update keeps the decoded payload and its annotations. A payload
// update starts a new decode and clears annotations that belong to the old
// image. The caller uses the generation number to reject an older decode.

export interface BinaryViewSource {
	data?: string | null | undefined;
	mime?: string | null | undefined;
}

export interface BinaryViewSnapshot {
	generation: number;
	data: string | null;
	mime: string | null;
}

export interface BinaryViewPlan {
	generation: number;
	snapshot: BinaryViewSnapshot;
	initial: boolean;
	payloadChanged: boolean;
	/** True when the caller must start a new decode. */
	decode: boolean;
	empty: boolean;
	/** True when the old annotations do not apply to the new payload. */
	resetAnnotations: boolean;
}

export function planBinaryView(
	previous: BinaryViewSnapshot | null,
	source: BinaryViewSource
): BinaryViewPlan {
	const data = source.data ?? null;
	const mime = source.mime ?? null;
	const empty = data === null || data.length === 0;
	const initial = previous === null;
	const payloadChanged = !initial && previous.data !== data;
	const generation = previous === null ? 0 : previous.generation + (payloadChanged ? 1 : 0);
	return {
		generation,
		snapshot: { generation, data, mime },
		initial,
		payloadChanged,
		decode: !empty && (initial || payloadChanged),
		empty,
		resetAnnotations: payloadChanged
	};
}
