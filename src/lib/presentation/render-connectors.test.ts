import { describe, expect, it } from 'vitest';
import type { PresentationDeck, PresentationElement, PresentationSlide } from './model';
import {
	indexPresentationElements,
	presentationElementBox,
	presentationElementRender,
	renderPresentationConnector,
	renderPresentationSlide
} from './render';

/**
 * The browser suite checks visible connector geometry. It cannot count the
 * element reads behind one render pass, so it cannot detect a return to a full
 * slide scan for every connector. These isolated cases keep that work bound.
 * See docs/TESTING.md.
 */

function element(id: string, overrides: Partial<PresentationElement> = {}): PresentationElement {
	return {
		id,
		type: 'line',
		x: 0,
		y: 0,
		width: 10,
		height: 0,
		rotation: 0,
		fill: 'transparent',
		stroke: '#334155',
		strokeWidth: 2,
		color: '#0f172a',
		fontSize: 24,
		textAlign: 'left',
		content: '',
		...overrides
	};
}

function slide(elements: PresentationElement[]): PresentationSlide {
	return { id: 'dense', background: '#ffffff', notes: '', elements };
}

function deck(elements: PresentationElement[]): PresentationDeck {
	return { version: 1, width: 1600, height: 900, theme: 'light', slides: [slide(elements)] };
}

/** Counts each `id` read, which is the endpoint lookup work. */
function counted(element: PresentationElement, reads: { count: number }): PresentationElement {
	const result = { ...element };
	Object.defineProperty(result, 'id', {
		enumerable: true,
		get() {
			reads.count += 1;
			return element.id;
		}
	});
	return result;
}

/** Targets stay ahead of their connectors, as in a dense linked diagram. */
function denseElements(targetCount: number, connectorCount: number): PresentationElement[] {
	const targets = Array.from({ length: targetCount }, (_, index) =>
		element(`target-${index}`, { x: index * 4, y: 10, width: 20, height: 20 })
	);
	const connectors = Array.from({ length: connectorCount }, (_, index) =>
		element(`connector-${index}`, {
			type: 'arrow',
			x: 0,
			y: 100 + index,
			width: 5,
			height: 5,
			startId: `target-${targetCount - 1 - (index % targetCount)}`,
			endId: `target-${index % targetCount}`
		})
	);
	return [...targets, ...connectors];
}

describe('connector endpoint lookup bound', () => {
	it('reads a linear number of element ids for a dense linked slide', async () => {
		const reads = { count: 0 };
		const elements = denseElements(200, 200).map((entry) => counted(entry, reads));
		const rendered = await renderPresentationSlide(deck(elements), slide(elements), 0);
		expect(rendered).toContain('mdsh-slide-connector');
		console.log(
			`connector lookup reads: ${reads.count} for ${elements.length} elements (bound ${elements.length * 6})`
		);
		expect(reads.count).toBeLessThanOrEqual(elements.length * 6);
	});

	it('records a reproducible dense render pass benchmark', async () => {
		const targetCount = 2000;
		const connectorCount = 2000;
		const elements = denseElements(targetCount, connectorCount);
		const denseDeck = deck(elements);
		const denseSlide = slide(elements);
		const samples: number[] = [];
		for (let run = 0; run < 5; run++) {
			const start = performance.now();
			await renderPresentationSlide(denseDeck, denseSlide, 0);
			samples.push(Number((performance.now() - start).toFixed(2)));
		}
		samples.sort((first, second) => first - second);
		const p50 = samples[Math.floor(samples.length / 2)];
		const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)];
		console.log(
			`connector benchmark: ${JSON.stringify({
				elements: targetCount + connectorCount,
				connectors: connectorCount,
				runs: samples.length,
				p50ms: p50,
				p95ms: p95,
				samples
			})}`
		);
		expect(samples).toHaveLength(5);
	});
});

describe('connector endpoint index', () => {
	const shape = element('shape', { type: 'rectangle', x: 10, y: 20, width: 100, height: 50 });
	const arrow = element('arrow', {
		type: 'arrow',
		x: 300,
		y: 200,
		width: 40,
		height: 20,
		startId: 'shape',
		endId: 'missing'
	});
	const linkedSlide = slide([shape, arrow]);

	it('matches the slide scan for a connected and a missing endpoint', () => {
		const index = indexPresentationElements(linkedSlide.elements);
		const box = presentationElementBox(arrow, linkedSlide, index);
		expect(box).toEqual(presentationElementBox(arrow, linkedSlide));
		// Start at the shape center, end at the arrow's own far corner.
		expect(box).toEqual({
			left: 60,
			top: 45,
			width: 280,
			height: 175,
			x1: 0,
			y1: 0,
			x2: 280,
			y2: 175
		});
	});

	it('keeps the first element when two elements share an id', () => {
		const first = element('same', { x: 0, y: 0, width: 10, height: 10 });
		const second = element('same', { x: 100, y: 100, width: 10, height: 10 });
		const link = element('link', {
			type: 'arrow',
			x: 200,
			y: 200,
			width: 10,
			height: 10,
			startId: 'same'
		});
		const shared = slide([first, second, link]);
		const index = indexPresentationElements(shared.elements);
		expect(index.get('same')).toBe(first);
		expect(presentationElementBox(link, shared, index)).toEqual(
			presentationElementBox(link, shared)
		);
	});

	it('reads endpoint geometry changes after the index is built', () => {
		const moving = element('moving', { type: 'rectangle', x: 0, y: 0, width: 40, height: 40 });
		const link = element('link', {
			type: 'arrow',
			x: 200,
			y: 200,
			width: 10,
			height: 10,
			startId: 'moving'
		});
		const movingSlide = slide([moving, link]);
		const index = indexPresentationElements(movingSlide.elements);
		const before = presentationElementBox(link, movingSlide, index);
		moving.x = 100;
		moving.y = 100;
		const after = presentationElementBox(link, movingSlide, index);
		expect(after).not.toEqual(before);
		expect(after).toEqual(presentationElementBox(link, movingSlide));
	});

	it('reuses one connector box for the style and the SVG line', () => {
		const index = indexPresentationElements(linkedSlide.elements);
		const rendered = presentationElementRender(arrow, linkedSlide, index);
		expect(rendered.style).toContain('left:60px;top:45px;width:280px;height:175px');
		expect(rendered.connector).toContain('viewBox="0 0 280 175"');
		expect(rendered.connector).toContain('<line x1="0" y1="0" x2="280" y2="175"');
		expect(rendered.connector).toBe(renderPresentationConnector(arrow, linkedSlide));
	});
});
