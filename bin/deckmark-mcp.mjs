#!/usr/bin/env node
// Opt-in local MCP server. It reads JSON-RPC over stdin and writes JSON-RPC over
// stdout. Access is limited to explicit --root directories. No write tool, no
// shell, no network listener, and no external agent account.

import { createHash } from 'node:crypto';
import { constants, realpathSync, statSync, writeSync } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 500;
const MAX_DIRECTORIES = 5000;
const MAX_DEPTH = 64;
const MAX_VISITED = 20000;
const MAX_TOTAL_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_ISSUES = 1000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_PATCH_INPUT_CHARS = 256 * 1024;
const MAX_INLINE_PATCH_BYTES = 256 * 1024;
const REQUEST_DEADLINE_MS = 10_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
// Credential-bearing path components. The list keeps ordinary source and
// configuration files readable, so it names credential stores and not every
// `.json`, `.toml` or `.yml` file.
const SENSITIVE_PATTERNS = [
	/(^|\/)\.env(\.|$)/i,
	/(^|\/)\.git(\/|$)/i,
	/(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.|$)/i,
	/\.(pem|key|p12|pfx|jks|keystore)$/i,
	/(^|\/)\.ssh(\/|$)/i,
	/(^|\/)\.gnupg(\/|$)/i,
	/(^|\/)\.aws(\/|$)/i,
	/(^|\/)\.azure(\/|$)/i,
	/(^|\/)\.kube(\/|$)/i,
	/(^|\/)\.docker(\/|$)/i,
	/(^|\/)\.config\/gcloud(\/|$)/i,
	/(^|\/)\.config\/gh(\/|$)/i,
	/(^|\/)\.config\/containers(\/|$)/i,
	/(^|\/)\.config\/azure(\/|$)/i,
	/(^|\/)\.config\/git\/credentials$/i,
	/(^|\/)\.netrc$/i,
	/(^|\/)_netrc$/i,
	/(^|\/)\.pypirc$/i,
	/(^|\/)\.git-credentials$/i,
	/(^|\/)\.npmrc$/i,
	/(^|\/)\.yarnrc\.yml$/i,
	/(^|\/)\.vault-token$/i,
	/(^|\/)\.pgpass$/i,
	/(^|\/)\.my\.cnf$/i,
	/(^|\/)\.htpasswd$/i,
	/(^|\/)\.terraformrc$/i,
	/(^|\/)\.cargo\/credentials(\.toml)?$/i,
	/(^|\/)\.gem\/credentials$/i,
	/(^|\/)\.password-store(\/|$)/i,
	/(^|\/)\.m2\/settings(-security)?\.xml$/i
];

function isSensitivePath(path) {
	const normalized = path.split('\\').join('/');
	return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}
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
	if (isSensitivePath(requested)) fail('Sensitive files are excluded', 'sensitive');
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
		if (isSensitivePath(relative(root, real).split(sep).join('/')) || isSensitivePath(real))
			fail('Sensitive files are excluded', 'sensitive');
		matches.add(real);
	}
	if (matches.size > 1) fail('Path matches multiple approved roots', 'ambiguous-path');
	const [real] = matches;
	if (!real) fail('Path is outside the approved roots or does not exist', 'outside-root');
	return real;
}

// Maps one canonical path to its approved root and checks the secret denylist.
// Every actual read repeats this decision on the opened object, so a path that
// was valid before a concurrent rename cannot authorize later bytes.
function approvedRealPath(real) {
	for (const root of roots) {
		if (real === root || real.startsWith(root + sep)) {
			const inside = relative(root, real).split(sep).join('/');
			if (isSensitivePath(inside) || isSensitivePath(real))
				fail('Sensitive files are excluded', 'sensitive');
			return { root, relativePath: inside };
		}
	}
	fail('Path is outside the approved roots or changed during the operation', 'outside-root');
}

// Returns the canonical path of an open descriptor when the platform exposes it.
// The descriptor, not the requested string, then identifies the object that the
// read uses.
function descriptorPath(fd) {
	for (const base of ['/proc/self/fd', '/dev/fd']) {
		try {
			const resolved = realpathSync(`${base}/${fd}`);
			if (resolved === base || resolved.startsWith(base + sep)) continue;
			return resolved;
		} catch {
			// The platform does not expose descriptor paths. The identity check
			// below still compares the opened inode with the canonical path.
		}
	}
	return null;
}

// Opens a canonical file without following a leaf symlink, then binds the
// approved-root decision to that descriptor. The caller reads from the returned
// handle, so a later path swap cannot change the bytes.
async function openAuthorized(absolute) {
	let handle;
	try {
		handle = await open(absolute, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
	} catch {
		fail('Path is outside the approved roots or changed during the operation', 'unsafe-path');
	}
	try {
		const info = await handle.stat();
		if (!info.isFile()) fail('Not a file', 'input');
		let canonical;
		try {
			canonical = realpathSync(absolute);
		} catch {
			fail('Path is outside the approved roots or changed during the operation', 'unsafe-path');
		}
		const authorized = approvedRealPath(canonical);
		const fromDescriptor = descriptorPath(handle.fd);
		if (fromDescriptor !== null) {
			const pinned = approvedRealPath(fromDescriptor);
			if (pinned.relativePath !== authorized.relativePath)
				fail('Path changed during the operation', 'unsafe-path');
		}
		let current;
		try {
			current = statSync(canonical);
		} catch {
			fail('Path is outside the approved roots or changed during the operation', 'unsafe-path');
		}
		if (current.dev !== info.dev || current.ino !== info.ino)
			fail('The file identity changed during the operation', 'unsafe-path');
		return { handle, info, canonical, root: authorized.root };
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
}

async function withAuthorizedFile(absolute, work) {
	const opened = await openAuthorized(absolute);
	try {
		return await work(opened);
	} finally {
		await opened.handle.close().catch(() => {});
	}
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

function deadline() {
	return Date.now() + REQUEST_DEADLINE_MS;
}

function checkDeadline(limit) {
	if (Date.now() > limit) fail('Operation exceeded the 10 s deadline', 'deadline');
}

// Iterative and asynchronous: the event loop keeps serving protocol messages
// between directory reads. Directory count, depth, visited entries, files and
// elapsed time all have explicit budgets.
async function walk(root, limit) {
	const output = [];
	const state = { directories: 0, visited: 0, truncated: false };
	const stack = [{ directory: root, depth: 0 }];
	while (stack.length > 0 && output.length < MAX_FILES) {
		checkDeadline(limit);
		const { directory, depth } = stack.pop();
		if (depth > MAX_DEPTH) {
			state.truncated = true;
			continue;
		}
		state.directories += 1;
		if (state.directories > MAX_DIRECTORIES) {
			state.truncated = true;
			break;
		}
		let handle;
		let listingDirectory;
		try {
			// Re-resolve the directory before it is opened. File reads repeat this
			// decision on their own descriptor.
			const realDirectory = realpathSync(directory);
			approvedRealPath(realDirectory);
			listingDirectory = realDirectory;
			handle = await opendir(realDirectory);
		} catch {
			state.truncated = true;
			continue;
		}
		for await (const entry of handle) {
			state.visited += 1;
			if (state.visited > MAX_VISITED || output.length >= MAX_FILES) {
				state.truncated = true;
				break;
			}
			if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.mdsh')
				continue;
			const absolute = join(listingDirectory, entry.name);
			const relativePath = relative(root, absolute).split(sep).join('/');
			if (isSensitivePath(relativePath)) continue;
			if (entry.isDirectory()) {
				stack.push({ directory: absolute, depth: depth + 1 });
			} else if (entry.isFile()) {
				try {
					const bytes = await authorizedSize(absolute);
					output.push({ path: relativePath, kind: classify(entry.name), bytes });
				} catch {
					state.truncated = true;
				}
			}
		}
	}
	return { files: output, truncated: state.truncated };
}

async function listFiles(limit) {
	const files = [];
	let truncated = false;
	for (const root of roots) {
		const result = await walk(root, limit);
		truncated ||= result.truncated;
		files.push(...result.files);
		if (files.length >= MAX_FILES) {
			truncated = true;
			break;
		}
	}
	return { files: files.slice(0, MAX_FILES), truncated: truncated || files.length > MAX_FILES };
}

function lineStarts(text) {
	const starts = [0];
	let index = text.indexOf('\n');
	while (index >= 0) {
		starts.push(index + 1);
		index = text.indexOf('\n', index + 1);
	}
	return starts;
}

function lineAt(starts, offset) {
	let low = 0;
	let high = starts.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if (starts[middle] <= offset) low = middle + 1;
		else high = middle - 1;
	}
	return high + 1;
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

async function readText(absolute) {
	if (!TEXT.has(extname(absolute).toLowerCase()))
		fail('Binary files are not readable as text', 'input');
	return withAuthorizedFile(absolute, async ({ handle, info }) => {
		if (info.size > MAX_FILE_BYTES) fail('File exceeds the 1 MiB read limit', 'input');
		const bytes = await handle.readFile();
		// Recheck the bytes that were actually read, not only the earlier stat size.
		if (bytes.byteLength > MAX_FILE_BYTES) fail('File exceeds the 1 MiB read limit', 'input');
		return bytes.toString('utf8');
	});
}

async function authorizedSize(absolute) {
	return withAuthorizedFile(absolute, async ({ info }) => info.size);
}

async function collectFiles(base, limit) {
	const files = [];
	let truncated = false;
	for (const root of base) {
		let info;
		try {
			info = statSync(root);
		} catch {
			truncated = true;
			continue;
		}
		if (info.isFile()) {
			files.push({ absolute: root });
			continue;
		}
		const result = await walk(root, limit);
		truncated ||= result.truncated;
		for (const entry of result.files) files.push({ absolute: join(root, entry.path) });
		if (files.length >= MAX_FILES) {
			truncated = true;
			break;
		}
	}
	return { files: files.slice(0, MAX_FILES), truncated: truncated || files.length > MAX_FILES };
}

async function callTool(name, args = {}) {
	const limit = deadline();
	if (!tools.some((tool) => tool.name === name)) fail(`Unknown tool: ${name}`, 'unknown-tool');
	switch (name) {
		case 'list_files': {
			return toolResult(await listFiles(limit));
		}
		case 'read_file': {
			const absolute = safePath(args.path);
			const kind = classify(absolute);
			if (kind === 'image' || kind === 'pdf')
				return toolResult({
					path: args.path,
					kind,
					bytes: await authorizedSize(absolute),
					text: null
				});
			return toolResult({ path: args.path, kind, text: await readText(absolute) });
		}
		case 'search': {
			if (typeof args.query !== 'string' || args.query.length === 0)
				fail('Query is required', 'input');
			const matchLimit = Math.min(100, Math.max(1, Number(args.limit ?? 50)));
			const base = args.path ? [safePath(args.path)] : roots;
			const collected = await collectFiles(base, limit);
			const hits = [];
			let totalBytes = 0;
			let truncated = collected.truncated;
			for (const file of collected.files) {
				checkDeadline(limit);
				if (!TEXT.has(extname(file.absolute).toLowerCase())) continue;
				const text = await readText(file.absolute);
				totalBytes += text.length;
				if (totalBytes > MAX_TOTAL_TEXT_BYTES) {
					truncated = true;
					break;
				}
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
					if (hits.length >= matchLimit) break;
				}
				if (hits.length >= matchLimit) break;
			}
			return toolResult({
				query: args.query,
				hits,
				truncated: truncated || hits.length >= matchLimit
			});
		}
		case 'check': {
			const base = args.path ? [safePath(args.path)] : roots;
			const collected = await collectFiles(base, limit);
			const notes = collected.files.filter((file) => classify(file.absolute) === 'note');
			const names = new Set(
				notes.map((file) =>
					file.absolute
						.split(/[\\/]/)
						.pop()
						.replace(/\.[^.]+$/, '')
						.toLowerCase()
				)
			);
			const issues = [];
			let totalBytes = 0;
			let truncated = collected.truncated;
			for (const file of notes) {
				checkDeadline(limit);
				if (issues.length >= MAX_ISSUES) {
					truncated = true;
					break;
				}
				const text = await readText(file.absolute);
				totalBytes += text.length;
				if (totalBytes > MAX_TOTAL_TEXT_BYTES) {
					truncated = true;
					break;
				}
				const starts = lineStarts(text);
				if (text.startsWith('---') && !/^---[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text))
					issues.push({
						path: file.absolute,
						line: 1,
						severity: 'error',
						message: 'Unclosed front matter'
					});
				for (const match of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
					if (issues.length >= MAX_ISSUES) {
						truncated = true;
						break;
					}
					if (!names.has(match[1].trim().toLowerCase()))
						issues.push({
							path: file.absolute,
							line: lineAt(starts, match.index),
							severity: 'warning',
							message: `Missing wiki target: ${match[1].trim()}`
						});
				}
			}
			return toolResult({
				issues,
				count: issues.length,
				truncated: truncated || issues.length >= MAX_ISSUES
			});
		}
		case 'project_metadata': {
			const collected = await listFiles(limit);
			const kinds = {};
			for (const file of collected.files) kinds[file.kind] = (kinds[file.kind] ?? 0) + 1;
			return toolResult({
				roots,
				files: collected.files.length,
				kinds,
				bytes: collected.files.reduce((sum, file) => sum + file.bytes, 0),
				truncated: collected.truncated
			});
		}
		case 'propose_patch': {
			const absolute = safePath(args.path);
			const text = await readText(absolute);
			if (typeof args.before !== 'string' || args.before.length === 0)
				fail('before is required', 'input');
			if (
				args.before.length > MAX_PATCH_INPUT_CHARS ||
				String(args.after).length > MAX_PATCH_INPUT_CHARS
			)
				fail('Patch input exceeds the 256 KiB limit', 'input');
			const occurrences = text.split(args.before).length - 1;
			if (occurrences !== 1) fail(`Expected one match, found ${occurrences}`, 'stale');
			const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
			const inlineBodies = text.length <= MAX_INLINE_PATCH_BYTES;
			return toolResult({
				path: args.path,
				baseHash: hash,
				applied: false,
				edits: [{ before: args.before, after: String(args.after) }],
				inlineBodies,
				...(inlineBodies
					? { before: text, after: text.replace(args.before, String(args.after)) }
					: {})
			});
		}
		default:
			return toolResult('Unknown tool', true);
	}
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolError(error) {
	return toolResult(`${error.code ?? 'error'}: ${error.message}`, true);
}

function withDeadline(work) {
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new Error('Operation exceeded the 10 s deadline');
			error.code = 'deadline';
			reject(error);
		}, REQUEST_DEADLINE_MS);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// One tool job runs at a time so results stay ordered. Protocol requests
// (ping, initialize, shutdown) bypass this queue and keep the server
// responsive while a heavy walk or scan is still running.
let toolChain = Promise.resolve();
function queueToolCall(id, params) {
	toolChain = toolChain.then(async () => {
		try {
			send({
				jsonrpc: '2.0',
				id,
				result: await withDeadline(callTool(params?.name, params?.arguments))
			});
		} catch (error) {
			send({ jsonrpc: '2.0', id, result: toolError(error) });
		}
	});
}

async function handleLine(line) {
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
			queueToolCall(request.id, request.params);
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
}

// A capped line reader rejects an oversized request while it is still
// buffered, before JSON parsing, and then discards the rest of that line.
let buffered = '';
let discarding = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	buffered += chunk;
	let newline = buffered.indexOf('\n');
	while (newline >= 0) {
		const line = buffered.slice(0, newline);
		buffered = buffered.slice(newline + 1);
		if (discarding) discarding = false;
		else if (Buffer.byteLength(line) > MAX_REQUEST_BYTES)
			send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeds 1 MiB' } });
		else void handleLine(line);
		newline = buffered.indexOf('\n');
	}
	if (buffered.length > MAX_REQUEST_BYTES) {
		buffered = '';
		if (!discarding) {
			discarding = true;
			send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeds 1 MiB' } });
		}
	}
});
process.stdin.on('end', () => {
	if (!discarding && buffered.trim()) void handleLine(buffered);
	buffered = '';
});
