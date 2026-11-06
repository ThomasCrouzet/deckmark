#!/usr/bin/env node
// Opt-in local MCP server. It reads JSON-RPC over stdin and writes JSON-RPC over
// stdout. Access is limited to explicit --root directories. No write tool, no
// shell, no network listener, and no external agent account.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, writeSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 500;
const SENSITIVE =
	/(^|\/)\.env(\.|$)|(^|\/)\.git(\/|$)|(^|\/)id_(rsa|ed25519)|\.(pem|key|p12|pfx)$/i;
const TEXT = new Set([
	'.md',
	'.markdown',
	'.mdx',
	'.txt',
	'.json',
	'.js',
	'.mjs',
	'.ts',
	'.py',
	'.rs',
	'.sh',
	'.css',
	'.html',
	'.yml',
	'.yaml',
	'.toml'
]);

function fail(message, code = 'mcp_error') {
	const error = new Error(message);
	error.code = code;
	throw error;
}

function parseRoots(argv) {
	const roots = [];
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] !== '--root')
			fail(
				`Unknown argument: ${argv[index]}. Usage: deckmark-mcp --root <directory> [--root ...]`,
				'usage'
			);
		const value = argv[++index];
		if (!value) fail('Missing --root value.', 'usage');
		let real;
		try {
			real = realpathSync(value);
		} catch {
			fail(`Root directory does not exist: ${value}`, 'usage');
		}
		if (!statSync(real).isDirectory()) fail(`Not a directory: ${value}`, 'usage');
		roots.push(real);
	}
	if (roots.length === 0) fail('At least one --root directory is required.', 'usage');
	return [...new Set(roots)].slice(0, 8);
}

// A usage error is one line on standard error and exit code 2. It must not
// print a stack trace and it must not start the protocol loop.
let roots;
try {
	roots = parseRoots(process.argv.slice(2));
} catch (error) {
	const message =
		error?.code === 'usage'
			? error.message
			: `Cannot use the approved roots: ${error?.message ?? error}`;
	writeSync(2, `deckmark-mcp: ${message}\n`);
	process.exit(2);
}

function safePath(requested) {
	if (typeof requested !== 'string' || requested.length === 0) fail('Path is required');
	if (isAbsolute(requested) || requested.split(/[\\/]/).includes('..'))
		fail('Path traversal rejected', 'unsafe-path');
	if (SENSITIVE.test(requested)) fail('Sensitive files are excluded', 'sensitive');
	const matches = new Set();
	for (const root of roots) {
		const candidate = resolve(root, requested);
		let real;
		try {
			real = realpathSync(candidate);
		} catch {
			continue;
		}
		if (real !== root && !real.startsWith(root + sep)) continue;
		if (SENSITIVE.test(relative(root, real).split(sep).join('/')))
			fail('Sensitive files are excluded', 'sensitive');
		matches.add(real);
	}
	if (matches.size > 1) fail('Path matches multiple approved roots', 'ambiguous-path');
	const [real] = matches;
	if (!real) fail('Path is outside the approved roots or does not exist', 'outside-root');
	return real;
}

function classify(path) {
	const extension = extname(path).toLowerCase();
	if (extension === '.pdf') return 'pdf';
	if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp'].includes(extension))
		return 'image';
	if (['.md', '.markdown', '.mdx'].includes(extension)) return 'note';
	if (extension === '.txt' || TEXT.has(extension)) return 'code';
	return 'binary';
}

function walk(root, directory = root, output = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (output.length >= MAX_FILES) break;
		if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.mdsh') continue;
		const absolute = join(directory, entry.name);
		const relativePath = relative(root, absolute).split(sep).join('/');
		if (SENSITIVE.test(relativePath)) continue;
		if (entry.isDirectory()) walk(root, absolute, output);
		else if (entry.isFile())
			output.push({
				path: relativePath,
				kind: classify(entry.name),
				bytes: statSync(absolute).size
			});
	}
	return output;
}

function toolResult(value, isError = false) {
	return {
		content: [
			{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
		],
		...(isError ? { isError: true } : {})
	};
}

const tools = [
	{
		name: 'list_files',
		description: 'List files under the approved roots.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false }
	},
	{
		name: 'read_file',
		description: 'Read one text file. Images and PDFs return metadata only.',
		inputSchema: {
			type: 'object',
			properties: { path: { type: 'string' } },
			required: ['path'],
			additionalProperties: false
		}
	},
	{
		name: 'search',
		description: 'Search text under the approved roots. Returns path and line.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				path: { type: 'string' },
				limit: { type: 'integer', minimum: 1, maximum: 100 }
			},
			required: ['query'],
			additionalProperties: false
		}
	},
	{
		name: 'check',
		description: 'Report missing wiki targets and malformed front matter.',
		inputSchema: {
			type: 'object',
			properties: { path: { type: 'string' } },
			additionalProperties: false
		}
	},
	{
		name: 'project_metadata',
		description: 'Report document counts, kinds and bytes.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false }
	},
	{
		name: 'propose_patch',
		description: 'Validate a proposed before/after replacement. Never writes the file.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				before: { type: 'string' },
				after: { type: 'string' }
			},
			required: ['path', 'before', 'after'],
			additionalProperties: false
		}
	}
];

function readText(absolute) {
	const info = statSync(absolute);
	if (!info.isFile()) fail('Not a file', 'input');
	if (info.size > MAX_FILE_BYTES) fail('File exceeds the 1 MiB read limit', 'input');
	if (!TEXT.has(extname(absolute).toLowerCase()))
		fail('Binary files are not readable as text', 'input');
	return readFileSync(absolute, 'utf8');
}

function callTool(name, args = {}) {
	if (!tools.some((tool) => tool.name === name)) fail(`Unknown tool: ${name}`, 'unknown-tool');
	switch (name) {
		case 'list_files': {
			const files = roots.flatMap((root) => walk(root));
			return toolResult({ files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES });
		}
		case 'read_file': {
			const absolute = safePath(args.path);
			const kind = classify(absolute);
			if (kind === 'image' || kind === 'pdf')
				return toolResult({ path: args.path, kind, bytes: statSync(absolute).size, text: null });
			return toolResult({ path: args.path, kind, text: readText(absolute) });
		}
		case 'search': {
			if (typeof args.query !== 'string' || args.query.length === 0)
				fail('Query is required', 'input');
			const limit = Math.min(100, Math.max(1, Number(args.limit ?? 50)));
			const base = args.path ? [safePath(args.path)] : roots;
			const files = base.flatMap((root) =>
				statSync(root).isFile()
					? [{ absolute: root }]
					: walk(root).map((entry) => ({ absolute: join(root, entry.path) }))
			);
			const hits = [];
			for (const file of files.slice(0, MAX_FILES)) {
				if (!TEXT.has(extname(file.absolute).toLowerCase())) continue;
				const text = readText(file.absolute);
				for (const [index, line] of text.split(/\r?\n/).entries()) {
					if (!line.includes(args.query)) continue;
					hits.push({
						path: relative(
							roots.find((root) => file.absolute.startsWith(root + sep)) ?? roots[0],
							file.absolute
						)
							.split(sep)
							.join('/'),
						line: index + 1,
						text: line.slice(0, 200)
					});
					if (hits.length >= limit) break;
				}
				if (hits.length >= limit) break;
			}
			return toolResult({ query: args.query, hits, truncated: hits.length >= limit });
		}
		case 'check': {
			const base = args.path ? [safePath(args.path)] : roots;
			const files = base.flatMap((root) =>
				statSync(root).isFile()
					? [{ absolute: root }]
					: walk(root).map((entry) => ({ absolute: join(root, entry.path) }))
			);
			const names = new Set(
				files
					.filter((file) => classify(file.absolute) === 'note')
					.map((file) =>
						file.absolute
							.split(/[\\/]/)
							.pop()
							.replace(/\.[^.]+$/, '')
							.toLowerCase()
					)
			);
			const issues = [];
			for (const file of files.filter((entry) => classify(entry.absolute) === 'note')) {
				const text = readText(file.absolute);
				if (text.startsWith('---') && !/^---[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text))
					issues.push({
						path: file.absolute,
						line: 1,
						severity: 'error',
						message: 'Unclosed front matter'
					});
				for (const match of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
					if (!names.has(match[1].trim().toLowerCase()))
						issues.push({
							path: file.absolute,
							line: text.slice(0, match.index).split('\n').length,
							severity: 'warning',
							message: `Missing wiki target: ${match[1].trim()}`
						});
				}
			}
			return toolResult({ issues, count: issues.length });
		}
		case 'project_metadata': {
			const files = roots.flatMap((root) => walk(root));
			const kinds = {};
			for (const file of files) kinds[file.kind] = (kinds[file.kind] ?? 0) + 1;
			return toolResult({
				roots,
				files: files.length,
				kinds,
				bytes: files.reduce((sum, file) => sum + file.bytes, 0)
			});
		}
		case 'propose_patch': {
			const absolute = safePath(args.path);
			const text = readText(absolute);
			if (typeof args.before !== 'string' || args.before.length === 0)
				fail('before is required', 'input');
			const occurrences = text.split(args.before).length - 1;
			if (occurrences !== 1) fail(`Expected one match, found ${occurrences}`, 'stale');
			const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
			return toolResult({
				path: args.path,
				baseHash: hash,
				applied: false,
				edits: [{ before: args.before, after: String(args.after) }],
				before: text,
				after: text.replace(args.before, String(args.after))
			});
		}
		default:
			return toolResult('Unknown tool', true);
	}
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = createInterface({ input: process.stdin, terminal: false });
input.on('line', (line) => {
	if (!line.trim()) return;
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
		return;
	}
	if (
		request === null ||
		typeof request !== 'object' ||
		Array.isArray(request) ||
		request.jsonrpc !== '2.0' ||
		typeof request.method !== 'string' ||
		('id' in request &&
			request.id !== null &&
			typeof request.id !== 'string' &&
			!(typeof request.id === 'number' && Number.isFinite(request.id))) ||
		('params' in request && (request.params === null || typeof request.params !== 'object'))
	) {
		send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
		return;
	}
	if (!('id' in request)) return;
	try {
		if (request.method === 'initialize') {
			send({
				jsonrpc: '2.0',
				id: request.id,
				result: {
					protocolVersion: '2024-11-05',
					capabilities: { tools: {} },
					serverInfo: { name: 'deckmark-mcp', version: '1.0.0' }
				}
			});
			return;
		}
		if (request.method === 'ping') {
			send({ jsonrpc: '2.0', id: request.id, result: {} });
			return;
		}
		if (request.method === 'tools/list') {
			send({ jsonrpc: '2.0', id: request.id, result: { tools } });
			return;
		}
		if (request.method === 'tools/call') {
			try {
				send({
					jsonrpc: '2.0',
					id: request.id,
					result: callTool(request.params?.name, request.params?.arguments)
				});
			} catch (error) {
				send({
					jsonrpc: '2.0',
					id: request.id,
					result: toolResult(`${error.code ?? 'error'}: ${error.message}`, true)
				});
			}
			return;
		}
		send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
	} catch (error) {
		send({
			jsonrpc: '2.0',
			id: request.id ?? null,
			error: { code: -32603, message: String(error?.message ?? error) }
		});
	}
});
