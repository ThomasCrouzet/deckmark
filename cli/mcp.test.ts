import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	mkdirSync,
	symlinkSync,
	unlinkSync
} from 'node:fs';
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

// Retained failure risks for the MCP filesystem boundary. A browser cannot
// start this process or move its directory entries. The risks are: a valid
// path replaced between authorization and read; an ancestor directory swapped
// for an outside symlink during a scan; a leaf replaced by a symlink; and a
// secret file reached through an in-root alias. The checks below repeat the
// real protocol and compare returned bytes with the approved fixture only.
describe('MCP authorization races', () => {
	it('rejects a leaf replaced by a symbolic link after an authorized read', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'deckmark-mcp-outside-'));
		try {
			writeFileSync(join(root, 'notes', 'approved.md'), 'approved-bytes');
			writeFileSync(join(outside, 'secret.md'), 'outside-secret');
			const first = await request('tools/call', {
				name: 'read_file',
				arguments: { path: 'notes/approved.md' }
			});
			expect(JSON.stringify(first.result)).toContain('approved-bytes');
			unlinkSync(join(root, 'notes', 'approved.md'));
			symlinkSync(join(outside, 'secret.md'), join(root, 'notes', 'approved.md'));
			const second = await request('tools/call', {
				name: 'read_file',
				arguments: { path: 'notes/approved.md' }
			});
			expect(second.result).toMatchObject({ isError: true });
			expect(JSON.stringify(second.result)).not.toContain('outside-secret');
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('never returns outside bytes while a directory is swapped repeatedly', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'deckmark-mcp-outside-'));
		const docs = join(root, 'docs');
		const held = join(root, 'docs-held');
		mkdirSync(docs);
		writeFileSync(join(docs, 'note.md'), 'APPROVED-BYTES');
		writeFileSync(join(outside, 'note.md'), 'OUTSIDE-SECRET');
		let swapped = false;
		let running = true;
		let swaps = 0;
		const toggle = () => {
			if (!running) return;
			try {
				if (!swapped) {
					renameSync(docs, held);
					symlinkSync(outside, docs);
					swapped = true;
				} else {
					unlinkSync(docs);
					renameSync(held, docs);
					swapped = false;
				}
				swaps += 1;
			} catch {
				// The other side of the swap may hold the name for a moment.
			}
			setTimeout(toggle, 0);
		};
		toggle();
		let approved = 0;
		try {
			for (let index = 0; index < 2000; index++) {
				const response = await request('tools/call', {
					name: 'read_file',
					arguments: { path: 'docs/note.md' }
				});
				const text = JSON.stringify(response.result);
				expect(text).not.toContain('OUTSIDE-SECRET');
				if ((response.result as { isError?: boolean }).isError) continue;
				expect(text).toContain('APPROVED-BYTES');
				approved += 1;
			}
		} finally {
			running = false;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
			try {
				if (swapped) unlinkSync(docs);
				renameSync(held, docs);
			} catch {
				// afterEach removes the whole tree.
			}
			rmSync(outside, { recursive: true, force: true });
		}
		expect(swaps).toBeGreaterThan(0);
		expect(approved).toBeGreaterThan(0);
	}, 20_000);

	it('keeps search and propose_patch inside the approved tree during swaps', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'deckmark-mcp-outside-'));
		const docs = join(root, 'docs');
		const held = join(root, 'docs-held');
		mkdirSync(docs);
		writeFileSync(join(docs, 'note.md'), 'APPROVED-BYTES');
		writeFileSync(join(outside, 'note.md'), 'OUTSIDE-SECRET');
		let swapped = false;
		let running = true;
		const toggle = () => {
			if (!running) return;
			try {
				if (!swapped) {
					renameSync(docs, held);
					symlinkSync(outside, docs);
					swapped = true;
				} else {
					unlinkSync(docs);
					renameSync(held, docs);
					swapped = false;
				}
			} catch {
				// The other side of the swap may hold the name for a moment.
			}
			setTimeout(toggle, 0);
		};
		toggle();
		try {
			for (let index = 0; index < 120; index++) {
				const search = await request('tools/call', {
					name: 'search',
					arguments: { query: 'SECRET' }
				});
				const searchText = (search.result as { content: Array<{ text: string }> }).content[0]!.text;
				if (!(search.result as { isError?: boolean }).isError) {
					const report = JSON.parse(searchText) as { hits?: unknown };
					expect(JSON.stringify(report.hits ?? [])).not.toContain('OUTSIDE-SECRET');
				}
				const patch = await request('tools/call', {
					name: 'propose_patch',
					arguments: { path: 'docs/note.md', before: 'APPROVED-BYTES', after: 'changed' }
				});
				expect(JSON.stringify(patch.result)).not.toContain('OUTSIDE-SECRET');
			}
		} finally {
			running = false;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
			try {
				if (swapped) unlinkSync(docs);
				renameSync(held, docs);
			} catch {
				// afterEach removes the whole tree.
			}
			rmSync(outside, { recursive: true, force: true });
		}
	}, 20_000);
});

describe('bounded MCP work', () => {
	it('indexes wiki diagnostic lines in linear time', async () => {
		const body = `${'line\n'.repeat(5000)}[[Missing]]\n`;
		writeFileSync(join(root, 'notes', 'long.md'), body);
		const response = await request('tools/call', { name: 'check', arguments: {} });
		const text = (response.result as { content: Array<{ text: string }> }).content[0]!.text;
		const report = JSON.parse(text) as { issues: Array<{ path: string; line: number }> };
		const issue = report.issues.find((entry) => entry.path.endsWith('long.md'));
		expect(issue?.line).toBe(5001);
	});

	it('survives a directory tree deeper than the walk limit', () => {
		let current = root;
		for (let depth = 0; depth < 70; depth++) {
			current = join(current, `d${depth}`);
			mkdirSync(current);
		}
		writeFileSync(join(current, 'deep.md'), '# Deep');
		const responses = exchange([
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'list_files', arguments: {} }
			})
		]);
		expect(responses).toMatchObject([{ id: 1 }]);
		const text = (responses[0] as { result: { content: Array<{ text: string }> } }).result
			.content[0]!.text;
		expect(JSON.parse(text).truncated).toBe(true);
	});

	it('answers ping before a queued heavy tool call', () => {
		const responses = exchange([
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'check', arguments: {} }
			}),
			JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })
		]);
		expect(responses.map((entry) => (entry as { id: number }).id)).toEqual([2, 1]);
	});

	it('rejects an oversized request line before parsing and keeps serving', () => {
		const responses = exchange([
			`{"jsonrpc":"2.0","id":1,"method":"ping","params":{"padding":"${'x'.repeat(1024 * 1024)}"}}`,
			'{"jsonrpc":"2.0","id":2,"method":"ping"}'
		]);
		expect(responses).toEqual([
			{
				jsonrpc: '2.0',
				id: null,
				error: { code: -32600, message: 'Request exceeds 1 MiB' }
			},
			{ jsonrpc: '2.0', id: 2, result: {} }
		]);
	});

	it('rejects oversized patch input and omits large inline bodies', async () => {
		const oversized = await request('tools/call', {
			name: 'propose_patch',
			arguments: {
				path: 'notes/guide.md',
				before: 'x'.repeat(300_000),
				after: 'y'
			}
		});
		expect(JSON.stringify(oversized.result)).toContain('256 KiB');

		writeFileSync(join(root, 'notes', 'large.md'), `${'# Large\n'.repeat(40_000)}target\n`);
		const patch = await request('tools/call', {
			name: 'propose_patch',
			arguments: { path: 'notes/large.md', before: 'target', after: 'changed' }
		});
		const text = (patch.result as { content: Array<{ text: string }> }).content[0]!.text;
		const report = JSON.parse(text) as { inlineBodies: boolean; before?: string; after?: string };
		expect(report.inlineBodies).toBe(false);
		expect(report.before).toBeUndefined();
		expect(report.after).toBeUndefined();
	});
});
