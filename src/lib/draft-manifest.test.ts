import { describe, expect, it } from 'vitest';
import { selectActiveManifestId, selectInlineContentIds } from './draft-manifest';
import type { DraftManifest } from './draft-manifest-key';

function manifest(id: string, order: number, open: boolean, contentLength = 100): DraftManifest {
	return {
		id,
		name: `${id}.md`,
		createdAt: 1,
		updatedAt: 1,
		order,
		open,
		contentLength,
		contentBytes: contentLength,
		binaryBytes: 0,
		hasData: false
	};
}

describe('startup body selection', () => {
	const manifests = [
		manifest('a', 0, true),
		manifest('b', 1, true),
		manifest('c', 2, true),
		manifest('closed-small', 3, false, 1024),
		manifest('closed-large', 4, false, 300 * 1024)
	];

	it('selects the preferred active tab before reading any body', () => {
		expect(selectActiveManifestId(manifests, 'b', 'a')).toBe('b');
		expect(selectActiveManifestId(manifests, 'missing', 'c')).toBe('c');
		expect(selectActiveManifestId(manifests, null, null)).toBe('a');
	});

	it('reads only the active open tab plus the closed body budget', () => {
		expect([...selectInlineContentIds(manifests, 'b')]).toEqual(['b', 'closed-small']);
	});

	it('keeps a large active tab resident even above the closed limit', () => {
		const large = [manifest('large', 0, true, 5 * 1024 * 1024), manifest('other', 1, true)];
		expect([...selectInlineContentIds(large, 'large')]).toEqual(['large']);
	});
});
