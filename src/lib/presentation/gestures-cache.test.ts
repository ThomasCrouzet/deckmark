import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { withGestureRoot } from './gestures-test-root.svelte';
import { PresentationEditor } from './editor.svelte';
import { createPresentationGestures } from './gestures.svelte';
import { createDeck, createElement, createSlide, serializePresentation } from './model';
import { presentationElementBox } from './render';

function pointer(x: number, y: number, pointerId = 1, pointerType = 'mouse'): PointerEvent {
	return {
		clientX: x,
		clientY: y,
		pointerId,
		pointerType,
		button: 0,
		shiftKey: false,
		preventDefault() {},
		stopPropagation() {}
	} as PointerEvent;
}

const cleanups: Array<() => void> = [];

function setup(elements = [createElement('rectangle', { id: 'moving', x: 100, y: 100 })]) {
	const editor = new PresentationEditor(serializePresentation(createDeck()), () => {});
	editor.deck = createDeck({ slides: [createSlide(), createSlide()] });
	editor.slide.elements = elements;
	let factor = 1;
	let queued: FrameRequestCallback | undefined;
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		queued = callback;
		return 1;
	});
	vi.stubGlobal('cancelAnimationFrame', () => (queued = undefined));
	let gestures!: ReturnType<typeof createPresentationGestures>;
	cleanups.push(
		withGestureRoot(() => {
			gestures = createPresentationGestures(
				editor,
				() => null,
				() => factor,
				() => {}
			);
		})
	);
	flushSync();
	return {
		editor,
		gestures,
		scale(value: number) {
			factor = value;
		},
		frame() {
			const callback = queued;
			queued = undefined;
			flushSync(() => callback?.(0));
		},
		start() {
			gestures.startObject(pointer(0, 0), editor.slide.elements[0]!);
			flushSync();
		},
		move(x: number, y: number) {
			gestures.pointerMove(pointer(x, y));
			const callback = queued;
			queued = undefined;
			flushSync(() => callback?.(0));
		}
	};
}

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.unstubAllGlobals();
});

function legacySnap(editor: PresentationEditor, values: number[], axis: 'x' | 'y', scale: number) {
	const dimension = axis === 'x' ? editor.deck.width : editor.deck.height;
	const candidates = [0, dimension / 2, dimension];
	for (const element of editor.slide.elements) {
		if (editor.selected.includes(element.id)) continue;
		const box = presentationElementBox(element, editor.slide);
		const start = axis === 'x' ? box.left : box.top;
		const size = axis === 'x' ? box.width : box.height;
		candidates.push(start, (start + (start + size)) / 2, start + size);
	}
	let best = 8 / scale + 1;
	let correction = 0;
	let guide: number | null = null;
	for (const candidate of candidates) {
		for (const value of values) {
			const gap = candidate - value;
			if (Math.abs(gap) < best && Math.abs(gap) <= 8 / scale) {
				best = Math.abs(gap);
				correction = gap;
				guide = candidate;
			}
		}
	}
	return { correction, guide };
}

describe('gesture snapping cache regression 317', () => {
	for (const count of [200, 1000, 2000]) {
		it(`does not reread stationary geometry on a ${count}-element slide after the first frame`, () => {
			let reads = 0;
			const stationary = Array.from({ length: count - 1 }, (_, index) => {
				const element = createElement('rectangle', { id: `fixed-${index}`, y: 400 });
				Object.defineProperty(element, 'x', {
					enumerable: true,
					get() {
						reads++;
						return 600 + index / 10;
					}
				});
				return element;
			});
			const run = setup([
				createElement('rectangle', { id: 'moving', x: 100, y: 100 }),
				...stationary
			]);
			run.start();
			const firstStart = performance.now();
			run.move(40, 30);
			const firstFrameMs = performance.now() - firstStart;
			reads = 0;
			const rawFrameMs: number[] = [];
			for (let frame = 0; frame < 40; frame++) {
				const start = performance.now();
				run.move(41 + frame, 31 + frame);
				rawFrameMs.push(performance.now() - start);
			}
			const sorted = [...rawFrameMs].sort((a, b) => a - b);
			console.info(
				JSON.stringify({
					metric: 'gesture-work-without-dom',
					elementsPerSlide: count,
					stationaryElements: count - 1,
					firstFrameMs,
					rawFrameMs,
					p50: sorted[20],
					p95: sorted[38],
					geometryReads: reads,
					limits:
						'jsdom synchronous gesture and Svelte flush work, not browser frame intervals or paint'
				})
			);
			expect(run.editor.primary!.x).toBeGreaterThan(140);
			expect(reads).toBe(0);
		});
	}

	it('matches the legacy scan for seeded groups, signed connectors, ties and fractional scales', () => {
		let seed = 317;
		const random = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};
		for (let layout = 0; layout < 30; layout++) {
			const elements = [
				createElement('rectangle', {
					id: 'moving',
					x: 200,
					y: 180,
					width: 40,
					height: 30,
					groupId: 'g'
				}),
				createElement('ellipse', {
					id: 'grouped',
					x: 260,
					y: 220,
					width: 30,
					height: 20,
					groupId: 'g',
					rotation: 33.5
				}),
				...Array.from({ length: 40 }, (_, index) =>
					createElement(index % 3 === 0 ? 'line' : 'rectangle', {
						id: `fixed-${index}`,
						x: 200 + Math.round(random() * 900) / 2,
						y: 180 + Math.round(random() * 600) / 2,
						width:
							index % 3 === 0 ? Math.round(random() * 300 - 150) : 1 + Math.round(random() * 150),
						height:
							index % 3 === 0 ? Math.round(random() * 200 - 100) : 1 + Math.round(random() * 100),
						rotation: random() * 360
					})
				),
				createElement('arrow', { id: 'linked', startId: 'moving', endId: 'fixed-39' })
			];
			const run = setup(elements);
			const factor = [0.5, 0.73, 1, 1.25, 2.37][layout % 5]!;
			run.scale(factor);
			run.start();
			run.editor.slide.elements[5]!.x = -25.25;
			run.editor.slide.elements[5]!.y = -10.5;
			for (let frame = 0; frame < 12; frame++) {
				const dx = (random() * 180 - 80) * factor;
				const dy = (random() * 150 - 60) * factor;
				if (Math.hypot(dx, dy) < 3) {
					const before = [
						run.editor.primary!.x,
						run.editor.primary!.y,
						run.gestures.guideX,
						run.gestures.guideY
					];
					run.move(dx, dy);
					expect([
						run.editor.primary!.x,
						run.editor.primary!.y,
						run.gestures.guideX,
						run.gestures.guideY
					]).toEqual(before);
					continue;
				}
				const x = legacySnap(
					run.editor,
					[200 + dx / factor, 245 + dx / factor, 290 + dx / factor],
					'x',
					factor
				);
				const y = legacySnap(
					run.editor,
					[180 + dy / factor, 210 + dy / factor, 240 + dy / factor],
					'y',
					factor
				);
				run.move(dx, dy);
				expect(run.editor.primary!.x).toBeCloseTo(200 + dx / factor + x.correction, 10);
				expect(run.editor.primary!.y).toBeCloseTo(180 + dy / factor + y.correction, 10);
				expect([run.gestures.guideX, run.gestures.guideY]).toEqual([x.guide, y.guide]);
			}
			run.gestures.cancel();
		}
	});

	it('preserves candidate order and moving-edge order at equal distance', () => {
		const run = setup([
			createElement('rectangle', { id: 'moving', x: 100, y: 100, width: 20, height: 20 }),
			createElement('rectangle', { id: 'earlier', x: 151, y: 400, width: 2, height: 1 }),
			createElement('rectangle', { id: 'later', x: 147, y: 450, width: 2, height: 1 })
		]);
		run.start();
		run.move(40, 13);
		expect(run.gestures.guideX).toBe(151);
		expect(run.editor.primary!.x).toBe(141);
	});

	it('refreshes changed stationary geometry, membership, dimensions and snap settings', () => {
		const run = setup([
			createElement('rectangle', { id: 'moving', x: 100, y: 100, width: 20, height: 20 }),
			createElement('rectangle', { id: 'fixed', x: 147, y: 400, width: 1, height: 1 })
		]);
		run.start();
		run.move(40, 13);
		expect(run.gestures.guideX).toBe(148);
		run.editor.slide.elements[1]!.x = 143;
		run.move(40, 13);
		expect(run.gestures.guideX).toBe(143);
		run.editor.slide.elements.splice(1, 1);
		run.editor.deck.width = 286;
		run.move(40, 13);
		expect(run.gestures.guideX).toBe(143);
		run.gestures.snap = false;
		run.move(40, 13);
		expect(run.gestures.guideX).toBeNull();
		expect(run.editor.primary!.x).toBe(140);
		run.gestures.snap = true;
		run.move(40, 13);
		expect(run.gestures.guideX).toBe(143);
	});

	for (const boundary of ['cancel', 'pointercancel', 'undo', 'slide', 'selection'] as const) {
		it(`clears guides and queued work after ${boundary}`, () => {
			const run = setup([
				createElement('rectangle', { id: 'moving', x: 100, y: 100, width: 20, height: 20 }),
				createElement('rectangle', { id: 'fixed', x: 147, y: 400, width: 1, height: 1 })
			]);
			run.start();
			run.move(40, 13);
			expect(run.gestures.guideX).toBe(148);
			run.gestures.pointerMove(pointer(80, 13));
			flushSync(() => {
				if (boundary === 'cancel') run.gestures.cancel();
				else if (boundary === 'pointercancel') run.gestures.pointerEnd(pointer(80, 13), true);
				else if (boundary === 'undo') run.editor.undo();
				else if (boundary === 'slide') run.editor.selectSlide(1);
				else run.editor.selected = [];
			});
			expect([run.gestures.guideX, run.gestures.guideY]).toEqual([null, null]);
			const source = serializePresentation(run.editor.deck);
			run.frame();
			expect(serializePresentation(run.editor.deck)).toBe(source);
		});
	}

	it('retains rAF coalescing and discards object snapping when touch becomes a pinch', () => {
		const run = setup();
		run.gestures.startObject(pointer(0, 0, 1, 'touch'), run.editor.slide.elements[0]!);
		run.gestures.pointerMove(pointer(30, 20, 1, 'touch'));
		run.gestures.pointerMove(pointer(50, 40, 1, 'touch'));
		expect(run.editor.primary!.x).toBe(100);
		run.frame();
		expect(run.editor.primary!.x).toBe(150);
		run.gestures.startBackground(pointer(100, 100, 2, 'touch'));
		run.gestures.pointerMove(pointer(200, 200, 2, 'touch'));
		run.frame();
		expect(run.gestures.zoom).toBeGreaterThan(1);
		expect(run.editor.primary!.x).toBe(100);
		expect([run.gestures.guideX, run.gestures.guideY]).toEqual([null, null]);
	});
});
