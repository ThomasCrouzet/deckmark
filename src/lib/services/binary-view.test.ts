import { describe, expect, it } from 'vitest';
import { planBinaryView, type BinaryViewSnapshot } from './binary-view-plan';
import { createBinaryRenderGate, createObjectUrlSlot } from './binary-view-render';

// These cases keep the deterministic generation decisions that a browser case
// cannot force: an out-of-order decode completion and the exact object-URL
// replacement order. The Playwright case still checks the visible image and PDF.

describe('planBinaryView', () => {
	it('decodes an initial payload and keeps annotations', () => {
		const plan = planBinaryView(null, { data: 'data:image/png;base64,AAAA', mime: 'image/png' });
		expect(plan.generation).toBe(0);
		expect(plan.initial).toBe(true);
		expect(plan.payloadChanged).toBe(false);
		expect(plan.decode).toBe(true);
		expect(plan.empty).toBe(false);
		expect(plan.resetAnnotations).toBe(false);
		expect(plan.snapshot).toEqual({
			generation: 0,
			data: 'data:image/png;base64,AAAA',
			mime: 'image/png'
		});
	});

	it('keeps the decode and annotations when only metadata changes', () => {
		const previous: BinaryViewSnapshot = {
			generation: 0,
			data: 'data:image/png;base64,AAAA',
			mime: 'image/png'
		};
		const plan = planBinaryView(previous, {
			data: 'data:image/png;base64,AAAA',
			mime: 'image/jpeg'
		});
		expect(plan.generation).toBe(0);
		expect(plan.payloadChanged).toBe(false);
		expect(plan.decode).toBe(false);
		expect(plan.resetAnnotations).toBe(false);
		expect(plan.snapshot.mime).toBe('image/jpeg');
	});

	it('advances the generation and resets annotations for a new payload', () => {
		let snapshot = planBinaryView(null, { data: 'data:image/png;base64,AAAA' });
		snapshot = planBinaryView(snapshot.snapshot, { data: 'data:image/png;base64,BBBB' });
		const first = snapshot;
		expect(first.generation).toBe(1);
		expect(first.payloadChanged).toBe(true);
		expect(first.decode).toBe(true);
		expect(first.resetAnnotations).toBe(true);

		const second = planBinaryView(first.snapshot, { data: 'data:image/png;base64,CCCC' });
		expect(second.generation).toBe(2);
		expect(second.resetAnnotations).toBe(true);
	});

	it('does not decode an empty payload but resets stale annotations', () => {
		const previous: BinaryViewSnapshot = {
			generation: 4,
			data: 'data:image/png;base64,AAAA',
			mime: 'image/png'
		};
		const plan = planBinaryView(previous, { data: undefined });
		expect(plan.generation).toBe(5);
		expect(plan.empty).toBe(true);
		expect(plan.decode).toBe(false);
		expect(plan.resetAnnotations).toBe(true);
	});

	it('decodes a payload that returns after an empty state', () => {
		const previous: BinaryViewSnapshot = { generation: 5, data: null, mime: 'image/png' };
		const plan = planBinaryView(previous, { data: 'data:image/png;base64,DDDD' });
		expect(plan.generation).toBe(6);
		expect(plan.decode).toBe(true);
		expect(plan.resetAnnotations).toBe(true);
	});
});

describe('createBinaryRenderGate', () => {
	it('accepts only the newest token', () => {
		const gate = createBinaryRenderGate();
		const first = gate.begin();
		const second = gate.begin();
		expect(gate.isCurrent(first)).toBe(false);
		expect(gate.isCurrent(second)).toBe(true);
		gate.invalidate();
		expect(gate.isCurrent(second)).toBe(false);
		const third = gate.begin();
		expect(gate.isCurrent(third)).toBe(true);
	});
});

describe('createObjectUrlSlot', () => {
	it('revokes the displayed URL exactly when it is replaced or cleared', () => {
		const revoked: string[] = [];
		const slot = createObjectUrlSlot((url) => revoked.push(url));
		slot.replace('blob:first');
		expect(slot.current).toBe('blob:first');
		slot.replace('blob:first');
		expect(revoked).toEqual([]);
		slot.replace('blob:second');
		expect(revoked).toEqual(['blob:first']);
		expect(slot.current).toBe('blob:second');
		slot.clear();
		expect(revoked).toEqual(['blob:first', 'blob:second']);
		expect(slot.current).toBeNull();
		slot.clear();
		expect(revoked).toEqual(['blob:first', 'blob:second']);
	});
});
