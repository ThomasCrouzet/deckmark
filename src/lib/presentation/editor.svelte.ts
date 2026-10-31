import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
	createDeck,
	createElement,
	createSlide,
	parsePresentation,
	serializePresentation,
	type PresentationDeck,
	type PresentationElement,
	type PresentationElementType
} from './model';

type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type NumericProperty =
	'x' | 'y' | 'width' | 'height' | 'rotation' | 'fontSize' | 'strokeWidth';

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

let clipboard: PresentationElement[] = [];

/** Keep one undo entry for each completed user operation. */
export class PresentationEditor {
	deck = $state<PresentationDeck>(createDeck());
	index = $state(0);
	selected = $state<string[]>([]);
	source = $state('');
	error = $state(false);
	undoEntries = $state<string[]>([]);
	redoEntries = $state<string[]>([]);
	clipboardAvailable = $state(clipboard.length > 0);
	private operationStart: string | null = null;
	private operationSource: string | null = null;
	private operationDeck: PresentationDeck | null = null;
	private write: (source: string) => void;

	constructor(source: string, write: (source: string) => void) {
		this.write = write;
		this.receive(source);
	}

	get slide() {
		return this.deck.slides[this.index]!;
	}
	get elements() {
		return this.slide.elements.filter((element) => this.selected.includes(element.id));
	}
	get primary() {
		return this.elements[0];
	}

	receive(source: string): boolean {
		if (source === this.source && !this.error) return false;
		this.source = source;
		try {
			this.deck = parsePresentation(source);
			this.index = Math.min(this.index, this.deck.slides.length - 1);
			this.selected = [];
			this.error = false;
			this.undoEntries = [];
			this.redoEntries = [];
			this.operationStart = null;
			this.operationSource = null;
			this.operationDeck = null;
		} catch {
			this.error = true;
		}
		return true;
	}

	writeSource(source: string) {
		this.receive(source);
		this.write(source);
	}

	begin() {
		if (this.operationStart === null) {
			this.operationStart = serializePresentation(this.deck);
			this.operationSource = this.source;
			this.operationDeck = clone(this.deck);
		}
	}

	commit() {
		const source = serializePresentation(this.deck);
		if (this.operationStart === source) {
			this.operationStart = null;
			this.operationSource = null;
			this.operationDeck = null;
			return;
		}
		if (this.operationStart !== null && this.operationStart !== source) {
			this.undoEntries = [...this.undoEntries, this.operationSource ?? this.operationStart].slice(
				-60
			);
			let bytes = this.undoEntries.reduce((total, entry) => total + entry.length * 2, 0);
			while (bytes > 24 * 1024 * 1024 && this.undoEntries.length > 1) {
				bytes -= this.undoEntries[0]!.length * 2;
				this.undoEntries = this.undoEntries.slice(1);
			}
			this.redoEntries = [];
		}
		this.operationStart = null;
		this.operationSource = null;
		this.operationDeck = null;
		this.publish(source);
	}

	publish(source = serializePresentation(this.deck)) {
		if (source === this.source) return;
		this.source = source;
		this.write(source);
	}

	cancel() {
		if (this.operationStart === null) return;
		this.deck = this.operationDeck ?? parsePresentation(this.operationStart);
		this.operationStart = null;
		this.operationSource = null;
		this.operationDeck = null;
	}

	change(operation: () => void) {
		if (this.error) return;
		this.begin();
		operation();
		this.commit();
	}

	undo() {
		if (this.operationStart !== null) this.commit();
		const previous = this.undoEntries.at(-1);
		if (!previous) return;
		this.redoEntries = [...this.redoEntries, serializePresentation(this.deck)];
		this.undoEntries = this.undoEntries.slice(0, -1);
		this.deck = parsePresentation(previous);
		this.index = Math.min(this.index, this.deck.slides.length - 1);
		this.selected = [];
		this.publish(previous);
	}

	redo() {
		if (this.operationStart !== null) this.commit();
		const next = this.redoEntries.at(-1);
		if (!next) return;
		this.undoEntries = [...this.undoEntries, serializePresentation(this.deck)];
		this.redoEntries = this.redoEntries.slice(0, -1);
		this.deck = parsePresentation(next);
		this.index = Math.min(this.index, this.deck.slides.length - 1);
		this.selected = [];
		this.publish(next);
	}

	select(id: string, extend = false) {
		const element = this.slide.elements.find((entry) => entry.id === id);
		if (!element) return;
		const ids = element.groupId
			? this.slide.elements
					.filter((entry) => entry.groupId === element.groupId)
					.map((entry) => entry.id)
			: [id];
		this.selected = extend
			? ids.every((value) => this.selected.includes(value))
				? this.selected.filter((value) => !ids.includes(value))
				: [...new SvelteSet([...this.selected, ...ids])]
			: ids;
	}

	selectSlide(index: number) {
		this.index = Math.max(0, Math.min(index, this.deck.slides.length - 1));
		this.selected = [];
	}

	addSlide() {
		this.change(() => {
			this.deck.slides.splice(
				this.index + 1,
				0,
				createSlide({ background: this.slide.background })
			);
			this.selectSlide(this.index + 1);
		});
	}

	duplicateSlide() {
		this.change(() => {
			const slide = clone(this.slide);
			slide.id = createSlide().id;
			slide.elements = this.cloneElements(slide.elements, false);
			this.deck.slides.splice(this.index + 1, 0, slide);
			this.selectSlide(this.index + 1);
		});
	}

	deleteSlide() {
		this.change(() => {
			this.deck.slides.splice(this.index, 1);
			if (!this.deck.slides.length) this.deck.slides.push(createSlide());
			this.selectSlide(Math.min(this.index, this.deck.slides.length - 1));
		});
	}

	moveSlide(from: number, to: number) {
		if (to < 0 || to >= this.deck.slides.length || from === to) return;
		this.change(() => {
			const [slide] = this.deck.slides.splice(from, 1);
			if (slide) this.deck.slides.splice(to, 0, slide);
			this.selectSlide(to);
		});
	}

	add(type: PresentationElementType, content = '') {
		const offset = (this.slide.elements.length % 8) * 24;
		const element = createElement(type, {
			x: 100 + offset,
			y: 100 + offset,
			content,
			color: type === 'text' && this.deck.theme === 'dark' ? '#f8fafc' : '#172033'
		});
		this.constrain(element);
		this.change(() => {
			this.slide.elements.push(element);
			this.selected = [element.id];
		});
		return element.id;
	}

	setProperty(key: keyof PresentationElement, value: string | number) {
		this.change(() => {
			for (const element of this.elements) {
				if (['x', 'y', 'width', 'height'].includes(key)) this.materializeConnector(element);
				Object.assign(element, { [key]: value });
				this.constrain(element);
			}
		});
	}

	private materializeConnector(element: PresentationElement, detach = true) {
		if (element.type !== 'line' && element.type !== 'arrow') return;
		const startTarget = element.startId
			? this.slide.elements.find((candidate) => candidate.id === element.startId)
			: undefined;
		const endTarget = element.endId
			? this.slide.elements.find((candidate) => candidate.id === element.endId)
			: undefined;
		if (!startTarget && !endTarget) return;
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
		if (detach) {
			delete element.startId;
			delete element.endId;
		}
	}

	private elementBounds(element: PresentationElement) {
		const endX = element.x + element.width;
		const endY = element.y + element.height;
		const left = Math.min(element.x, endX);
		const top = Math.min(element.y, endY);
		const right = Math.max(element.x, endX);
		const bottom = Math.max(element.y, endY);
		return { left, top, right, bottom, width: right - left, height: bottom - top };
	}

	moveSelection(deltaX: number, deltaY: number) {
		if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || !this.elements.length) return;
		this.change(() => {
			for (const element of this.elements) {
				this.materializeConnector(element);
				element.x += deltaX;
				element.y += deltaY;
				this.constrain(element);
			}
		});
	}

	constrain(element: PresentationElement) {
		if (element.type === 'line' || element.type === 'arrow') {
			const endX = Math.max(0, Math.min(this.deck.width, element.x + element.width));
			const endY = Math.max(0, Math.min(this.deck.height, element.y + element.height));
			element.x = Math.max(0, Math.min(this.deck.width, element.x));
			element.y = Math.max(0, Math.min(this.deck.height, element.y));
			element.width = endX - element.x;
			element.height = endY - element.y;
			element.rotation = ((element.rotation % 360) + 360) % 360;
			element.fontSize = Math.max(8, Math.min(200, element.fontSize));
			element.strokeWidth = Math.max(0, Math.min(32, element.strokeWidth));
			return;
		}
		element.width = Math.max(12, Math.min(this.deck.width, element.width));
		element.height = Math.max(12, Math.min(this.deck.height, element.height));
		element.x = Math.max(0, Math.min(this.deck.width - element.width, element.x));
		element.y = Math.max(0, Math.min(this.deck.height - element.height, element.y));
		element.rotation = ((element.rotation % 360) + 360) % 360;
		element.fontSize = Math.max(8, Math.min(200, element.fontSize));
		element.strokeWidth = Math.max(0, Math.min(32, element.strokeWidth));
	}

	remove() {
		this.change(() => {
			for (const element of this.slide.elements) {
				const removeStart =
					element.startId !== undefined && this.selected.includes(element.startId);
				const removeEnd = element.endId !== undefined && this.selected.includes(element.endId);
				if (!removeStart && !removeEnd) continue;
				this.materializeConnector(element, false);
				if (removeStart) delete element.startId;
				if (removeEnd) delete element.endId;
			}
			this.slide.elements = this.slide.elements.filter(
				(element) => !this.selected.includes(element.id)
			);
			this.selected = [];
		});
	}

	copy() {
		const selected = new SvelteSet(this.selected);
		clipboard = this.elements.map((original) => {
			const element = clone(original);
			this.materializeConnector(element, false);
			if (element.startId && !selected.has(element.startId)) delete element.startId;
			if (element.endId && !selected.has(element.endId)) delete element.endId;
			return element;
		});
		this.clipboardAvailable = clipboard.length > 0;
		return `mdsh-slide-elements\n${JSON.stringify(clipboard)}`;
	}

	private cloneElements(elements: PresentationElement[], offset = true) {
		const ids = new SvelteMap(
			elements.map((element) => [element.id, createElement(element.type).id])
		);
		const groups = new SvelteMap<string, string>();
		return elements.map((original) => {
			const element = clone(original);
			element.id = ids.get(original.id)!;
			if (offset) {
				element.x += 24;
				element.y += 24;
			}
			if (element.groupId) {
				if (!groups.has(element.groupId)) groups.set(element.groupId, createElement('text').id);
				element.groupId = groups.get(element.groupId)!;
			}
			if (element.startId) {
				const mapped = ids.get(element.startId);
				if (mapped) element.startId = mapped;
				else delete element.startId;
			}
			if (element.endId) {
				const mapped = ids.get(element.endId);
				if (mapped) element.endId = mapped;
				else delete element.endId;
			}
			this.constrain(element);
			return element;
		});
	}

	paste(text?: string) {
		let elements = clipboard;
		if (text?.startsWith('mdsh-slide-elements\n')) {
			try {
				const candidate = JSON.parse(
					text.slice('mdsh-slide-elements\n'.length)
				) as PresentationElement[];
				const deck = createDeck();
				deck.slides[0]!.elements = candidate;
				elements = parsePresentation(serializePresentation(deck)).slides[0]!.elements;
			} catch {
				return;
			}
		}
		if (!elements.length) return;
		this.change(() => {
			const copied = this.cloneElements(elements);
			this.slide.elements.push(...copied);
			this.selected = copied.map((element) => element.id);
		});
	}

	duplicate() {
		this.copy();
		this.paste();
	}

	group() {
		if (this.selected.length < 2) return;
		this.setProperty('groupId', createElement('text').id);
	}

	ungroup() {
		this.change(() => {
			for (const element of this.elements) delete element.groupId;
		});
	}

	layer(direction: 'front' | 'back' | 'forward' | 'backward') {
		this.change(() => {
			const selected = this.elements;
			const others = this.slide.elements.filter((element) => !this.selected.includes(element.id));
			if (direction === 'front') this.slide.elements = [...others, ...selected];
			else if (direction === 'back') this.slide.elements = [...selected, ...others];
			else {
				const entries = this.slide.elements;
				const step = direction === 'forward' ? 1 : -1;
				const ordered = step === 1 ? [...selected].reverse() : selected;
				for (const element of ordered) {
					const index = entries.findIndex((entry) => entry.id === element.id);
					const next = entries[index + step];
					if (next && !this.selected.includes(next.id)) {
						entries[index] = next;
						entries[index + step] = element;
					}
				}
			}
		});
	}

	align(alignment: Alignment) {
		if (!this.elements.length) return;
		this.change(() => {
			const elements = this.elements;
			for (const element of elements) this.materializeConnector(element);
			const bounds = elements.map((element) => this.elementBounds(element));
			const box =
				elements.length === 1
					? { left: 0, top: 0, right: this.deck.width, bottom: this.deck.height }
					: {
							left: Math.min(...bounds.map((entry) => entry.left)),
							top: Math.min(...bounds.map((entry) => entry.top)),
							right: Math.max(...bounds.map((entry) => entry.right)),
							bottom: Math.max(...bounds.map((entry) => entry.bottom))
						};
			for (const [index, element] of elements.entries()) {
				const current = bounds[index]!;
				if (alignment === 'left') element.x += box.left - current.left;
				if (alignment === 'center') {
					element.x += (box.left + box.right - current.left - current.right) / 2;
				}
				if (alignment === 'right') element.x += box.right - current.right;
				if (alignment === 'top') element.y += box.top - current.top;
				if (alignment === 'middle') {
					element.y += (box.top + box.bottom - current.top - current.bottom) / 2;
				}
				if (alignment === 'bottom') element.y += box.bottom - current.bottom;
				this.constrain(element);
			}
		});
	}

	distribute(axis: 'x' | 'y') {
		if (this.elements.length < 3) return;
		this.change(() => {
			const selected = this.elements;
			for (const element of selected) this.materializeConnector(element);
			const entries = selected
				.map((element) => ({ element, bounds: this.elementBounds(element) }))
				.sort((a, b) =>
					axis === 'x' ? a.bounds.left - b.bounds.left : a.bounds.top - b.bounds.top
				);
			const first = entries[0]!.bounds;
			const last = entries.at(-1)!.bounds;
			const start = axis === 'x' ? first.left : first.top;
			const end = axis === 'x' ? last.right : last.bottom;
			const totalSize = entries.reduce(
				(sum, entry) => sum + (axis === 'x' ? entry.bounds.width : entry.bounds.height),
				0
			);
			const gap = (end - start - totalSize) / (entries.length - 1);
			let position = start;
			for (const entry of entries) {
				const current = axis === 'x' ? entry.bounds.left : entry.bounds.top;
				entry.element[axis] += position - current;
				position += (axis === 'x' ? entry.bounds.width : entry.bounds.height) + gap;
				this.constrain(entry.element);
			}
		});
	}

	connect() {
		if (this.elements.length !== 2) return;
		const [start, end] = this.elements;
		this.change(() => {
			const arrow = createElement('arrow', { startId: start!.id, endId: end!.id });
			this.slide.elements.push(arrow);
			this.selected = [arrow.id];
		});
	}

	setAspect(aspect: string) {
		const height = aspect === '4:3' ? 960 : aspect === '1:1' ? 1280 : 720;
		this.change(() => {
			const ratioX = 1280 / this.deck.width;
			const ratioY = height / this.deck.height;
			this.deck.width = 1280;
			this.deck.height = height;
			for (const slide of this.deck.slides)
				for (const element of slide.elements) {
					element.x *= ratioX;
					element.y *= ratioY;
					element.width *= ratioX;
					element.height *= ratioY;
				}
		});
	}
}
