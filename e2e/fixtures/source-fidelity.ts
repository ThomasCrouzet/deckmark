const surroundings = [
	'---',
	'title: "Source fidelity"',
	'tags: [one, two]',
	'---',
	'',
	'Original heading',
	'================',
	'',
	'<!-- Keep this comment. -->',
	'',
	'<aside>Keep raw HTML.</aside>',
	'',
	'* first item',
	'* second item',
	'    + nested item',
	'',
	'7) seven',
	'8) eight',
	'',
	'- [x] done',
	'- [ ] pending',
	'',
	'[Example][target] and <https://example.invalid/>.',
	'',
	'[target]: https://example.invalid/ "Keep this title"',
	'',
	'~~~~js sample',
	'const untouched = "value";',
	'~~~~',
	'',
	'    indented code',
	'',
	'| Left | Right |',
	'| :--- | ----: |',
	'| one | two |',
	'',
	'A hard break.  ',
	'The next line.',
	'',
	'',
	'***',
	'',
	'__Strong__ and _emphasis_ with `code` and &amp; an entity.',
	''
].join('\n');

export const sentence = 'The small bird sings.';
export const replacement = 'The bright bird sings clearly.';

export const fidelityFixtures = [
	{ id: 'paragraph', target: `${sentence} Keep this sentence.\nKeep this soft wrap.` },
	{ id: 'heading', target: `${sentence}\n---------------------` },
	{ id: 'nested-list', target: `* outer\n    + ${sentence}\n    + Keep this item.\n* last` },
	{ id: 'ordered-list', target: `3) ${sentence}\n4) Keep this item.` },
	{ id: 'quote', target: `> ${sentence}\n> Keep this line.\n>\n> Keep this paragraph.` },
	{
		id: 'table',
		target: `| Sentence | Other |\n| :------- | ----: |\n| ${sentence} | Keep this cell. |`
	},
	{ id: 'emphasis', target: `__${sentence}__ and _keep this_ with &amp; and \\*literal\\*.` },
	{ id: 'reference-link', target: `[${sentence}][target] and [keep][target].` },
	{ id: 'crlf', target: `${sentence}\nKeep this line.`, crlf: true },
	{ id: 'no-final-newline', target: sentence, noFinalNewline: true },
	{ id: 'inline-code', target: 'Keep ``before ' + sentence + ' after`` and _this_.' },
	{ id: 'inline-code-boundary', target: 'Keep ``' + sentence + '`` and _this_.' },
	{ id: 'code-block', target: `~~~~text sample\n${sentence}\nKeep this line.\n~~~~` },
	{
		id: 'code-block-crlf',
		target: `~~~~text sample\n${sentence}\nKeep this line.\n~~~~`,
		crlf: true
	},
	{ id: 'code-info-collision', target: `~~~${sentence}\n${sentence}\n~~~` },
	{ id: 'indented-code', target: `    ${sentence}\n    Keep this line.` },
	{ id: 'quote-second-line', target: `> Keep this line.\n> ${sentence}\n> Keep the end.` },
	{ id: 'entities', target: `&amp; &#65; \\*literal\\* ${sentence} Keep &copy;.` },
	{ id: 'unicode', target: `Café 🐦. ${sentence} Keep 日本語.` }
].map(({ id, target, crlf, noFinalNewline }) => {
	let source = `${surroundings}\n${target}\n\nKeep the final paragraph.\n`;
	if (crlf) source = source.replaceAll('\n', '\r\n');
	if (noFinalNewline) source = source.trimEnd();
	return {
		id,
		source,
		expected:
			id === 'code-info-collision'
				? source.replace('\n' + sentence, '\n' + replacement)
				: id === 'inline-code-boundary'
					? source.replace('``' + sentence + '``', replacement)
					: source.replace(sentence, replacement)
	};
});
