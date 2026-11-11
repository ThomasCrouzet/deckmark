import { describe, expect, it } from 'vitest';
import {
	LONG_DOCUMENT_CHARS,
	editorDocumentPolicy,
	interactionCharacterCount
} from './editor-document-policy';

function embeddedNote(payloadLength: number, text = 'Short note.\n'): string {
	const source = `# Note\n\n${text}\n![Figure](data:image/png;base64,${'A'.repeat(payloadLength)})\n`;
	return source;
}

function embeddedNoteAtSize(bytes: number): string {
	const prefix = '# Note\n\nShort note.\n\n![Figure](data:image/png;base64,';
	const suffix = ')\n';
	return `${prefix}${'A'.repeat(bytes - prefix.length - suffix.length)}${suffix}`;
}

describe('editorDocumentPolicy', () => {
	it('gives an inline image and a project asset the same policy', () => {
		const inline = editorDocumentPolicy(embeddedNote(500 * 1024));
		const referenced = editorDocumentPolicy(
			'# Note\n\nShort note.\n\n![Figure](assets/figure.png)\n'
		);
		expect(inline.longDocument).toBe(false);
		expect(inline.virtualCursor).toBe(true);
		expect(referenced.longDocument).toBe(false);
		expect(referenced.virtualCursor).toBe(true);
		expect(inline.interactionChars).toBeLessThan(200);
	});

	it('keeps the long-document policy for a genuine text document', () => {
		for (const bytes of [255 * 1024, 256 * 1024, 257 * 1024]) {
			const policy = editorDocumentPolicy('x'.repeat(bytes));
			expect(policy.interactionChars).toBe(bytes);
			expect(policy.longDocument, `${bytes} text bytes`).toBe(bytes >= LONG_DOCUMENT_CHARS);
			expect(policy.virtualCursor).toBe(bytes < LONG_DOCUMENT_CHARS);
		}
	});

	it('keeps the short-document policy with an embedded payload at every byte boundary', () => {
		for (const bytes of [255 * 1024, 256 * 1024, 257 * 1024]) {
			const source = embeddedNoteAtSize(bytes);
			expect(source.length).toBe(bytes);
			const policy = editorDocumentPolicy(source);
			expect(policy.longDocument, `${bytes} source bytes`).toBe(false);
			expect(policy.virtualCursor).toBe(true);
			expect(policy.interactionChars).toBeLessThan(200);
		}
	});

	it('ignores a malformed or unterminated payload up to the line end', () => {
		const source = `Text.\n![Figure](data:image/png;base64,${'A'.repeat(400 * 1024)}\nMore text.`;
		expect(interactionCharacterCount(source)).toBeLessThan(200);
	});

	it('does not let a data URI in a code sample hide a large prose document', () => {
		const prose = 'Ordinary paragraph text. '.repeat(Math.ceil((300 * 1024) / 25));
		const policy = editorDocumentPolicy(
			`${prose}\n\n\`\`\`\n${'data:image/png;base64,AAAA'}\n\`\`\``
		);
		expect(policy.longDocument).toBe(true);
	});
});
