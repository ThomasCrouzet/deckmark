// Plain text entry for the visual editor code block language picker.
//
// Crepe lists only the languages of CodeMirror. A code block can start with
// an empty language, but the picker offered no way to return to plain text
// after a language change. This entry writes the `text` info string, which
// stays in the Markdown source and loads no highlighter.

import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';

export const PLAIN_TEXT_LANGUAGE_NAME = 'text';

export function plainTextLanguage(): LanguageDescription {
	const language = StreamLanguage.define<null>({
		startState: () => null,
		token(stream) {
			stream.skipToEnd();
			return null;
		}
	});
	return LanguageDescription.of({
		name: PLAIN_TEXT_LANGUAGE_NAME,
		alias: [PLAIN_TEXT_LANGUAGE_NAME, 'plain', 'plaintext', 'txt'],
		support: new LanguageSupport(language)
	});
}

/** Return the list with one plain text entry first. Keep the other entries. */
export function withPlainTextLanguage(
	languages: readonly LanguageDescription[]
): LanguageDescription[] {
	const rest = languages.filter((entry) => entry.name.toLowerCase() !== PLAIN_TEXT_LANGUAGE_NAME);
	return [plainTextLanguage(), ...rest];
}
