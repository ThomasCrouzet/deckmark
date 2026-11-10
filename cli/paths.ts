import { constants } from 'node:fs';
import {
	access,
	lstat,
	mkdir,
	open,
	opendir,
	realpath,
	rename,
	stat,
	unlink,
	type FileHandle
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { CliError, EXIT } from './exit';

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_ENTRIES = 5000;
export const MAX_DIRECTORIES = 10_000;
export const MAX_DIRECTORY_DEPTH = 64;

const IGNORED_DIRECTORIES = new Set([
	'.git',
	'.mdsh',
	'.svelte-kit',
	'build',
	'coverage',
	'dist',
	'node_modules',
	'playwright-report',
	'target',
	'test-results'
]);

export async function requireFile(path: string): Promise<string> {
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new Error('not a file');
		return await realpath(path);
	} catch {
		throw new CliError(EXIT.INPUT, 'input-not-found', `Cannot read file: ${path}`);
	}
}

export async function requireDirectory(path: string): Promise<string> {
	try {
		const info = await stat(path);
		if (!info.isDirectory()) throw new Error('not a directory');
		return await realpath(path);
	} catch {
		throw new CliError(EXIT.INPUT, 'input-not-found', `Cannot read directory: ${path}`);
	}
}

/** Converts platform separators to the slash form used by project paths. */
export function toProjectPath(path: string): string {
	return path.split(sep).join('/');
}

/**
 * True when `target` is `root` or a descendant of it. The test uses a path
 * component boundary, so `..notes` is inside while `..` is outside. The
 * platform path module also applies the Windows case-insensitive rule.
 */
export function isWithinRoot(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return (
		fromRoot === '' ||
		(!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
	);
}

export function displayPath(path: string): string {
	const absolute = resolve(path);
	const cwd = resolve(process.cwd());
	if (absolute === cwd) return '.';
	return isWithinRoot(cwd, absolute)
		? toProjectPath(relative(cwd, absolute))
		: toProjectPath(absolute);
}

export interface WalkOptions {
	maxEntries?: number;
	maxDirectories?: number;
	maxDepth?: number;
	deadline?: Deadline;
	/** Include only files that match this predicate. */
	accept?: (relativePath: string) => boolean;
}

/** Lists regular files in stable path order. Symbolic links are not followed. */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
	const limit = options.maxEntries ?? MAX_ENTRIES;
	const directoryLimit = options.maxDirectories ?? MAX_DIRECTORIES;
	const depthLimit = options.maxDepth ?? MAX_DIRECTORY_DEPTH;
	const found: string[] = [];
	const stack: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
	let directories = 0;
	const rootReal = await realpath(root).catch(() => {
		throw new CliError(EXIT.INPUT, 'input-unreadable', `Cannot read directory: ${root}`);
	});
	while (stack.length > 0) {
		options.deadline?.check();
		const current = stack.pop()!;
		if (current.depth > depthLimit)
			throw new CliError(EXIT.INPUT, 'depth-limit', `Directory depth exceeds ${depthLimit} levels`);
		directories += 1;
		if (directories > directoryLimit)
			throw new CliError(
				EXIT.INPUT,
				'directory-limit',
				`Directory has more than ${directoryLimit} folders`
			);
		const realDirectory = await realpath(current.directory).catch(() => {
			throw new CliError(
				EXIT.INPUT,
				'input-unreadable',
				`Cannot read directory: ${current.directory}`
			);
		});
		if (!isWithinRoot(rootReal, realDirectory))
			throw new CliError(
				EXIT.INPUT,
				'input-unreadable',
				`Directory changed during the scan: ${current.directory}`
			);
		let entries;
		try {
			entries = await opendir(current.directory);
		} catch {
			throw new CliError(
				EXIT.INPUT,
				'input-unreadable',
				`Cannot read directory: ${current.directory}`
			);
		}
		const names: Array<{ name: string; directory: boolean }> = [];
		for await (const entry of entries) {
			options.deadline?.check();
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
			if (entry.isDirectory()) names.push({ name: entry.name, directory: true });
			else if (entry.isFile()) names.push({ name: entry.name, directory: false });
		}
		names.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
		// Push folders in reverse so files keep a stable lexical visit order.
		const folders: Array<{ directory: string; depth: number }> = [];
		for (const entry of names) {
			const absolute = resolve(current.directory, entry.name);
			if (entry.directory) {
				folders.push({ directory: absolute, depth: current.depth + 1 });
				continue;
			}
			const path = toProjectPath(relative(root, absolute));
			if (options.accept && !options.accept(path)) continue;
			found.push(path);
			if (found.length > limit)
				throw new CliError(EXIT.INPUT, 'entry-limit', `Directory has more than ${limit} files`);
		}
		for (let index = folders.length - 1; index >= 0; index--) stack.push(folders[index]!);
	}
	return found.sort();
}

const READ_CHUNK_BYTES = 256 * 1024;
const NO_FOLLOW = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);

export interface ReadOptions {
	deadline?: Deadline;
	maxBytes?: number;
}

/**
 * Opens one regular file below the approved root and pins its identity.
 * The read uses the validated handle, so a later path swap cannot redirect it.
 */
async function openConfined(
	root: string,
	relativePath: string,
	options: ReadOptions
): Promise<{ handle: FileHandle; size: number }> {
	const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
	const rootReal = await realpath(root).catch(() => {
		throw new CliError(EXIT.INPUT, 'input-not-found', `Cannot read directory: ${root}`);
	});
	const absolute = resolve(rootReal, relativePath);
	if (!isWithinRoot(rootReal, absolute))
		throw new CliError(
			EXIT.INPUT,
			'input-outside-root',
			`File is outside the root: ${relativePath}`
		);
	options.deadline?.check();
	const leaf = await lstat(absolute).catch(() => {
		throw new CliError(EXIT.INPUT, 'input-not-found', `Cannot read file: ${relativePath}`);
	});
	if (leaf.isSymbolicLink())
		throw new CliError(
			EXIT.INPUT,
			'input-unreadable',
			`Symbolic links are not read: ${relativePath}`
		);
	if (!leaf.isFile())
		throw new CliError(EXIT.INPUT, 'input-not-readable', `Not a file: ${relativePath}`);
	if (leaf.size > maxBytes)
		throw new CliError(
			EXIT.INPUT,
			'file-too-large',
			`File is larger than ${maxBytes} bytes: ${relativePath}`
		);
	let handle: FileHandle;
	try {
		handle = await open(absolute, constants.O_RDONLY | NO_FOLLOW);
	} catch {
		throw new CliError(EXIT.INPUT, 'input-unreadable', `Cannot read file: ${relativePath}`);
	}
	try {
		const info = await handle.stat();
		if (!info.isFile())
			throw new CliError(EXIT.INPUT, 'input-not-readable', `Not a file: ${relativePath}`);
		if (info.size > maxBytes)
			throw new CliError(
				EXIT.INPUT,
				'file-too-large',
				`File is larger than ${maxBytes} bytes: ${relativePath}`
			);
		const resolved = await realpath(absolute);
		if (!isWithinRoot(rootReal, resolved))
			throw new CliError(
				EXIT.INPUT,
				'input-outside-root',
				`File is outside the root: ${relativePath}`
			);
		const onDisk = await stat(resolved);
		if (onDisk.dev !== info.dev || onDisk.ino !== info.ino)
			throw new CliError(
				EXIT.INPUT,
				'input-unreadable',
				`File changed during the read: ${relativePath}`
			);
		return { handle, size: info.size };
	} catch (error) {
		await handle.close().catch(() => {});
		if (error instanceof CliError) throw error;
		throw new CliError(EXIT.INPUT, 'input-unreadable', `Cannot read file: ${relativePath}`);
	}
}

/** Reads one confined file and enforces the byte budget while consuming it. */
async function readConfined(
	root: string,
	relativePath: string,
	options: ReadOptions
): Promise<Uint8Array> {
	const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
	const { handle } = await openConfined(root, relativePath, options);
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for (;;) {
			options.deadline?.check();
			const remaining = maxBytes + 1 - total;
			const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > maxBytes)
				throw new CliError(
					EXIT.INPUT,
					'file-too-large',
					`File is larger than ${maxBytes} bytes: ${relativePath}`
				);
			chunks.push(buffer.subarray(0, bytesRead));
		}
	} catch (error) {
		if (error instanceof CliError) throw error;
		throw new CliError(EXIT.INPUT, 'input-unreadable', `Cannot read file: ${relativePath}`);
	} finally {
		await handle.close().catch(() => {});
	}
	return Buffer.concat(chunks, total);
}

export async function readText(
	root: string,
	relativePath: string,
	options: ReadOptions = {}
): Promise<string> {
	const bytes = await readConfined(root, relativePath, options);
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new CliError(EXIT.INPUT, 'input-not-text', `File is not UTF-8 text: ${relativePath}`);
	}
}

export async function readBytes(
	root: string,
	relativePath: string,
	options: ReadOptions = {}
): Promise<Uint8Array> {
	return readConfined(root, relativePath, options);
}

export type OutputFormat = 'html' | 'md' | 'zip';

const OUTPUT_EXTENSIONS: Record<OutputFormat, readonly string[]> = {
	html: ['.html', '.htm'],
	md: ['.md', '.markdown', '.txt'],
	zip: ['.zip']
};

function hasTraversal(path: string): boolean {
	return path.split(/[\\/]+/).some((part) => part === '..') || path.includes('\0');
}

/**
 * Resolves an output target and rejects traversal, unsupported extensions,
 * and directories. A relative target must stay below the current directory.
 * The returned target records the approved parent identity for the write.
 */
export async function resolveOutput(
	path: string,
	format: OutputFormat,
	options: OutputOptions = {}
): Promise<string> {
	if (!path.trim() || hasTraversal(path))
		throw new CliError(EXIT.UNSAFE_PATH, 'unsafe-output', `Unsafe output path: ${path}`);
	const base = resolve(options.cwd ?? process.cwd());
	const target = resolve(base, path);
	const extension = target.slice(target.lastIndexOf('.')).toLowerCase();
	if (!OUTPUT_EXTENSIONS[format].includes(extension))
		throw new CliError(
			EXIT.USAGE,
			'unsupported-output',
			`Output for ${format} needs one of these extensions: ${OUTPUT_EXTENSIONS[format].join(', ')}`
		);
	let approval: OutputApproval;
	if (isAbsolute(path)) {
		// An explicit absolute path is a user decision. Reject directories below.
		approval = { confined: false, cwd: base, parent: null };
	} else {
		const cwd = await realpath(base);
		const parent = await nearestExistingParent(dirname(target));
		const realParent = await realpath(parent);
		if (!isWithinRoot(cwd, realParent))
			throw new CliError(EXIT.UNSAFE_PATH, 'unsafe-output', `Unsafe output path: ${path}`);
		const info = await stat(realParent);
		approval = {
			confined: true,
			cwd,
			parent: { real: realParent, dev: info.dev, ino: info.ino }
		};
	}
	try {
		const info = await stat(target);
		if (info.isDirectory())
			throw new CliError(EXIT.USAGE, 'unsupported-output', `Output is a directory: ${path}`);
	} catch (error) {
		if (error instanceof CliError) throw error;
	}
	outputApprovals.set(target, approval);
	return target;
}

export interface OutputOptions {
	cwd?: string;
}

interface OutputApproval {
	confined: boolean;
	cwd: string;
	parent: { real: string; dev: number; ino: number } | null;
}

interface DirectoryIdentity {
	real: string;
	dev: number;
	ino: number;
}

const outputApprovals = new Map<string, OutputApproval>();

async function nearestExistingParent(directory: string): Promise<string> {
	let current = directory;
	while (true) {
		try {
			await access(current, constants.F_OK);
			return current;
		} catch {
			const parent = dirname(current);
			if (parent === current) return current;
			current = parent;
		}
	}
}

/** Writes through a temporary file in the target directory, then renames. */
export async function writeOutput(target: string, data: string | Uint8Array): Promise<void> {
	const approval = outputApprovals.get(target);
	outputApprovals.delete(target);
	if (!approval)
		throw new CliError(
			EXIT.UNSAFE_PATH,
			'unsafe-output',
			`Output path was not approved: ${target}`
		);
	await writeApproved(target, data, approval);
}

async function writeApproved(
	target: string,
	data: string | Uint8Array,
	approval: OutputApproval
): Promise<void> {
	const directory = dirname(target);
	if (approval.confined) await assertApprovedParent(directory, approval, target);
	try {
		await mkdir(directory, { recursive: true });
	} catch {
		throw new CliError(
			EXIT.OUTPUT,
			'output-failed',
			`Cannot create output directory: ${directory}`
		);
	}
	const expected = approval.confined
		? await currentDirectoryIdentity(directory, approval.cwd, target)
		: null;
	const temporary = resolve(
		directory,
		`.${basename(target)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
	);
	let handle;
	try {
		handle = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
			0o644
		);
		if (expected) await assertDirectoryIdentity(directory, expected, target);
		await handle.writeFile(data);
		await handle.close();
		handle = undefined;
		if (expected) await assertDirectoryIdentity(directory, expected, target);
		await rename(temporary, target);
	} catch (error) {
		if (handle) await handle.close().catch(() => {});
		await unlink(temporary).catch(() => {});
		if (error instanceof CliError) throw error;
		throw new CliError(EXIT.OUTPUT, 'output-failed', `Cannot write output: ${target}`);
	}
}

/** Checks the nearest existing parent before any directory is created. */
async function assertApprovedParent(
	directory: string,
	approval: OutputApproval,
	target: string
): Promise<void> {
	const parent = await nearestExistingParent(directory);
	const real = await realpath(parent).catch(() => null);
	if (!real || !isWithinRoot(approval.cwd, real)) throw unsafeOutput(target);
	if (approval.parent && real === approval.parent.real) {
		const info = await stat(real);
		if (info.dev !== approval.parent.dev || info.ino !== approval.parent.ino)
			throw unsafeOutput(target);
	}
}

async function currentDirectoryIdentity(
	directory: string,
	root: string,
	target: string
): Promise<DirectoryIdentity> {
	const real = await realpath(directory).catch(() => null);
	if (!real || !isWithinRoot(root, real)) throw unsafeOutput(target);
	const info = await stat(real);
	if (!info.isDirectory()) throw unsafeOutput(target);
	return { real, dev: info.dev, ino: info.ino };
}

/** Rejects a parent switch between staging and replacement. */
async function assertDirectoryIdentity(
	directory: string,
	expected: DirectoryIdentity,
	target: string
): Promise<void> {
	const real = await realpath(directory).catch(() => null);
	if (!real || real !== expected.real) throw unsafeOutput(target);
	const info = await stat(real);
	if (info.dev !== expected.dev || info.ino !== expected.ino) throw unsafeOutput(target);
}

function unsafeOutput(target: string): CliError {
	return new CliError(EXIT.UNSAFE_PATH, 'unsafe-output', `Unsafe output path: ${target}`);
}

export class Deadline {
	private readonly expires: number | null;

	constructor(timeoutMs: number) {
		this.expires = timeoutMs > 0 ? Date.now() + timeoutMs : null;
	}

	check(): void {
		if (this.expires !== null && Date.now() > this.expires)
			throw new CliError(EXIT.ABORTED, 'timeout', 'Operation timed out');
	}
}

/** Runs tasks with a fixed concurrency and keeps the result order. */
export async function mapPool<T, R>(
	items: readonly T[],
	concurrency: number,
	deadline: Deadline,
	task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			deadline.check();
			results[index] = await task(items[index]!, index);
		}
	}
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () =>
		worker()
	);
	await Promise.all(workers);
	return results;
}
