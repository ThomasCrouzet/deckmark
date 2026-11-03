import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root = '';
let server: ChildProcessWithoutNullStreams | null = null;
let buffer = '';
const pending = new Map<number, (value: Record<string, unknown>) => void>();

function nextId() {
	return Math.floor(Math.random() * 1_000_000);
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
});

describe('deckmark MCP server', () => {
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
