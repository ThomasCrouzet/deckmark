import { createHash } from 'node:crypto';
import { libraryRows, noteContent } from './corpus.mjs';

export const stressFixtures = [
	{ id: 'markdown-50kb', kind: 'markdown', bytes: 50_000 },
	{ id: 'markdown-240kb', kind: 'markdown', bytes: 240_000 },
	{ id: 'markdown-1mb', kind: 'markdown', bytes: 1_000_000 },
	{ id: 'markdown-5mb', kind: 'markdown', bytes: 5_000_000 },
	{ id: 'line-1mb', kind: 'line', bytes: 1_000_000 },
	{ id: 'headings-1000', kind: 'headings', headings: 1000 },
	{ id: 'rich-markdown', kind: 'rich', sections: 100 },
	{ id: 'code-50kb', kind: 'code', bytes: 50_000 },
	{ id: 'code-1mb', kind: 'code', bytes: 1_000_000 },
	{ id: 'code-5mb', kind: 'code', bytes: 5_000_000 },
	{ id: 'json-50kb', kind: 'json', bytes: 50_000 },
	{ id: 'json-1mb', kind: 'json', bytes: 1_000_000 },
	{ id: 'json-5mb', kind: 'json', bytes: 5_000_000 },
	{ id: 'json-10mb', kind: 'json', bytes: 10_000_000 },
	{ id: 'deck-20', kind: 'deck', slides: 20 },
	{ id: 'deck-100', kind: 'deck', slides: 100 },
	{ id: 'deck-300', kind: 'deck', slides: 300 }
];

export const stressLibraries = [0, 300, 900, 3000];
export const executableModes = ['source', 'split', 'code', 'json'];

export function stressMatrix() {
	const cases = [];
	for (const fixture of stressFixtures) {
		const modes =
			fixture.kind === 'deck'
				? ['slide-canvas', 'slide-text', 'slide-notes', 'slide-source']
				: fixture.kind === 'code'
					? ['code']
					: fixture.kind === 'json'
						? ['json']
						: ['source', 'split', 'wysiwyg', 'read', 'annotation'];
		for (const mode of modes) {
			for (const library of stressLibraries) {
				cases.push({
					id: `${mode}/${fixture.id}/lib-${library}`,
					mode,
					fixture: fixture.id,
					library,
					adapter: executableModes.includes(mode) ? 'web' : 'unavailable',
					...(!executableModes.includes(mode)
						? { reason: 'The stress browser adapter is not implemented. This case cannot pass.' }
						: {})
				});
			}
		}
	}
	return {
		schema: 'deckmark-stress-matrix/1',
		fixtures: stressFixtures,
		libraries: stressLibraries,
		cases
	};
}

function deckContent(count) {
	const slides = Array.from({ length: count }, (_, index) => ({
		id: `slide-${index}`,
		background: '#ffffff',
		notes: `Speaker notes ${index}.`,
		elements: Array.from({ length: 10 }, (_, object) => ({
			id: `element-${index}-${object}`,
			type: object === 0 ? 'text' : 'rectangle',
			x: 40 + object * 30,
			y: 40 + object * 20,
			width: object === 0 ? 700 : 100,
			height: object === 0 ? 100 : 60,
			rotation: 0,
			fill: object === 0 ? 'transparent' : '#dbeafe',
			stroke: 'none',
			strokeWidth: 0,
			color: '#111827',
			fontSize: 30,
			textAlign: 'left',
			content: ''
		}))
	}));
	const body = slides
		.map(
			(slide, index) =>
				`<!-- mdsh-slide:${slide.id} -->\n\n<!-- mdsh-element:element-${index}-0 -->\n# Benchmark slide ${index}\n\nStable slide text.\n`
		)
		.join('\n---\n\n');
	return `${body}\n<!-- mdsh-presentation\n${JSON.stringify({ version: 1, width: 1280, height: 720, theme: 'default', slides })}\n-->\n`;
}

export function stressFixture(id) {
	const definition = stressFixtures.find((entry) => entry.id === id);
	if (!definition) throw new Error(`Unknown stress fixture: ${id}`);
	let content;
	if (definition.kind === 'json')
		content = '{"payload":"' + 'a'.repeat(definition.bytes - 14) + '"}';
	else if (definition.kind === 'line') content = 'a'.repeat(definition.bytes);
	else if (definition.kind === 'markdown')
		content = noteContent(327, definition.bytes).slice(0, definition.bytes);
	else if (definition.kind === 'code') {
		const line = '// Stable code benchmark content.\n';
		content = line.repeat(Math.ceil(definition.bytes / line.length)).slice(0, definition.bytes);
	} else if (definition.kind === 'headings') {
		content = Array.from(
			{ length: definition.headings },
			(_, index) => `## Heading ${index}\n\nStable paragraph ${index}.\n`
		).join('\n');
	} else if (definition.kind === 'rich') {
		content = Array.from(
			{ length: definition.sections },
			(_, index) =>
				`## Rich section ${index}\n\n\`\`\`mermaid\nflowchart LR\nA --> B\n\`\`\`\n\n$$x^2 + y^2 = z^2$$\n\n| Key | Value |\n| --- | --- |\n| ${index} | $x + 1$ |\n`
		).join('\n');
	} else content = deckContent(definition.slides);
	const extension = definition.kind === 'json' ? 'json' : definition.kind === 'code' ? 'js' : 'md';
	return {
		id,
		name: `${id}.${extension}`,
		content,
		bytes: Buffer.byteLength(content),
		sha256: createHash('sha256').update(content).digest('hex'),
		generator: 'scripts/benchmark-fixtures/stress.mjs#stressFixture',
		arguments: { id }
	};
}

export function stressLibrary(count) {
	if (!stressLibraries.includes(count)) throw new Error(`Unknown stress library size: ${count}`);
	return libraryRows(count);
}
