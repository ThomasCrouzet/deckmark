import { describe, expect, it } from 'vitest';
import {
	applyPatchPlan,
	contentHash,
	parsePatchProposal,
	planPatch,
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
