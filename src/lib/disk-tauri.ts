import {
	ImportSession,
	ImportReadError,
	validateMarkdownContent,
	type ImportOptions,
	type ImportReport
} from './import-limits';
import { IMPORT_LIMITS } from './config';
/**
 * Opaque-capability disk I/O for the Tauri desktop shell.
 *
 * Native Rust dialogs create all capabilities. The webview displays the path.
 * It can read, inspect, or write only with the unguessable token from Rust.
 * The token is valid only for the current process session.
 */

import { pathBasename, isMarkdownDiskPath, type PathLinkRecord, pathLinkRecord } from './disk-link';

export interface DiskFileMeta {
	lastModified: number;
	size: number;
	revision: string;
}

export interface NativeDiskGrant {
	token: string;
	path: string;
	stat: DiskFileMeta | null;
}

export interface NativeDiskRead {
	content: string;
	stat: DiskFileMeta;
}

export interface TauriDiskIo {
	restoreGrants(): Promise<NativeDiskGrant[]>;
	forgetGrant(token: string): Promise<void>;
	renameFile(
		token: string,
		name: string,
		expectedRevision: string | null
	): Promise<NativeDiskGrant>;
	openGrants(multiple: boolean): Promise<NativeDiskGrant[]>;
	openDirectoryGrants(): Promise<NativeDiskGrant[]>;
	saveGrant(suggestedName: string): Promise<NativeDiskGrant | null>;
	saveExportGrant(suggestedName: string): Promise<NativeDiskGrant | null>;
	readFile(token: string): Promise<NativeDiskRead>;
	writeText(
		token: string,
		content: string,
		expectedRevision: string | null,
		force: boolean
	): Promise<DiskFileMeta>;
	writeBytes(
		token: string,
		contents: Uint8Array,
		expectedRevision: string | null,
		force: boolean
	): Promise<DiskFileMeta>;
	stat(token: string): Promise<DiskFileMeta | null>;
}

export interface OpenedDiskFile {
	token?: string;
	name: string;
	content: string;
	path: string;
	lastModified: number;
	size: number;
	revision: string;
	link: PathLinkRecord;
}

export interface OpenedDiskFiles {
	files: OpenedDiskFile[];
	failed: number;
	report?: ImportReport;
}

let io: TauriDiskIo | null = null;
let ioPromise: Promise<TauriDiskIo> | null = null;
let restorePromise: Promise<void> | null = null;
const grantsByPath = new Map<string, NativeDiskGrant>();

function registerGrants(grants: NativeDiskGrant[]): void {
	for (const grant of grants) {
		if (grant.token && isMarkdownDiskPath(grant.path)) grantsByPath.set(grant.path, grant);
		else if (grant.token) grantsByPath.set(grant.path, grant);
	}
}

async function grantForPath(path: string): Promise<NativeDiskGrant> {
	if (!grantsByPath.has(path)) {
		if (!restorePromise) {
			restorePromise = getIo()
				.then(async (currentIo) => {
					registerGrants(await currentIo.restoreGrants());
				})
				.catch((error: unknown) => {
					restorePromise = null;
					throw error;
				});
		}
		await restorePromise;
	}
	const grant = grantsByPath.get(path);
	if (!grant) throw new Error('Disk capability expired. Choose the file again.');
	return grant;
}

export function setTauriDiskIoForTests(value: TauriDiskIo | null): void {
	io = value;
	ioPromise = value ? Promise.resolve(value) : null;
	restorePromise = null;
	grantsByPath.clear();
}

export async function createTauriDiskIo(): Promise<TauriDiskIo> {
	const { invoke } = await import('@tauri-apps/api/core');
	const toMeta = (stat: { mtimeMs: number; size: number; revision: string }): DiskFileMeta => ({
		lastModified: stat.mtimeMs,
		size: stat.size,
		revision: stat.revision
	});
	const toGrant = (grant: {
		token: string;
		path: string;
		stat: { mtimeMs: number; size: number; revision: string } | null;
	}): NativeDiskGrant => ({
		token: grant.token,
		path: grant.path,
		stat: grant.stat ? toMeta(grant.stat) : null
	});

	return {
		async restoreGrants() {
			const grants = await invoke<Parameters<typeof toGrant>[0][]>('disk_restore_grants');
			return grants.map(toGrant);
		},
		async forgetGrant(token) {
			await invoke('disk_forget_grant', { token });
		},
		async renameFile(token, name, expectedRevision) {
			return toGrant(
				await invoke<Parameters<typeof toGrant>[0]>('disk_rename', {
					token,
					name,
					expectedRevision
				})
			);
		},
		async openGrants(multiple) {
			const grants = await invoke<
				Array<{
					token: string;
					path: string;
					stat: { mtimeMs: number; size: number; revision: string } | null;
				}>
			>('disk_open_dialog', { multiple });
			return grants.map(toGrant);
		},
		async openDirectoryGrants() {
			const grants = await invoke<
				Array<{
					token: string;
					path: string;
					stat: { mtimeMs: number; size: number; revision: string } | null;
				}>
			>('disk_open_directory');
			return grants.map(toGrant);
		},
		async saveGrant(suggestedName) {
			const grant = await invoke<{
				token: string;
				path: string;
				stat: { mtimeMs: number; size: number; revision: string } | null;
			} | null>('disk_save_dialog', { suggestedName, export: false });
			return grant ? toGrant(grant) : null;
		},
		async saveExportGrant(suggestedName) {
			const grant = await invoke<{
				token: string;
				path: string;
				stat: { mtimeMs: number; size: number; revision: string } | null;
			} | null>('disk_save_dialog', { suggestedName, export: true });
			return grant ? toGrant(grant) : null;
		},
		async readFile(token) {
			const result = await invoke<{
				content: string;
				stat: { mtimeMs: number; size: number; revision: string };
			}>('disk_read', { token });
			return { content: result.content, stat: toMeta(result.stat) };
		},
		async writeText(token, content, expectedRevision, force) {
			const stat = await invoke<{ mtimeMs: number; size: number; revision: string }>('disk_write', {
				token,
				content,
				expectedRevision,
				force
			});
			return toMeta(stat);
		},
		async writeBytes(token, contents, expectedRevision, force) {
			const stat = await invoke<{ mtimeMs: number; size: number; revision: string }>(
				'disk_write_bytes',
				{ token, contents: Array.from(contents), expectedRevision, force }
			);
			return toMeta(stat);
		},
		async stat(token) {
			const stat = await invoke<{ mtimeMs: number; size: number; revision: string } | null>(
				'disk_stat',
				{ token }
			);
			return stat ? toMeta(stat) : null;
		}
	};
}

async function getIo(): Promise<TauriDiskIo> {
	if (io) return io;
	if (!ioPromise) {
		ioPromise = createTauriDiskIo().then((created) => {
			io = created;
			return created;
		});
	}
	return ioPromise;
}

export async function tauriPickAndOpen(options: ImportOptions = {}): Promise<OpenedDiskFiles> {
	const currentIo = await getIo();
	const grants = await currentIo.openGrants(true);
	registerGrants(grants);
	return openGrants(grants, currentIo, options);
}

export async function tauriPickDirectoryAndOpen(
	options: ImportOptions = {}
): Promise<OpenedDiskFiles> {
	const currentIo = await getIo();
	const grants = await currentIo.openDirectoryGrants();
	registerGrants(grants);
	return openGrants(grants, currentIo, options);
}

export async function tauriPickSaveTarget(suggestedName: string): Promise<PathLinkRecord | null> {
	const currentIo = await getIo();
	const grant = await currentIo.saveGrant(suggestedName);
	if (!grant) return null;
	registerGrants([grant]);
	return pathLinkRecord(grant.path);
}

export async function tauriWritePath(
	path: string,
	content: string,
	expectedRevision: string | null,
	force = false
): Promise<DiskFileMeta> {
	const currentIo = await getIo();
	const grant = await grantForPath(path);
	const stat = await currentIo.writeText(grant.token, content, expectedRevision, force);
	grant.stat = stat;
	return stat;
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
	if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
		reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
		reader.readAsArrayBuffer(blob);
	});
}

export async function tauriSaveExportBlob(blob: Blob, suggestedName: string): Promise<boolean> {
	const currentIo = await getIo();
	const grant = await currentIo.saveExportGrant(suggestedName);
	if (!grant) return false;
	registerGrants([grant]);
	const bytes = await readBlobBytes(blob);
	const expectedRevision = grant.stat?.revision ?? null;
	if (/\.(md|markdown|mdx|txt|html|htm|json)$/i.test(grant.path)) {
		grant.stat = await currentIo.writeText(
			grant.token,
			new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes),
			expectedRevision,
			false
		);
	} else {
		grant.stat = await currentIo.writeBytes(grant.token, bytes, expectedRevision, false);
	}
	return true;
}

export async function tauriReadMeta(path: string): Promise<DiskFileMeta | null> {
	const currentIo = await getIo();
	return currentIo.stat((await grantForPath(path)).token);
}

export async function tauriReadPath(path: string): Promise<NativeDiskRead> {
	const currentIo = await getIo();
	return currentIo.readFile((await grantForPath(path)).token);
}

export async function tauriRenamePath(
	path: string,
	name: string,
	expectedRevision: string | null
): Promise<NativeDiskGrant> {
	const currentIo = await getIo();
	const grant = await grantForPath(path);
	const renamed = await currentIo.renameFile(grant.token, name, expectedRevision);
	grantsByPath.delete(path);
	registerGrants([renamed]);
	return renamed;
}

export async function tauriForgetPath(path: string): Promise<void> {
	const currentIo = await getIo();
	let grant: NativeDiskGrant;
	try {
		grant = await grantForPath(path);
	} catch (error) {
		if (error instanceof Error && error.message.includes('capability expired')) return;
		throw error;
	}
	await currentIo.forgetGrant(grant.token);
	grantsByPath.delete(path);
}

export async function tauriCheckPath(path: string): Promise<'ok' | 'broken' | 'permission-needed'> {
	try {
		return (await tauriReadMeta(path)) ? 'ok' : 'broken';
	} catch {
		return 'permission-needed';
	}
}

export async function tauriOpenNativeGrants(
	grants: NativeDiskGrant[],
	options: ImportOptions = {}
): Promise<OpenedDiskFiles> {
	const currentIo = await getIo();
	const markdownGrants = grants.filter((grant) => isMarkdownDiskPath(grant.path));
	registerGrants(markdownGrants);
	return openGrants(markdownGrants, currentIo, options);
}

async function openGrants(
	grants: NativeDiskGrant[],
	currentIo: TauriDiskIo,
	options: ImportOptions
): Promise<OpenedDiskFiles> {
	const files: OpenedDiskFile[] = [];
	const session = new ImportSession(options);
	session.publish();
	for (const grant of grants) {
		if (!(await session.pause())) break;
		try {
			const before = grant.stat ?? (await currentIo.stat(grant.token));
			if (!before) throw new ImportReadError('read');
			session.reserve(before.size);
			const result = await currentIo.readFile(grant.token);
			if (session.cancelled) break;
			const { content, stat } = result;
			if (stat.size > IMPORT_LIMITS.maxFileBytes) throw new ImportReadError('file-size');
			const growth = Math.max(0, stat.size - before.size);
			if (session.report.bytes + growth > IMPORT_LIMITS.maxBatchBytes)
				throw new ImportReadError('batch-size');
			session.report.bytes += growth;
			validateMarkdownContent(content);
			grant.stat = stat;
			files.push({
				token: grant.token,
				name: pathBasename(grant.path),
				content,
				path: grant.path,
				lastModified: stat.lastModified,
				size: stat.size,
				revision: stat.revision,
				link: pathLinkRecord(grant.path)
			});
			session.accept();
		} catch (error) {
			if (session.cancelled) break;
			session.fail(
				pathBasename(grant.path),
				error instanceof ImportReadError ? error.reason : 'read'
			);
		}
	}
	return { files, failed: session.report.failed, report: session.publish() };
}
