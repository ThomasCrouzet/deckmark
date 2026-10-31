export const PRESENTATION_METADATA_MARKER = /^[ \t]*<!-- mdsh-presentation[ \t]*\r?$/;
export const PRESENTATION_SOURCE_ESCAPE_MARKER = /^[ \t]*<!-- mdsh-literal -->[ \t]*\r?$/;
const PRESENTATION_ELEMENT_MARKER =
	/^[ \t]*<!-- mdsh-element:([A-Za-z0-9][A-Za-z0-9._:-]{0,127}) -->[ \t]*\r?$/;
const PRESENTATION_ELEMENT_END_MARKER =
	/^[ \t]*<!-- mdsh-end-element:([A-Za-z0-9][A-Za-z0-9._:-]{0,127}) gap=[01](?: fence=[bt][0-9]+)? -->[ \t]*\r?$/;

/** Return the first content offset after a complete YAML front matter block. */
export function presentationContentStart(markdown: string): number {
	return /^(---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/.exec(markdown)?.[0].length ?? 0;
}

export function nextPresentationFence(line: string, fence: string): string {
	if (fence) {
		return new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*\\r?$`).test(line) ? '' : fence;
	}
	return /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? '';
}

/** Detect the format without loading the presentation editor at startup. */
export function isPresentation(markdown: string): boolean {
	if (!markdown.includes('<!-- mdsh-presentation')) return false;
	const contentStart = presentationContentStart(markdown);
	const framedEnds = new Map<string, number>();
	if (markdown.includes('<!-- mdsh-end-element:')) {
		let scanOffset = contentStart;
		while (scanOffset < markdown.length) {
			const next = markdown.indexOf('\n', scanOffset);
			const line = markdown.slice(scanOffset, next === -1 ? markdown.length : next);
			const endMatch = PRESENTATION_ELEMENT_END_MARKER.exec(line);
			if (endMatch) framedEnds.set(endMatch[1]!, scanOffset);
			if (next === -1) break;
			scanOffset = next + 1;
		}
	}
	let fence = '';
	let offset = contentStart;
	let escapedLine = false;
	let framedElementId = '';
	const hasFramedElements = framedEnds.size > 0;
	while (offset < markdown.length) {
		const next = markdown.indexOf('\n', offset);
		const line = markdown.slice(offset, next === -1 ? markdown.length : next);
		const framedEnd = PRESENTATION_ELEMENT_END_MARKER.exec(line);
		if (
			framedElementId &&
			framedEnd?.[1] === framedElementId &&
			framedEnds.get(framedElementId) === offset
		) {
			framedElementId = '';
			fence = '';
			escapedLine = false;
		} else if (!fence && !escapedLine && PRESENTATION_SOURCE_ESCAPE_MARKER.test(line)) {
			escapedLine = true;
		} else {
			if (!fence && !escapedLine && hasFramedElements) {
				if (!framedElementId) {
					framedElementId = PRESENTATION_ELEMENT_MARKER.exec(line)?.[1] ?? '';
				}
			}
			if (!fence && !escapedLine && !framedElementId && PRESENTATION_METADATA_MARKER.test(line))
				return true;
			escapedLine = false;
		}
		fence = nextPresentationFence(line, fence);
		if (next === -1) break;
		offset = next + 1;
	}
	return false;
}
