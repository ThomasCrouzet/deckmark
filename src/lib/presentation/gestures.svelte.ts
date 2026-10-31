import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import type { PresentationEditor } from './editor.svelte';
import type { PresentationElement } from './model';
import { presentationElementBox } from './render';

export type PresentationHandle = 'nw' | 'ne' | 'sw' | 'se';

export interface PresentationMarquee {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PresentationGestures {
	readonly guideX: number | null;
	readonly guideY: number | null;
	readonly marquee: PresentationMarquee | null;
	readonly pan: { x: number; y: number };
	zoom: number;
	snap: boolean;
	startObject(event: PointerEvent, element: PresentationElement): void;
	startHandle(event: PointerEvent, mode: 'resize' | 'rotate', handle?: string): void;
	startBackground(event: PointerEvent): void;
	pointerMove(event: PointerEvent): void;
	pointerEnd(event: PointerEvent, cancelled?: boolean): void;
	resetView(): void;
	cancel(): void;
}

interface Point {
	x: number;
	y: number;
}

interface Bounds {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

interface ElementSnapshot {
	element: PresentationElement;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
}

interface ActiveBase {
	pointerId: number;
	startClient: Point;
	latestClient: Point;
	shiftKey: boolean;
	operation: boolean;
}

interface MoveGesture extends ActiveBase {
	kind: 'move';
	deselectOnTap?: string;
	snapshots: ElementSnapshot[];
	bounds: Bounds;
}

interface ResizeGesture extends ActiveBase {
	kind: 'resize';
	handle: PresentationHandle;
	snapshots: ElementSnapshot[];
	bounds: Bounds;
}

interface RotateGesture extends ActiveBase {
	kind: 'rotate';
	snapshots: ElementSnapshot[];
	bounds: Bounds;
	startAngle: number;
}

interface MarqueeGesture extends ActiveBase {
	kind: 'marquee';
	startSlide: Point;
	previousSelection: string[];
}

interface PanGesture extends ActiveBase {
	kind: 'pan';
	startPan: Point;
}

type ActiveGesture = MoveGesture | ResizeGesture | RotateGesture | MarqueeGesture | PanGesture;

interface TrackedPointer extends Point {
	target: Element | null;
}

interface PinchGesture {
	firstId: number;
	secondId: number;
	distance: number;
	midpoint: Point;
	zoom: number;
	pan: Point;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const MIN_SIZE = 12;
const SNAP_DISTANCE_PX = 8;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function rotate(point: Point, angle: number): Point {
	const cosine = Math.cos(angle);
	const sine = Math.sin(angle);
	return {
		x: point.x * cosine - point.y * sine,
		y: point.x * sine + point.y * cosine
	};
}

function elementBounds(element: Pick<PresentationElement, 'x' | 'y' | 'width' | 'height'>): Bounds {
	const left = Math.min(element.x, element.x + element.width);
	const right = Math.max(element.x, element.x + element.width);
	const top = Math.min(element.y, element.y + element.height);
	const bottom = Math.max(element.y, element.y + element.height);
	return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function combinedBounds(
	elements: readonly Pick<PresentationElement, 'x' | 'y' | 'width' | 'height'>[]
): Bounds {
	if (elements.length === 0) {
		return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
	}
	const entries = elements.map(elementBounds);
	const left = Math.min(...entries.map((entry) => entry.left));
	const top = Math.min(...entries.map((entry) => entry.top));
	const right = Math.max(...entries.map((entry) => entry.right));
	const bottom = Math.max(...entries.map((entry) => entry.bottom));
	return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function snapshot(element: PresentationElement): ElementSnapshot {
	return {
		element,
		x: element.x,
		y: element.y,
		width: element.width,
		height: element.height,
		rotation: element.rotation
	};
}

function midpoint(first: Point, second: Point): Point {
	return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function distance(first: Point, second: Point): number {
	return Math.hypot(second.x - first.x, second.y - first.y);
}

function currentTarget(event: PointerEvent): Element | null {
	const target = event.currentTarget;
	return target && 'setPointerCapture' in target ? (target as Element) : null;
}

function capture(target: Element | null, pointerId: number): void {
	if (!target || !('setPointerCapture' in target)) return;
	try {
		(target as Element & { setPointerCapture(id: number): void }).setPointerCapture(pointerId);
	} catch {
		// The browser can release a pointer before this handler runs.
	}
}

function release(target: Element | null, pointerId: number): void {
	if (!target || !('releasePointerCapture' in target)) return;
	try {
		(target as Element & { releasePointerCapture(id: number): void }).releasePointerCapture(
			pointerId
		);
	} catch {
		// The pointer can already belong to another target.
	}
}

export function createPresentationGestures(
	editor: PresentationEditor,
	getCanvas: () => HTMLElement | null,
	getScale: () => number,
	finishText: () => void,
	getMultiSelect: () => boolean = () => false
): PresentationGestures {
	let guideX = $state<number | null>(null);
	let guideY = $state<number | null>(null);
	let marquee = $state<PresentationMarquee | null>(null);
	let pan = $state<Point>({ x: 0, y: 0 });
	let zoom = $state(1);
	let snapEnabled = $state(true);
	let active: ActiveGesture | null = null;
	let pinch: PinchGesture | null = null;
	let frame: number | null = null;
	const pointers = new SvelteMap<number, TrackedPointer>();

	function scale(): number {
		const value = getScale();
		return Number.isFinite(value) && value > 0 ? value : 1;
	}

	function toSlide(point: Point): Point {
		const canvas = getCanvas();
		if (!canvas) return { x: 0, y: 0 };
		const rect = canvas.getBoundingClientRect();
		const factor = scale();
		return { x: (point.x - rect.left) / factor, y: (point.y - rect.top) / factor };
	}

	function track(event: PointerEvent): TrackedPointer {
		const tracked = {
			x: event.clientX,
			y: event.clientY,
			target: pointers.get(event.pointerId)?.target ?? currentTarget(event)
		};
		pointers.set(event.pointerId, tracked);
		return tracked;
	}

	function startPointer(event: PointerEvent): void {
		const tracked = track(event);
		capture(tracked.target, event.pointerId);
		// Do not cancel compatibility mouse events for a mouse or pen. The
		// canvas uses `touch-action: none` and `user-select: none`, so a touch
		// still cannot scroll the page. Cancelling pointerdown also suppresses
		// click and dblclick, which would block text editing and keyboard focus.
		if (event.pointerType === 'touch') event.preventDefault();
	}

	function startForegroundPointer(event: PointerEvent): void {
		event.stopPropagation();
		startPointer(event);
	}

	function clearGuides(): void {
		guideX = null;
		guideY = null;
	}

	function cancelFrame(): void {
		if (frame === null) return;
		if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
		frame = null;
	}

	function schedule(): void {
		if (frame !== null) return;
		if (typeof requestAnimationFrame !== 'function') {
			applyLatest();
			return;
		}
		frame = requestAnimationFrame(() => {
			frame = null;
			applyLatest();
		});
	}

	function candidates(axis: 'x' | 'y'): number[] {
		const selected = new SvelteSet(editor.selected);
		const dimension = axis === 'x' ? editor.deck.width : editor.deck.height;
		const result = [0, dimension / 2, dimension];
		for (const element of editor.slide.elements) {
			if (selected.has(element.id)) continue;
			const box = presentationElementBox(element, editor.slide);
			const bounds = {
				left: box.left,
				top: box.top,
				right: box.left + box.width,
				bottom: box.top + box.height,
				width: box.width,
				height: box.height
			};
			if (axis === 'x') result.push(bounds.left, (bounds.left + bounds.right) / 2, bounds.right);
			else result.push(bounds.top, (bounds.top + bounds.bottom) / 2, bounds.bottom);
		}
		return result;
	}

	function snapDelta(
		bounds: Bounds,
		delta: number,
		axis: 'x' | 'y'
	): { delta: number; guide: number | null } {
		if (!snapEnabled) return { delta, guide: null };
		const values =
			axis === 'x'
				? [bounds.left + delta, (bounds.left + bounds.right) / 2 + delta, bounds.right + delta]
				: [bounds.top + delta, (bounds.top + bounds.bottom) / 2 + delta, bounds.bottom + delta];
		const threshold = SNAP_DISTANCE_PX / scale();
		let correction = 0;
		let guide: number | null = null;
		let best = threshold + 1;
		for (const candidate of candidates(axis)) {
			for (const value of values) {
				const gap = candidate - value;
				if (Math.abs(gap) < best && Math.abs(gap) <= threshold) {
					best = Math.abs(gap);
					correction = gap;
					guide = candidate;
				}
			}
		}
		return { delta: delta + correction, guide };
	}

	function constrainConnector(element: PresentationElement): void {
		const endX = clamp(element.x + element.width, 0, editor.deck.width);
		const endY = clamp(element.y + element.height, 0, editor.deck.height);
		element.x = clamp(element.x, 0, editor.deck.width);
		element.y = clamp(element.y, 0, editor.deck.height);
		element.width = endX - element.x;
		element.height = endY - element.y;
	}

	function constrainElement(element: PresentationElement): void {
		if (element.type === 'line' || element.type === 'arrow') constrainConnector(element);
		else editor.constrain(element);
	}

	function materializeConnector(element: PresentationElement): void {
		if (element.type !== 'line' && element.type !== 'arrow') return;
		const startTarget = element.startId
			? editor.slide.elements.find((candidate) => candidate.id === element.startId)
			: undefined;
		const endTarget = element.endId
			? editor.slide.elements.find((candidate) => candidate.id === element.endId)
			: undefined;
		const start = startTarget
			? { x: startTarget.x + startTarget.width / 2, y: startTarget.y + startTarget.height / 2 }
			: { x: element.x, y: element.y };
		const end = endTarget
			? { x: endTarget.x + endTarget.width / 2, y: endTarget.y + endTarget.height / 2 }
			: { x: element.x + element.width, y: element.y + element.height };
		element.x = start.x;
		element.y = start.y;
		element.width = end.x - start.x;
		element.height = end.y - start.y;
		delete element.startId;
		delete element.endId;
	}

	function prepareSnapshots(): ElementSnapshot[] {
		const selected = new SvelteSet(editor.selected);
		const result: ElementSnapshot[] = [];
		for (const element of editor.elements) {
			if (element.type === 'line' || element.type === 'arrow') {
				const movesWithTargets =
					element.startId !== undefined &&
					element.endId !== undefined &&
					selected.has(element.startId) &&
					selected.has(element.endId);
				if (movesWithTargets) continue;
				materializeConnector(element);
			}
			result.push(snapshot(element));
		}
		return result;
	}

	function keepGroupInBounds(elements: readonly PresentationElement[]): void {
		const bounds = combinedBounds(elements);
		const deltaX =
			bounds.width > editor.deck.width
				? -bounds.left
				: bounds.left < 0
					? -bounds.left
					: bounds.right > editor.deck.width
						? editor.deck.width - bounds.right
						: 0;
		const deltaY =
			bounds.height > editor.deck.height
				? -bounds.top
				: bounds.top < 0
					? -bounds.top
					: bounds.bottom > editor.deck.height
						? editor.deck.height - bounds.bottom
						: 0;
		for (const element of elements) {
			element.x += deltaX;
			element.y += deltaY;
			constrainElement(element);
		}
	}

	function applyMove(gesture: MoveGesture): void {
		if (distance(gesture.startClient, gesture.latestClient) < 3) return;
		let deltaX = (gesture.latestClient.x - gesture.startClient.x) / scale();
		let deltaY = (gesture.latestClient.y - gesture.startClient.y) / scale();
		if (gesture.shiftKey) {
			if (Math.abs(deltaX) >= Math.abs(deltaY)) deltaY = 0;
			else deltaX = 0;
		}
		const snappedX = snapDelta(gesture.bounds, deltaX, 'x');
		const snappedY = snapDelta(gesture.bounds, deltaY, 'y');
		deltaX = clamp(snappedX.delta, -gesture.bounds.left, editor.deck.width - gesture.bounds.right);
		deltaY = clamp(snappedY.delta, -gesture.bounds.top, editor.deck.height - gesture.bounds.bottom);
		guideX = deltaX === snappedX.delta ? snappedX.guide : null;
		guideY = deltaY === snappedY.delta ? snappedY.guide : null;
		for (const entry of gesture.snapshots) {
			entry.element.x = entry.x + deltaX;
			entry.element.y = entry.y + deltaY;
			constrainElement(entry.element);
		}
	}

	function resizeBox(gesture: ResizeGesture): Bounds {
		let deltaX = (gesture.latestClient.x - gesture.startClient.x) / scale();
		let deltaY = (gesture.latestClient.y - gesture.startClient.y) / scale();
		if (gesture.snapshots.length === 1 && gesture.snapshots[0]!.rotation !== 0) {
			const local = rotate(
				{ x: deltaX, y: deltaY },
				(-gesture.snapshots[0]!.rotation * Math.PI) / 180
			);
			deltaX = local.x;
			deltaY = local.y;
		}
		let left = gesture.bounds.left;
		let right = gesture.bounds.right;
		let top = gesture.bounds.top;
		let bottom = gesture.bounds.bottom;
		if (gesture.handle.includes('w')) left += deltaX;
		else right += deltaX;
		if (gesture.handle.includes('n')) top += deltaY;
		else bottom += deltaY;
		if (gesture.shiftKey && gesture.bounds.width > 0 && gesture.bounds.height > 0) {
			const ratio = gesture.bounds.width / gesture.bounds.height;
			const width = Math.max(MIN_SIZE, right - left);
			const height = Math.max(MIN_SIZE, bottom - top);
			if (width / height > ratio) {
				const nextHeight = width / ratio;
				if (gesture.handle.includes('n')) top = bottom - nextHeight;
				else bottom = top + nextHeight;
			} else {
				const nextWidth = height * ratio;
				if (gesture.handle.includes('w')) left = right - nextWidth;
				else right = left + nextWidth;
			}
		}
		if (right - left < MIN_SIZE) {
			if (gesture.handle.includes('w')) left = right - MIN_SIZE;
			else right = left + MIN_SIZE;
		}
		if (bottom - top < MIN_SIZE) {
			if (gesture.handle.includes('n')) top = bottom - MIN_SIZE;
			else bottom = top + MIN_SIZE;
		}
		const horizontal = gesture.handle.includes('w') ? left : right;
		const vertical = gesture.handle.includes('n') ? top : bottom;
		const snappedX = snapDelta(
			{ left: horizontal, right: horizontal, top, bottom, width: 0, height: bottom - top },
			0,
			'x'
		);
		const snappedY = snapDelta(
			{ left, right, top: vertical, bottom: vertical, width: right - left, height: 0 },
			0,
			'y'
		);
		if (gesture.handle.includes('w')) left += snappedX.delta;
		else right += snappedX.delta;
		if (gesture.handle.includes('n')) top += snappedY.delta;
		else bottom += snappedY.delta;
		left = clamp(left, 0, editor.deck.width - MIN_SIZE);
		right = clamp(right, left + MIN_SIZE, editor.deck.width);
		top = clamp(top, 0, editor.deck.height - MIN_SIZE);
		bottom = clamp(bottom, top + MIN_SIZE, editor.deck.height);
		guideX = snappedX.guide;
		guideY = snappedY.guide;
		return { left, top, right, bottom, width: right - left, height: bottom - top };
	}

	function applyResize(gesture: ResizeGesture): void {
		const single = gesture.snapshots[0];
		if (
			gesture.snapshots.length === 1 &&
			single &&
			(single.element.type === 'line' || single.element.type === 'arrow')
		) {
			const start = { x: single.x, y: single.y };
			const end = { x: single.x + single.width, y: single.y + single.height };
			const target = {
				x: gesture.handle.includes('w') ? gesture.bounds.left : gesture.bounds.right,
				y: gesture.handle.includes('n') ? gesture.bounds.top : gesture.bounds.bottom
			};
			const moveStart = distance(start, target) <= distance(end, target);
			const fixed = moveStart ? end : start;
			const original = moveStart ? start : end;
			let moved = {
				x: original.x + (gesture.latestClient.x - gesture.startClient.x) / scale(),
				y: original.y + (gesture.latestClient.y - gesture.startClient.y) / scale()
			};
			if (gesture.shiftKey) {
				const length = distance(fixed, moved);
				const angle = Math.atan2(moved.y - fixed.y, moved.x - fixed.x);
				const constrained = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
				moved = {
					x: fixed.x + Math.cos(constrained) * length,
					y: fixed.y + Math.sin(constrained) * length
				};
			}
			const snappedX = snapDelta(
				{ left: moved.x, top: moved.y, right: moved.x, bottom: moved.y, width: 0, height: 0 },
				0,
				'x'
			);
			const snappedY = snapDelta(
				{ left: moved.x, top: moved.y, right: moved.x, bottom: moved.y, width: 0, height: 0 },
				0,
				'y'
			);
			moved.x = clamp(moved.x + snappedX.delta, 0, editor.deck.width);
			moved.y = clamp(moved.y + snappedY.delta, 0, editor.deck.height);
			const nextStart = moveStart ? moved : start;
			const nextEnd = moveStart ? end : moved;
			single.element.x = nextStart.x;
			single.element.y = nextStart.y;
			single.element.width = nextEnd.x - nextStart.x;
			single.element.height = nextEnd.y - nextStart.y;
			guideX = snappedX.guide;
			guideY = snappedY.guide;
			return;
		}
		if (
			gesture.snapshots.length === 1 &&
			single &&
			single.rotation !== 0 &&
			single.element.type !== 'line' &&
			single.element.type !== 'arrow'
		) {
			const localDelta = rotate(
				{
					x: (gesture.latestClient.x - gesture.startClient.x) / scale(),
					y: (gesture.latestClient.y - gesture.startClient.y) / scale()
				},
				(-single.rotation * Math.PI) / 180
			);
			let left = 0;
			let top = 0;
			let right = single.width;
			let bottom = single.height;
			if (gesture.handle.includes('w')) left += localDelta.x;
			else right += localDelta.x;
			if (gesture.handle.includes('n')) top += localDelta.y;
			else bottom += localDelta.y;
			if (gesture.shiftKey && single.width > 0 && single.height > 0) {
				const ratio = single.width / single.height;
				const width = Math.max(MIN_SIZE, right - left);
				const height = Math.max(MIN_SIZE, bottom - top);
				if (width / height > ratio) {
					const nextHeight = width / ratio;
					if (gesture.handle.includes('n')) top = bottom - nextHeight;
					else bottom = top + nextHeight;
				} else {
					const nextWidth = height * ratio;
					if (gesture.handle.includes('w')) left = right - nextWidth;
					else right = left + nextWidth;
				}
			}
			if (right - left < MIN_SIZE) {
				if (gesture.handle.includes('w')) left = right - MIN_SIZE;
				else right = left + MIN_SIZE;
			}
			if (bottom - top < MIN_SIZE) {
				if (gesture.handle.includes('n')) top = bottom - MIN_SIZE;
				else bottom = top + MIN_SIZE;
			}
			const localCenterShift = {
				x: (left + right - single.width) / 2,
				y: (top + bottom - single.height) / 2
			};
			const worldCenterShift = rotate(localCenterShift, (single.rotation * Math.PI) / 180);
			single.element.width = right - left;
			single.element.height = bottom - top;
			single.element.x =
				single.x + single.width / 2 + worldCenterShift.x - single.element.width / 2;
			single.element.y =
				single.y + single.height / 2 + worldCenterShift.y - single.element.height / 2;
			constrainElement(single.element);
			clearGuides();
			return;
		}
		const box = resizeBox(gesture);
		const scaleX = gesture.bounds.width > 0 ? box.width / gesture.bounds.width : 1;
		const scaleY = gesture.bounds.height > 0 ? box.height / gesture.bounds.height : 1;
		for (const entry of gesture.snapshots) {
			entry.element.x = box.left + (entry.x - gesture.bounds.left) * scaleX;
			entry.element.y = box.top + (entry.y - gesture.bounds.top) * scaleY;
			entry.element.width = entry.width * scaleX;
			entry.element.height = entry.height * scaleY;
			constrainElement(entry.element);
		}
		keepGroupInBounds(gesture.snapshots.map((entry) => entry.element));
	}

	function applyRotate(gesture: RotateGesture): void {
		const center = {
			x: (gesture.bounds.left + gesture.bounds.right) / 2,
			y: (gesture.bounds.top + gesture.bounds.bottom) / 2
		};
		const current = toSlide(gesture.latestClient);
		let delta = Math.atan2(current.y - center.y, current.x - center.x) - gesture.startAngle;
		if (gesture.shiftKey) delta = Math.round(delta / (Math.PI / 12)) * (Math.PI / 12);
		for (const entry of gesture.snapshots) {
			const originalCenter = { x: entry.x + entry.width / 2, y: entry.y + entry.height / 2 };
			const moved = rotate(
				{ x: originalCenter.x - center.x, y: originalCenter.y - center.y },
				delta
			);
			entry.element.x = center.x + moved.x - entry.width / 2;
			entry.element.y = center.y + moved.y - entry.height / 2;
			entry.element.rotation = (((entry.rotation + (delta * 180) / Math.PI) % 360) + 360) % 360;
		}
		keepGroupInBounds(gesture.snapshots.map((entry) => entry.element));
		clearGuides();
	}

	function applyMarquee(gesture: MarqueeGesture): void {
		const point = toSlide(gesture.latestClient);
		const left = clamp(Math.min(gesture.startSlide.x, point.x), 0, editor.deck.width);
		const top = clamp(Math.min(gesture.startSlide.y, point.y), 0, editor.deck.height);
		const right = clamp(Math.max(gesture.startSlide.x, point.x), 0, editor.deck.width);
		const bottom = clamp(Math.max(gesture.startSlide.y, point.y), 0, editor.deck.height);
		marquee = { x: left, y: top, width: right - left, height: bottom - top };
	}

	function applyPan(gesture: PanGesture): void {
		pan = {
			x: gesture.startPan.x + gesture.latestClient.x - gesture.startClient.x,
			y: gesture.startPan.y + gesture.latestClient.y - gesture.startClient.y
		};
	}

	function applyPinch(value: PinchGesture): void {
		const first = pointers.get(value.firstId);
		const second = pointers.get(value.secondId);
		if (!first || !second) return;
		const currentDistance = Math.max(1, distance(first, second));
		const currentMidpoint = midpoint(first, second);
		zoom = clamp(value.zoom * (currentDistance / value.distance), MIN_ZOOM, MAX_ZOOM);
		pan = {
			x: value.pan.x + currentMidpoint.x - value.midpoint.x,
			y: value.pan.y + currentMidpoint.y - value.midpoint.y
		};
	}

	function applyLatest(): void {
		if (pinch) {
			applyPinch(pinch);
			return;
		}
		if (!active) return;
		if (active.kind === 'move') applyMove(active);
		else if (active.kind === 'resize') applyResize(active);
		else if (active.kind === 'rotate') applyRotate(active);
		else if (active.kind === 'marquee') applyMarquee(active);
		else applyPan(active);
	}

	function beginPinch(): void {
		const ids = [...pointers.keys()];
		if (ids.length < 2) return;
		if (active?.operation) editor.cancel();
		active = null;
		marquee = null;
		clearGuides();
		const firstId = ids[0]!;
		const secondId = ids[1]!;
		const first = pointers.get(firstId)!;
		const second = pointers.get(secondId)!;
		pinch = {
			firstId,
			secondId,
			distance: Math.max(1, distance(first, second)),
			midpoint: midpoint(first, second),
			zoom,
			pan: { ...pan }
		};
	}

	function startObject(event: PointerEvent, element: PresentationElement): void {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		finishText();
		startForegroundPointer(event);
		if (pointers.size > 1) {
			beginPinch();
			return;
		}
		const extendSelection = event.shiftKey || event.ctrlKey || event.metaKey || getMultiSelect();
		const deselectOnTap = extendSelection && editor.selected.includes(element.id);
		if (!editor.selected.includes(element.id)) {
			editor.select(element.id, extendSelection);
		}
		if (!editor.selected.includes(element.id)) return;
		editor.begin();
		const snapshots = prepareSnapshots();
		if (snapshots.length === 0) {
			editor.cancel();
			return;
		}
		active = {
			kind: 'move',
			...(deselectOnTap ? { deselectOnTap: element.id } : {}),
			pointerId: event.pointerId,
			startClient: { x: event.clientX, y: event.clientY },
			latestClient: { x: event.clientX, y: event.clientY },
			shiftKey: event.shiftKey,
			operation: true,
			snapshots,
			bounds: combinedBounds(snapshots)
		};
	}

	function startHandle(event: PointerEvent, mode: 'resize' | 'rotate', handle = 'se'): void {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		if (editor.elements.length === 0) return;
		finishText();
		startForegroundPointer(event);
		if (pointers.size > 1) {
			beginPinch();
			return;
		}
		const safeHandle: PresentationHandle =
			handle === 'nw' || handle === 'ne' || handle === 'sw' || handle === 'se' ? handle : 'se';
		editor.begin();
		const snapshots = prepareSnapshots();
		if (snapshots.length === 0) {
			editor.cancel();
			return;
		}
		const bounds = combinedBounds(snapshots);
		const base = {
			pointerId: event.pointerId,
			startClient: { x: event.clientX, y: event.clientY },
			latestClient: { x: event.clientX, y: event.clientY },
			shiftKey: event.shiftKey,
			operation: true,
			snapshots,
			bounds
		};
		active =
			mode === 'resize'
				? { ...base, kind: 'resize', handle: safeHandle }
				: {
						...base,
						kind: 'rotate',
						startAngle: Math.atan2(
							toSlide(base.startClient).y - (bounds.top + bounds.bottom) / 2,
							toSlide(base.startClient).x - (bounds.left + bounds.right) / 2
						)
					};
	}

	function startBackground(event: PointerEvent): void {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		finishText();
		startPointer(event);
		if (pointers.size > 1) {
			beginPinch();
			return;
		}
		const base = {
			pointerId: event.pointerId,
			startClient: { x: event.clientX, y: event.clientY },
			latestClient: { x: event.clientX, y: event.clientY },
			shiftKey: event.shiftKey,
			operation: false
		};
		if (event.pointerType === 'touch' || event.altKey) {
			active = { ...base, kind: 'pan', startPan: { ...pan } };
		} else {
			const startSlide = toSlide(base.startClient);
			active = {
				...base,
				kind: 'marquee',
				startSlide,
				previousSelection: event.shiftKey ? [...editor.selected] : []
			};
			marquee = { x: startSlide.x, y: startSlide.y, width: 0, height: 0 };
			if (!event.shiftKey) editor.selected = [];
		}
	}

	function pointerMove(event: PointerEvent): void {
		if (!pointers.has(event.pointerId)) return;
		track(event);
		if (active?.pointerId === event.pointerId) {
			active.latestClient = { x: event.clientX, y: event.clientY };
			active.shiftKey = event.shiftKey;
		}
		event.preventDefault();
		schedule();
	}

	function finishMarquee(gesture: MarqueeGesture): void {
		if (!marquee) return;
		const right = marquee.x + marquee.width;
		const bottom = marquee.y + marquee.height;
		const selected = editor.slide.elements
			.filter((element) => {
				const box = presentationElementBox(element, editor.slide);
				const bounds = {
					left: box.left,
					top: box.top,
					right: box.left + box.width,
					bottom: box.top + box.height
				};
				return (
					bounds.right >= marquee!.x &&
					bounds.left <= right &&
					bounds.bottom >= marquee!.y &&
					bounds.top <= bottom
				);
			})
			.map((element) => element.id);
		editor.selected = [...new SvelteSet([...gesture.previousSelection, ...selected])];
	}

	function pointerEnd(event: PointerEvent, cancelled = false): void {
		const tracked = pointers.get(event.pointerId);
		if (!tracked) return;
		track(event);
		cancelFrame();
		applyLatest();
		pointers.delete(event.pointerId);
		release(tracked.target, event.pointerId);
		if (pinch) {
			if (event.pointerId === pinch.firstId || event.pointerId === pinch.secondId) pinch = null;
			return;
		}
		if (!active || active.pointerId !== event.pointerId) return;
		const completed = active;
		active = null;
		if (cancelled) {
			if (completed.operation) editor.cancel();
			else if (completed.kind === 'marquee') editor.selected = completed.previousSelection;
		} else if (completed.operation) {
			if (distance(completed.startClient, completed.latestClient) < 3) {
				editor.cancel();
				if (completed.kind === 'move' && completed.deselectOnTap)
					editor.select(completed.deselectOnTap, true);
			} else editor.commit();
		} else if (completed.kind === 'marquee') {
			finishMarquee(completed);
		}
		marquee = null;
		clearGuides();
	}

	function resetView(): void {
		pan = { x: 0, y: 0 };
		zoom = 1;
		marquee = null;
		clearGuides();
	}

	function cancel(): void {
		cancelFrame();
		if (active?.operation) editor.cancel();
		else if (active?.kind === 'marquee') editor.selected = active.previousSelection;
		for (const [pointerId, tracked] of pointers) release(tracked.target, pointerId);
		pointers.clear();
		active = null;
		pinch = null;
		marquee = null;
		clearGuides();
	}

	return {
		get guideX() {
			return guideX;
		},
		get guideY() {
			return guideY;
		},
		get marquee() {
			return marquee;
		},
		get pan() {
			return pan;
		},
		get zoom() {
			return zoom;
		},
		set zoom(value: number) {
			if (Number.isFinite(value)) zoom = clamp(value, MIN_ZOOM, MAX_ZOOM);
		},
		get snap() {
			return snapEnabled;
		},
		set snap(value: boolean) {
			snapEnabled = value;
			if (!value) clearGuides();
		},
		startObject,
		startHandle,
		startBackground,
		pointerMove,
		pointerEnd,
		resetView,
		cancel
	};
}
