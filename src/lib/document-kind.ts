import { isPresentation } from './presentation/detect.js';

export type DocumentKind = 'note' | 'presentation';

/** Derive the document type without loading the slide editor. */
export function documentKind(content: string): DocumentKind {
	return isPresentation(content) ? 'presentation' : 'note';
}
