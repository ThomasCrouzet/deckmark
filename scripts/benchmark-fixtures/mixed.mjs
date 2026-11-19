// Deterministic mixed benchmark notes. The bytes come from real-like document
// structure: uneven prose, one wide table, one long list and inline base64
// images on single long lines. Every run returns the same bytes for the same
// arguments, so a report can name the fixture by hash.
//
// The three sizes copy the reported note shape: about 600 KB of Markdown with
// tables, a long list and six base64 images. The 200 KB and 1 MB sizes keep the
// same structures with a different prose share.
import { deflateSync } from 'node:zlib';

/** Text anchors that place a caret by content. They must stay unique. */
export const MIXED_MARKERS = {
	prose: 'Prose caret anchor',
	table: 'Table caret anchor',
	list: 'List caret anchor',
	image: 'Image caret anchor'
};

const SENTENCES = [
	'The review started from the exported note and worked backwards to the source.',
	'A short pause between keys is enough for the scheduled publication to start.',
	'Readers expect a table to keep its column widths when one cell changes.',
	'This paragraph is deliberately longer than the one before it so the layout is not uniform, and it ends with a claim that the next paragraph must support.',
	'We measured the same document before and after the change on one machine.',
	'The checklist item names were copied from the field notes without edits.',
	'Numbers in the second column come from the four recorded runs.',
	'Every image below is a generated chart with no personal data.',
	'One long line of base64 text is enough to make a naive copy expensive.',
	'A quiet editor still has work queued after the last character arrives.',
	'Rows below the fold keep their original spacing.',
	'That last sentence was short on purpose.',
	'The note mixes prose, tables, lists and images because the reported file did too.',
	'Editors that rebuild the whole document for one cell edit will show up here.',
	'We keep the wording uneven so no section looks generated.',
	'The final section restates the open question without answering it.',
	'Column three holds a stable identifier that never changes between runs.',
	'This is a normal paragraph with **bold text** and `inline code` inside it.',
	'The table has more rows than a reader will scan on one screen.',
	'A list of ninety or more items is realistic for a release checklist.',
	'The caret marker sits inside the structure that the probe measures.',
	'Long prose sections sit between the structures to match the reported layout.',
	'Some paragraphs carry a single sentence and others carry five or six, because uniform stanzas hid the original defect.',
	'The measured window covers the animation frame and the publication that follows it.',
	'A table row that changes in one cell should not cost a full document parse.',
	'The document ends with a short note that no further content follows.'
];

const HEADINGS = [
	'Field notes',
	'Why this shape',
	'Structure under test',
	'Measurement notes',
	'Open questions',
	'Charts',
	'Release checklist',
	'Closing notes',
	'Appendix',
	'Reading guide'
];

/** Small deterministic PRNG so text selection is stable across runs. */
function random(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typeBytes = Buffer.from(type, 'ascii');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
	return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * Build one valid PNG whose base64 form has about `base64Chars` characters.
 * The pixel data is small noise. A tEXt chunk carries the remaining bytes, so
 * the image stays decodable and the encoded line reaches the requested length.
 * @param {number} base64Chars
 * @param {number} seed
 */
export function chartPngBase64(base64Chars, seed = 1) {
	const size = 24;
	const scanlines = Buffer.alloc(size * (1 + size * 3));
	for (let row = 0; row < size; row += 1) {
		const offset = row * (1 + size * 3);
		scanlines[offset] = 0;
		for (let column = 0; column < size * 3; column += 1) {
			scanlines[offset + 1 + column] = (row * 37 + column * 11 + seed * 29) & 0xff;
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8;
	header[9] = 2;
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	// 4 character boundary: base64 length is 4 * ceil(bytes / 3).
	const targetBytes = Math.ceil((base64Chars * 3) / 4);
	const fixed = Buffer.concat([
		signature,
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(scanlines, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
	const keyword = Buffer.from('Comment\0', 'latin1');
	const wrapper = 4 + 4 + 4; // length, type and crc of the tEXt chunk
	const textBytes = Math.max(0, targetBytes - fixed.length - wrapper - keyword.length);
	const patternUnit = 'Generated benchmark chart padding. ';
	const pattern = Buffer.from(
		patternUnit.repeat(Math.ceil(textBytes / patternUnit.length) + 1),
		'latin1'
	);
	const png = Buffer.concat([
		signature,
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(scanlines, { level: 9 })),
		chunk('tEXt', Buffer.concat([keyword, pattern.subarray(0, textBytes)])),
		chunk('IEND', Buffer.alloc(0))
	]);
	return png.toString('base64');
}

/**
 * One paragraph with 1 to 6 sentences. Length varies to keep the prose uneven.
 * @param {() => number} pick
 * @param {{ min?: number, max?: number }} [length]
 */
function paragraph(pick, length = {}) {
	const count =
		length.min && length.max
			? Math.round(length.min + pick() * (length.max - length.min))
			: 1 + Math.floor(pick() * 6);
	const chosen = [];
	for (let index = 0; index < count; index += 1) {
		chosen.push(SENTENCES[Math.floor(pick() * SENTENCES.length)]);
	}
	return chosen.join(' ');
}

/**
 * Prose block of about `bytes` characters, with a heading and 2 to 4 paragraphs.
 * @param {() => number} pick
 * @param {string} heading
 * @param {number} bytes
 * @param {string} [anchor]
 */
function proseSection(pick, heading, bytes, anchor) {
	const parts = [`## ${heading}`, ''];
	if (anchor) parts.push(anchor, '');
	let size = parts.join('\n').length;
	let index = 0;
	while (size < bytes || index < 2) {
		const remaining = bytes - size;
		const wanted = 90 + Math.floor(pick() * 700);
		let text = paragraph(pick, { min: 1, max: 4 });
		while (text.length < wanted) {
			const extra = paragraph(pick, { min: 1, max: 2 });
			if (text.length + extra.length > wanted * 1.4) break;
			text += ' ' + extra;
		}
		if (index >= 1 && text.length > remaining) {
			text = text
				.slice(0, Math.max(80, remaining))
				.replace(/\s+\S*$/, '')
				.trim();
			if (!text) break;
		}
		parts.push(text, '');
		size += text.length + 2;
		index += 1;
		if (index === 2 && pick() > 0.5) {
			const quote = '> ' + paragraph(pick, { min: 1, max: 1 });
			parts.push(quote, '');
			size += quote.length + 2;
		}
	}
	return { text: parts.join('\n'), size: parts.join('\n').length };
}

/**
 * Wide table with 5 columns and at least 60 body rows. The marker cell sits in
 * the middle third of the table.
 * @param {() => number} pick
 * @param {number} rows
 */
function wideTable(pick, rows) {
	const header = ['Step', 'Owner', 'Recorded value', 'Note', 'State'];
	const markerRow = Math.floor(rows / 3);
	const body = [];
	for (let index = 0; index < rows; index += 1) {
		body.push([
			String(index + 1),
			`team ${1 + (index % 4)}`,
			(pick() * 1000).toFixed(1),
			index === markerRow
				? MIXED_MARKERS.table
				: `row ${index + 1} detail ${Math.floor(pick() * 1000)}`,
			index % 3 === 0 ? 'open' : 'done'
		]);
	}
	// Pad every cell to a column width. A formatted table is common in real
	// notes, and the notes that reproduce the reported defect carry one.
	const widths = header.map((cell, column) =>
		Math.max(cell.length, ...body.map((row) => row[column].length))
	);
	const line = (cells) =>
		`| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |`;
	const separator = `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`;
	return [line(header), separator, ...body.map(line)].join('\n');
}

/** One list with at least 90 items. The marker item sits near the middle. */
function longList(items) {
	const markerItem = Math.floor(items * 0.45);
	const lines = [];
	for (let index = 0; index < items; index += 1) {
		lines.push(
			`${index + 1}. ${
				index === markerItem
					? MIXED_MARKERS.list
					: `Checklist entry ${index + 1} with a stable label and no extra markup`
			}`
		);
	}
	return lines.join('\n');
}

/**
 * Build one mixed note.
 * @param {{
 *   label?: string,
 *   targetBytes?: number,
 *   imageLineChars?: number[],
 *   tableRows?: number,
 *   listItems?: number,
 *   includeTables?: boolean,
 *   seed?: number
 * }} [options]
 */
export function mixedNote(options = {}) {
	const label = options.label ?? 'mixed';
	const targetBytes = options.targetBytes ?? 600_000;
	const imageLineChars = options.imageLineChars ?? [90_000, 70_000, 60_000, 50_000, 40_000, 30_000];
	const tableRows = options.tableRows ?? 64;
	const listItems = options.listItems ?? 96;
	const includeTables = options.includeTables ?? true;
	const pick = random(options.seed ?? targetBytes);
	const imagePrefix = '![Generated chart](data:image/png;base64,';
	const images = imageLineChars.map(
		(chars, index) => `${imagePrefix}${chartPngBase64(chars - imagePrefix.length - 1, index + 1)})`
	);
	const table = includeTables ? wideTable(pick, tableRows) : '';
	const list = longList(listItems);
	const structureBytes =
		images.reduce((total, image) => total + image.length + 2, 0) +
		table.length +
		list.length +
		2_000;
	const proseBudget = Math.max(20_000, targetBytes - structureBytes);
	// Uneven shares, so no two sections carry the same amount of text. Each
	// image gets a short section of its own; normalize every share so the note
	// lands near the requested byte count.
	const shares = [0.1, 0.16, 0.2, 0.14, 0.22, 0.18];
	const imageShare = 0.03;
	const scale =
		proseBudget / (shares.reduce((total, share) => total + share, 0) + imageShare * images.length);
	const budget = (/** @type {number} */ share) => Math.floor(scale * share);
	const parts = [
		'---',
		`title: Mixed benchmark note ${label}`,
		'tags: [benchmark, mixed, note]',
		'---',
		'',
		`# Mixed document ${label}`,
		'',
		'This note keeps prose, a wide table, a long list and base64 images in one file.',
		''
	];
	parts.push(proseSection(pick, HEADINGS[0], budget(shares[0])).text, '');
	parts.push(proseSection(pick, HEADINGS[1], budget(shares[1])).text, '');
	if (includeTables) {
		// A line directly after the table, with no blank separator, is common in
		// real notes and makes the source form differ from the editor form.
		parts.push(
			'## Wide table',
			'',
			'Every row below holds five cells.',
			'',
			`${table}\nValues in the table above come from the same review pass.`,
			''
		);
	}
	const firstImages = images.slice(0, Math.ceil(images.length / 2));
	const restImages = images.slice(Math.ceil(images.length / 2));
	for (const [index, image] of firstImages.entries()) {
		parts.push(proseSection(pick, `${HEADINGS[2]} ${index + 1}`, budget(imageShare)).text, '');
		parts.push(image, '');
	}
	parts.push(
		proseSection(
			pick,
			HEADINGS[3],
			budget(shares[2]),
			`${MIXED_MARKERS.prose} marks a plain paragraph near the middle of the document.`
		).text,
		''
	);
	parts.push('## Long list', '', 'A release checklist with one item per line.', '', list, '');
	parts.push(proseSection(pick, HEADINGS[4], budget(shares[3])).text, '');
	for (const [index, image] of restImages.entries()) {
		parts.push(proseSection(pick, `${HEADINGS[5]} ${index + 1}`, budget(imageShare)).text, '');
		parts.push(image, '');
		if (index === restImages.length - 1) {
			parts.push(
				`${MIXED_MARKERS.image} follows the last chart image and closes this section.`,
				''
			);
		}
	}
	parts.push(proseSection(pick, HEADINGS[6], budget(shares[4])).text, '');
	parts.push(proseSection(pick, HEADINGS[7], budget(shares[5])).text, '');
	return parts.join('\n');
}

/**
 * Remove every table line. The harness uses this variant to compare one edit
 * with the same note when no table container exists.
 * @param {string} markdown
 */
export function removeTables(markdown) {
	return markdown
		.split('\n')
		.filter((line) => !line.startsWith('|'))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n');
}

/** @param {string} markdown */
export function mixedStats(markdown) {
	let maxLineChars = 0;
	for (const line of markdown.split('\n')) maxLineChars = Math.max(maxLineChars, line.length);
	const inlineImageCount = markdown.match(/!\[[^\]]*\]\(data:image\/[a-z+]+;base64,/g)?.length ?? 0;
	let tableRowCount = 0;
	let listItemCount = 0;
	for (const block of markdown.split(/\n{2,}/)) {
		const rows = block.split('\n').filter((line) => line.startsWith('|'));
		if (rows.length > 2) tableRowCount = Math.max(tableRowCount, rows.length - 2);
		const items = block.split('\n').filter((line) => /^\d+\. /.test(line));
		if (items.length) listItemCount = Math.max(listItemCount, items.length);
	}
	return {
		bytes: Buffer.byteLength(markdown),
		maxLineChars,
		inlineImageCount,
		tableRowCount,
		listItemCount
	};
}

export const MIXED_FIXTURE_SPECS = [
	{
		id: 'note-200k-mixed',
		label: '200k',
		targetBytes: 200_000,
		imageLineChars: [60_000, 60_000]
	},
	{
		id: 'note-600k-mixed',
		label: '600k',
		targetBytes: 600_000,
		imageLineChars: [90_000, 70_000, 60_000, 50_000, 40_000, 30_000]
	},
	{
		id: 'note-1mb-mixed',
		label: '1mb',
		targetBytes: 1_000_000,
		imageLineChars: [90_000, 70_000, 60_000, 50_000, 40_000, 30_000]
	}
];
