import { describe, expect, it } from 'vitest';
import { parsePresentation, serializePresentation } from './model';

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

	it('adds presentation metadata after the deck changes', () => {
		const deck = parsePresentation(ordinary);
		deck.slides[0]!.elements[0]!.x += 1;
		const output = serializePresentation(deck);
		expect(output).toContain('<!-- mdsh-presentation');
		expect(output).toContain('title: "A: B" # keep this comment');
	});
});
