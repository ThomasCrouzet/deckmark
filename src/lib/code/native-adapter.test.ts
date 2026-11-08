import { describe, expect, it } from 'vitest';
import { resolveRejectedNativeChange } from './native-adapter.js';

describe('native rejected change resolution', () => {
	const fileId = 'file-a';
	const revision = (generation: number, id = fileId) => ({ fileId: id, generation });

	it('adopts an authoritative snapshot with the same accepted text', () => {
		expect(
			resolveRejectedNativeChange(fileId, 'same', { revision: revision(7), text: 'same' })
		).toEqual({ kind: 'adopt', revision: revision(7) });
	});

	it('blocks when the authoritative text diverged', () => {
		expect(
			resolveRejectedNativeChange(fileId, 'mine', {
				revision: revision(7),
				text: 'external'
			})
		).toEqual({ kind: 'block', reason: 'diverged' });
	});

	it('blocks a snapshot for another file', () => {
		expect(
			resolveRejectedNativeChange(fileId, 'same', {
				revision: revision(7, 'file-b'),
				text: 'same'
			})
		).toEqual({ kind: 'block', reason: 'missing' });
	});

	it('blocks a missing snapshot', () => {
		expect(resolveRejectedNativeChange(fileId, 'same', null)).toEqual({
			kind: 'block',
			reason: 'missing'
		});
	});
});
