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

	it('marks only edges inside an SCC as cyclic', () => {
		const a = file('a', 'a.md', '<!-- mdsh-block id="x" -->\nA\n<!-- /mdsh-block -->');
		const b = file('b', 'b.md', '<!-- mdsh-block id="y" -->\nB\n<!-- /mdsh-block -->');
		const c = file('c', 'c.md', '<!-- mdsh-block id="z" -->\nC\n<!-- /mdsh-block -->');
		a.content = insertInclude(a.content, 'b.md', 'y', 'h', 'B');
		b.content = insertInclude(b.content, 'c.md', 'z', 'h', 'C');
		c.content = insertInclude(c.content, 'c.md', 'z', 'h', 'C');
		const reports = buildLinkReport([a, b, c]);
		const states = Object.fromEntries(
			reports.map((report) => [
				`${report.include.fileId}:${report.include.sourcePath}`,
				report.state
			])
		);
		expect(states['a:b.md']).not.toBe('cycle');
		expect(states['b:c.md']).not.toBe('cycle');
		expect(states['c:c.md']).toBe('cycle');
	});

	it('resolves a wide diamond DAG without exponential traversal', () => {
		const files: FileItem[] = [];
		for (let layer = 0; layer < 24; layer++) {
			for (const side of ['l', 'r']) {
				const id = `${layer}${side}`;
				const target = layer < 23 ? [`${layer + 1}l.md`, `${layer + 1}r.md`] : [];
				let content = `<!-- mdsh-block id="b" -->\nLayer ${id}\n<!-- /mdsh-block -->`;
				for (const path of target)
					content = insertInclude(content, path, 'b', 'h', `Layer ${layer + 1}`);
				files.push(file(id, `${id}.md`, content));
			}
		}
		const started = performance.now();
		const reports = buildLinkReport(files);
		expect(reports).toHaveLength(23 * 2 * 2);
		expect(reports.every((report) => report.state !== 'cycle')).toBe(true);
		expect(performance.now() - started).toBeLessThan(500);
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
