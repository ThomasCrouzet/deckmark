import { describe, expect, it } from 'vitest';
import {
	applyPatchPlan,
	contentHash,
	parsePatchProposal,
	planPatch,
	planRevert,
	safePatchPath,
	type AiPatchProposal
} from './patches';

const file = { id: 'a', name: 'guide.md', relativePath: 'notes/guide.md', content: 'Hello world' };
const other = { id: 'b', name: 'other.md', content: 'Other' };

function proposal(overrides: Partial<AiPatchProposal['files'][number]> = {}): AiPatchProposal {
	return {
		files: [
			{
				path: 'notes/guide.md',
				baseHash: contentHash(file.content),
				hunks: [{ before: 'world', after: 'DeckMark' }],
				...overrides
			}
		]
	};
}

describe('patch planning', () => {
	it('computes a plan without modifying files', () => {
		const plan = planPatch(proposal(), [file, other], ['a']);
		expect(plan.files[0]).toMatchObject({
			status: 'ready',
			before: 'Hello world',
			after: 'Hello DeckMark'
		});
		expect(file.content).toBe('Hello world');
	});

	it('blocks stale hashes and out-of-scope files', () => {
		expect(planPatch(proposal({ baseHash: 'stale' }), [file], ['a']).files[0]?.status).toBe(
			'stale'
		);
		expect(planPatch(proposal(), [file], ['b']).rejected).toEqual([
			{ path: 'notes/guide.md', reason: 'outside-scope' }
		]);
	});

	it('rejects missing or ambiguous hunks', () => {
		expect(
			planPatch(proposal({ hunks: [{ before: 'absent', after: 'x' }] }), [file], ['a']).files[0]
				?.status
		).toBe('conflict');
		const duplicate = { ...file, content: 'x x' };
		expect(
			planPatch(
				{
					files: [
						{
							path: 'guide.md',
							baseHash: contentHash(duplicate.content),
							hunks: [{ before: 'x', after: 'y' }]
						}
					]
				},
				[duplicate],
				['a']
			).files[0]?.status
		).toBe('conflict');
	});

	it('rejects empty and out-of-range hunk matches without scanning every occurrence', () => {
		expect(
			planPatch(proposal({ hunks: [{ before: '', after: 'x' }] }), [file], ['a']).files[0]?.status
		).toBe('conflict');
		const repeated = { ...file, content: 'x'.repeat(1_000_000) };
		expect(
			planPatch(
				{
					files: [
						{
							path: 'guide.md',
							baseHash: contentHash(repeated.content),
							hunks: [{ before: 'x', after: 'y', occurrence: 2 }]
						}
					]
				},
				[repeated],
				['a']
			).files[0]?.status
		).toBe('ready');
	});

	it('rejects an oversized untrusted provider reply', () => {
		expect(parsePatchProposal('x'.repeat(2_000_001))).toBeNull();
	});

	it('applies only approved files and rechecks revisions', () => {
		const plan = planPatch(proposal(), [file], ['a']);
		expect(applyPatchPlan(plan, [file], []).changes).toEqual([]);
		expect(applyPatchPlan(plan, [file], ['notes/guide.md']).changes).toEqual([
			{ id: 'a', content: 'Hello DeckMark' }
		]);
		expect(
			applyPatchPlan(plan, [{ ...file, content: 'Changed' }], ['notes/guide.md']).rejected
		).toEqual(['notes/guide.md']);
	});

	it('applies a partial hunk selection', () => {
		const target = { ...file, content: 'a b c' };
		const patch: AiPatchProposal = {
			files: [
				{
					path: 'guide.md',
					baseHash: contentHash(target.content),
					hunks: [
						{ before: 'a', after: 'A' },
						{ before: 'c', after: 'C' }
					]
				}
			]
		};
		const plan = planPatch(patch, [target], ['a']);
		expect(applyPatchPlan(plan, [target], ['guide.md'], { 'guide.md': [1] }).changes).toEqual([
			{ id: 'a', content: 'a b C' }
		]);
	});

	it('preserves an explicit occurrence through selective apply', () => {
		const target = { ...file, content: 'alpha alpha' };
		const patch: AiPatchProposal = {
			files: [
				{
					path: 'guide.md',
					baseHash: contentHash(target.content),
					hunks: [{ before: 'alpha', after: 'beta', occurrence: 2 }]
				}
			]
		};
		const plan = planPatch(patch, [target], ['a']);
		expect(plan.files[0]?.status).toBe('ready');
		expect(plan.files[0]?.after).toBe('alpha beta');
		expect(applyPatchPlan(plan, [target], ['guide.md'], { 'guide.md': [0] }).changes).toEqual([
			{ id: 'a', content: 'alpha beta' }
		]);
	});

	it('keeps subset application aligned with the full preview', () => {
		const target = { ...file, content: 'one two one two' };
		const patch: AiPatchProposal = {
			files: [
				{
					path: 'guide.md',
					baseHash: contentHash(target.content),
					hunks: [
						{ before: 'one', after: 'ONE', occurrence: 1 },
						{ before: 'one', after: 'UNO', occurrence: 2 }
					]
				}
			]
		};
		const plan = planPatch(patch, [target], ['a']);
		expect(plan.files[0]?.after).toBe('ONE two UNO two');
		// Selecting only the second hunk must still hit the second occurrence.
		expect(applyPatchPlan(plan, [target], ['guide.md'], { 'guide.md': [1] }).changes).toEqual([
			{ id: 'a', content: 'one two UNO two' }
		]);
		// Selecting both must match the preview exactly.
		expect(applyPatchPlan(plan, [target], ['guide.md'], { 'guide.md': [0, 1] }).changes).toEqual([
			{ id: 'a', content: 'ONE two UNO two' }
		]);
	});

	it('applies a subset of same-before hunks without renumbering later matches', () => {
		const target = { ...file, content: 'x y x' };
		const patch: AiPatchProposal = {
			files: [
				{
					path: 'guide.md',
					baseHash: contentHash(target.content),
					hunks: [
						{ before: 'x', after: 'A', occurrence: 1 },
						{ before: 'x', after: 'B', occurrence: 2 }
					]
				}
			]
		};
		const plan = planPatch(patch, [target], ['a']);
		expect(plan.files[0]?.after).toBe('A y B');
		expect(applyPatchPlan(plan, [target], ['guide.md'], { 'guide.md': [1] }).changes).toEqual([
			{ id: 'a', content: 'x y B' }
		]);
	});

	it('rejects an ambiguous basename across project folders', () => {
		const docs = {
			id: 'a',
			name: 'README.md',
			relativePath: 'docs/README.md',
			content: 'Same body'
		};
		const examples = {
			id: 'b',
			name: 'README.md',
			relativePath: 'examples/README.md',
			content: 'Same body'
		};
		const ambiguous: AiPatchProposal = {
			files: [
				{
					path: 'README.md',
					baseHash: contentHash('Same body'),
					hunks: [{ before: 'Same', after: 'Changed' }]
				}
			]
		};
		const plan = planPatch(ambiguous, [docs, examples], ['a', 'b']);
		expect(plan.files[0]).toMatchObject({ status: 'ambiguous', fileId: null });
		expect(applyPatchPlan(plan, [docs, examples], ['README.md']).changes).toEqual([]);
		expect(applyPatchPlan(plan, [docs, examples], ['README.md']).rejected).toEqual(['README.md']);
	});

	it('resolves an exact relative path when basenames collide', () => {
		const docs = {
			id: 'a',
			name: 'README.md',
			relativePath: 'docs/README.md',
			content: 'Docs body'
		};
		const examples = {
			id: 'b',
			name: 'README.md',
			relativePath: 'examples/README.md',
			content: 'Examples body'
		};
		const plan = planPatch(
			{
				files: [
					{
						path: 'examples/README.md',
						baseHash: contentHash('Examples body'),
						hunks: [{ before: 'Examples', after: 'Changed' }]
					}
				]
			},
			[docs, examples],
			['a', 'b']
		);
		expect(plan.files[0]).toMatchObject({ status: 'ready', fileId: 'b' });
		expect(applyPatchPlan(plan, [docs, examples], ['examples/README.md']).changes).toEqual([
			{ id: 'b', content: 'Changed body' }
		]);
	});

	it('revalidates the canonical path at apply time after a rename', () => {
		const original = {
			id: 'a',
			name: 'guide.md',
			relativePath: 'notes/guide.md',
			content: 'Hello world'
		};
		const plan = planPatch(proposal(), [original], ['a']);
		expect(plan.files[0]?.status).toBe('ready');
		const moved = { ...original, relativePath: 'archive/guide.md' };
		expect(applyPatchPlan(plan, [moved], ['notes/guide.md']).rejected).toEqual(['notes/guide.md']);
	});

	it('refuses a revert when exact bytes differ despite a 32-bit hash collision', () => {
		// These two literal fixtures collide under FNV-1a 32-bit.
		const applied = '4c6d3c14';
		const later = '34749a0f';
		expect(contentHash(applied)).toBe(contentHash(later));
		const original = { id: 'a', canonicalPath: 'guide.md', content: 'ORIGINAL' };
		const after = { id: 'a', canonicalPath: 'guide.md', content: applied };
		const current = { id: 'a', name: 'guide.md', relativePath: 'guide.md', content: later };
		expect(planRevert([after], [original], [current])).toEqual({
			changes: [],
			rejected: ['guide.md']
		});
	});

	it('reverts all applied files or none when one file changed', () => {
		const before = [
			{ id: 'a', canonicalPath: 'one.md', content: 'One before' },
			{ id: 'b', canonicalPath: 'two.md', content: 'Two before' }
		];
		const after = [
			{ id: 'a', canonicalPath: 'one.md', content: 'One after' },
			{ id: 'b', canonicalPath: 'two.md', content: 'Two after' }
		];
		const files = [
			{ id: 'a', name: 'one.md', relativePath: 'one.md', content: 'One after' },
			{ id: 'b', name: 'two.md', relativePath: 'two.md', content: 'Two edited later' }
		];
		expect(planRevert(after, before, files)).toEqual({
			changes: [],
			rejected: ['two.md']
		});
		expect(
			planRevert(
				after,
				before,
				files.map((file) => ({ ...file, content: file.id === 'b' ? 'Two after' : file.content }))
			)
		).toEqual({
			changes: [
				{ id: 'a', content: 'One before' },
				{ id: 'b', content: 'Two before' }
			],
			rejected: []
		});
	});

	it('rejects path traversal and duplicate paths', () => {
		expect(safePatchPath('../secret')).toBe(false);
		expect(safePatchPath('/etc/passwd')).toBe(false);
		expect(safePatchPath('notes/guide.md')).toBe(true);
		const duplicate = proposal();
		duplicate.files.push(duplicate.files[0]!);
		expect(planPatch(duplicate, [file], ['a']).rejected[0]?.reason).toBe('invalid-path');
	});
});

describe('proposal parsing', () => {
	it('reads fenced JSON and ignores prose', () => {
		const parsed = parsePatchProposal(
			'Here is the patch:\n```json\n' + JSON.stringify(proposal()) + '\n```\nDone.'
		);
		expect(parsed?.files[0]?.path).toBe('notes/guide.md');
	});

	it('returns null for malformed output', () => {
		expect(parsePatchProposal('No patch here')).toBeNull();
		expect(parsePatchProposal('```json\n{"files":[]}\n```')).toBeNull();
	});
});
