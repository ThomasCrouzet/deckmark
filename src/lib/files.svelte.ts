import { ImportSession, type ImportOptions, type ImportReport } from './import-limits';
import { readPreference, writePreference } from './preferences';
import { IMPORT_LIMITS } from './config';
import { browser } from '$app/env';
import { db, newId } from './db';
import type { DraftRow } from './db';
import type { FileItem, TrashedFile } from './types';
import { isFSASupported, listDiskLinks, pickDirectoryFiles } from './fsa';
import { isDesktop } from './desktop';
import type { NativeDiskGrant } from './disk-tauri';
import {
	loadTrashRows,
	moveToTrash,
	moveManyToTrash,
	restoreFromTrash,
	purgePermanently,
	purgeManyPermanently,
	persistReorder
} from './trash';
import {
	openFromDisk as diskOpenFromDisk,
	openPathsFromDesktop as diskOpenPathsFromDesktop,
	openDirectoryFromDisk as diskOpenDirectoryFromDisk,
	saveToDisk as diskSaveToDisk,
	renameOnDisk,
	unlinkFromDisk as diskUnlinkFromDisk,
	refreshBrokenLinks as diskRefreshBrokenLinks
} from './disk-sync';

import { isMarkdownFile, normalizeRename, uniqueName, stripMdExtension } from './file-utils';

import {
	exportMarkdown as exportMarkdownOp,
	exportAllZip as exportAllZipOp,
	exportHTML as exportHTMLOp,
	exportPDF as exportPDFOp,
	exportSelectionZip as exportSelectionZipOp
} from './export-ops';
import { MetaIndex } from './meta-index';
import { rewriteWikiLinkTargets } from './wiki-links';
import { projectWikiCandidates } from './project-paths';
import { SaveQueue } from './save-queue';
import { reportPersistenceError } from './storage';
import { reportError } from './report';
import { recordVersion, createCheckpoint, createCheckpoints } from './version-history';
import type { ReplaceOptions } from './replace';
import { replaceInFilesAsync } from './replace-worker';
import { createCrossTab, type CrossTabMessage } from './cross-tab';
import { handleCrossTabPolicy } from './cross-tab-policy';
import { t } from '#lib/i18n/index.js';
import { notify } from './notify.svelte';
import { DEMO_DOCS } from './demo-doc';
import { toggleSelection, rangeSelection, clearSelection } from './selection';

const ACTIVE_ID_KEY = 'mdsh:activeId';

function toDraftRow(file: FileItem, order: number, open = true): DraftRow {
	return {
		id: file.id,
		name: file.name,
		content: file.content,
		...(file.projectId ? { projectId: file.projectId, relativePath: file.relativePath } : {}),
		createdAt: file.createdAt,
		updatedAt: file.updatedAt,
		order,
		open
	};
}

function applyDraftLocation(file: FileItem, row: DraftRow): void {
	file.name = row.name;
	if (row.projectId) file.projectId = row.projectId;
	else delete file.projectId;
	if (row.relativePath) file.relativePath = row.relativePath;
	else delete file.relativePath;
	file.updatedAt = Math.max(file.updatedAt, row.updatedAt);
}

class FilesStore {
	files = $state<FileItem[]>([]);
	/** Durable documents that are not currently shown as tabs. */
	closedFiles = $state<FileItem[]>([]);
	activeId = $state<string | null>(null);
	projectAnchor = $state<{ id: string; fragment: string } | null>(null);
	importProgress = $state<ImportReport | null>(null);
	lastImportReport = $state<ImportReport | null>(null);
	private importController: AbortController | null = null;
	private importSignal: AbortSignal | undefined;
	private renderAllowedIds = $state<string[]>([]);

	requiresRenderConfirmation(id: string): boolean {
		const file = this.files.find((file) => file.id === id);

		return (
			!!file &&
			file.content.length >= IMPORT_LIMITS.largeDocumentChars &&
			!this.renderAllowedIds.includes(id)
		);
	}

	allowDocumentRendering(id: string): void {
		if (!this.renderAllowedIds.includes(id)) this.renderAllowedIds.push(id);
	}

	cancelImport(): void {
		this.importController?.abort();
	}

	private beginImport(options: ImportOptions): ImportOptions {
		this.cancelImport();
		const controller = new AbortController();
		this.importController = controller;
		const signal = options.signal
			? AbortSignal.any([controller.signal, options.signal])
			: controller.signal;
		this.importSignal = signal;
		return {
			signal,
			onProgress: (report) => {
				if (this.importSignal !== signal) return;
				this.importProgress = report;
				options.onProgress?.(report);
			}
		};
	}

	private finishImport(report: ImportReport, signal?: AbortSignal): void {
		if (signal !== this.importSignal) return;
		this.lastImportReport = report;
		this.importProgress = null;
		this.importController = null;
	}

	loaded = $state(false);
	// §J1 - Error message if IndexedDB access fails at startup (private mode,
	// storage disabled, corrupted profile). Shown as a banner by +page.
	loadError = $state<string | null>(null);
	lastSavedAt = $state<number>(0);
	trash = $state<TrashedFile[]>([]);
	trashBusy = $state(false);
	private pendingTrashBatch: Promise<boolean> | null = null;
	// §B3.2 - `true` during the debounce (400 ms) + the IDB write. Shown by StatusBar.
	hasPendingSave = $state(false);
	saveErrorIds = $state<string[]>([]);
	// §6.5 - Always reassigned (new Set) - Svelte 5 does not track in-place mutations.
	selectedIds = $state<Set<string>>(new Set());

	/**
	 * In-flight moveToTrash promises per draft id. restore() must await these
	 * before restoreFromTrash so a late moveToTrash cannot delete a just-restored
	 * drafts row (fast Undo race).
	 */
	private pendingTrashMoves = new Map<string, Promise<boolean>>();
	private pendingRestores = new Map<string, Promise<void>>();
	private diskOperations = new Map<string, Promise<unknown>>();
	private renameTail: Promise<void> | null = null;
	private metaIndex = new MetaIndex(() => this.library);
	// §M3 - Ids with a local keystroke not yet persisted ("dirty") in the
	// cross-tab sense: a draft is dirty as long as a write is pending OR its
	// in-memory content differs from the last known base. Used to decide, when
	// receiving a message from another tab, between reloading (safe) and notifying
	// a conflict (local editing in progress, do not overwrite).
	private crossTab = createCrossTab((msg) => this.handleCrossTabMessage(msg));
	private saveQueue = new SaveQueue({
		onPendingChange: (pending) => {
			this.hasPendingSave = pending;
		},
		onFailuresChange: (ids) => {
			this.saveErrorIds = ids;
		},
		onSaved: (ts) => {
			this.lastSavedAt = ts;
		},
		onError: (err) => reportPersistenceError(err, 'save'),
		// §M3 - After each successful write, we publish to the other tabs so they
		// resynchronize this draft (and do not overwrite our write).
		onDraftSaved: (id, updatedAt) => {
			this.crossTab.post({ type: 'draft-written', id, updatedAt });
		},
		onDraftReconciled: (row) => {
			const file = this.library.find((entry) => entry.id === row.id);
			if (file) applyDraftLocation(file, row);
			this.metaIndex.invalidateMeta(row.id);
		},
		onConflictPreserved: (id, variant) => {
			this.closedFiles.push({ ...variant, dirty: false });
			this.metaIndex.invalidateMeta(variant.id);
			this.notifyCrossTabConflict(
				t('files.modifiedInOtherTab', {
					name: this.files.find((file) => file.id === id)?.name ?? id
				})
			);
		}
	});

	get active(): FileItem | null {
		return this.files.find((f) => f.id === this.activeId) ?? null;
	}

	get library(): FileItem[] {
		return [...this.files, ...this.closedFiles];
	}

	openDocument(id: string): void {
		if (this.closedFiles.some((file) => file.id === id)) this.reopen(id);
		else this.setActive(id);
	}

	hasSaveError(id: string): boolean {
		return this.saveErrorIds.includes(id);
	}

	/**
	 * §M3 - Receives a message from ANOTHER tab (never from the sender:
	 * BroadcastChannel does not echo back to itself → no loop).
	 *
	 * Use a conservative policy without automatic merge:
	 *  - `draft-written`: reload a clean draft from Dexie. For a dirty draft,
	 *    keep local edits and notify the user about the conflict.
	 *  - `removed`: remove an open tab only when no local edit is active.
	 *  - `reorder` and `backup-applied`: reload all state from Dexie. If a local
	 *    edit is active, keep it and notify the user.
	 *
	 * This fire-and-forget path must not cause data loss or a reload loop.
	 */
	private handleCrossTabMessage(msg: CrossTabMessage): void {
		if (!browser) return;
		// Capture editor changes before the policy checks pending saves.
		this.dispatchEditorFlush();
		handleCrossTabPolicy(msg, {
			isLoaded: (id) => [...this.files, ...this.closedFiles].some((f) => f.id === id),
			isPending: (id) => this.trashBusy || this.saveQueue.has(id),
			hasAnyPending: () => this.hasLocalPendingEdits(),
			fileName: (id) =>
				this.files.find((file) => file.id === id)?.name ??
				this.closedFiles.find((file) => file.id === id)?.name ??
				id,
			syncDraft: (id) => this.syncDraftFromOtherTab(id),
			closeRemoved: (id) => {
				this.detachFromView(id);
				const closed = this.closedFiles.findIndex((file) => file.id === id);
				if (closed >= 0) this.closedFiles.splice(closed, 1);
				this.saveQueue.discard(id);
			},
			reloadQuiet: () => this.reload(false),
			reloadSiblings: () => {
				void import('./workspaces.svelte').then((m) => m.workspaceStore.reload());
				void import('./templates.svelte').then((m) => m.templatesStore.reload());
			},
			invalidateAll: () => this.saveQueue.invalidateAll(this.files.map((f) => f.id)),
			notifyConflict: (message) => this.notifyCrossTabConflict(message),
			t
		});
	}

	/** §M3 - Is there at least one draft with a local write pending? */
	private hasLocalPendingEdits(): boolean {
		return (
			this.trashBusy ||
			this.pendingTrashMoves.size > 0 ||
			this.pendingRestores.size > 0 ||
			[...this.files, ...this.closedFiles].some((file) => this.saveQueue.has(file.id))
		);
	}

	/**
	 * Conflict reload first makes the local branch durable. The save queue
	 * preserves a conflicting remote branch before the view is reloaded.
	 */
	private notifyCrossTabConflict(message: string): void {
		notify.actionable(message, {
			label: t('files.reloadFromStorage'),
			run: () => {
				void this.flushPendingAwait()
					.then(() => this.reload(false))
					.catch((error) => reportPersistenceError(error, 'save'));
			}
		});
	}

	/** §M3 - Reloads a specific draft from Dexie after it was written by another tab. */
	private async syncDraftFromOtherTab(id: string): Promise<void> {
		const file = [...this.files, ...this.closedFiles].find((f) => f.id === id);
		if (!file) return; // not loaded here → nothing to resynchronize
		// Local editing pending on this file: real conflict. We do NOT reload (we
		// would lose the local keystroke) - we signal the conflict to the user.
		if (this.trashBusy || this.saveQueue.has(id)) {
			this.notifyCrossTabConflict(t('files.modifiedInOtherTab', { name: file.name }));
			return;
		}
		try {
			const row = await db.drafts.get(id);
			if (!row) return;
			// Re-check the absence of local editing AFTER the await (a keystroke may
			// have arrived in the meantime): if it became dirty, we abstain.
			if (this.trashBusy || this.saveQueue.has(id)) return;
			file.name = row.name;
			file.content = row.content;
			if (row.projectId) file.projectId = row.projectId;
			else delete file.projectId;
			if (row.relativePath) file.relativePath = row.relativePath;
			else delete file.relativePath;
			file.updatedAt = row.updatedAt;
			file.dirty = false;
			this.saveQueue.trackPersisted(row);
			this.metaIndex.invalidateMeta(id);
			if (row.open === false) {
				this.detachFromView(id, file);
				if (!this.closedFiles.some((entry) => entry.id === id)) this.closedFiles.push(file);
				return;
			}
			this.metaIndex.invalidateMeta(id);
		} catch (err) {
			reportError('cross-tab resync', err);
		}
	}

	async load(preferredActiveId: string | null = null): Promise<void> {
		if (!browser || this.loaded) return;
		try {
			const rows = await db.drafts.orderBy('order').toArray();
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- Transient local Set, never $state
			const linkedIds = new Set<string>();
			if (isFSASupported() || isDesktop()) {
				const links = await listDiskLinks();
				for (const link of links) {
					if (link.kind === 'path' || isFSASupported()) linkedIds.add(link.id);
				}
			}
			const items = rows.map((r) => ({
				id: r.id,
				name: r.name,
				content: r.content,
				...(r.projectId ? { projectId: r.projectId, relativePath: r.relativePath } : {}),
				createdAt: r.createdAt,
				updatedAt: r.updatedAt,
				dirty: false,
				linkedToDisk: linkedIds.has(r.id)
			}));
			for (const row of rows) this.saveQueue.trackPersisted(row);
			this.files = items.filter((_file, index) => rows[index]?.open !== false);
			this.closedFiles = items.filter((_file, index) => rows[index]?.open === false);
			const savedActiveId =
				preferredActiveId && this.files.some((file) => file.id === preferredActiveId)
					? preferredActiveId
					: readPreference(ACTIVE_ID_KEY);
			if (savedActiveId && this.files.some((f) => f.id === savedActiveId)) {
				this.activeId = savedActiveId;
			} else if (this.files.length > 0) {
				// invariant: files[0] is guaranteed non-undefined since length > 0.
				this.activeId = this.files[0]!.id;
			}
			await this.loadTrash();
			this.loaded = true;
			// Background FSA check - no await (must not block the display).
			void this.refreshBrokenLinks();
		} catch (err) {
			// §J1 - IndexedDB inaccessible (private browsing, storage disabled,
			// corrupted profile): we do not abandon the app on a misleading empty
			// screen ("no files"), we surface an actionable message.
			reportError('load IndexedDB', err);
			this.loadError = t('files.loadError');
		}
	}

	/**
	 * §1.1 - Reloads the whole state from Dexie (after a backup restoration, which
	 * rewrote the tables under our feet). Cancels the in-progress saves and timers,
	 * empties the in-memory state, then re-reads as at startup.
	 *
	 * §M3 - `broadcast` (default true) publishes a `backup-applied` signal to the
	 * other tabs so they resynchronize. Set to `false` when the reload is itself
	 * triggered by a cross-tab message (avoids the infinite loop).
	 */
	async reload(broadcast = true): Promise<void> {
		if (!browser) return;
		await this.pendingTrashBatch;
		// A quiet reload keeps this tab's view if the document is still open.
		const preferredActiveId = broadcast ? null : this.activeId;
		// invalidateAll (not discardAll): skip in-flight puts without deleting
		// IDB rows - discard reverse-delete would wipe restored / reloaded drafts.
		this.saveQueue.invalidateAll([...this.files, ...this.closedFiles].map((file) => file.id));
		this.files = [];
		this.closedFiles = [];
		this.trash = [];
		this.activeId = null;
		this.selectedIds = new Set();
		this.metaIndex = new MetaIndex(() => this.library);
		this.loaded = false;
		this.loadError = null;
		await this.load(preferredActiveId);
		if (broadcast) this.crossTab.post({ type: 'backup-applied' });
	}

	/** Reloads the durable trash and purges entries past the retention period. */
	private async loadTrash(): Promise<void> {
		const results = await loadTrashRows();
		for (const { entry } of results) {
			this.trash.push(entry);
		}
	}

	private persistActiveId(): void {
		if (!browser) return;
		writePreference(ACTIVE_ID_KEY, this.activeId);
	}

	/** Schedules the Dexie persistence of `id` after 400 ms (debounce via SaveQueue). */
	private scheduleSave(id: string): void {
		this.saveQueue.schedule(id, () => {
			const file = this.library.find((f) => f.id === id);
			if (!file) return null;
			// §2.4 - History snapshot at flush time (throttled + deduplicated in
			// recordVersion). Fire-and-forget: does not block the save; a history
			// failure must not compromise the save.
			void recordVersion({ id: file.id, name: file.name, content: file.content }).catch((err) =>
				reportError('version history', err)
			);
			const index = this.files.indexOf(file);
			return toDraftRow(file, index >= 0 ? index : this.library.indexOf(file), index >= 0);
		});
	}

	/** §A2.8 - Immediate flush of pending saves (pagehide / beforeunload). */
	flushPending(): void {
		this.dispatchEditorFlush();
		this.saveQueue.flush((id) => this.rowForFlush(id));
	}

	/**
	 * Flushes armed debounce timers and awaits in-flight IDB puts.
	 * Used before backup export so the JSON snapshot includes the latest edits.
	 */
	async flushPendingAwait(): Promise<void> {
		await this.pendingTrashBatch;
		await this.flushDraftsAwait();
		await this.pendingTrashBatch;
	}

	private async flushDraftsAwait(): Promise<void> {
		this.dispatchEditorFlush();
		await Promise.all(this.diskOperations.values());
		await this.saveQueue.flushAwait((id) => this.rowForFlush(id));
		await Promise.all([...this.pendingTrashMoves.values(), ...this.pendingRestores.values()]);
		await this.saveQueue.flushAwait((id) => this.rowForFlush(id));
	}

	private dispatchEditorFlush(): void {
		if (browser) window.dispatchEvent(new Event('mdsh:flush-editor'));
	}

	/** Shared draft-row builder for flush paths (history snapshot side-effect). */
	private rowForFlush(id: string): DraftRow | null {
		const openIndex = this.files.findIndex((file) => file.id === id);
		const file =
			openIndex >= 0 ? this.files[openIndex] : this.closedFiles.find((entry) => entry.id === id);
		if (!file) return null;
		// §M2 - History snapshot also on the close flush. The `scheduleSave`
		// debounce path already records a version, but not the
		// pagehide/beforeunload flush: combined with the 5 min throttle, the last
		// state before closing could have never had a version. `recordVersion`
		// handles its own throttle/dedup → no abusive duplicate. Fire-and-forget.
		void recordVersion({ id: file.id, name: file.name, content: file.content }).catch((err) =>
			reportError('version history', err)
		);
		return toDraftRow(file, openIndex >= 0 ? openIndex : this.files.length, openIndex >= 0);
	}

	createNew(name = t('files.untitledFilename'), content = ''): FileItem {
		const file: FileItem = {
			id: newId(),
			name: uniqueName(
				[...this.files, ...this.closedFiles].map((f) => f.name),
				name
			),
			content,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			dirty: content.length > 0
		};
		this.files.push(file);
		this.activeId = file.id;
		this.persistActiveId();
		if (content.length > 0) this.metaIndex.invalidateBacklinksIndex();
		this.scheduleSave(file.id);
		return file;
	}

	async openProjectLink(sourceId: string, destination: string): Promise<void> {
		const source = this.library.find((file) => file.id === sourceId);
		if (!source?.projectId || !source.relativePath) return;
		const { resolveProjectPath } = await import('./project-paths');
		const path = resolveProjectPath(source.relativePath, destination);
		const target = this.library.find(
			(file) => file.projectId === source.projectId && file.relativePath === path
		);
		if (!target) {
			notify.error(t('projects.linkMissing'));
			return;
		}
		const fragment = destination.split('#').slice(1).join('#');
		if (fragment) {
			try {
				this.projectAnchor = { id: target.id, fragment: decodeURIComponent(fragment) };
			} catch {
				this.projectAnchor = null;
			}
		}
		this.openDocument(target.id);
	}

	async importFiles(
		fileList: FileList | File[],
		options: ImportOptions = {}
	): Promise<{ created: FileItem[]; skipped: number; failed: number; report: ImportReport }> {
		const session = new ImportSession(this.beginImport(options));
		const created: FileItem[] = [];
		session.publish();
		try {
			for (const file of Array.from(fileList)) {
				if (!(await session.pause())) break;
				if (!isMarkdownFile(file)) {
					session.skip();
					continue;
				}
				const content = await session.read(file);
				if (content === null) continue;
				const matches = [...this.files, ...this.closedFiles].filter(
					(known) => known.linkedToDisk && known.name === file.name && known.content === content
				);
				if (matches.length === 1) {
					const existing = matches[0]!;
					if (this.closedFiles.includes(existing)) this.reopen(existing.id);
					else this.setActive(existing.id);
					created.push(existing);
					session.accept();
					continue;
				}
				const name = /\.(md|markdown)$/i.test(file.name) ? file.name : `${file.name}.md`;
				created.push(this.createNew(name, content));
				session.accept();
			}
			return {
				created,
				skipped: session.report.skipped,
				failed: session.report.failed,
				report: session.publish()
			};
		} finally {
			this.finishImport(session.publish(), session.options.signal);
		}
	}

	setActive(id: string): void {
		this.dispatchEditorFlush();
		this.activeId = id;
		this.persistActiveId();
	}

	navigateFile(direction: 1 | -1): void {
		if (this.files.length < 2) return;
		const index = this.files.findIndex((file) => file.id === this.activeId);
		if (index < 0) return;
		const next = this.files[(index + direction + this.files.length) % this.files.length]!;
		this.setActive(next.id);
	}

	private detachFromView(
		id: string,
		knownFile?: FileItem
	): { file: FileItem; index: number } | null {
		const idx = this.files.findIndex((file) => file.id === id);
		if (idx === -1) return null;
		const file = knownFile ?? this.files[idx]!;
		this.files.splice(idx, 1);
		if (this.activeId === id) {
			this.activeId = this.files[Math.min(idx, this.files.length - 1)]?.id ?? null;
			this.persistActiveId();
		}
		if (this.selectedIds.has(id)) {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- replace the state with a fresh Set
			const next = new Set(this.selectedIds);
			next.delete(id);
			this.selectedIds = next;
		}
		this.metaIndex.invalidateMeta(id);
		return { file, index: idx };
	}

	close(id: string, opts: { trash?: boolean; keepDB?: boolean } = {}): void {
		if (opts.trash === true) {
			this.delete(id);
			return;
		}
		const detached = this.detachFromView(id);
		if (!detached) return;
		this.closedFiles.push(detached.file);
		this.saveQueue.persist(toDraftRow(detached.file, detached.index, false));
	}

	/** Moves a document to the durable trash. This is distinct from closing a tab. */
	delete(id: string): void {
		if (this.trashBusy) return;
		const open = this.detachFromView(id);
		const closedIndex = this.closedFiles.findIndex((file) => file.id === id);
		const file =
			open?.file ?? (closedIndex >= 0 ? this.closedFiles.splice(closedIndex, 1)[0]! : null);
		if (!file) return;
		const order = open?.index ?? this.files.length + Math.max(0, closedIndex);
		this.metaIndex.invalidateMeta(id);
		this.saveQueue.discard(id);
		const trashedAt = Date.now();
		const entry: TrashedFile = { file, order, trashedAt };
		const displaced = this.trash.find((existing) => existing.file.id === id);
		if (displaced) this.trash = this.trash.filter((existing) => existing !== displaced);
		this.trash.push(entry);
		const moveP = moveToTrash(
			id,
			toDraftRow(file, order, false),
			order,
			trashedAt,
			(row) =>
				this.trash.push({
					file: { ...row.file, dirty: false },
					order: row.order,
					trashedAt: row.trashedAt
				}),
			(row) => {
				this.closedFiles.push({ ...row, dirty: false });
				this.metaIndex.invalidateMeta(row.id);
			}
		).then((ok) => {
			if (ok) this.crossTab.post({ type: 'removed', id });
			else {
				this.rollbackTrash(id, file, order, Boolean(open));
				if (displaced) this.trash.push(displaced);
			}
			return ok;
		});
		this.pendingTrashMoves.set(id, moveP);
		void moveP.finally(() => {
			if (this.pendingTrashMoves.get(id) === moveP) this.pendingTrashMoves.delete(id);
		});
	}

	/** Runs one batch after pending saves, disk operations, moves, and restores finish. */
	private runTrashBatch(run: () => Promise<void>): Promise<boolean> {
		if (!browser || this.trashBusy) return Promise.resolve(false);
		this.trashBusy = true;
		const operation = (async () => {
			try {
				if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
				await this.flushDraftsAwait();
				await run();
				// The reorder signal reloads library and trash state in clean tabs.
				this.crossTab.post({ type: 'reorder' });
				return true;
			} catch (error) {
				reportPersistenceError(error, 'trash');
				return false;
			} finally {
				this.trashBusy = false;
			}
		})();
		this.pendingTrashBatch = operation;
		void operation.then(() => {
			if (this.pendingTrashBatch === operation) this.pendingTrashBatch = null;
		});
		return operation;
	}

	/** Moves an ID snapshot to trash. Update the view only after the batch commits. */
	deleteMany(ids: readonly string[]): Promise<boolean> {
		const requested = new Set(ids);
		if (requested.size === 0) return Promise.resolve(true);
		return this.runTrashBatch(async () => {
			const trashedAt = Date.now();
			const entries = this.library.flatMap((file, order) =>
				requested.has(file.id) ? [{ file: { ...file }, order, trashedAt }] : []
			);
			if (entries.length === 0) return;
			const result = await moveManyToTrash(
				entries.map((entry) => ({
					id: entry.file.id,
					file: toDraftRow(entry.file, entry.order, false),
					order: entry.order,
					trashedAt
				}))
			);
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- Local operation result.
			const removed = new Set<string>();
			const currentFiles = new Map(this.library.map((file) => [file.id, file]));
			for (const { file } of entries) {
				const current = currentFiles.get(file.id);
				if (current && (current.content !== file.content || current.name !== file.name)) {
					// Keep an edit made during the transaction as a live document beside its trash copy.
					this.saveQueue.persist(
						toDraftRow(current, this.library.indexOf(current), this.files.includes(current))
					);
					this.notifyCrossTabConflict(t('files.otherTabChanges'));
					continue;
				}
				removed.add(file.id);
				this.saveQueue.discard(file.id);
				this.metaIndex.invalidateMeta(file.id);
			}
			const activeIndex = this.files.findIndex((file) => file.id === this.activeId);
			const nextActive =
				this.files.slice(activeIndex + 1).find((file) => !removed.has(file.id)) ??
				this.files.slice(0, activeIndex).findLast((file) => !removed.has(file.id));
			this.files = this.files.filter((file) => !removed.has(file.id));
			this.closedFiles = this.closedFiles.filter((file) => !removed.has(file.id));
			this.selectedIds = new Set([...this.selectedIds].filter((id) => !removed.has(id)));
			this.renderAllowedIds = this.renderAllowedIds.filter((id) => !removed.has(id));
			if (this.activeId && removed.has(this.activeId)) {
				this.activeId = nextActive?.id ?? null;
				this.persistActiveId();
			}
			const movedIds = new Set(entries.map((entry) => entry.file.id));
			this.trash = [
				...this.trash.filter((entry) => !movedIds.has(entry.file.id)),
				...entries,
				...result.preserved.map((row) => ({
					file: { ...row.file, dirty: false },
					order: row.order,
					trashedAt: row.trashedAt
				}))
			];
			for (const row of result.variants) {
				this.closedFiles.push({ ...row, dirty: false });
				this.metaIndex.invalidateMeta(row.id);
			}
		});
	}

	/** Reopens a durable document without creating a new copy. */
	reopen(id: string): FileItem | null {
		const idx = this.closedFiles.findIndex((file) => file.id === id);
		if (idx === -1) return null;
		const file = this.closedFiles.splice(idx, 1)[0]!;
		this.files.push(file);
		this.activeId = file.id;
		this.persistActiveId();
		this.metaIndex.invalidateBacklinksIndex();
		this.saveQueue.persist(toDraftRow(file, this.files.length - 1, true));
		return file;
	}

	/**
	 * Closes several views while preserving their durable documents.
	 * An explicit `trash: true` still delegates to the separate deletion action.
	 */
	closeMany(ids: string[], opts: { trash?: boolean; keepDB?: boolean } = {}): void {
		const toClose = ids.filter((id) => this.files.some((f) => f.id === id));
		if (toClose.length === 0) return;
		for (const id of toClose) this.close(id, opts);
	}

	/**
	 * §6.8 - Re-injects Dexie rows into `files` without recreating them (workspaces.restore).
	 * No scheduleSave: the rows already exist in DB.
	 * Disk links are probed asynchronously (same as `load`) so broken-link badges
	 * and save-to-disk still work after a workspace switch.
	 */
	openMany(rows: DraftRow[]): void {
		if (!browser || rows.length === 0) return;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient local set, never exposed to rendering
		const existing = new Set(this.files.map((f) => f.id));
		const addedIds: string[] = [];
		for (const r of rows) {
			if (!r || existing.has(r.id)) continue;
			const closedIndex = this.closedFiles.findIndex((file) => file.id === r.id);
			const item =
				closedIndex >= 0
					? this.closedFiles.splice(closedIndex, 1)[0]!
					: {
							id: r.id,
							name: r.name,
							content: r.content,
							...(r.projectId ? { projectId: r.projectId, relativePath: r.relativePath } : {}),
							createdAt: r.createdAt,
							updatedAt: r.updatedAt,
							dirty: false,
							linkedToDisk: false
						};
			this.files.push(item);
			existing.add(r.id);
			this.saveQueue.persist(toDraftRow(item, this.files.length - 1, true));
			addedIds.push(r.id);
		}
		if (addedIds.length === 0) return;
		this.metaIndex.invalidateBacklinksIndex();
		// Background: restore linkedToDisk flags for re-opened workspace tabs.
		if (isFSASupported() || isDesktop()) {
			void listDiskLinks()
				.then((links) => {
					const added = new Set(addedIds);
					let any = false;
					for (const link of links) {
						if (!added.has(link.id) || (link.kind === 'fsa' && !isFSASupported())) continue;
						const f = this.files.find((x) => x.id === link.id);
						if (f && !f.linkedToDisk) {
							f.linkedToDisk = true;
							any = true;
						}
					}
					if (any) void this.refreshBrokenLinks();
				})
				.catch((error: unknown) => reportPersistenceError(error, 'load'));
		}
	}

	/**
	 * Reorders open tabs to match `orderedIds` (workspace fileIds). Ids not
	 * currently open are ignored; open tabs missing from the list keep their
	 * relative tail order after the matched prefix.
	 */
	reorderToIds(orderedIds: readonly string[]): void {
		if (orderedIds.length === 0 || this.files.length <= 1) return;
		const byId = new Map(this.files.map((f) => [f.id, f]));
		const next: typeof this.files = [];
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local transient Set, not $state
		const seen = new Set<string>();
		for (const id of orderedIds) {
			const f = byId.get(id);
			if (!f || seen.has(id)) continue;
			next.push(f);
			seen.add(id);
		}
		for (const f of this.files) {
			if (!seen.has(f.id)) next.push(f);
		}
		// Only mutate when order actually changes (avoids needless meta churn).
		if (next.length !== this.files.length) return;
		let same = true;
		for (let i = 0; i < next.length; i++) {
			if (next[i]!.id !== this.files[i]!.id) {
				same = false;
				break;
			}
		}
		if (same) return;
		this.files = next;
	}

	restore(id: string): FileItem | null {
		if (this.trashBusy) return null;
		const idx = this.trash.findIndex((t) => t.file.id === id);
		if (idx === -1) return null;
		// invariant: splice on a valid index returns exactly 1 element.
		const entry = this.trash.splice(idx, 1)[0]!;
		const collision = [...this.files, ...this.closedFiles].some((file) => file.id === id);
		const restored: FileItem = collision
			? {
					id: newId(),
					name: uniqueName(
						[...this.files, ...this.closedFiles].map((file) => file.name),
						entry.file.name
					),
					content: entry.file.content,
					...(entry.file.projectId
						? {
								projectId: entry.file.projectId,
								relativePath: entry.file.relativePath
							}
						: {}),
					createdAt: entry.file.createdAt,
					updatedAt: entry.file.updatedAt,
					dirty: false,
					linkedToDisk: false
				}
			: entry.file;
		const insertAt = Math.min(entry.order, this.files.length);
		this.files.splice(insertAt, 0, restored);
		this.activeId = restored.id;
		this.persistActiveId();
		this.metaIndex.invalidateBacklinksIndex();
		// Atomic restoration (put draft + delete trashed in one transaction): no
		// window where the file exists in NO table. Since the row is persisted, no
		// scheduleSave here (later edits will go back through the normal path).
		//
		// Order matters for Undo races:
		// 1) await pending moveToTrash so it cannot run after restoreFromTrash
		//    and wipe the restored drafts row;
		// 2) settleAndRearm so a discarded in-flight put reverse-deletes before
		//    we rewrite the draft (not after).
		const restorePromise = (async () => {
			const pendingMove = this.pendingTrashMoves.get(id);
			if (pendingMove) {
				try {
					await pendingMove;
				} catch {
					// moveToTrash errors already handled in close's then
				}
			}
			await this.saveQueue.settleAndRearm(restored.id);
			const ok = await restoreFromTrash(
				id,
				toDraftRow(restored, insertAt),
				(row) => {
					if (!this.closedFiles.some((file) => file.id === row.id))
						this.closedFiles.push({ ...row, dirty: false });
					this.metaIndex.invalidateMeta(row.id);
				},
				(row) => {
					applyDraftLocation(restored, row);
					this.saveQueue.trackPersisted(row);
					this.metaIndex.invalidateMeta(row.id);
				}
			);
			if (!ok) this.rollbackRestore(restored.id, entry, insertAt);
		})();
		this.pendingRestores.set(id, restorePromise);
		void restorePromise.finally(() => {
			if (this.pendingRestores.get(id) === restorePromise) this.pendingRestores.delete(id);
		});
		return restored;
	}

	/**
	 * Cancels an optimistic restore after a failed Dexie transaction. Returns the
	 * row to the UI trash and removes it from open tabs.
	 */
	private rollbackRestore(id: string, entry: TrashedFile, insertAt: number): void {
		const fIdx = this.files.findIndex((f) => f.id === id);
		if (fIdx !== -1) this.files.splice(fIdx, 1);
		if (!this.trash.some((t) => t.file.id === entry.file.id)) {
			this.trash.push(entry);
		}
		if (this.activeId === id) {
			this.activeId = this.files[Math.min(insertAt, this.files.length - 1)]?.id ?? null;
			this.persistActiveId();
		}
		this.metaIndex.invalidateBacklinksIndex();
	}

	/**
	 * Cancels the optimistic move-to-trash when the Dexie write failed: re-inserts
	 * the file into the view, removes the trash entry and the purge timer. The
	 * draft is still in base (Dexie transaction rollback), so the view becomes
	 * consistent with storage again.
	 */
	private rollbackTrash(id: string, file: FileItem, idx: number, wasOpen: boolean): void {
		const tIdx = this.trash.findIndex((t) => t.file.id === id);
		if (tIdx !== -1) this.trash.splice(tIdx, 1);
		if (wasOpen && !this.files.some((f) => f.id === id)) {
			this.files.splice(Math.min(idx, this.files.length), 0, file);
			this.metaIndex.invalidateBacklinksIndex();
		} else if (!wasOpen && !this.closedFiles.some((entry) => entry.id === id)) {
			this.closedFiles.push(file);
			this.metaIndex.invalidateMeta(id);
		}
		this.saveQueue.persist(toDraftRow(file, idx, wasOpen));
	}

	purgeTrash(id: string): void {
		if (!this.trash.some((entry) => entry.file.id === id)) return;
		void this.runTrashBatch(async () => {
			const entry = this.trash.find((entry) => entry.file.id === id);
			if (!entry) return;
			await purgePermanently(id);
			this.trash = this.trash.filter((current) => current !== entry);
		});
	}

	/** Deletes a trash ID snapshot after pending moves and restores settle. */
	purgeTrashMany(ids: readonly string[]): Promise<boolean> {
		const requested = new Set(ids);
		if (requested.size === 0) return Promise.resolve(true);
		return this.runTrashBatch(async () => {
			const entries = this.trash.filter((entry) => requested.has(entry.file.id));
			await purgeManyPermanently(entries.map((entry) => entry.file.id));
			const removed = new Set(entries);
			this.trash = this.trash.filter((entry) => !removed.has(entry));
		});
	}

	updateContent(id: string, content: string): void {
		const file = this.library.find((f) => f.id === id);
		if (!file || file.content === content) return;
		file.content = content;
		file.updatedAt = Date.now();
		file.dirty = true;
		this.metaIndex.invalidateMeta(id);
		this.scheduleSave(id);
	}

	rename(id: string, name: string): Promise<boolean> {
		const file = this.files.find((f) => f.id === id);
		if (!file) return Promise.resolve(false);
		if (file.projectId && file.relativePath) {
			return import('./projects').then(({ renameProjectDocument }) =>
				renameProjectDocument(id, name)
			);
		}
		const normalized = normalizeRename(name);
		if (/[\r\n[\]|]/.test(normalized)) {
			notify.error(t('files.invalidLinkName'));
			return Promise.resolve(false);
		}
		if (
			this.library.some(
				(entry) =>
					entry.id !== id &&
					stripMdExtension(entry.name).toLowerCase() === stripMdExtension(normalized).toLowerCase()
			)
		) {
			notify.error(t('files.nameExists', { name: normalized }));
			return Promise.resolve(false);
		}
		if (normalized === file.name && !this.diskOperations.has(id)) return Promise.resolve(true);
		const plan = () => {
			const oldTarget = stripMdExtension(file.name).toLowerCase();
			const nextTarget = stripMdExtension(normalized);
			const rewrite = (content: string) =>
				rewriteWikiLinkTargets(content, (target) =>
					target.toLowerCase() === oldTarget ? nextTarget : target
				);
			const changes =
				this.metaIndex.wikiLinkCandidates(oldTarget).length === 1
					? this.library.flatMap((entry) =>
							rewrite(entry.content) === entry.content
								? []
								: [{ file: entry, before: entry.content }]
						)
					: [];
			return { changes, rewrite };
		};
		if (
			!file.linkedToDisk &&
			!this.diskOperations.has(id) &&
			!this.renameTail &&
			plan().changes.length === 0
		) {
			this.syncDiskName(id, normalized);
			return Promise.resolve(true);
		}
		const previousRename = this.renameTail;
		const operation = this.queueDiskOperation(id, async () => {
			await previousRename;
			if (
				this.library.some(
					(entry) =>
						entry.id !== id &&
						stripMdExtension(entry.name).toLowerCase() ===
							stripMdExtension(normalized).toLowerCase()
				)
			) {
				notify.error(t('files.nameExists', { name: normalized }));
				return false;
			}
			const { changes, rewrite } = plan();
			try {
				await createCheckpoints(
					changes.map(({ file }) => ({ id: file.id, name: file.name, content: file.content }))
				);
			} catch (error) {
				reportPersistenceError(error, 'save');
				return false;
			}
			if (
				changes.some(({ file, before }) => !this.library.includes(file) || file.content !== before)
			) {
				notify.error(t('files.otherTabChanges'));
				return false;
			}
			const current = this.diskDeps.getFile(id);
			if (!current) return false;
			if (current.linkedToDisk && !(await renameOnDisk(id, normalized, this.diskDeps)))
				return false;

			this.syncDiskName(id, normalized);
			for (const change of changes) {
				// Use the latest text if an edit occurred during native I/O.
				this.updateContent(change.file.id, rewrite(change.file.content));
			}
			if (changes.length) notify.success(t('files.linksUpdated', { n: changes.length }));
			return true;
		});
		const settled = operation.then(
			() => {},
			() => {}
		);
		this.renameTail = settled;
		void settled.then(() => {
			if (this.renameTail === settled) this.renameTail = null;
		});
		return operation;
	}

	private queueDiskOperation<T>(id: string, run: () => Promise<T>): Promise<T> {
		const operation = (this.diskOperations.get(id) ?? Promise.resolve()).catch(() => {}).then(run);
		this.diskOperations.set(id, operation);
		void operation
			.finally(() => {
				if (this.diskOperations.get(id) === operation) this.diskOperations.delete(id);
			})
			.catch(() => {});
		return operation;
	}

	/** Apply committed project rows without resetting another document's editor. */
	acceptProjectRows(
		rows: DraftRow[],
		expected?: ReadonlyMap<
			string,
			{ content: string; relativePath?: string | undefined; updatedAt: number }
		>,
		reconcile?: (content: string, id: string) => string
	): string[] {
		const applied: string[] = [];
		for (const row of rows) {
			const existing = this.library.find((file) => file.id === row.id);
			const before = expected?.get(row.id);
			const changed = !!(
				existing &&
				before &&
				(existing.content !== before.content ||
					existing.relativePath !== before.relativePath ||
					existing.updatedAt !== before.updatedAt)
			);
			if (existing) {
				existing.name = row.name;
				existing.content = changed
					? (reconcile?.(existing.content, row.id) ?? existing.content)
					: row.content;
				existing.updatedAt = changed ? Date.now() : row.updatedAt;
				if (row.projectId) existing.projectId = row.projectId;
				else delete existing.projectId;
				if (row.relativePath) existing.relativePath = row.relativePath;
				else delete existing.relativePath;
				existing.dirty = true;
			} else if (row.open === false) this.closedFiles.push({ ...row, dirty: false });
			else this.files.push({ ...row, dirty: false });
			this.saveQueue.invalidate(row.id);
			this.saveQueue.trackPersisted(row);
			if (changed) this.scheduleSave(row.id);
			else applied.push(row.id);
			this.metaIndex.invalidateMeta(row.id);
		}
		this.crossTab.post({ type: 'reorder' });
		return applied;
	}

	private syncDiskName(id: string, name: string): void {
		const file =
			this.files.find((entry) => entry.id === id) ??
			this.closedFiles.find((entry) => entry.id === id);
		if (!file || !name || file.name === name) return;
		file.name = name;
		file.updatedAt = Date.now();
		this.metaIndex.invalidateMeta(id);
		if (this.closedFiles.includes(file))
			this.saveQueue.persist(toDraftRow(file, this.files.length, false));
		else this.scheduleSave(id);
	}

	// ─── Exports (delegation → export-ops.ts) ────────────────────────────────

	private get exportDeps() {
		return {
			getFiles: () => this.library,
			scheduleSave: (id: string) => this.scheduleSave(id)
		};
	}

	exportActive(): void {
		if (this.active) this.export(this.active.id);
	}
	export(id: string): void {
		this.dispatchEditorFlush();
		exportMarkdownOp(id, this.exportDeps);
	}
	async exportAll(): Promise<void> {
		this.dispatchEditorFlush();
		return exportAllZipOp(this.exportDeps);
	}
	async exportOpen(): Promise<void> {
		this.dispatchEditorFlush();
		return exportAllZipOp({ ...this.exportDeps, getFiles: () => this.files });
	}
	async exportHTML(id: string): Promise<void> {
		this.dispatchEditorFlush();
		return exportHTMLOp(id, this.exportDeps);
	}
	async exportActiveHTML(): Promise<void> {
		if (this.active) await this.exportHTML(this.active.id);
	}
	async exportPDF(id: string): Promise<void> {
		this.dispatchEditorFlush();
		return exportPDFOp(id, this.exportDeps);
	}
	async exportActivePDF(): Promise<void> {
		if (this.active) await this.exportPDF(this.active.id);
	}
	async exportSelectedZip(): Promise<void> {
		this.dispatchEditorFlush();
		return exportSelectionZipOp(this.selectedIds, this.exportDeps);
	}

	// §4.5 / §M1 - Drag-reorder.
	// The in-memory array is reordered first (→ `indexOf` gives the NEW order),
	// then we FLUSH the pending content (instead of cancelling it) with this new
	// `order`: `cancelAll` destroyed the pending timers without writing, losing the
	// last pre-reorder keystroke in base. `persistReorder` then touches ONLY the
	// `order` field (db.drafts.update), so the freshly flushed content is never
	// overwritten.
	reorder(fromId: string, toId: string): void {
		const fromIdx = this.files.findIndex((f) => f.id === fromId);
		const toIdx = this.files.findIndex((f) => f.id === toId);
		if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
		// invariant: splice on a valid index returns exactly 1 element.
		const moved = this.files.splice(fromIdx, 1)[0]!;
		this.files.splice(toIdx, 0, moved);
		const orderedIds = this.files.map((f) => f.id);
		this.saveQueue.flushPending(orderedIds, (id) => {
			const file = this.files.find((f) => f.id === id);
			if (!file) return null;
			return toDraftRow(file, this.files.indexOf(file));
		});
		void persistReorder(orderedIds).then((ts) => {
			// ts === null: the order write failed (already notified by
			// reportPersistenceError). We do NOT show "saved" and we do not propagate
			// to the other tabs - nothing was persisted.
			if (ts === null) return;
			this.lastSavedAt = ts;
			// §M3 - Informs the other tabs that the order changed in base.
			this.crossTab.post({ type: 'reorder' });
		});
	}

	// ─── Disk sync (delegation → disk-sync.ts) ───────────────────────────────

	private get diskDeps() {
		return {
			getFile: (id: string) => this.library.find((f) => f.id === id),
			getFiles: () => [...this.files, ...this.closedFiles],
			onActivate: (id: string) => {
				if (this.closedFiles.some((file) => file.id === id)) this.reopen(id);
				else this.setActive(id);
			},
			onCreate: (name: string, content: string) => this.createNew(name, content),
			onSyncName: (id: string, name: string) => this.syncDiskName(id, name),
			onUpdateContent: (id: string, content: string) => this.updateContent(id, content),
			scheduleSave: (id: string) => this.scheduleSave(id),
			onImportRollback: (id: string) => {
				this.detachFromView(id);
				this.saveQueue.discard(id);
			}
		};
	}

	async openFromDisk(options: ImportOptions = {}): Promise<FileItem[]> {
		const configured = this.beginImport(options);
		try {
			return await diskOpenFromDisk(this.diskDeps, configured);
		} finally {
			this.finishImport(this.importProgress ?? new ImportSession().publish(), configured.signal);
		}
	}

	/** Desktop: open native capabilities from argv / file association. */
	async openPathsFromDesktop(
		grants: NativeDiskGrant[],
		options: ImportOptions = {}
	): Promise<string[]> {
		const configured = this.beginImport(options);
		try {
			const result = await diskOpenPathsFromDesktop(grants, this.diskDeps, configured);
			await this.flushPendingAwait();
			return result.processedTokens;
		} finally {
			this.finishImport(this.importProgress ?? new ImportSession().publish(), configured.signal);
		}
	}

	/**
	 * §2.3 - "Vault" import: opens a folder and creates one tab per markdown file
	 * found (recursive, capped). The files are NOT linked to disk (one-shot import)
	 * - they become normal local drafts, which resolves the inter-file wiki-links
	 * via the existing MetaIndex.
	 */
	async importDirectory(
		options: ImportOptions = {}
	): Promise<{ count: number; truncated: boolean; report?: ImportReport }> {
		if (!browser) return { count: 0, truncated: false };
		if (isDesktop()) return this.importDirectoryFromDesktop(options);
		const configured = this.beginImport(options);
		try {
			const { files, truncated, report } = await pickDirectoryFiles(configured);
			for (const file of files) this.createNew(file.name, file.content);
			this.finishImport(report, configured.signal);
			return { count: files.length, truncated, report };
		} finally {
			if (this.importSignal === configured.signal) {
				this.importProgress = null;
				this.importController = null;
			}
		}
	}

	async importDirectoryFromDesktop(
		options: ImportOptions = {}
	): Promise<{ count: number; truncated: boolean; report?: ImportReport }> {
		if (!browser || !isDesktop()) return { count: 0, truncated: false };
		const configured = this.beginImport(options);
		try {
			const files = await diskOpenDirectoryFromDisk(this.diskDeps, configured);
			const report = this.importProgress;
			if (report) this.finishImport(report, configured.signal);
			return {
				count: files.length,
				truncated: !!report && (report.failed > 0 || report.cancelled),
				...(report ? { report } : {})
			};
		} finally {
			if (this.importSignal === configured.signal) {
				this.importProgress = null;
				this.importController = null;
			}
		}
	}

	/**
	 * §P1.9 - Opt-in guided tour: creates the demo files (wiki-linked, showing
	 * off backlinks and the link graph) and activates the first one. Never
	 * called automatically - only from the explicit Welcome-screen button.
	 */
	loadDemo(): FileItem[] {
		const created = DEMO_DOCS.map((doc) => this.createNew(doc.name, doc.content));
		// invariant: DEMO_DOCS is a non-empty const array, `created` has the same length.
		this.setActive(created[0]!.id);
		return created;
	}

	/**
	 * Replaces matching text in the selected scope. `updateContent` marks each
	 * file as dirty, schedules a save, and records an undoable history snapshot.
	 * Returns file and occurrence counts, or a regular expression error.
	 */
	async replaceInAll(
		query: string,
		replacement: string,
		opts: ReplaceOptions,
		scope: 'library' | 'open' = 'library'
	): Promise<{ files: number; occurrences: number; regexError: string | null }> {
		const slices = (scope === 'library' ? this.library : this.files).map((f) => ({
			id: f.id,
			name: f.name,
			content: f.content
		}));
		const { results, total, regexError } = await replaceInFilesAsync(
			slices,
			query,
			replacement,
			opts
		);
		if (regexError) return { files: 0, occurrences: 0, regexError };
		const unchanged = () =>
			results.every((result) => {
				const before = slices.find((file) => file.id === result.id);
				const current = this.library.find((file) => file.id === result.id);

				return (
					before && current && before.content === current.content && before.name === current.name
				);
			});
		if (!unchanged()) return { files: 0, occurrences: 0, regexError: t('files.otherTabChanges') };
		await createCheckpoints(
			slices.filter((file) => results.some((result) => result.id === file.id))
		);
		if (!unchanged()) return { files: 0, occurrences: 0, regexError: t('files.otherTabChanges') };
		for (const r of results) this.updateContent(r.id, r.content);
		return { files: results.length, occurrences: total, regexError: null };
	}

	async restoreVersion(id: string, content: string): Promise<boolean> {
		const file = this.files.find((entry) => entry.id === id);
		if (!file || file.content === content) return false;
		const before = { id: file.id, name: file.name, content: file.content };
		await createCheckpoint(before);
		const current = this.files.find((entry) => entry.id === id);
		if (current !== file || current.content !== before.content || current.name !== before.name) {
			throw new Error(t('files.otherTabChanges'));
		}
		this.updateContent(id, content);
		return true;
	}
	async saveActiveToDisk(): Promise<boolean> {
		if (!browser || !this.active) return false;
		return this.saveToDisk(this.active.id);
	}
	async saveToDisk(id: string): Promise<boolean> {
		this.dispatchEditorFlush();
		return this.queueDiskOperation(id, () => diskSaveToDisk(id, this.diskDeps));
	}
	async unlinkFromDisk(id: string): Promise<void> {
		return this.queueDiskOperation(id, () => diskUnlinkFromDisk(id, this.diskDeps));
	}
	async refreshBrokenLinks(): Promise<void> {
		return diskRefreshBrokenLinks(this.files, (id) => this.files.find((f) => f.id === id));
	}

	// ─── MetaIndex (delegation → meta-index.ts) ──────────────────────────────

	/** Front-matter tags of file `id`. */
	getTags(id: string): string[] {
		return this.metaIndex.getTags(id);
	}
	/** All unique tags of the corpus, sorted alphabetically. */
	get allTags(): string[] {
		return this.metaIndex.allTags;
	}
	/** Title: front-matter `title` > first H1 (if FM present) > filename without extension. */
	displayTitle(id: string): string {
		return this.metaIndex.displayTitle(id);
	}
	documentTitle(id: string): string {
		return this.metaIndex.documentTitle(id);
	}
	/** Files that contain a wiki-link pointing to `targetId`. */
	backlinks(targetId: string): FileItem[] {
		return this.library.filter(
			(file) =>
				file.id !== targetId &&
				this.metaIndex
					.wikiLinkTargets(file.id)
					.some((target) => this.resolveWikiLink(target, file.id) === targetId)
		);
	}
	/** Resolves a wiki-link → file id, or `null` if not found. */
	resolveWikiLink(target: string, sourceId?: string): string | null {
		const source = this.library.find((file) => file.id === sourceId);
		if (source?.projectId) {
			const candidates = projectWikiCandidates(source, target, this.library);
			return candidates.length === 1 ? candidates[0]!.id : null;
		}
		return this.metaIndex.resolveWikiLink(target);
	}
	/**
	 * Opens a wiki-link target: activates the existing file, or creates a new one
	 * (Obsidian behavior). Returns the resolved/created id.
	 */
	openWikiLink(target: string, sourceId?: string): string | null {
		const source = this.library.find((file) => file.id === sourceId);
		if (source?.projectId) {
			const matches = projectWikiCandidates(source, target, this.library);
			if (matches.length !== 1) {
				notify.info(
					matches.length ? t('files.ambiguousLink', { name: target }) : t('projects.linkMissing')
				);
				return null;
			}
			const file = matches[0]!;
			const fragment = target.split('#').slice(1).join('#');
			if (fragment) this.projectAnchor = { id: file.id, fragment };
			this.openDocument(file.id);
			return file.id;
		}
		const resolved = this.resolveWikiLink(target);
		if (resolved) {
			this.openDocument(resolved);
			return resolved;
		}
		if (this.metaIndex.wikiLinkCandidates(target).length > 1) {
			notify.info(t('files.ambiguousLink', { name: target }));
			return null;
		}
		const trimmed = target.trim();
		if (!trimmed) return null;
		return this.createNew(`${trimmed}.md`).id;
	}
	/** @internal - outgoing wiki-link targets of file `id`. */
	wikiLinkTargets(id: string): string[] {
		return this.metaIndex.wikiLinkTargets(id);
	}

	// ─── Sidebar multi-selection (§6.5) ──────────────────────────────────────
	// Always new Set() - Svelte 5 does not track in-place mutations.
	// Pure logic lives in `selection.ts` (unit-tested without the store).

	/** Cmd/Ctrl+click: adds/removes `id` from the selection. */
	selectionToggle(id: string): void {
		this.selectedIds = toggleSelection(this.selectedIds, id);
	}
	/** Shift+click: selects the range between `anchorId` and `targetId`. */
	selectionRange(anchorId: string, targetId: string): void {
		this.selectedIds = rangeSelection(
			this.selectedIds,
			this.files.map((f) => f.id),
			anchorId,
			targetId
		);
	}
	/** Clears the selection. */
	selectionClear(): void {
		this.selectedIds = clearSelection();
	}
	/** Closes all selected files + clears the selection. */
	closeSelected(): void {
		const ids = Array.from(this.selectedIds);
		for (const id of ids) this.close(id);
		this.selectedIds = clearSelection();
	}
}

export const filesStore = new FilesStore();
