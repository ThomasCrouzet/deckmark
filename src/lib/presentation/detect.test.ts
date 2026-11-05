import { describe, expect, it } from 'vitest';
import { isPresentation } from './detect';

const metadata = `<!-- mdsh-presentation
{"version":1,"width":1280,"height":720,"theme":"light","slides":[]}
-->`;

describe('presentation detection placement', () => {
	it('accepts a metadata marker at the end', () => {
		expect(isPresentation(`# Body\n\n${metadata}\n`)).toBe(true);
	});

	it('accepts a metadata marker after front matter', () => {
		expect(isPresentation(`---\ntitle: Deck\n---\n\n# Body\n\n${metadata}\n`)).toBe(true);
	});

	it('accepts a byte order mark and CRLF line endings', () => {
		const source = `\uFEFF# Body\r\n\r\n${metadata.replaceAll('\n', '\r\n')}\r\n`;
		expect(isPresentation(source)).toBe(true);
	});

	it('ignores a marker inside a fence', () => {
		const source = `# Example\n\n\`\`\`markdown\n${metadata}\n\`\`\`\n`;
		expect(isPresentation(source)).toBe(false);
	});

	it('ignores a marker escaped by the literal marker', () => {
		const source = `# Literal\n\n<!-- mdsh-literal -->\n${metadata}\n`;
		expect(isPresentation(source)).toBe(false);
	});

	it('ignores a marker inside a framed element', () => {
		const source = [
			'<!-- mdsh-element:frame-1 -->',
			metadata,
			'<!-- mdsh-end-element:frame-1 gap=0 -->',
			''
		].join('\n');
		expect(isPresentation(source)).toBe(false);
	});

	it('classifies malformed metadata as presentation for the parser to reject', () => {
		const source = '# Body\n\n<!-- mdsh-presentation\nnot json\n-->\n';
		expect(isPresentation(source)).toBe(true);
	});

	it('classifies metadata before later content as presentation', () => {
		const source = `${metadata}\n\n# Body after metadata\n`;
		expect(isPresentation(source)).toBe(true);
	});

	it('rejects a marker with leading text on the same line', () => {
		expect(isPresentation(`# Body\n\ntext <!-- mdsh-presentation\n-->\n`)).toBe(false);
	});
});
