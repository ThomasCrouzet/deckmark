import { describe, expect, it } from 'vitest';
import {
	createPresentationSerializeCache,
	parsePresentation,
	primePresentationSerializeCache,
	serializePresentation,
	serializePresentationCached
} from './model';

const ordinary = [
	'---',
	'title: "A: B" # keep this comment',
	'count: 01',
	'---',
	'',
	'# First slide',
	'',
	'---',
	'',
	'```md',
	'---',
	'```',
	''
].join('\n');

describe('presentation format round trip', () => {
	it('keeps the exact bytes of a document without presentation metadata', () => {
		const deck = parsePresentation(ordinary);
		expect(serializePresentation(deck)).toBe(ordinary);
	});

	it('keeps cached slide output identical to a full serialization', () => {
		const deck = parsePresentation(ordinary);
		const cache = createPresentationSerializeCache();
		serializePresentationCached(deck, cache);
		deck.slides[0]!.elements[0]!.x += 1;
		expect(serializePresentationCached(deck, cache)).toBe(serializePresentation(deck));
	});

	it('validates a changed slide while reusing unchanged cached slides', () => {
		const deck = parsePresentation(ordinary);
		deck.slides.push({
			...deck.slides[0]!,
			id: 'second-slide',
			elements: deck.slides[0]!.elements.map((element) => ({
				...element,
				id: 'second-element'
			}))
		});
		const cache = createPresentationSerializeCache();
		const first = serializePresentationCached(deck, cache);
		deck.slides[0]!.elements[0]!.x += 1;
		expect(serializePresentationCached(deck, cache)).not.toBe(first);
		deck.slides[1]!.elements[0]!.width = -1;
		expect(() => serializePresentationCached(deck, cache)).toThrow();
	});

	it('validates and reserializes only dirty slides when the caller supplies a scope', () => {
		const deck = parsePresentation(
			[
				'---',
				'title: "Scoped"',
				'---',
				'',
				'# First slide',
				'',
				'---',
				'',
				'# Second slide',
				'',
				'```md',
				'---',
				'```',
				'',
				'---',
				'',
				'# Third slide'
			].join('\r\n')
		);
		const cache = createPresentationSerializeCache();
		primePresentationSerializeCache(deck, cache);
		const counts: Record<string, number> = {};
		const listener = (event: Event) => {
			const detail = (event as CustomEvent<{ kind: string; name: string }>).detail;
			if (detail.kind === 'counter') counts[detail.name] = (counts[detail.name] ?? 0) + 1;
		};
		(window as { __MDSH_EDITOR_PERF__?: boolean }).__MDSH_EDITOR_PERF__ = true;
		window.addEventListener('deckmark:editor-perf', listener);
		try {
			const changed = deck.slides[1]!;
			changed.elements[0]!.x += 1;
			const output = serializePresentationCached(deck, cache, new Set([changed.id]));
			window.removeEventListener('deckmark:editor-perf', listener);
			expect(output).toBe(serializePresentation(deck));
			expect(counts['presentation.slide.validate']).toBe(1);
			expect(counts['presentation.slide.reuse']).toBe(2);
			expect(counts['presentation.metadata.reuse']).toBe(2);
		} finally {
			window.removeEventListener('deckmark:editor-perf', listener);
			(window as { __MDSH_EDITOR_PERF__?: boolean }).__MDSH_EDITOR_PERF__ = false;
		}
	});

	it('revalidates every slide after a deck dimension change', () => {
		const deck = parsePresentation(ordinary);
		const cache = createPresentationSerializeCache();
		serializePresentationCached(deck, cache);
		deck.width = 960;
		deck.slides[0]!.elements[0]!.x = 900;
		expect(() => serializePresentationCached(deck, cache)).toThrow();
	});

	it('adds presentation metadata after the deck changes', () => {
		const deck = parsePresentation(ordinary);
		deck.slides[0]!.elements[0]!.x += 1;
		const output = serializePresentation(deck);
		expect(output).toContain('<!-- mdsh-presentation');
		expect(output).toContain('title: "A: B" # keep this comment');
	});
});
