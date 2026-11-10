export interface NativeProjectEntryBase {
	relativePath: string;
	mime: string;
	mtimeMs: number;
	size: number;
	revision: string;
	first: number;
	second: number;
}

export interface NativeProjectMarkdownEntry extends NativeProjectEntryBase {
	kind: 'markdown';
	content: string;
}

export interface NativeProjectAssetEntry extends NativeProjectEntryBase {
	kind: 'asset';
	bytes: Uint8Array;
}

export type NativeProjectEntry = NativeProjectMarkdownEntry | NativeProjectAssetEntry;

export interface NativeProjectSnapshot {
	rootId: string;
	token: string;
	name: string;
	entries: NativeProjectEntry[];
}

interface RawProjectEntry extends NativeProjectEntryBase {
	kind: 'markdown' | 'asset';
	content: string | null;
	bytes: number[] | null;
}

interface RawProjectSnapshot {
	rootId: string;
	token: string;
	name: string;
	entries: RawProjectEntry[];
}

export interface NativeProjectManifestEntry {
	kind: 'markdown' | 'asset';
	relativePath: string;
	mtimeMs: number;
	size: number;
	first: number;
	second: number;
}

export interface NativeProjectManifest {
	rootId: string;
	token: string;
	entries: NativeProjectManifestEntry[];
}

async function invokeProject<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke<T>(command, args);
}

function toEntry(entry: RawProjectEntry): NativeProjectEntry {
	const common = {
		relativePath: entry.relativePath,
		mime: entry.mime,
		mtimeMs: entry.mtimeMs,
		size: entry.size,
		revision: entry.revision,
		first: entry.first,
		second: entry.second
	};
	if (entry.kind === 'markdown') {
		if (entry.content === null) throw new Error('Native Markdown entry has no content.');
		return { ...common, kind: 'markdown', content: entry.content };
	}
	if (entry.bytes === null) throw new Error('Native asset entry has no bytes.');
	return { ...common, kind: 'asset', bytes: Uint8Array.from(entry.bytes) };
}

function toSnapshot(snapshot: RawProjectSnapshot): NativeProjectSnapshot {
	return { ...snapshot, entries: snapshot.entries.map(toEntry) };
}

export async function pickNativeProject(): Promise<NativeProjectSnapshot | null> {
	const snapshot = await invokeProject<RawProjectSnapshot | null>('project_pick_root');
	return snapshot ? toSnapshot(snapshot) : null;
}

export async function openNativeProject(rootId: string): Promise<NativeProjectSnapshot> {
	return toSnapshot(await invokeProject<RawProjectSnapshot>('project_open_root', { rootId }));
}

export async function refreshNativeProject(token: string): Promise<NativeProjectSnapshot> {
	return toSnapshot(await invokeProject<RawProjectSnapshot>('project_refresh', { token }));
}

export async function manifestNativeProject(token: string): Promise<NativeProjectManifest> {
	return invokeProject<NativeProjectManifest>('project_manifest', { token });
}

export async function readNativeProjectEntry(
	token: string,
	relativePath: string
): Promise<NativeProjectEntry> {
	return toEntry(await invokeProject<RawProjectEntry>('project_read', { token, relativePath }));
}

export async function writeNativeProjectText(
	token: string,
	relativePath: string,
	content: string,
	expectedRevision: string | null
): Promise<NativeProjectMarkdownEntry> {
	const entry = toEntry(
		await invokeProject<RawProjectEntry>('project_write_text', {
			token,
			relativePath,
			content,
			expectedRevision
		})
	);
	if (entry.kind !== 'markdown') throw new Error('Native write returned a non-Markdown entry.');
	return entry;
}

export async function writeNativeProjectAsset(
	token: string,
	relativePath: string,
	contents: Uint8Array,
	expectedRevision: string | null
): Promise<NativeProjectAssetEntry> {
	const entry = toEntry(
		await invokeProject<RawProjectEntry>('project_write_asset', {
			token,
			relativePath,
			contents: Array.from(contents),
			expectedRevision
		})
	);
	if (entry.kind !== 'asset') throw new Error('Native write returned a non-asset entry.');
	return entry;
}

export async function renameNativeProjectEntry(
	token: string,
	fromPath: string,
	toPath: string,
	expectedRevision: string
): Promise<NativeProjectEntry> {
	return toEntry(
		await invokeProject<RawProjectEntry>('project_rename', {
			token,
			fromPath,
			toPath,
			expectedRevision
		})
	);
}

export async function revokeNativeProject(token: string): Promise<void> {
	await invokeProject('project_revoke', { token });
}
