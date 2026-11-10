import { describe, expect, it } from 'vitest';
import { readDroppedFiles } from './project-transfer';

interface FakeNode {
	name: string;
	directory?: boolean;
	children?: FakeNode[];
	/** Overrides the batches returned by readEntries. */
	batches?: FakeNode[][];
}

function asEntry(node: FakeNode) {
	return {
		name: node.name,
		isFile: !node.directory,
		isDirectory: !!node.directory,
		file(resolve: (file: File) => void) {
			resolve(new File([node.name], node.name));
		},
		createReader() {
			const batches = node.batches ?? [node.children ?? []];
			let index = 0;
			return {
				readEntries(callback: (entries: unknown[]) => void) {
					const batch = (batches[index++] ?? []).map(asEntry);
					queueMicrotask(() => callback(batch));
				}
			};
		}
	};
}

async function read(node: FakeNode): Promise<string[]> {
	const dataTransfer = {
		items: [{ webkitGetAsEntry: () => asEntry(node) }],
		files: []
	} as unknown as DataTransfer;
	const files = await readDroppedFiles(dataTransfer);
	return files.map((entry) => entry.relativePath);
}

describe('dropped directory discovery', () => {
	it('reads every readEntries batch with deterministic paths', async () => {
		const paths = await read({
			name: 'Root',
			directory: true,
			batches: [
				[{ name: 'a.md' }, { name: 'sub', directory: true, children: [{ name: 'b.md' }] }],
				[{ name: 'c.md' }],
				[]
			]
		});
		expect(paths).toEqual(['Root/a.md', 'Root/sub/b.md', 'Root/c.md']);
	});

	it('stops an overdeep empty tree before reading its children', async () => {
		let node: FakeNode = { name: 'Leaf', directory: true };
		for (let depth = 0; depth < 40; depth += 1) {
			node = { name: `d${depth}`, directory: true, children: [node] };
		}
		await expect(read(node)).rejects.toThrow('Project directory depth limit');
	});

	it('stops a wide empty tree at the visited-entry budget', async () => {
		const children = Array.from({ length: 6000 }, (_, index) => ({
			name: `empty-${index}`,
			directory: true
		}));
		await expect(read({ name: 'Wide', directory: true, children })).rejects.toThrow(
			'Project discovery entry limit'
		);
	});
});
