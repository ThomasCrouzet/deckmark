import { db, newId, type DraftRow, type ProjectAssetRow } from './db';
import { filesStore } from './files.svelte';
import { IMPORT_LIMITS, MAX_IMAGE_BYTES } from './config';
import {
	documentKindForFile,
	imageMimeForName,
	isCodeExtension,
	isMarkdownExtension
} from './document-kind';
import { validateMarkdownContent } from './import-limits';
import { PROJECT_SCALE_LIMITS } from './project-limits';
import { projectDocumentLimit } from './project-limits';
import {
	pathKey,
	projectPath,
	projectWikiCandidates,
	relativeDestination,
	resolveProjectPath
} from './project-paths';
import { rewriteProjectDestinations } from './project-links';
import { rewriteWikiLinkTargets } from './wiki-links';

/** A selected document or folder that moves or copies into a project folder. */
export interface TransferSelection {
	projectId?: string;
	documentIds?: string[];
	folder?: string;
}

export type TransferMode = 'move' | 'copy';

export interface TransferConflict {
	path: string;
}

export interface TransferResult {
	status: 'done' | 'cancelled' | 'empty';
	documents: number;
	assets: number;
	targetProjectId?: string;
	targetFolder?: string;
	renamed: string[];
	unresolved: Array<{ document: string; destination: string }>;
}

export interface TransferOptions {
	mode: TransferMode;
	targetProjectId: string;
	targetFolder?: string;
	/** Name of the moved or copied folder below the target folder. */
	folderName?: string;
	/** Ask the user before the transfer keeps both entries. */
	onConflict?: (conflicts: TransferConflict[]) => Promise<boolean>;
}

interface SourceFile {
	id: string;
	name: string;
	content: string;
	oldPath: string;
	projectId?: string;
	createdAt: number;
	updatedAt: number;
	order: number;
	kind?: DraftRow['kind'];
	mime?: string;
	data?: string;
	origin?: DraftRow['origin'];
	open?: boolean;
}

interface PlannedDocument {
	source: SourceFile;
	newPath: string;
	nextId: string;
}

interface PlannedAsset {
	source: ProjectAssetRow;
	newPath: string;
	nextId: string;
}

interface RewriteContext {
	moved: Map<string, string>;
	/** Paths that exist in the target project after the transfer. */
	validPaths: Set<string>;
	sourceDocs: readonly { id: string; projectId: string; relativePath: string }[];
	destinationDocs: readonly { id: string; projectId: string; relativePath: string }[];
	useMoved: boolean;
	crossProject: boolean;
	unresolved: Array<{ document: string; destination: string }>;
}

export const PROJECT_DRAG_TYPE = 'application/x-mdsh-project';

const MARKDOWN_LINK = /\.(?:md|markdown|mdx|txt)$/i;

function folderPrefix(folder: string | undefined): string {
	if (!folder) return '';
	return `${projectPath(folder)}/`;
}

function basename(path: string): string {
	return path.split('/').pop()!;
}

interface ProjectDocumentMetadata {
	id: string;
	relativePath: string;
}

/** Reads project document identity and path from manifest keys only. */
async function projectDocumentMetadata(projectId: string): Promise<ProjectDocumentMetadata[]> {
	const keys = await db.drafts.orderBy('manifest').keys();
	const documents: ProjectDocumentMetadata[] = [];
	for (const raw of keys) {
		try {
			const key = JSON.parse(String(raw)) as unknown[];
			if (key[3] !== projectId) continue;
			const id = key[1];
			const relativePath = key[4];
			if (typeof id === 'string' && typeof relativePath === 'string' && relativePath)
				documents.push({ id, relativePath });
		} catch {
			/* An invalid manifest key is not a project document. */
		}
	}
	return documents;
}

/** Reads project asset paths from the compound index without binary data. */
async function projectAssetPathList(projectId: string): Promise<string[]> {
	const keys = await db.projectAssets
		.where('[projectId+path]')
		.between([projectId, ''], [projectId, '\uffff'])
		.keys();
	return keys.map((key) => String(Array.isArray(key) ? key[1] : ''));
}

function sourceFileFromRow(row: DraftRow): SourceFile {
	return {
		id: row.id,
		name: row.name,
		content: row.content,
		oldPath: row.relativePath ?? row.name,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		order: row.order,
		...(row.kind ? { kind: row.kind } : {}),
		...(row.mime ? { mime: row.mime } : {}),
		...(row.data ? { data: row.data } : {}),
		...(row.origin ? { origin: row.origin } : {}),
		open: row.open ?? true
	};
}

function occupiedFromPaths(
	documentPaths: readonly string[],
	assetPaths: readonly string[],
	exclude: ReadonlySet<string>
): Map<string, string> {
	const occupied = new Map<string, string>();
	for (const path of documentPaths) {
		const key = pathKey(path);
		if (!exclude.has(key)) occupied.set(key, path);
	}
	for (const path of assetPaths) {
		const key = pathKey(path);
		if (!exclude.has(key)) occupied.set(key, path);
	}
	return occupied;
}

function occupiedPaths(
	documents: readonly DraftRow[],
	assets: readonly ProjectAssetRow[],
	excludeDocumentIds: ReadonlySet<string>,
	excludeAssetIds: ReadonlySet<string>
): Map<string, string> {
	const occupied = new Map<string, string>();
	for (const document of documents) {
		if (!document.relativePath || excludeDocumentIds.has(document.id)) continue;
		occupied.set(pathKey(document.relativePath), document.relativePath);
	}
	for (const asset of assets) {
		if (excludeAssetIds.has(asset.id)) continue;
		occupied.set(pathKey(asset.path), asset.path);
	}
	return occupied;
}

function conflictVariant(path: string, occupied: Map<string, string>, added: Set<string>): string {
	const parts = path.split('/');
	const original = parts.pop()!;
	const parent = parts.length ? `${parts.join('/')}/` : '';
	const dot = original.lastIndexOf('.');
	const stem = dot > 0 ? original.slice(0, dot) : original;
	const extension = dot > 0 ? original.slice(dot) : '';
	let sequence = 2;
	while (true) {
		const suffix = ` (${sequence})`;
		const limit = Math.max(1, 1024 - parent.length - extension.length - suffix.length);
		const candidate = projectPath(`${parent}${stem.slice(0, limit)}${suffix}${extension}`);
		const key = pathKey(candidate);
		if (!occupied.has(key) && !added.has(key)) {
			added.add(key);
			return candidate;
		}
		sequence += 1;
	}
}

function uniqueByPath(
	docs: readonly { id: string; projectId: string; relativePath: string }[],
	path: string
): { id: string; projectId: string; relativePath: string } | undefined {
	const exact = docs.find((doc) => doc.relativePath && pathKey(doc.relativePath) === pathKey(path));
	if (exact) return exact;
	const name = basename(path).replace(MARKDOWN_LINK, '').toLowerCase();
	const matches = docs.filter(
		(doc) =>
			doc.relativePath &&
			basename(doc.relativePath).replace(MARKDOWN_LINK, '').toLowerCase() === name
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function wikiDestination(from: string, to: string, target: string): string {
	const next = relativeDestination(from, to);
	if (!next) return target.split('#', 1)[0]!;
	const suffix = target.slice(target.split('#', 1)[0]!.length);
	return (
		(MARKDOWN_LINK.test(target.split('#', 1)[0]!) ? next : next.replace(MARKDOWN_LINK, '')) + suffix
	);
}

function rewriteDocumentContent(
	content: string,
	from: string,
	nextFrom: string,
	context: RewriteContext
): string {
	const rewritten = rewriteProjectDestinations(content, ({ source }) => {
		const target = resolveProjectPath(from, source);
		if (!target) return null;
		const moved = context.useMoved ? context.moved.get(pathKey(target)) : undefined;
		const targetPath =
			moved ??
			(context.validPaths.has(pathKey(target)) && !target.startsWith('data:') ? target : null);
		if (!targetPath) {
			context.unresolved.push({ document: nextFrom, destination: source });
			return null;
		}
		if (targetPath === target && nextFrom === from) return null;
		const suffix = source.match(/[?#].*$/)?.[0] ?? '';
		const relative = relativeDestination(nextFrom, targetPath);
		return (relative || encodeURIComponent(basename(targetPath))) + suffix;
	});
	return rewriteWikiLinkTargets(rewritten, (target) => {
		const value = target.split('#', 1)[0]!;
		if (!value) return target;
		const candidates = projectWikiCandidates(
			{ projectId: 'source', relativePath: from },
			target,
			context.sourceDocs
		);
		let nextTarget: string | undefined;
		if (candidates.length === 1) {
			const candidate = candidates[0]!;
			nextTarget = context.useMoved
				? context.moved.get(pathKey(candidate.relativePath!))
				: undefined;
			if (!nextTarget && context.validPaths.has(pathKey(candidate.relativePath!)))
				nextTarget = candidate.relativePath!;
		}
		if (!nextTarget && context.crossProject) {
			const destination = uniqueByPath(context.destinationDocs, value);
			if (destination?.relativePath && context.validPaths.has(pathKey(destination.relativePath)))
				nextTarget = destination.relativePath;
		}
		if (!nextTarget) {
			if (context.crossProject)
				context.unresolved.push({ document: nextFrom, destination: target });
			return target;
		}
		if (nextTarget === value && nextFrom === from) return target;
		return wikiDestination(nextFrom, nextTarget, target);
	});
}

function targetPath(
	prefix: string,
	folderName: string | undefined,
	folder: string | undefined,
	sourcePath: string,
	name: string
): string {
	if (!folder) return projectPath(`${prefix}${name}`);
	const suffix = sourcePath.slice(folder.length + 1);
	const root = folderName ?? basename(folder);
	return projectPath(`${prefix}${root}/${suffix}`);
}

/** Move or copy a selection from the library or a project into a target folder. */
export async function transferProjectSelection(
	selection: TransferSelection,
	options: TransferOptions
): Promise<TransferResult> {
	await filesStore.flushPendingAwait();
	const targetFolder = options.targetFolder ? projectPath(options.targetFolder) : undefined;
	const prefix = folderPrefix(targetFolder);
	const sourceProjectId = selection.projectId;
	const folder = selection.folder ? projectPath(selection.folder) : undefined;
	if (folder && targetFolder && (targetFolder === folder || targetFolder.startsWith(`${folder}/`)))
		throw new Error('A folder cannot move into itself');

	// Read source identity and paths first. Bodies load only for the selected
	// entries, except for a move where inbound links can come from any
	// nonselected document in the source project.
	let sourceDocuments: ProjectDocumentMetadata[] = [];
	let sourceAssetPaths: string[] = [];
	let sourceDocumentRows: DraftRow[] = [];
	let sourceAssetRows: ProjectAssetRow[] = [];
	if (sourceProjectId) {
		[sourceDocuments, sourceAssetPaths] = await Promise.all([
			projectDocumentMetadata(sourceProjectId),
			projectAssetPathList(sourceProjectId)
		]);
		if (selection.documentIds) {
			const rows = await db.drafts.bulkGet(selection.documentIds);
			sourceDocumentRows = rows.filter(
				(row): row is DraftRow => !!row && row.projectId === sourceProjectId && !!row.relativePath
			);
		} else if (folder) {
			[sourceDocumentRows, sourceAssetRows] = await Promise.all([
				db.drafts
					.where('[projectId+relativePath]')
					.between([sourceProjectId, `${folder}/`], [sourceProjectId, `${folder}/\uffff`])
					.toArray(),
				db.projectAssets
					.where('[projectId+path]')
					.between([sourceProjectId, `${folder}/`], [sourceProjectId, `${folder}/\uffff`])
					.toArray()
			]);
		}
		if (options.mode === 'move')
			sourceDocumentRows = await db.drafts.where('projectId').equals(sourceProjectId).toArray();
	} else {
		await filesStore.ensureContent(selection.documentIds ?? []);
	}
	const documents = sourceDocumentRows.map(sourceFileFromRow);
	const assets = sourceAssetRows;
	const selectedDocuments = documents.filter((row) =>
		selection.documentIds
			? selection.documentIds.includes(row.id)
			: folder
				? row.oldPath.startsWith(`${folder}/`)
				: false
	);
	const selectedAssets = assets.filter((asset) =>
		selection.documentIds ? false : folder ? asset.path.startsWith(`${folder}/`) : false
	);
	const libraryDocuments: SourceFile[] = sourceProjectId
		? []
		: filesStore.library
				.filter((file) => selection.documentIds?.includes(file.id))
				.map((file) => ({
					id: file.id,
					name: file.name,
					content: file.content,
					oldPath: file.relativePath ?? file.name,
					createdAt: file.createdAt,
					updatedAt: file.updatedAt,
					order: filesStore.library.indexOf(file),
					...(file.kind ? { kind: file.kind } : {}),
					...(file.mime ? { mime: file.mime } : {}),
					...(file.data ? { data: file.data } : {}),
					...(file.origin ? { origin: file.origin } : {}),
					open: filesStore.files.includes(file)
				}));
	const sources = [...libraryDocuments, ...selectedDocuments];
	if (!sources.length && !selectedAssets.length)
		return { status: 'empty', documents: 0, assets: 0, renamed: [], unresolved: [] };

	const destinationDocuments =
		sourceProjectId === options.targetProjectId
			? sourceDocuments
			: await projectDocumentMetadata(options.targetProjectId);
	const destinationAssetPaths =
		sourceProjectId === options.targetProjectId
			? sourceAssetPaths
			: await projectAssetPathList(options.targetProjectId);
	const destinationDocs: Array<{ id: string; projectId: string; relativePath: string }> =
		destinationDocuments.map((doc) => ({
			id: doc.id,
			projectId: options.targetProjectId,
			relativePath: doc.relativePath
		}));
	// Only a same-project move removes the selected source paths. A copy keeps
	// them occupied, so a copied path must never collide with its original.
	const excludeKeys = new Set(
		options.mode === 'move' && options.targetProjectId === sourceProjectId
			? [
					...selectedDocuments.map((row) => pathKey(row.oldPath)),
					...selectedAssets.map((asset) => pathKey(asset.path))
				]
			: []
	);
	const occupied = occupiedFromPaths(
		destinationDocuments.map((doc) => doc.relativePath),
		destinationAssetPaths,
		excludeKeys
	);
	const added = new Set<string>();
	const plannedDocuments: PlannedDocument[] = sources.map((source) => ({
		source,
		newPath: targetPath(
			prefix,
			options.folderName,
			folder,
			source.oldPath,
			basename(source.oldPath)
		),
		nextId: newId()
	}));
	const plannedAssets: PlannedAsset[] = selectedAssets.map((asset) => ({
		source: asset,
		newPath: targetPath(prefix, options.folderName, folder, asset.path, basename(asset.path)),
		nextId: newId()
	}));
	const conflicts: TransferConflict[] = [];
	for (const planned of [...plannedDocuments, ...plannedAssets]) {
		const key = pathKey(planned.newPath);
		if (occupied.has(key) || added.has(key)) conflicts.push({ path: planned.newPath });
		added.add(key);
	}
	const uniqueConflicts = [
		...new Map(conflicts.map((conflict) => [pathKey(conflict.path), conflict])).values()
	];
	if (uniqueConflicts.length) {
		const accepted = options.onConflict ? await options.onConflict(uniqueConflicts) : false;
		if (!accepted)
			return { status: 'cancelled', documents: 0, assets: 0, renamed: [], unresolved: [] };
		for (const planned of [...plannedDocuments, ...plannedAssets]) {
			if (!conflicts.some((entry) => pathKey(entry.path) === pathKey(planned.newPath))) continue;
			planned.newPath = conflictVariant(planned.newPath, occupied, added);
		}
	}
	const moved = new Map<string, string>();
	for (const planned of plannedDocuments)
		moved.set(pathKey(planned.source.oldPath), planned.newPath);
	for (const planned of plannedAssets) moved.set(pathKey(planned.source.path), planned.newPath);
	const crossProject = !!sourceProjectId && sourceProjectId !== options.targetProjectId;
	const targetDocsBefore = destinationDocs.filter(
		(row) => !(options.mode === 'move' && moved.has(pathKey(row.relativePath)))
	);
	const sourceAfter = new Set<string>();
	const destinationAfter = new Set<string>();
	const allSourceDocumentPaths = sourceProjectId
		? sourceDocuments.map((doc) => doc.relativePath)
		: documents.map((row) => row.oldPath);
	const allSourceAssetPaths = sourceProjectId
		? sourceAssetPaths
		: selectedAssets.map((asset) => asset.path);
	if (crossProject) {
		// A move removes the selected entries from the source project. A copy
		// leaves every source entry in place.
		for (const path of allSourceDocumentPaths) {
			const key = pathKey(path);
			if (options.mode === 'copy' || !moved.has(key)) sourceAfter.add(key);
		}
		for (const path of allSourceAssetPaths) {
			const key = pathKey(path);
			if (options.mode === 'copy' || !moved.has(key)) sourceAfter.add(key);
		}
		for (const row of targetDocsBefore) destinationAfter.add(pathKey(row.relativePath));
	} else {
		for (const path of allSourceDocumentPaths) {
			const key = pathKey(path);
			sourceAfter.add(options.mode === 'move' && moved.has(key) ? pathKey(moved.get(key)!) : key);
		}
		for (const path of allSourceAssetPaths) {
			const key = pathKey(path);
			sourceAfter.add(options.mode === 'move' && moved.has(key) ? pathKey(moved.get(key)!) : key);
		}
	}
	for (const planned of plannedDocuments) destinationAfter.add(pathKey(planned.newPath));
	for (const planned of plannedAssets) destinationAfter.add(pathKey(planned.newPath));
	for (const path of destinationAssetPaths) {
		const key = pathKey(path);
		if (!(options.mode === 'move' && moved.has(key))) destinationAfter.add(key);
	}
	const sourceDocs = (
		sourceProjectId
			? sourceDocuments
			: documents.map((row) => ({ id: row.id, relativePath: row.oldPath }))
	).map((row) => ({
		id: row.id,
		projectId: 'source',
		relativePath: row.relativePath
	}));
	const destinationWikiDocs = [
		...targetDocsBefore.map((row) => ({
			id: row.id,
			projectId: options.targetProjectId,
			relativePath: row.relativePath
		})),
		...plannedDocuments.map((planned) => ({
			id: planned.source.id,
			projectId: options.targetProjectId,
			relativePath: planned.newPath
		}))
	];
	const unresolved: Array<{ document: string; destination: string }> = [];
	const contentById = new Map<string, string>();
	for (const planned of plannedDocuments) {
		const context: RewriteContext = {
			moved,
			validPaths: crossProject ? destinationAfter : sourceAfter,
			sourceDocs,
			destinationDocs: destinationWikiDocs,
			useMoved: true,
			crossProject,
			unresolved
		};
		contentById.set(
			planned.source.id,
			rewriteDocumentContent(
				planned.source.content,
				planned.source.oldPath,
				planned.newPath,
				context
			)
		);
	}
	const changedExisting: DraftRow[] = [];
	// A copy keeps the originals canonical, so no existing source document has
	// a link to retarget and no existing row joins the insert batch.
	if (sourceProjectId && options.mode === 'move') {
		for (const row of documents) {
			if (selectedDocuments.some((doc) => doc.id === row.id)) continue;
			const rewritten = rewriteDocumentContent(row.content, row.oldPath, row.oldPath, {
				moved,
				validPaths: crossProject ? sourceAfter : sourceAfter,
				sourceDocs,
				destinationDocs: destinationWikiDocs,
				useMoved: !crossProject,
				crossProject,
				unresolved
			});
			if (rewritten !== row.content)
				changedExisting.push({
					id: row.id,
					name: row.name,
					content: rewritten,
					projectId: sourceProjectId!,
					relativePath: row.oldPath,
					createdAt: row.createdAt,
					updatedAt: Date.now(),
					order: row.order,
					...(row.kind ? { kind: row.kind } : {}),
					...(row.mime ? { mime: row.mime } : {}),
					...(row.data ? { data: row.data } : {}),
					...(row.origin ? { origin: row.origin } : {})
				});
		}
	}
	const now = Date.now();
	const written: DraftRow[] = [
		...plannedDocuments.map((planned) => ({
			id: options.mode === 'copy' ? planned.nextId : planned.source.id,
			name: basename(planned.newPath),
			content: contentById.get(planned.source.id) ?? planned.source.content,
			projectId: options.targetProjectId,
			relativePath: planned.newPath,
			createdAt: options.mode === 'copy' ? now : planned.source.createdAt,
			updatedAt: now,
			order: planned.source.order,
			open: options.mode === 'copy' ? false : (planned.source.open ?? true),
			...(planned.source.kind ? { kind: planned.source.kind } : {}),
			...(planned.source.mime ? { mime: planned.source.mime } : {}),
			...(planned.source.data ? { data: planned.source.data } : {}),
			...(options.mode === 'copy'
				? { origin: 'imported' as const }
				: planned.source.origin
					? { origin: planned.source.origin }
					: {})
		})),
		...changedExisting
	];
	const writtenAssets: ProjectAssetRow[] = plannedAssets.map((planned) => ({
		id: options.mode === 'copy' ? planned.nextId : planned.source.id,
		projectId: options.targetProjectId,
		path: planned.newPath,
		mime: planned.source.mime,
		data: options.mode === 'copy' ? new Uint8Array(planned.source.data) : planned.source.data
	}));
	const expected = new Map(
		[
			...selectedDocuments,
			...documents.filter((row) => changedExisting.some((entry) => entry.id === row.id))
		].map((row) => [
			row.id,
			{ content: row.content, relativePath: row.oldPath, updatedAt: row.updatedAt }
		])
	);
	const rewriteLive = (content: string, id: string): string => {
		const row = [...selectedDocuments, ...documents].find((entry) => entry.id === id);
		if (!row) return content;
		const nextPath = moved.get(pathKey(row.oldPath)) ?? row.oldPath;
		return rewriteDocumentContent(content, row.oldPath, nextPath, {
			moved,
			validPaths: crossProject ? destinationAfter : sourceAfter,
			sourceDocs,
			destinationDocs: destinationWikiDocs,
			useMoved: true,
			crossProject,
			unresolved: []
		});
	};
	await db.transaction('rw', db.projects, db.drafts, db.projectAssets, db.versions, async () => {
		if (!(await db.projects.get(options.targetProjectId)))
			throw new Error('Project no longer exists');
		if (sourceProjectId) {
			for (const row of selectedDocuments) {
				const current = await db.drafts.get(row.id);
				if (
					!current ||
					current.projectId !== sourceProjectId ||
					current.relativePath !== row.oldPath ||
					current.content !== row.content ||
					current.updatedAt !== row.updatedAt
				)
					throw new Error('The document changed during the transfer');
			}
			for (const row of changedExisting) {
				const original = documents.find((entry) => entry.id === row.id);
				const current = await db.drafts.get(row.id);
				if (
					!original ||
					!current ||
					current.relativePath !== original.oldPath ||
					current.content !== original.content ||
					current.updatedAt !== original.updatedAt
				)
					throw new Error('The document changed during the transfer');
			}
		} else {
			for (const planned of plannedDocuments) {
				const current = await db.drafts.get(planned.source.id);
				if (
					!current ||
					current.projectId ||
					current.relativePath ||
					current.content !== planned.source.content ||
					current.updatedAt !== planned.source.updatedAt
				)
					throw new Error('The document changed during the transfer');
			}
		}
		const [durableDocuments, durableAssetPaths] = await Promise.all([
			projectDocumentMetadata(options.targetProjectId),
			projectAssetPathList(options.targetProjectId)
		]);
		const stillOccupied = occupiedFromPaths(
			durableDocuments.map((doc) => doc.relativePath),
			durableAssetPaths,
			options.mode === 'move' ? excludeKeys : new Set()
		);
		for (const planned of [...plannedDocuments, ...plannedAssets]) {
			const occupiedNow = stillOccupied.has(pathKey(planned.newPath));
			const plannedVariant = conflicts.some(
				(conflict) => pathKey(conflict.path) === pathKey(planned.newPath)
			);
			if (occupiedNow && !plannedVariant) throw new Error('Project path already exists');
		}
		if (options.mode === 'move') {
			for (const row of [...selectedDocuments, ...changedExisting]) {
				await db.versions.add({
					id: newId(),
					draftId: row.id,
					name: row.name,
					content: row.content,
					createdAt: now
				});
			}
			await db.drafts.bulkPut(written);
			if (writtenAssets.length) await db.projectAssets.bulkPut(writtenAssets);
		} else {
			await db.drafts.bulkAdd(written);
			if (writtenAssets.length) await db.projectAssets.bulkAdd(writtenAssets);
		}
		await db.projects.update(options.targetProjectId, { updatedAt: now });
		if (sourceProjectId && sourceProjectId !== options.targetProjectId)
			await db.projects.update(sourceProjectId, { updatedAt: now });
	});
	filesStore.acceptProjectRows(
		options.mode === 'move' ? written : written.filter((row) => !row.open),
		options.mode === 'move' ? expected : undefined,
		options.mode === 'move' ? rewriteLive : undefined
	);
	return {
		status: 'done',
		documents: plannedDocuments.length,
		assets: plannedAssets.length,
		targetProjectId: options.targetProjectId,
		...(targetFolder ? { targetFolder } : {}),
		renamed: uniqueConflicts.map((conflict) => conflict.path),
		unresolved: [
			...new Map(
				unresolved.map((entry) => [`${entry.document}\u0000${entry.destination}`, entry])
			).values()
		]
	};
}

export interface DroppedFile {
	file: File;
	relativePath: string;
}

interface EntryLike {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
	file: (callback: (file: File) => void, error?: (error: unknown) => void) => void;
	createReader: () => {
		readEntries: (
			callback: (entries: EntryLike[]) => void,
			error?: (error: unknown) => void
		) => void;
	};
}

function dataTransferEntries(dataTransfer: DataTransfer): EntryLike[] {
	const items = Array.from(dataTransfer.items ?? []);
	const entries: EntryLike[] = [];
	for (const item of items) {
		if (typeof item.webkitGetAsEntry !== 'function') continue;
		const entry = item.webkitGetAsEntry() as EntryLike | null;
		if (entry) entries.push(entry);
	}
	return entries;
}

const DISCOVERY_TIME_BUDGET_MS = 30_000;
const DISCOVERY_VISITED_FACTOR = 4;
const DISCOVERY_DIRECTORY_FACTOR = 2;

/**
 * Walks the dropped tree with explicit depth, visited-entry, directory and
 * elapsed-time budgets. The queue grows on the heap, so a deep tree cannot
 * grow the JavaScript call stack. A branch over the depth limit fails before
 * its children are read.
 */
async function readEntryTree(
	root: EntryLike,
	parent: string,
	output: DroppedFile[]
): Promise<void> {
	const maxVisited = PROJECT_SCALE_LIMITS.maxEntries * DISCOVERY_VISITED_FACTOR;
	const maxDirectories = PROJECT_SCALE_LIMITS.maxEntries * DISCOVERY_DIRECTORY_FACTOR;
	const maxDepth = PROJECT_SCALE_LIMITS.maxDepth;
	const started = Date.now();
	const stack: Array<{ entry: EntryLike; parent: string; depth: number }> = [
		{ entry: root, parent, depth: 0 }
	];
	let visited = 0;
	let directories = 0;
	let queued = 1;
	while (stack.length > 0) {
		if (Date.now() - started > DISCOVERY_TIME_BUDGET_MS)
			throw new Error('Project discovery time limit');
		const current = stack.pop()!;
		queued -= 1;
		visited += 1;
		if (visited > maxVisited) throw new Error('Project discovery entry limit');
		const path = current.parent ? `${current.parent}/${current.entry.name}` : current.entry.name;
		if (current.entry.isFile) {
			if (output.length >= PROJECT_SCALE_LIMITS.maxEntries) throw new Error('Project entry limit');
			const file = await new Promise<File>((resolve, reject) =>
				current.entry.file(resolve, reject)
			);
			output.push({ file, relativePath: path });
			continue;
		}
		if (!current.entry.isDirectory) continue;
		if (current.depth >= maxDepth) throw new Error('Project directory depth limit');
		directories += 1;
		if (directories > maxDirectories) throw new Error('Project discovery directory limit');
		const reader = current.entry.createReader();
		const children: EntryLike[] = [];
		while (true) {
			const batch = await new Promise<EntryLike[]>((resolve, reject) =>
				reader.readEntries(resolve, reject)
			);
			if (!batch.length) break;
			children.push(...batch);
			queued += batch.length;
			if (visited + queued > maxVisited) throw new Error('Project discovery entry limit');
		}
		for (let index = children.length - 1; index >= 0; index -= 1) {
			stack.push({ entry: children[index]!, parent: path, depth: current.depth + 1 });
		}
	}
}

/** Read a drop payload and keep the path of each file inside a dropped folder. */
export async function readDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
	const entries = dataTransferEntries(dataTransfer);
	if (entries.length) {
		const output: DroppedFile[] = [];
		for (const entry of entries) await readEntryTree(entry, '', output);
		return output;
	}
	return Array.from(dataTransfer.files ?? []).map((file) => ({
		file,
		relativePath: file.webkitRelativePath || file.name
	}));
}

export interface ImportEntriesResult {
	documents: number;
	assets: number;
	skipped: string[];
}

/** Import OS files or folder contents below one project folder. */
export async function importProjectEntries(
	projectId: string,
	folder: string | undefined,
	entries: readonly DroppedFile[]
): Promise<ImportEntriesResult> {
	await filesStore.flushPendingAwait();
	const prefix = folderPrefix(folder);
	if (!entries.length) return { documents: 0, assets: 0, skipped: [] };
	if (entries.length > PROJECT_SCALE_LIMITS.maxEntries) throw new Error('Project entry limit');
	const drafts: DraftRow[] = [];
	const assets: ProjectAssetRow[] = [];
	const skipped: string[] = [];
	const paths = new Set<string>();
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	let bytes = 0;
	const now = Date.now();
	for (const entry of entries) {
		const path = projectPath(`${prefix}${entry.relativePath.replace(/\\/g, '/')}`);
		if (pathKey(path).startsWith('.mdsh/')) throw new Error('Reserved project path');
		if (paths.has(pathKey(path))) throw new Error('Duplicate project path');
		paths.add(pathKey(path));
		if (entry.file.size > IMPORT_LIMITS.maxFileBytes) throw new Error('Project file size limit');
		bytes += entry.file.size;
		if (bytes > PROJECT_SCALE_LIMITS.maxBytes) throw new Error('Project size limit');
		const name = basename(path);
		if (isMarkdownExtension(path)) {
			const content = decoder.decode(new Uint8Array(await entry.file.arrayBuffer()));
			validateMarkdownContent(content);
			if (documentKindForFile({ name, content: '' }) === 'presentation') {
				drafts.push({
					id: newId(),
					name,
					content,
					projectId,
					relativePath: path,
					createdAt: now,
					updatedAt: now,
					order: filesStore.library.length + drafts.length,
					open: false,
					kind: 'presentation',
					origin: 'imported'
				});
			} else {
				drafts.push({
					id: newId(),
					name,
					content,
					projectId,
					relativePath: path,
					createdAt: now,
					updatedAt: now,
					order: filesStore.library.length + drafts.length,
					open: false,
					origin: 'imported'
				});
			}
			continue;
		}
		if (isCodeExtension(path)) {
			const content = decoder.decode(new Uint8Array(await entry.file.arrayBuffer()));
			drafts.push({
				id: newId(),
				name,
				content,
				projectId,
				relativePath: path,
				createdAt: now,
				updatedAt: now,
				order: filesStore.library.length + drafts.length,
				open: false,
				kind: 'code',
				origin: 'imported'
			});
			continue;
		}
		const mime = imageMimeForName(path);
		if (mime.startsWith('image/')) {
			if (entry.file.size > MAX_IMAGE_BYTES) throw new Error('Project image size limit');
			assets.push({
				id: newId(),
				projectId,
				path,
				mime,
				data: new Uint8Array(await entry.file.arrayBuffer())
			});
			continue;
		}
		skipped.push(path);
	}
	if (skipped.length) throw new Error(`Unsupported project file: ${skipped[0]}`);
	if (!drafts.length && !assets.length) return { documents: 0, assets: 0, skipped: [] };
	await db.transaction('rw', db.projects, db.drafts, db.projectAssets, async () => {
		if (!(await db.projects.get(projectId))) throw new Error('Project no longer exists');
		const existingDocuments = await db.drafts.where('projectId').equals(projectId).toArray();
		const existingAssets = await db.projectAssets.where('projectId').equals(projectId).toArray();
		if (
			existingDocuments.length + drafts.length > projectDocumentLimit() ||
			existingDocuments.length + drafts.length + existingAssets.length + assets.length >=
				PROJECT_SCALE_LIMITS.maxEntries - 3
		)
			throw new Error('Project entry limit');
		const occupied = occupiedPaths(existingDocuments, existingAssets, new Set(), new Set());
		for (const path of paths)
			if (occupied.has(path)) throw new Error('Project path already exists');
		await db.drafts.bulkAdd(drafts);
		await db.projectAssets.bulkAdd(assets);
		await db.projects.update(projectId, { updatedAt: now });
	});
	filesStore.acceptProjectRows(drafts);
	return { documents: drafts.length, assets: assets.length, skipped };
}
