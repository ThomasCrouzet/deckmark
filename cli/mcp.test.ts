import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root = '';
let secondRoot = '';
let server: ChildProcessWithoutNullStreams | null = null;
let buffer = '';
const pending = new Map<number, (value: Record<string, unknown>) => void>();

function nextId() {
	return Math.floor(Math.random() * 1_000_000);
}

function exchange(lines: string[]) {
	const result = spawnSync(
		process.execPath,
		[resolve('bin/deckmark-mcp.mjs'), '--root', root, '--root', secondRoot],
		{ input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 5000 }
	);
	expect(result.error).toBeUndefined();
	expect(result.stderr).toBe('');
	expect(result.status).toBe(0);
	return result.stdout
		.trim()
		.split('\n')
		.map((line): unknown => JSON.parse(line));
}

async function request(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
	const id = nextId();
	const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
	const response = new Promise<Record<string, unknown>>((resolvePromise) => {
		pending.set(id, resolvePromise);
	});
	server!.stdin.write(`${message}\n`);
	return response;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'deckmark-mcp-'));
	secondRoot = mkdtempSync(join(tmpdir(), 'deckmark-mcp-second-'));
	buffer = '';
	pending.clear();
	mkdirSync(join(root, 'notes'));
	writeFileSync(join(root, 'notes', 'guide.md'), '# Guide\n\nSee [[Missing]].\n');
	writeFileSync(join(root, '.env'), 'SECRET=1');
	server = spawn(process.execPath, [resolve('bin/deckmark-mcp.mjs'), '--root', root], {
		stdio: ['pipe', 'pipe', 'pipe']
	});
	server.stdout.on('data', (chunk: Buffer) => {
		buffer += chunk.toString();
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.trim()) continue;
			const value = JSON.parse(line) as { id?: number };
			if (value.id === undefined) continue;
			pending.get(value.id)?.(value);
			pending.delete(value.id);
		}
	});
});

afterEach(() => {
	server?.kill();
	server = null;
	rmSync(root, { recursive: true, force: true });
	rmSync(secondRoot, { recursive: true, force: true });
});

describe('deckmark MCP server', () => {
	it.each(['read_file', 'search', 'check', 'propose_patch'])(
		'rejects excluded canonical files and directories for %s',
		async (name) => {
			writeFileSync(join(root, '.env.json'), 'secret-marker');
			symlinkSync('.env.json', join(root, 'public.json'));
			mkdirSync(join(root, '.git'));
			writeFileSync(join(root, '.git', 'secret.md'), 'secret-marker [[Missing]]');
			symlinkSync('.git', join(root, 'public'));
			for (const path of ['public.json', 'public/secret.md', 'public']) {
				const response = await request('tools/call', {
					name,
					arguments: { path, query: 'secret-marker', before: 'secret-marker', after: 'changed' }
				});
				expect(response.result).toMatchObject({ isError: true });
				expect(JSON.stringify(response.result)).toContain('sensitive');
				expect(JSON.stringify(response.result)).not.toContain('secret-marker');
			}
		}
	);

	it.each(['read_file', 'search', 'check', 'propose_patch'])(
		'rejects ambiguous paths across roots for %s',
		(name) => {
			writeFileSync(join(root, 'shared.md'), 'first-root');
			writeFileSync(join(secondRoot, 'shared.md'), 'second-root');
			const responses = exchange([
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: {
						name,
						arguments: { path: 'shared.md', query: 'root', before: 'first-root', after: 'changed' }
					}
				})
			]);
			expect(responses).toMatchObject([{ id: 1, result: { isError: true } }]);
			expect(JSON.stringify(responses)).toContain('ambiguous-path');
			expect(JSON.stringify(responses)).not.toContain('first-root');
			expect(readFileSync(join(root, 'shared.md'), 'utf8')).toBe('first-root');
			expect(readFileSync(join(secondRoot, 'shared.md'), 'utf8')).toBe('second-root');
		}
	);

	it('reads a unique later-root path and a safe alias', () => {
		writeFileSync(join(secondRoot, 'unique.md'), 'later-root');
		symlinkSync('notes/guide.md', join(root, 'alias.md'));
		const responses = exchange(
			['unique.md', 'alias.md'].map((path, id) =>
				JSON.stringify({
					jsonrpc: '2.0',
					id,
					method: 'tools/call',
					params: { name: 'read_file', arguments: { path } }
				})
			)
		);
		expect(responses).toHaveLength(2);
		expect(JSON.stringify(responses[0])).toContain('later-root');
		expect(JSON.stringify(responses[1])).toContain('# Guide');
	});

	it.each([
		['null', -32600],
		['[]', -32600],
		['42', -32600],
		['"invalid"', -32600],
		['{}', -32600],
		['{"jsonrpc":"1.0","id":1,"method":"ping"}', -32600],
		['{"jsonrpc":"2.0","id":{},"method":"ping"}', -32600],
		['{"jsonrpc":"2.0","id":false,"method":"ping"}', -32600],
		['{"jsonrpc":"2.0","id":1,"method":null}', -32600],
		['{"jsonrpc":"2.0","id":1,"method":"ping","params":null}', -32600],
		['{"jsonrpc":"2.0","id":1,"method":"ping","params":"bad"}', -32600],
		['{', -32700]
	])('keeps serving after malformed input %s', (line, code) => {
		const responses = exchange([line, '{"jsonrpc":"2.0","id":99,"method":"ping"}']);
		expect(responses).toEqual([
			{
				jsonrpc: '2.0',
				id: null,
				error: { code, message: code === -32700 ? 'Parse error' : 'Invalid Request' }
			},
			{ jsonrpc: '2.0', id: 99, result: {} }
		]);
	});

	it('does not reply to notifications and preserves string and null request IDs', () => {
		const responses = exchange([
			'{"jsonrpc":"2.0","method":"notifications/initialized"}',
			'{"jsonrpc":"2.0","method":"ping"}',
			'{"jsonrpc":"2.0","method":"unknown"}',
			'{"jsonrpc":"2.0","method":"tools/call","params":{"name":"read_file","arguments":{"path":"missing"}}}',
			'{"jsonrpc":"2.0","id":"last","method":"ping"}',
			'{"jsonrpc":"2.0","id":null,"method":"ping"}'
		]);
		expect(responses).toEqual([
			{ jsonrpc: '2.0', id: 'last', result: {} },
			{ jsonrpc: '2.0', id: null, result: {} }
		]);
	});

	it('initializes, exposes read-only tools and reads a file', async () => {
		const initialized = await request('initialize');
		expect(initialized.result).toMatchObject({
			protocolVersion: '2024-11-05',
			serverInfo: { name: 'deckmark-mcp' }
		});
		const list = await request('tools/list');
		expect(list.result).toMatchObject({ tools: expect.any(Array) });
		const tools = (list.result as { tools: Array<{ name: string }> }).tools.map(
			(tool) => tool.name
		);
		expect(tools).toContain('read_file');
		expect(tools).not.toContain('write_file');
		const read = await request('tools/call', {
			name: 'read_file',
			arguments: { path: 'notes/guide.md' }
		});
		expect(JSON.stringify(read.result)).toContain('# Guide');
	});

	it('searches, checks, reports metadata and proposes a patch without writing', async () => {
		const search = await request('tools/call', {
			name: 'search',
			arguments: { query: 'Guide' }
		});
		expect(JSON.stringify(search.result)).toContain('notes/guide.md');
		const check = await request('tools/call', { name: 'check', arguments: {} });
		expect(JSON.stringify(check.result)).toContain('Missing wiki target');
		const metadata = await request('tools/call', { name: 'project_metadata', arguments: {} });
		const metadataText = (metadata.result as { content: Array<{ text: string }> }).content[0]!.text;
		expect(JSON.parse(metadataText).kinds.note).toBe(1);
		const before = readFileSync(join(root, 'notes', 'guide.md'), 'utf8');
		const patch = await request('tools/call', {
			name: 'propose_patch',
			arguments: { path: 'notes/guide.md', before: 'See [[Missing]].', after: 'Updated.' }
		});
		const patchText = (patch.result as { content: Array<{ text: string }> }).content[0]!.text;
		expect(JSON.parse(patchText).applied).toBe(false);
		expect(readFileSync(join(root, 'notes', 'guide.md'), 'utf8')).toBe(before);
	});

	it('rejects traversal and sensitive files', async () => {
		const traversal = await request('tools/call', {
			name: 'read_file',
			arguments: { path: '../outside.md' }
		});
		expect(JSON.stringify(traversal.result)).toContain('unsafe-path');
		const secret = await request('tools/call', {
			name: 'read_file',
			arguments: { path: '.env' }
		});
		expect(JSON.stringify(secret.result)).toContain('sensitive');
	});
});
