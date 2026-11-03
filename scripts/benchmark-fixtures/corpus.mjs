// Deterministic benchmark content. Every generator returns the same bytes for the
// same arguments, so a recorded artifact can be reproduced and compared by hash.

const EPOCH = 1_700_000_000_000;
const PARAGRAPH =
	'Local benchmark text keeps the same words in every run. The editor reads Markdown, while the preview draws a table and a diagram. ';
const HEADINGS = [
	'Introduction',
	'Context',
	'Method',
	'Results',
	'Review',
	'Appendix',
	'Notes',
	'References'
];

/** @param {number} index @param {number} targetBytes */
export function noteContent(index = 0, targetBytes = 16_000) {
	const label = String(index).padStart(3, '0');
	const parts = [
		'---',
		`title: Benchmark note ${label}`,
		'tags: [benchmark, corpus, note]',
		'---',
		''
	];
	let size = parts.join('\n').length;
	let section = 0;
	while (size < targetBytes) {
		const heading = HEADINGS[section % HEADINGS.length];
		const block = [
			`## ${heading} ${section + 1}`,
			'',
			`Paragraph ${section + 1} with a [[Benchmark note ${label}]] link and a \`code span\`.`,
			'',
			PARAGRAPH.repeat(2 + (section % 3)),
			'',
			'| Key | Value |',
			'| --- | --- |',
			`| section | ${section + 1} |`,
			`| note | ${label} |`,
			'',
			'```js',
			`const value${section} = ${section} * 2;`,
			'```',
			'',
			`Inline math $x_{${section}} + 1 = 2$ and a closing line.`,
			''
		].join('\n');
		parts.push(block);
		size += block.length;
		section += 1;
	}
	return parts.join('\n');
}

/** @param {number} [bytes] */
export function largeNote(bytes = 240_000) {
	return noteContent(999, bytes);
}

/** @param {number} index */
export function libraryDocument(index) {
	const id = `bench-${String(index).padStart(3, '0')}`;
	return {
		id,
		name: `${id}.md`,
		content: noteContent(index, 16_000),
		createdAt: EPOCH + index,
		updatedAt: EPOCH + index,
		order: index,
		open: true
	};
}

/** @param {number} [documents] @param {number} [bytesPerDocument] */
export function libraryRows(documents = 300, bytesPerDocument = 16_000) {
	return Array.from({ length: documents }, (_, index) => ({
		...libraryDocument(index),
		content: noteContent(index, bytesPerDocument)
	}));
}

/** @param {number} documents @param {number} folders */
export function projectRows(documents = 600, folders = 30) {
	const projectId = 'benchmark-project';
	const rows = Array.from({ length: documents }, (_, index) => {
		const folder = `section-${String(index % folders).padStart(2, '0')}`;
		const nested = `part-${String(Math.floor(index / folders) % 4)}`;
		const name = `note-${String(index).padStart(3, '0')}.md`;
		return {
			id: `${projectId}-${String(index).padStart(3, '0')}`,
			name,
			content: noteContent(index, 4_000),
			projectId,
			relativePath: `${folder}/${nested}/${name}`,
			createdAt: EPOCH + index,
			updatedAt: EPOCH + index,
			order: index,
			open: index === 0
		};
	});
	return {
		project: {
			id: projectId,
			name: 'Benchmark project',
			createdAt: EPOCH,
			updatedAt: EPOCH
		},
		documents: rows
	};
}

export const generators = {
	largeNote: (/** @type {{bytes?: number}} */ args = {}) => largeNote(args.bytes),
	libraryRows: (/** @type {{documents?: number, bytesPerDocument?: number}} */ args = {}) =>
		libraryRows(args.documents, args.bytesPerDocument),
	projectRows: (/** @type {{documents?: number, folders?: number}} */ args = {}) =>
		projectRows(args.documents, args.folders)
};
