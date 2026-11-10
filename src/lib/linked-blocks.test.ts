import { describe, expect, it } from 'vitest';
import {
	buildLinkReport,
	currentLinkReport,
	detachInclude,
	extractBlocks,
	extractIncludes,
	freezeInclude,
	insertInclude,
	linkedBlockKey,
	locateInclude,
	updateInclude
} from './linked-blocks';
import type { FileItem } from './types';

const now = Date.now();
function file(id: string, name: string, content: string, extra: Partial<FileItem> = {}): FileItem {
	return { id, name, content, createdAt: now, updatedAt: now, dirty: false, ...extra };
}

function projectFile(
	id: string,
	projectId: string,
	relativePath: string,
	content: string
): FileItem {
	return file(id, relativePath.split('/').pop()!, content, { projectId, relativePath });
}

function blockFile(id: string, name: string, blockId: string, body: string): FileItem {
	return file(id, name, `<!-- mdsh-block id="${blockId}" -->\n${body}\n<!-- /mdsh-block -->`);
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
		const frozen = freezeInclude(consumer.content, extractIncludes(consumer)[0]!)!;
		consumer.content = frozen;
		expect(buildLinkReport([source, consumer])[0]?.state).toBe('frozen');
		consumer.content = include.replace('source.md', 'missing.md');
		expect(buildLinkReport([source, consumer])[0]?.state).toBe('missing');
	});

	it('updates only the snapshot and detaches without deleting text', () => {
		const consumer = file('consumer', 'consumer.md', include + '\nKeep me.\n');
		const updated = updateInclude(consumer.content, extractIncludes(consumer)[0]!, 'Fresh block.')!;
		expect(updated).toContain('Fresh block.');
		expect(updated).toContain('Keep me.');
		expect(updated).not.toContain('Hello block.');
		const detached = detachInclude(
			updated,
			extractIncludes({ ...consumer, content: updated })[0]!
		)!;
		expect(detached).toContain('Fresh block.');
		expect(detached).not.toContain('mdsh-include');
	});

	it('revalidates a captured include after the consumer document changes', () => {
		const consumer = file('consumer', 'consumer.md', include + '\nKeep me.\n');
		const captured = extractIncludes(consumer)[0]!;
		const prefix = 'A NEW PREFIX\n';
		const shifted = prefix + consumer.content;
		const current = locateInclude(shifted, consumer.id, captured)!;
		expect(current.from).toBe(captured.from + prefix.length);
		const updated = updateInclude(shifted, captured, 'Fresh block.')!;
		expect(updated.startsWith(prefix)).toBe(true);
		expect(updated).toContain('Fresh block.');
		expect(updated).toContain('Keep me.');
		const refreshed = extractIncludes({ ...consumer, content: updated })[0]!;
		expect(detachInclude(updated, refreshed)).toBe(prefix + '\n\nFresh block.\n\nKeep me.\n');
	});

	it('rejects a stale range with repeated identical includes or a deleted include', () => {
		const consumer = file('consumer', 'consumer.md', include + '\n' + include + '\n');
		const captured = extractIncludes(consumer)[0]!;
		const shifted = 'A NEW PREFIX\n' + consumer.content;
		expect(locateInclude(shifted, consumer.id, captured)).toBeNull();
		expect(updateInclude(shifted, captured, 'Fresh block.')).toBeNull();
		expect(freezeInclude(shifted, captured)).toBeNull();
		expect(detachInclude(shifted, captured)).toBeNull();

		const removed = 'A NEW PREFIX\n';
		expect(locateInclude(removed, consumer.id, captured)).toBeNull();
		expect(detachInclude(removed, captured)).toBeNull();
	});

	it('keeps a distinct identity for repeated block IDs and reports ambiguity', () => {
		const repeated = file(
			'repeated',
			'repeated.md',
			'<!-- mdsh-block id="x" -->\nFirst\n<!-- /mdsh-block -->\n' +
				'<!-- mdsh-block id="x" -->\nSecond\n<!-- /mdsh-block -->'
		);
		const blocks = extractBlocks(repeated);
		expect(blocks.map((block) => block.key)).toEqual([
			linkedBlockKey('repeated', 'x', 0),
			linkedBlockKey('repeated', 'x', 1)
		]);
		const consumer = file(
			'consumer',
			'consumer.md',
			insertInclude('', 'repeated.md', 'x', blocks[1]!.hash, blocks[1]!.body)
		);
		expect(buildLinkReport([repeated, consumer])[0]?.state).toBe('ambiguous');
	});

	it('resolves project sources only inside the consumer project', () => {
		const sourceA = blockFile('a-source', 'intro.md', 'x', 'A secret text');
		sourceA.projectId = 'A';
		sourceA.relativePath = 'docs/intro.md';
		const sourceB = blockFile('b-source', 'intro.md', 'x', 'B intended text');
		sourceB.projectId = 'B';
		sourceB.relativePath = 'docs/intro.md';
		const blockB = extractBlocks(sourceB)[0]!;
		const consumer = projectFile(
			'b-consumer',
			'B',
			'notes/consumer.md',
			insertInclude('', 'docs/intro.md', 'x', blockB.hash, blockB.body)
		);
		for (const files of [
			[sourceA, sourceB, consumer],
			[sourceB, sourceA, consumer]
		]) {
			const report = buildLinkReport(files).find((entry) => entry.include.fileId === consumer.id)!;
			expect(report.state).toBe('current');
			expect(report.sourceBody).toBe('B intended text');
			const fresh = currentLinkReport(files, consumer.id, report.include)!;
			expect(updateInclude(consumer.content, fresh.include, fresh.sourceBody)).toBe(
				consumer.content
			);
		}
	});

	it('uses canonical project path keys and rejects ambiguous aliases', () => {
		const source = projectFile(
			'source',
			'P',
			'docs/Guide.md',
			'<!-- mdsh-block id="x" -->\nGuide\n<!-- /mdsh-block -->'
		);
		const block = extractBlocks(source)[0]!;
		const consumer = projectFile(
			'consumer',
			'P',
			'notes/reader.md',
			insertInclude('', 'DOCS/GUIDE.MD', 'x', block.hash, block.body)
		);
		expect(buildLinkReport([source, consumer])[0]?.state).toBe('current');

		const first = projectFile(
			'first',
			'P',
			'a/intro.md',
			'<!-- mdsh-block id="x" -->\nFirst\n<!-- /mdsh-block -->'
		);
		const second = projectFile(
			'second',
			'P',
			'b/intro.md',
			'<!-- mdsh-block id="x" -->\nSecond\n<!-- /mdsh-block -->'
		);
		const alias = projectFile(
			'alias',
			'P',
			'notes/alias.md',
			insertInclude('', 'intro.md', 'x', block.hash, block.body)
		);
		expect(
			buildLinkReport([first, second, alias]).find((report) => report.include.fileId === alias.id)
				?.state
		).toBe('ambiguous');

		const standAloneA = blockFile('stand-a', 'intro.md', 'x', 'Stand A');
		const standAloneB = blockFile('stand-b', 'intro.md', 'x', 'Stand B');
		const standAloneConsumer = file(
			'stand-consumer',
			'consumer.md',
			insertInclude('', 'intro.md', 'x', block.hash, block.body)
		);
		expect(buildLinkReport([standAloneA, standAloneB, standAloneConsumer])[0]?.state).toBe(
			'ambiguous'
		);
	});

	it('never crosses a project boundary for missing or cyclic sources', () => {
		const sourceB = blockFile('b-source', 'intro.md', 'x', 'Other project');
		sourceB.projectId = 'B';
		sourceB.relativePath = 'docs/intro.md';
		const consumerA = projectFile('a-consumer', 'A', 'notes/reader.md', '');
		const blockB = extractBlocks(sourceB)[0]!;
		consumerA.content = insertInclude('', 'docs/intro.md', 'x', blockB.hash, blockB.body);
		expect(buildLinkReport([sourceB, consumerA])[0]?.state).toBe('missing');

		sourceB.content += `\n${insertInclude('', 'notes/reader.md', 'x', 'h', 'Other')}`;
		const reports = buildLinkReport([sourceB, consumerA]);
		expect(reports.some((report) => report.state === 'cycle')).toBe(false);
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
