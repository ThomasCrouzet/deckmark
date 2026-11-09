import { describe, expect, it } from 'vitest';
import {
	createPresentationSerializeCache,
	parsePresentation,
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

	it('adds presentation metadata after the deck changes', () => {
		const deck = parsePresentation(ordinary);
		deck.slides[0]!.elements[0]!.x += 1;
		const output = serializePresentation(deck);
		expect(output).toContain('<!-- mdsh-presentation');
		expect(output).toContain('title: "A: B" # keep this comment');
	});
});
