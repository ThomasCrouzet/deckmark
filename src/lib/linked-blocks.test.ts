import { describe, expect, it } from 'vitest';
import {
	buildLinkReport,
	detachInclude,
	extractBlocks,
	extractIncludes,
	freezeInclude,
	insertInclude,
	updateInclude
} from './linked-blocks';
import type { FileItem } from './types';

const now = Date.now();
function file(id: string, name: string, content: string): FileItem {
	return { id, name, content, createdAt: now, updatedAt: now, dirty: false };
}

const source = file(
	'source',
	'source.md',
	'# Source\n\n<!-- mdsh-block id="intro" -->\nHello block.\n<!-- /mdsh-block -->\n'
);
const sourceBlocks = extractBlocks(source);
const include = render(file('consumer0', 'consumer0.md', ''));

function render(target: FileItem) {
	const [block] = sourceBlocks;
	return insertInclude(target.content, 'source.md', block!.id, block!.hash, block!.body);
}

describe('linked blocks', () => {
	it('extracts block ids and hashes', () => {
		expect(sourceBlocks).toHaveLength(1);
		expect(sourceBlocks[0]).toMatchObject({ id: 'intro', body: 'Hello block.' });
	});

	it('reports current, changed, frozen and missing links', () => {
		const consumer = file('consumer', 'consumer.md', include);
		expect(buildLinkReport([source, consumer])[0]?.state).toBe('current');
		source.content = source.content.replace('Hello block.', 'Changed block.');
		expect(buildLinkReport([source, consumer])[0]?.state).toBe('changed');
		const frozen = freezeInclude(consumer.content, extractIncludes(consumer)[0]!);
		consumer.content = frozen;
		expect(buildLinkReport([source, consumer])[0]?.state).toBe('frozen');
		consumer.content = include.replace('source.md', 'missing.md');
		expect(buildLinkReport([source, consumer])[0]?.state).toBe('missing');
	});

	it('updates only the snapshot and detaches without deleting text', () => {
		const consumer = file('consumer', 'consumer.md', include + '\nKeep me.\n');
		const updated = updateInclude(consumer.content, extractIncludes(consumer)[0]!, 'Fresh block.');
		expect(updated).toContain('Fresh block.');
		expect(updated).toContain('Keep me.');
		expect(updated).not.toContain('Hello block.');
		const detached = detachInclude(updated, extractIncludes({ ...consumer, content: updated })[0]!);
		expect(detached).toContain('Fresh block.');
		expect(detached).not.toContain('mdsh-include');
	});

	it('detects cycles', () => {
		const a = file('a', 'a.md', '<!-- mdsh-block id="x" -->\nA\n<!-- /mdsh-block -->');
		a.content = insertInclude(a.content, 'b.md', 'y', 'h', 'B').replace('a.md', 'a.md');
		const b = file('b', 'b.md', '<!-- mdsh-block id="y" -->\nB\n<!-- /mdsh-block -->');
		b.content = insertInclude(b.content, 'a.md', 'x', 'h', 'A');
		const reports = buildLinkReport([a, b]);
		expect(reports.some((report) => report.state === 'cycle')).toBe(true);
	});
});
