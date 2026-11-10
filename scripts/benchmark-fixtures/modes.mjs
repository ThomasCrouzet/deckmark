import { createHash } from 'node:crypto';
import { noteContent } from './corpus.mjs';
import { stressFixture } from './stress.mjs';

export const modeFixtures = [
	{ id: 'read-rich-30', kind: 'read' },
	{ id: 'read-markdown-1mb', kind: 'read' },
	{ id: 'deck-20', kind: 'deck' },
	{ id: 'deck-100', kind: 'deck' },
	{ id: 'deck-300', kind: 'deck' }
];

export const modeCases = [
	{ id: 'read/read-rich-30/lib-0', mode: 'read', fixture: 'read-rich-30', library: 0 },
	{ id: 'read/read-markdown-1mb/lib-0', mode: 'read', fixture: 'read-markdown-1mb', library: 0 },
	{ id: 'slide-text/deck-20/lib-0', mode: 'slide-text', fixture: 'deck-20', library: 0 },
	{ id: 'slide-text/deck-100/lib-0', mode: 'slide-text', fixture: 'deck-100', library: 0 },
	{ id: 'slide-text/deck-300/lib-0', mode: 'slide-text', fixture: 'deck-300', library: 0 },
	{ id: 'slide-notes/deck-20/lib-0', mode: 'slide-notes', fixture: 'deck-20', library: 0 },
	{ id: 'slide-notes/deck-100/lib-0', mode: 'slide-notes', fixture: 'deck-100', library: 0 },
	{ id: 'slide-notes/deck-300/lib-0', mode: 'slide-notes', fixture: 'deck-300', library: 0 },
	{ id: 'wysiwyg/read-rich-30/lib-0', mode: 'wysiwyg', fixture: 'read-rich-30', library: 0 },
	{ id: 'slide-canvas/deck-20/lib-0', mode: 'slide-canvas', fixture: 'deck-20', library: 0 },
	{ id: 'annotation/read-rich-30/lib-0', mode: 'annotation', fixture: 'read-rich-30', library: 0 },
	{ id: 'slide-source/deck-20/lib-0', mode: 'slide-source', fixture: 'deck-20', library: 0 }
];

export function modeMatrix() {
	return {
		schema: 'deckmark-mode-matrix/1',
		fixtures: modeFixtures,
		cases: modeCases.map((entry) => ({
			...entry,
			adapter: 'web',
			expected: expectedWorkload(entry)
		}))
	};
}

export function expectedWorkload(entry) {
	if (entry.mode === 'read')
		return entry.fixture === 'read-rich-30'
			? { diagrams: 30, tail: 'Read tail sentinel', approximation: false }
			: { diagrams: 0, tail: 'Read tail sentinel', approximation: false };
	if (entry.mode === 'wysiwyg') return { kind: 'wysiwyg', tail: 'Read tail sentinel' };
	if (entry.mode === 'slide-canvas') return { kind: 'canvas', objectType: 'rectangle' };
	if (entry.mode === 'annotation') return { kind: 'annotation', strokes: 20 };
	if (entry.mode === 'slide-source')
		return { kind: 'slide-source', initial: '# Benchmark slide 0' };
	return entry.mode === 'slide-text'
		? {
				field: 'text',
				initialField: '# Benchmark slide 0\n\nStable slide text.',
				position: 'start/middle/end of the edited field'
			}
		: {
				field: 'notes',
				initialField: 'Speaker notes 0.',
				position: 'start/middle/end of the edited field'
			};
}

function readRichContent() {
	const sections = Array.from({ length: 30 }, (_, index) =>
		[
			`## Read section ${index}`,
			'Stable paragraph for the Read-mode benchmark.',
			`\`\`\`mermaid\nflowchart LR\nRead${index} --> Next${index}\n\`\`\``,
			'$$x^2 + y^2 = z^2$$',
			`| Key | Value |\n| --- | --- |\n| ${index} | ${index + 1} |`
		].join('\n\n')
	);
	return `${sections.join('\n\n')}\n\n## Read tail sentinel\n\nComplete tail.\n`;
}

export function modeFixture(id) {
	const definition = modeFixtures.find((entry) => entry.id === id);
	if (!definition) throw new Error(`Unknown mode fixture: ${id}`);
	if (definition.kind === 'deck') {
		const deck = stressFixture(id);
		return {
			...deck,
			id,
			generator: 'scripts/benchmark-fixtures/modes.mjs#modeFixture',
			arguments: { id }
		};
	}
	const content =
		id === 'read-rich-30'
			? readRichContent()
			: `${noteContent(327, 1_000_000)}\n\n## Read tail sentinel\n\nComplete tail.\n`;
	return {
		id,
		name: `${id}.md`,
		content,
		bytes: Buffer.byteLength(content),
		sha256: createHash('sha256').update(content).digest('hex'),
		generator: 'scripts/benchmark-fixtures/modes.mjs#modeFixture',
		arguments: { id }
	};
}
