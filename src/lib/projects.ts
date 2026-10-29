import { browser } from '$app/env';

import { db, newId, type DraftRow, type ProjectAssetRow, type ProjectRow } from './db';

import { filesStore } from './files.svelte';
import {
	projectPath,
	pathKey,
	imageMime,
	projectWikiCandidates,
	relativeDestination
} from './project-paths';
import { renameProjectLinks, projectLinkReport } from './project-links';
import { buildProjectZip, PROJECT_LIMITS, type ProjectInput } from './project-archive';
import { IMPORT_LIMITS } from './config';
import { normalizeRename } from './file-utils';
import { rewriteWikiLinkTargets } from './wiki-links';
import { notify } from './notify.svelte';
import { t } from './i18n';
import { reportError } from './report';

export async function importProject(input: ProjectInput): Promise<ProjectRow> {
	if (!browser || typeof indexedDB === 'undefined') throw new Error('Storage is not available');
	await filesStore.flushPendingAwait();
	const now = Date.now();
	const project: ProjectRow = {
		id: newId(),
		name: input.name || 'Project',
		createdAt: now,
		updatedAt: now
	};
	const rows: DraftRow[] = input.documents.map((document, index) => ({
		id: newId(),
		name: document.relativePath.split('/').pop()!,
		content: document.content,
		projectId: project.id,
		relativePath: projectPath(document.relativePath),
		createdAt: now,
		updatedAt: now,
		order: filesStore.library.length + index,
		open: false
	}));
	const assets: ProjectAssetRow[] = input.assets.map((asset) => ({
		...asset,
		id: newId(),
		projectId: project.id,
		path: projectPath(asset.path)
	}));
	const keys = [
		...rows.map((row) => pathKey(row.relativePath!)),
		...assets.map((asset) => pathKey(asset.path))
	];
	if (new Set(keys).size !== keys.length) throw new Error('Duplicate project path');
	await db.transaction('rw', db.projects, db.projectAssets, db.drafts, async () => {
		await db.projects.add(project);
		await db.projectAssets.bulkAdd(assets);
		await db.drafts.bulkAdd(rows);
	});
	filesStore.acceptProjectRows(rows);
	return project;
}

export async function createProject(name: string): Promise<ProjectRow> {
	return importProject({
		name,
		documents: [{ relativePath: 'README.md', content: '' }],
		assets: []
	});
}

export async function createProjectDocument(projectId: string, path: string): Promise<string> {
	const relativePath = projectPath(/\.(md|markdown|mdx|txt)$/i.test(path) ? path : `${path}.md`);

	if (relativePath.split('/')[0]!.toLowerCase() === '.mdsh')
		throw new Error('Reserved project path');

	await filesStore.flushPendingAwait();
	const now = Date.now();
	const row: DraftRow = {
		id: newId(),
		projectId,
		relativePath,
		name: relativePath.split('/').pop()!,
		content: '',
		createdAt: now,
		updatedAt: now,
		order: filesStore.library.length,
		open: true
	};
	await db.transaction('rw', db.projects, db.projectAssets, db.drafts, async () => {
		if (!(await db.projects.get(projectId))) throw new Error('Project no longer exists');
		const documents = await db.drafts.where('projectId').equals(projectId).toArray();
		const assets = await db.projectAssets.where('projectId').equals(projectId).toArray();
		if (
			documents.length >= IMPORT_LIMITS.maxFiles ||
			documents.length + assets.length >= PROJECT_LIMITS.maxEntries - 3
		)
			throw new Error('Project entry limit');
		if (
			[...documents.map((doc) => doc.relativePath!), ...assets.map((asset) => asset.path)].some(
				(existing) => pathKey(existing) === pathKey(relativePath)
			)
		)
			throw new Error('Project path already exists');
		await db.drafts.add(row);
	});
	filesStore.acceptProjectRows([row]);
	filesStore.openDocument(row.id);
	return row.id;
}

export async function exportProject(projectId: string): Promise<boolean> {
	await filesStore.flushPendingAwait();
	const snapshot = await db.transaction(
		'r',
		db.projects,
		db.drafts,
		db.projectAssets,
		async () => ({
			project: await db.projects.get(projectId),
			documents: await db.drafts.where('projectId').equals(projectId).toArray(),
			assets: await db.projectAssets.where('projectId').equals(projectId).toArray()
		})
	);
	if (!snapshot.project) throw new Error('Project no longer exists');
	const blob = await buildProjectZip(
		snapshot.project.name,
		snapshot.documents.map((doc) => ({
			id: doc.id,
			relativePath: doc.relativePath!,
			content: doc.content
		})),
		snapshot.assets
	);
	const { triggerDownload, sanitizeFilename } = await import('./services/export');
	return triggerDownload(blob, sanitizeFilename(`${snapshot.project.name}.zip`));
}

export async function checkProjectLinks(projectId: string) {
	await filesStore.flushPendingAwait();
	const [documents, assets] = await Promise.all([
		db.drafts.where('projectId').equals(projectId).toArray(),
		db.projectAssets.where('projectId').equals(projectId).toArray()
	]);
	return projectLinkReport(
		documents.map((doc) => ({ id: doc.id, relativePath: doc.relativePath!, content: doc.content })),
		assets.map((asset) => asset.path)
	);
}

let renameQueue: Promise<unknown> = Promise.resolve();

export function renameProjectDocument(id: string, requested: string): Promise<boolean> {
	const operation = renameQueue
		.catch(() => {})
		.then(async () => {
			let nativeRename: import('./projects-native').NativeRenameReceipt | undefined;
			let committed = false;
			try {
				await filesStore.flushPendingAwait();
				const document = filesStore.library.find((file) => file.id === id);
				if (!document?.projectId || !document.relativePath) return false;
				const name = normalizeRename(requested);
				if (name.includes('/') || name.includes('\\')) throw new Error('Use a filename');
				const oldPath = document.relativePath;
				const newPath = projectPath([...oldPath.split('/').slice(0, -1), name].join('/'));
				if (oldPath === newPath) return true;
				const snapshot = filesStore.library
					.filter((file) => file.projectId === document.projectId)
					.map((file) => ({ ...file }));
				const rewrite = (content: string, fileId: string) => {
					const file = snapshot.find((entry) => entry.id === fileId)!;
					const from = file.relativePath!;
					const linked = renameProjectLinks(content, from, oldPath, newPath);
					return rewriteWikiLinkTargets(linked, (target) => {
						const candidates = projectWikiCandidates(file, target, snapshot);
						if (candidates.length !== 1 || candidates[0]!.id !== id || target === id) return target;
						const suffix = target.match(/#.*$/)?.[0] ?? '';
						const next = relativeDestination(from === oldPath ? newPath : from, newPath);

						return (
							(/\.(?:md|markdown|mdx|txt)$/i.test(target.split('#', 1)[0]!)
								? next
								: next.replace(/\.(?:md|markdown|mdx|txt)$/i, '')) + suffix
						);
					});
				};
				const rewritten = snapshot
					.map((file) => {
						const content = rewrite(file.content, file.id);
						return { file, content, relativePath: file.id === id ? newPath : file.relativePath! };
					})
					.filter((entry) => entry.content !== entry.file.content || entry.file.id === id);
				const { renameNativeProjectDocument } = await import('./projects-native');
				nativeRename = await renameNativeProjectDocument(document.projectId, oldPath, newPath);
				const rows = await db.transaction(
					'rw',
					db.drafts,
					db.projectAssets,
					db.versions,
					async () => {
						const durable = await db.drafts
							.where('projectId')
							.equals(document.projectId!)
							.toArray();
						const assets = await db.projectAssets
							.where('projectId')
							.equals(document.projectId!)
							.toArray();
						if (
							durable.some(
								(row) => row.id !== id && pathKey(row.relativePath!) === pathKey(newPath)
							) ||
							assets.some((asset) => pathKey(asset.path) === pathKey(newPath))
						)
							throw new Error('Project path already exists');
						const result: DraftRow[] = [];
						for (const entry of rewritten) {
							const before = durable.find((row) => row.id === entry.file.id);
							const current = filesStore.library.find((file) => file.id === entry.file.id);
							if (
								!before ||
								before.content !== entry.file.content ||
								before.relativePath !== entry.file.relativePath ||
								current?.content !== entry.file.content
							)
								throw new Error('The document changed during rename');
							await db.versions.add({
								id: newId(),
								draftId: before.id,
								name: before.name,
								content: before.content,
								createdAt: Date.now()
							});
							result.push({
								...before,
								name: before.id === id ? name : before.name,
								relativePath: entry.relativePath,
								content: entry.content,
								updatedAt: Date.now()
							});
						}
						await db.drafts.bulkPut(result);
						return result;
					}
				);
				committed = true;
				filesStore.acceptProjectRows(
					rows,
					new Map(snapshot.map((file) => [file.id, file])),
					rewrite
				);
				await nativeRename.commit();
				return true;
			} catch (error) {
				if (nativeRename && !committed) {
					try {
						await nativeRename.rollback();
					} catch (rollbackError) {
						reportError('project rename rollback', rollbackError);
					}
				}
				reportError('project rename', error);
				notify.error(t('projects.operationFailed'));
				return false;
			}
		});
	renameQueue = operation;
	return operation;
}

export async function addProjectImage(projectId: string, file: File): Promise<string> {
	const { embedImageFile } = await import('./render/image-media');
	await embedImageFile(file);
	const { sanitizeFilename } = await import('./services/export');
	const path = projectPath(`assets/${newId()}-${sanitizeFilename(file.name)}`);
	const mime = imageMime(path);
	if (!mime) throw new Error('Unsupported image type');
	const data = new Uint8Array(await file.arrayBuffer());
	await db.transaction('rw', db.projects, db.drafts, db.projectAssets, async () => {
		if (!(await db.projects.get(projectId))) throw new Error('Project no longer exists');
		const documents = await db.drafts.where('projectId').equals(projectId).toArray();
		const assets = await db.projectAssets.where('projectId').equals(projectId).toArray();
		const encoder = new TextEncoder();
		const size =
			data.byteLength +
			assets.reduce((total, asset) => total + asset.data.byteLength, 0) +
			documents.reduce((total, document) => total + encoder.encode(document.content).byteLength, 0);
		if (
			size > PROJECT_LIMITS.maxBytes ||
			documents.length + assets.length >= PROJECT_LIMITS.maxEntries - 3
		)
			throw new Error('Project size limit');
		await db.projectAssets.add({ id: newId(), projectId, path, mime, data });
	});
	return path;
}
