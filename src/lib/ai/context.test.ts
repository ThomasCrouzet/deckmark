import { describe, expect, it } from 'vitest';
import { buildContext, isSecretPath, tokenEstimate } from './context';

const files = [
	{ id: 'a', name: 'a.md', content: 'Alpha', projectId: 'P' },
	{ id: 'b', name: 'b.py', content: 'print("b")', kind: 'code' as const, projectId: 'P' },
	{ id: 'c', name: '.env', content: 'TOKEN=secret', projectId: 'P' },
	{ id: 'd', name: 'image.png', content: '', kind: 'image' as const, projectId: 'P' },
	{ id: 'e', name: 'ignored.log', content: 'ignored', projectId: 'P' },
	{ id: 'f', name: 'f.md', content: 'F '.repeat(5000), projectId: 'P' }
];

describe('AI context manifest', () => {
	it('excludes secrets and binary files before transmission', () => {
		const bundle = buildContext({
			scope: 'project',
			activeId: 'a',
			selection: '',
			files,
			projectId: 'P'
		});
		const byPath = new Map(bundle.manifest.map((entry) => [entry.path, entry]));
		expect(byPath.get('.env')?.reason).toBe('secret');
		expect(byPath.get('image.png')?.reason).toBe('binary');
		expect(bundle.text).not.toContain('TOKEN=secret');
		expect(bundle.text).not.toContain('image.png');
	});

	it('honours ignore patterns and keeps a deterministic order', () => {
		const bundle = buildContext({
			scope: 'project',
			activeId: 'a',
			selection: '',
			files,
			projectId: 'P',
			ignorePatterns: ['*.log']
		});
		expect(bundle.manifest.map((entry) => entry.path)).toEqual([
			'.env',
			'a.md',
			'b.py',
			'f.md',
			'ignored.log',
			'image.png'
		]);
		expect(bundle.manifest.find((entry) => entry.path === 'ignored.log')?.reason).toBe('ignored');
	});

	it('fails closed when Project scope has no project id', () => {
		const scoped = [
			{ id: 'p', name: 'a.md', projectId: 'A', content: 'private project A' },
			{ id: 'q', name: 'b.md', projectId: 'B', content: 'private project B' },
			{ id: 's', name: 's.md', content: 'standalone secret' }
		];
		for (const projectId of [null, undefined, ''] as const) {
			const bundle = buildContext({
				scope: 'project',
				activeId: 's',
				selection: '',
				files: scoped,
				...(projectId === undefined ? {} : { projectId })
			});
			expect(bundle.manifest).toEqual([]);
			expect(bundle.text).toBe('');
			expect(bundle.estimatedTokens).toBe(0);
		}
	});

	it('keeps a valid Project scope to its exact project', () => {
		const scoped = [
			{ id: 'p', name: 'a.md', projectId: 'A', content: 'private project A' },
			{ id: 'q', name: 'b.md', projectId: 'B', content: 'private project B' },
			{ id: 's', name: 's.md', content: 'standalone secret' }
		];
		const bundle = buildContext({
			scope: 'project',
			activeId: 'p',
			selection: '',
			files: scoped,
			projectId: 'A'
		});
		expect(bundle.manifest.map((entry) => entry.id)).toEqual(['p']);
		expect(bundle.text).toContain('private project A');
		expect(bundle.text).not.toContain('private project B');
		expect(bundle.text).not.toContain('standalone secret');
	});

	it('selects only explicitly chosen files', () => {
		const bundle = buildContext({
			scope: 'files',
			activeId: 'a',
			selection: '',
			files,
			selectedIds: ['b']
		});
		expect(bundle.manifest.map((entry) => entry.path)).toEqual(['b.py']);
		expect(bundle.text).toContain('print("b")');
		expect(bundle.text).not.toContain('Alpha');
	});

	it('applies a deterministic token budget and truncation', () => {
		const bundle = buildContext({
			scope: 'project',
			activeId: 'a',
			selection: '',
			files: files.filter((file) => file.id === 'f'),
			projectId: 'P',
			maxTokens: 256
		});
		const entry = bundle.manifest[0]!;
		expect(entry.truncated).toBe(true);
		expect(entry.includedTokens).toBe(256);
		expect(bundle.estimatedTokens).toBe(256);
		expect(bundle.text.length).toBeLessThan(entry.bytes);
	});

	it('includes the exact selection and estimates its size', () => {
		const bundle = buildContext({
			scope: 'selection',
			activeId: 'a',
			selection: 'selected text',
			files
		});
		expect(bundle.text).toContain('selected text');
		expect(bundle.estimatedTokens).toBe(tokenEstimate('selected text'));
	});

	it('identifies common secret paths', () => {
		for (const path of ['.env', 'config/.env.local', 'id_rsa', 'certs/server.pem', 'secrets.json'])
			expect(isSecretPath(path)).toBe(true);
		expect(isSecretPath('notes.md')).toBe(false);
	});
});
