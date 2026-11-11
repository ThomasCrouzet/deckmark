/**
 * Chooses WYSIWYG interaction and paint policies from the rendered document
 * rather than from the encoded length of an embedded image.
 *
 * The source string still bounds safety, memory warnings and import limits. It
 * must not decide paint containment or caret behaviour: one 500 KiB Base64
 * image and the same raster stored as a project asset render the same blocks and
 * need the same editor policy.
 */

/** Interaction characters that select the long-document paint policy. */
export const LONG_DOCUMENT_CHARS = 256 * 1024;

const DATA_IMAGE_PREFIX = 'data:image/';

/**
 * Length of every embedded image payload, ignoring the surrounding Markdown.
 * A payload ends at whitespace, a closing parenthesis or a Markdown delimiter.
 * The scan is linear and stops at the first delimiter, so it never decodes or
 * copies the image bytes.
 */
function embeddedImagePayloadLength(markdown: string): number {
	let skipped = 0;
	let index = 0;
	while ((index = markdown.indexOf(DATA_IMAGE_PREFIX, index)) !== -1) {
		let end = index + DATA_IMAGE_PREFIX.length;
		while (end < markdown.length) {
			const code = markdown.charCodeAt(end);
			// Whitespace, `)`, quote characters and angle brackets end the URI.
			if (
				code <= 0x20 ||
				code === 0x29 ||
				code === 0x22 ||
				code === 0x27 ||
				code === 0x3c ||
				code === 0x3e
			)
				break;
			end += 1;
		}
		skipped += end - index;
		index = end;
	}
	return skipped;
}

let cachedMarkdown: string | null = null;
let cachedInteractionChars = 0;

/** Source characters that remain once embedded image payloads are removed. */
export function interactionCharacterCount(markdown: string): number {
	if (markdown === cachedMarkdown) return cachedInteractionChars;
	cachedInteractionChars = Math.max(0, markdown.length - embeddedImagePayloadLength(markdown));
	cachedMarkdown = markdown;
	return cachedInteractionChars;
}

export interface EditorDocumentPolicy {
	/** Characters after embedded image payload removal. */
	interactionChars: number;
	/** True when the visual editor applies large-document paint containment. */
	longDocument: boolean;
	/** True when the caret refinement plugin stays active. */
	virtualCursor: boolean;
}

/**
 * The paint and caret policies share one threshold. The caret plugin is a
 * compatibility refinement, not a rendering virtualizer, so an embedded image
 * must not switch it off for an otherwise short note. A genuinely long text
 * document keeps the previous reduced-interaction setting.
 */
export function editorDocumentPolicy(markdown: string): EditorDocumentPolicy {
	const interactionChars = interactionCharacterCount(markdown);
	const longDocument = interactionChars >= LONG_DOCUMENT_CHARS;
	return { interactionChars, longDocument, virtualCursor: !longDocument };
}
