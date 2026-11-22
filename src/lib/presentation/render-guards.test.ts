import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import type { PresentationDeck, PresentationElement, PresentationSlide } from './model';
import { presentationElementAppearance, renderPresentationSlide } from './render';

/**
 * The browser suite renders a real slide, but the model parser rejects an
 * unsupported alignment before any markup exists. It therefore cannot deliver
 * a hostile value to the renderer. This isolated case covers that one path.
 */

function textElement(overrides: Partial<PresentationElement> = {}): PresentationElement {
	return {
		id: 'text-1',
		type: 'text',
		x: 80,
		y: 80,
		width: 1120,
		height: 560,
		rotation: 0,
		fill: 'transparent',
		stroke: 'none',
		strokeWidth: 0,
		color: '#111827',
		fontSize: 30,
		textAlign: 'left',
		content: 'Slide body',
		...overrides
	};
}

function deckFor(element: PresentationElement): PresentationDeck {
	const slide: PresentationSlide = {
		id: 'slide-1',
		background: '#ffffff',
		notes: '',
		elements: [element]
	};
	return { version: 1, width: 1280, height: 720, theme: 'light', slides: [slide] };
}

describe('presentation render guards', () => {
	it('whitelists an injected alignment before the style attribute', async () => {
		const element = textElement({
			textAlign: 'left" onmouseover="alert(1)' as PresentationElement['textAlign']
		});
		const appearance = presentationElementAppearance(element);
		expect(appearance).toContain('--element-text-align:left');
		expect(appearance).not.toContain('"');
		const html = await renderPresentationSlide(deckFor(element), deckFor(element).slides[0]!, 0);
		expect(html).not.toContain('onmouseover');
		expect(html).toContain('--element-text-align:left');
	});

	it('renders the authoring placeholder empty on an exported slide', async () => {
		const element = textElement({ content: t('slides.newText') });
		const deck = deckFor(element);
		const html = await renderPresentationSlide(deck, deck.slides[0]!, 0);
		expect(html).not.toContain('Your text');
		expect(html).toContain('mdsh-slide-element-text');
	});
});
