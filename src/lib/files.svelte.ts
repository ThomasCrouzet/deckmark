import { ImportSession, readDataUrl, type ImportOptions, type ImportReport } from './import-limits';
import { readPreference, writePreference } from './preferences';
import { IMPORT_LIMITS } from './config';
import { browser } from '$app/env';
import { db, newId } from './db';
import type { DraftRow } from './db';
import type { FileItem, TrashedFile } from './types';
import {
	documentKind,
	documentKindForFile,
	imageMimeForName,
	isCodeExtension,
	isImageExtension,
	isMarkdownExtension,
	isPdfExtension,
	type DocumentKind
} from './document-kind';
import { isFSASupported, listDiskLinks, pickDirectoryFiles } from './fsa';
import { isDiskLinkingAvailable } from './disk-linking';
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

import { normalizeRename, uniqueName, stripMdExtension } from './file-utils';
import type { CodeLanguageId } from './code/languages';
import {
	cycleOpenTab,
	nextActiveAfterDetach,
	nextActiveAfterRemoval,
	rememberActiveTab,
	reorderedOpenIds
} from './file-tabs';

import { encodeDraftManifest } from './draft-manifest-key';
import { MetaIndex } from './meta-index';
import { rewriteWikiLinkTargets } from './wiki-links';
import { SaveQueue } from './save-queue';
import {
	exportMarkdown as exportMarkdownOp,
	exportAllZip as exportAllZipOp,
	exportHTML as exportHTMLOp,
	exportPDF as exportPDFOp,
	exportSelectionZip as exportSelectionZipOp
} from './export-ops';
import {
	DocumentRevisions,
	type DocumentChange,
	type DocumentRevision,
	type DocumentSnapshot
} from './document-revisions';
import { reportPersistenceError, resolveDraftSaveError } from './storage';
import { reportError } from './report';
import { recordVersion, createCheckpoint, createCheckpoints } from './version-history';
import type { ReplaceOptions } from './replace';
import { createCrossTab, type CrossTabMessage } from './cross-tab';
import { handleCrossTabPolicy } from './cross-tab-policy';
import { t } from '#lib/i18n/index.js';
import { notify } from './notify.svelte';
// Demo documents are loaded only from the explicit guided-tour action.
import { toggleSelection, rangeSelection, clearSelection } from './selection';

const ACTIVE_ID_KEY = 'mdsh:activeId';

function toDraftRow(file: FileItem, order: number, open = true): DraftRow {
	return {
		id: file.id,
		name: file.name,
		content: file.content,
		...(file.projectId ? { projectId: file.projectId, relativePath: file.relativePath } : {}),
		...(file.origin ? { origin: file.origin } : {}),
		...(file.sourceFileId ? { sourceFileId: file.sourceFileId } : {}),
		...(file.kind ? { kind: file.kind } : {}),
		...(file.mime ? { mime: file.mime } : {}),
		...(file.data ? { data: file.data } : {}),
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
	/** Set when a user-created note must open in Edit with a ready caret. */
	newDocumentFocusId = $state<string | null>(null);
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
	/** Monotonic boundary for startup and backup reloads. */
	private loadGeneration = 0;
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
	private pendingCrossTabSyncs = new Map<string, symbol>();
	private pendingContentLoads = new Map<string, Promise<FileItem | null>>();
	private diskOperations = new Map<string, Promise<unknown>>();
	private renameTail: Promise<void> | null = null;
	/** Bumped when one file's metadata changes so derived reads rerun. */
	private metaRev = $state(0);
	private metaIndex = new MetaIndex(
		() => this.library,
		() => {
			this.metaRev += 1;
		}
	);
	// §M3 - Ids with a local keystroke not yet persisted ("dirty") in the
	// cross-tab sense: a draft is dirty as long as a write is pending OR its
	// in-memory content differs from the last known base. Used to decide, when
	// receiving a message from another tab, between reloading (safe) and notifying
	// a conflict (local editing in progress, do not overwrite).
	private crossTab = createCrossTab((msg) => this.handleCrossTabMessage(msg));
	/**
	 * Most recently active documents, newest last. Closing a tab returns to what
	 * the user was viewing before that tab, which matches browser behavior and
	 * keeps the positional neighbor only as a fallback.
	 */
	private activeHistory: string[] = [];
	private libraryCache: {
		files: FileItem[];
		closed: FileItem[];
		filesLength: number;
		closedLength: number;
		value: FileItem[];
	} | null = null;
	private savedRevisions = new Map<string, DocumentRevision>();
	private documents: DocumentRevisions = new DocumentRevisions(
		(snapshot) => {
			const file = this.library.find((entry) => entry.id === snapshot.revision.fileId);
			if (!file || !this.documents.isCurrent(snapshot.revision)) return;
			file.content = snapshot.text;
			this.metaIndex.invalidateMeta(file.id);
			this.metaRev += 1;
		},
		(error) => reportPersistenceError(error, 'save')
	);
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
		onError: (err) => {
			// The queue records the failed ID before it calls this callback.
			const failed = this.library.filter((file) => this.saveQueue.hasDurabilityFailure(file.id));
			reportPersistenceError(
				err,
				'save',
				failed.length
					? failed.map((file) => ({
							id: file.id,
							name: file.name,
							retry: () => {
								this.dispatchEditorFlush();
								const row = this.rowForFlush(file.id);
								if (row && this.saveQueue.hasDurabilityFailure(file.id))
									this.saveQueue.persist(row);
							}
						}))
					: undefined
			);
		},
		// §M3 - After each successful write, we publish to the other tabs so they
		// resynchronize this draft (and do not overwrite our write).
		onDraftSaved: (id, updatedAt, revision) => {
			if (revision) this.savedRevisions.set(id, revision);
			resolveDraftSaveError(id);
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
		// Reuse the previous array while the open and closed lists keep the same
		// identity and length. Document switching recomputes many derived values
		// over the library, so a fresh copy on every read costs real time with
		// hundreds of documents.
		const cached = this.libraryCache;
		if (
			cached &&
			cached.files === this.files &&
			cached.closed === this.closedFiles &&
			cached.filesLength === this.files.length &&
			cached.closedLength === this.closedFiles.length
		)
			return cached.value;
		const value = this.closedFiles.length === 0 ? this.files : [...this.files, ...this.closedFiles];
		this.libraryCache = {
			files: this.files,
			closed: this.closedFiles,
			filesLength: this.files.length,
			closedLength: this.closedFiles.length,
			value
		};
		return value;
	}

	openDocument(id: string): Promise<void> {
		if (this.closedFiles.some((file) => file.id === id)) return this.openClosedDocument(id);
		this.setActive(id);
		return Promise.resolve();
	}

	private async openClosedDocument(id: string): Promise<void> {
		const file = this.closedFiles.find((entry) => entry.id === id);
		if (!file) return;
		if (file.contentDeferred) {
			const hydrated = await this.hydrateContent(id);
			if (!hydrated) return;
		}
		if (this.closedFiles.some((entry) => entry.id === id)) this.reopen(id);
		else if (this.files.some((entry) => entry.id === id)) this.setActive(id);
	}

	/** Reads one deferred body and applies it to the existing library item. */
	async hydrateContent(id: string): Promise<FileItem | null> {
		const file = this.library.find((entry) => entry.id === id) ?? null;
		if (!file || !file.contentDeferred) return file;
		const pending = this.pendingContentLoads.get(id);
		if (pending) return pending;
		const load = this.readContentRow(id);
		this.pendingContentLoads.set(id, load);
		void load.finally(() => {
			if (this.pendingContentLoads.get(id) === load) this.pendingContentLoads.delete(id);
		});
		return load;
	}

	private async readContentRow(id: string): Promise<FileItem | null> {
		const row = await db.drafts.get(id);
		const file = this.library.find((entry) => entry.id === id);
		// The document can be deleted while the body read is pending.
		if (!row || !file || !file.contentDeferred) return file ?? null;
		const { applyDraftContent } = await import('./draft-access');
		applyDraftContent(file, row);
		this.saveQueue.trackPersisted(row);
		this.metaIndex.invalidateMeta(id);
		this.metaRev += 1;
		return file;
	}

	/** Hydrates the requested bodies before an operation that needs exact text. */
	async ensureContent(ids: readonly string[]): Promise<void> {
		await Promise.all(ids.map((id) => this.hydrateContent(id)));
	}

	async ensureLibraryContent(): Promise<void> {
		await this.ensureContent(
			this.library.filter((file) => file.contentDeferred).map((file) => file.id)
		);
	}

	async ensureProjectContent(projectId: string): Promise<void> {
		await this.ensureContent(
			this.library
				.filter((file) => file.projectId === projectId && file.contentDeferred)
				.map((file) => file.id)
		);
	}

	/**
	 * Returns search text without materializing deferred bodies in the store.
	 * Search is an explicit operation, so it asks Dexie for exactly the missing
	 * rows and releases them when the worker owns the snapshot.
	 */
	async searchCorpus(
		files: readonly FileItem[]
	): Promise<Array<{ id: string; name: string; content: string }>> {
		if (!files.some((file) => file.contentDeferred))
			return files.map((file) => ({ id: file.id, name: file.name, content: file.content }));
		const { buildSearchCorpus } = await import('./draft-access');
		return buildSearchCorpus(files);
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
		// Invalidate reads even when the policy ignores an unloaded ID.
		if (msg.type === 'draft-written' || msg.type === 'removed')
			this.pendingCrossTabSyncs.delete(msg.id);
		else this.pendingCrossTabSyncs.clear();
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
				this.documents.forget(id);
				this.savedRevisions.delete(id);
				this.detachFromView(id);
				const closed = this.closedFiles.findIndex((file) => file.id === id);
				if (closed >= 0) this.closedFiles.splice(closed, 1);
				this.saveQueue.discard(id);
				this.metaIndex.invalidateMeta(id);
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

	/** Adds or refreshes a durable draft without replacing local edits. */
	private async syncDraftFromOtherTab(id: string): Promise<void> {
		const file = [...this.files, ...this.closedFiles].find((f) => f.id === id);
		if (this.trashBusy || this.saveQueue.has(id)) {
			this.notifyCrossTabConflict(t('files.modifiedInOtherTab', { name: file?.name ?? id }));
			return;
		}
		const token = Symbol();
		this.pendingCrossTabSyncs.set(id, token);
		try {
			const row = await db.drafts.get(id);
			if (this.pendingCrossTabSyncs.get(id) !== token || !row) return;
			const linked =
				!file && (isFSASupported() || isDesktop())
					? (await listDiskLinks()).some((link) => link.id === id)
					: false;
			if (this.pendingCrossTabSyncs.get(id) !== token) return;
			// Capture input that arrived while the database read was pending.
			this.dispatchEditorFlush();
			if (this.trashBusy || this.saveQueue.has(id)) return;
			if (!file) {
				if (this.library.some((entry) => entry.id === id)) return;
				const incoming: FileItem = { ...row, dirty: false, linkedToDisk: linked };
				if (row.open === false) this.closedFiles.push(incoming);
				else this.files.push(incoming);
				this.saveQueue.trackPersisted(row);
				this.metaIndex.invalidateMeta(id);
				void this.refreshBrokenLinks();
				return;
			}
			if (![...this.files, ...this.closedFiles].some((entry) => entry === file)) return;
			file.name = row.name;
			file.content = row.content;
			this.documents.forget(id);
			this.savedRevisions.delete(id);
			if (row.kind) file.kind = row.kind;
			else delete file.kind;
			if (row.mime) file.mime = row.mime;
			else delete file.mime;
			if (row.data) file.data = row.data;
			else delete file.data;
			if (row.projectId) file.projectId = row.projectId;
			else delete file.projectId;
			if (row.relativePath) file.relativePath = row.relativePath;
			else delete file.relativePath;
			file.updatedAt = row.updatedAt;
			file.dirty = false;
			file.contentDeferred = false;
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
		} finally {
			if (this.pendingCrossTabSyncs.get(id) === token) this.pendingCrossTabSyncs.delete(id);
		}
	}

	retryLoad(): void {
		// Dexie caches a rejected initial open. Reload the client after the user
		// restores storage access; the durable library stays in IndexedDB.
		if (typeof window !== 'undefined') window.location.reload();
	}

	async load(preferredActiveId: string | null = null): Promise<boolean> {
		if (!browser || this.loaded) return this.loaded;
		const generation = ++this.loadGeneration;
		let openTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			// A stale tab can hold an older database connection and block the
			// upgrade indefinitely. Surface a recoverable state instead of an
			// endless loading shell. Dexie keeps the request pending; the user
			// must close the other tab and retry.
			const timeout = new Promise<never>((_resolve, reject) => {
				openTimer = setTimeout(() => reject(new Error('storage-open-timeout')), 15_000);
			});
			return await Promise.race([this.loadData(preferredActiveId, generation), timeout]);
		} catch (err) {
			// Invalidate the pending read before publishing the failure. A late
			// IndexedDB result must not replace this state or claim success.
			if (this.loadGeneration === generation) this.loadGeneration += 1;
			// §J1 - IndexedDB inaccessible (private browsing, storage disabled,
			// blocked upgrade, corrupted profile): surface an actionable message.
			reportError('load IndexedDB', err);
			this.loadError = t('files.loadError');
			return false;
		} finally {
			// Do not keep a pending timer after a fast load.
			if (openTimer !== undefined) clearTimeout(openTimer);
		}
	}

	private async loadData(preferredActiveId: string | null, generation: number): Promise<boolean> {
		// The metadata scan, body budget, and full-row fallback live in an
		// on-demand chunk so the boot bundle stays small.
		const { loadDraftLibrary } = await import('./draft-access');
		const loaded = await loadDraftLibrary(preferredActiveId, readPreference(ACTIVE_ID_KEY));
		if (this.loadGeneration !== generation) return false;
		// Load the wiki index module before publishing the files. A reactive read
		// can run as soon as the library is assigned.
		await this.metaIndex.load();
		if (this.loadGeneration !== generation) return false;
		const trash = await loadTrashRows();
		if (this.loadGeneration !== generation) return false;
		for (const row of loaded.persistedRows) this.saveQueue.trackPersisted(row);
		this.files = loaded.files;
		this.closedFiles = loaded.closedFiles;
		this.activeId = loaded.activeId;
		this.metaIndex.invalidateBacklinksIndex();
		this.trash = trash.map(({ entry }) => entry);
		this.loadError = null;
		this.loaded = true;
		// Background FSA check - no await (must not block the display).
		void this.refreshBrokenLinks();
		return true;
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
		this.pendingCrossTabSyncs.clear();
		await this.pendingTrashBatch;
		this.pendingCrossTabSyncs.clear();
		// A quiet reload keeps this tab's view if the document is still open.
		const preferredActiveId = broadcast ? null : this.activeId;
		// invalidateAll (not discardAll): skip in-flight puts without deleting
		// IDB rows - discard reverse-delete would wipe restored / reloaded drafts.
		this.saveQueue.invalidateAll([...this.files, ...this.closedFiles].map((file) => file.id));
		this.documents.clear();
		this.savedRevisions.clear();
		this.files = [];
		this.closedFiles = [];
		this.trash = [];
		this.activeId = null;
		this.selectedIds = new Set();
		this.metaIndex.dispose();
		this.metaIndex = new MetaIndex(
			() => this.library,
			() => {
				this.metaRev += 1;
			}
		);
		this.loaded = false;
		this.loadError = null;
		const restored = await this.load(preferredActiveId);
		if (broadcast && restored) this.crossTab.post({ type: 'backup-applied' });
	}

	private persistActiveId(): void {
		if (!browser) return;
		writePreference(ACTIVE_ID_KEY, this.activeId);
	}

	/** Schedules the Dexie persistence of `id` after 400 ms (debounce via SaveQueue). */
	private scheduleSave(id: string): void {
		this.saveQueue.schedule(id, () => {
			const row = this.rowForFlush(id);
			if (row?.open === false) row.order = this.library.findIndex((file) => file.id === id);
			return row;
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
		try {
			if (browser && !window.dispatchEvent(new Event('mdsh:flush-editor', { cancelable: true }))) {
				throw new Error('document-flush-cancelled');
			}
			this.documents.flushAll();
		} catch (error) {
			reportPersistenceError(error, 'save');
			throw error;
		}
	}

	flushDocumentEdits(): void {
		this.dispatchEditorFlush();
	}

	private capturedDraftRow(file: FileItem, order: number, open = true): DraftRow {
		this.documents.open(file.id, file.content);
		const snapshot = this.documents.flush(file.id);
		if (!snapshot) throw new Error('document-snapshot-superseded');
		const row = toDraftRow(file, order, open);
		// Keep the derived metadata projection on every write path, including
		// rollback paths that do not go through a Dexie hook in a test shim.
		row.manifest = encodeDraftManifest(row);
		this.saveQueue.captureRevision(row, snapshot.revision);
		return row;
	}

	/** Shared draft-row builder for flush paths (history snapshot side-effect). */
	private rowForFlush(id: string): DraftRow | null {
		const openIndex = this.files.findIndex((file) => file.id === id);
		const file =
			openIndex >= 0 ? this.files[openIndex] : this.closedFiles.find((entry) => entry.id === id);
		if (!file) return null;
		const row = this.capturedDraftRow(
			file,
			openIndex >= 0 ? openIndex : this.files.length,
			openIndex >= 0
		);
		// §M2 - History snapshot also on the close flush. `recordVersion`
		// handles its own throttle and dedup. Fire-and-forget.
		void recordVersion({ id: file.id, name: file.name, content: file.content }).catch((err) =>
			reportError('version history', err)
		);
		return row;
	}

	createNew(
		name = t('files.untitledFilename'),
		content = '',
		options: {
			focusEditor?: boolean;
			origin?: FileItem['origin'];
			kind?: DocumentKind;
			mime?: string;
			data?: string;
			sourceFileId?: string;
		} = {}
	): FileItem {
		const kind = options.kind ?? documentKindForFile({ name, content });
		const file: FileItem = {
			id: newId(),
			name: uniqueName(
				[...this.files, ...this.closedFiles].map((f) => f.name),
				name
			),
			content,
			kind,
			...(options.mime ? { mime: options.mime } : {}),
			...(options.data ? { data: options.data } : {}),
			...(options.sourceFileId ? { sourceFileId: options.sourceFileId } : {}),
			origin: options.origin ?? (content.length > 0 || options.data ? 'imported' : 'created'),
			createdAt: Date.now(),
			updatedAt: Date.now(),
			dirty: content.length > 0 || !!options.data
		};
		this.rememberActive();
		this.files.push(file);
		this.activeId = file.id;
		if (options.focusEditor) this.newDocumentFocusId = file.id;
		this.persistActiveId();
		this.metaIndex.invalidateMeta(file.id);
		this.scheduleSave(file.id);
		return file;
	}

	async createDocument(
		kind: DocumentKind,
		options: { language?: CodeLanguageId; name?: string } = {}
	): Promise<FileItem> {
		if (kind === 'note') {
			this.dispatchEditorFlush();
			return this.createNew(t('files.untitledFilename'), '', {
				focusEditor: true,
				origin: 'created',
				kind: 'note'
			});
		}
		if (kind === 'code') {
			const { CODE_LANGUAGES } = await import('./code/languages');
			const language =
				CODE_LANGUAGES.find((entry) => entry.id === options.language) ?? CODE_LANGUAGES[0]!;
			const suggested = `${stripMdExtension(t('files.untitledFilename'))}.${language.extensions[0] ?? 'txt'}`;
			const raw = options.name?.trim() || suggested;
			const name = /\.[a-z0-9]+$/i.test(raw) ? raw : `${raw}.${language.extensions[0] ?? 'txt'}`;
			const content = language.id === 'json' || language.id === 'jsonc' ? '{}\n' : '';
			this.dispatchEditorFlush();
			return this.createNew(name, content, {
				focusEditor: true,
				origin: 'created',
				kind: 'code'
			});
		}
		const { createDeck, serializePresentation } = await import('./presentation/model');
		this.dispatchEditorFlush();
		return this.createNew(t('slides.newPresentationName'), serializePresentation(createDeck()), {
			origin: 'created',
			kind: 'presentation'
		});
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
				const image = isImageExtension(file.name);
				const pdf = isPdfExtension(file.name);
				const markdown = isMarkdownExtension(file.name);
				const code = isCodeExtension(file.name);
				if (!image && !pdf && !markdown && !code) {
					session.skip();
					continue;
				}
				if (image || pdf) {
					try {
						session.reserve(file.size);
						const data = await readDataUrl(
							file,
							IMPORT_LIMITS.maxFileBytes,
							session.options.signal
						);
						const mime = pdf ? 'application/pdf' : file.type || imageMimeForName(file.name);
						created.push(
							this.createNew(file.name, '', {
								origin: 'imported',
								kind: pdf ? 'pdf' : 'image',
								mime,
								data
							})
						);
						session.accept();
					} catch {
						if (!session.cancelled) session.fail(file.name, 'read');
					}
					continue;
				}
				const content = await session.read(file);
				if (content === null) continue;
				const matches = [...this.files, ...this.closedFiles].filter(
					(known) => known.linkedToDisk && known.name === file.name && known.content === content
				);
				if (matches.length === 1) {
					const existing = matches[0]!;
					if (this.closedFiles.includes(existing)) await this.openDocument(existing.id);
					else this.setActive(existing.id);
					created.push(existing);
					session.accept();
					continue;
				}
				created.push(
					this.createNew(file.name, content, {
						origin: 'imported',
						kind: code ? 'code' : documentKind(content)
					})
				);
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
		this.rememberActive();
		this.activeId = id;
		this.persistActiveId();
	}

	/** Records the document that is about to lose the active state. */
	private rememberActive(): void {
		this.activeHistory = rememberActiveTab(this.activeHistory, this.activeId);
	}

	/**
	 * Shows the start view without closing a tab or clearing the library. The
	 * open files stay available, and pending edits flush first.
	 */
	showHome(): void {
		this.dispatchEditorFlush();
		this.activeId = null;
		this.persistActiveId();
	}

	navigateFile(direction: 1 | -1): void {
		const nextId = cycleOpenTab(
			this.files.map((file) => file.id),
			this.activeId,
			direction
		);
		if (nextId) this.setActive(nextId);
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
			this.activeId = nextActiveAfterDetach(
				this.files.map((entry) => entry.id),
				this.activeHistory,
				id,
				{ id, index: idx }
			);
			this.persistActiveId();
		}
		if (this.selectedIds.has(id)) {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- replace the state with a fresh Set
			const next = new Set(this.selectedIds);
			next.delete(id);
			this.selectedIds = next;
		}
		// The file can stay in the library (a closed tab keeps its index entries).
		// Callers that remove it completely invalidate the meta index after removal.
		return { file, index: idx };
	}

	close(id: string, opts: { trash?: boolean; keepDB?: boolean } = {}): void {
		if (opts.trash === true) {
			this.delete(id);
			return;
		}
		this.dispatchEditorFlush();
		const detached = this.detachFromView(id);
		if (!detached) return;
		this.closedFiles.push(detached.file);
		this.saveQueue.persist(this.capturedDraftRow(detached.file, detached.index, false));
	}

	/** Moves a document to the durable trash. This is distinct from closing a tab. */
	delete(id: string): void {
		const candidate =
			this.files.find((file) => file.id === id) ?? this.closedFiles.find((file) => file.id === id);
		if (candidate?.contentDeferred) {
			void this.deleteAfterHydration(id);
			return;
		}
		this.deleteLoaded(id);
	}

	private async deleteAfterHydration(id: string): Promise<void> {
		const hydrated = await this.hydrateContent(id);
		if (hydrated) this.deleteLoaded(id);
	}

	private deleteLoaded(id: string): void {
		if (this.trashBusy) return;
		this.dispatchEditorFlush();
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
			this.capturedDraftRow(file, order, false),
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
		this.documents.forget(id);
		this.savedRevisions.delete(id);
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
			await this.ensureContent([...requested]);
			const trashedAt = Date.now();
			const entries = this.library.flatMap((file, order) =>
				requested.has(file.id) ? [{ file: { ...file }, order, trashedAt }] : []
			);
			if (entries.length === 0) return;
			const result = await moveManyToTrash(
				entries.map((entry) => ({
					id: entry.file.id,
					file: this.capturedDraftRow(entry.file, entry.order, false),
					order: entry.order,
					trashedAt
				}))
			);
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- Local operation result.
			const removed = new Set<string>();
			const currentFiles = new Map(this.library.map((file) => [file.id, file]));
			for (const { file } of entries) {
				this.documentSnapshot(file.id);
				const current = currentFiles.get(file.id);
				if (current && (current.content !== file.content || current.name !== file.name)) {
					// Keep an edit made during the transaction as a live document beside its trash copy.
					this.saveQueue.persist(
						this.capturedDraftRow(
							current,
							this.library.indexOf(current),
							this.files.includes(current)
						)
					);
					this.notifyCrossTabConflict(t('files.otherTabChanges'));
					continue;
				}
				removed.add(file.id);
				this.saveQueue.discard(file.id);
				this.documents.forget(file.id);
				this.savedRevisions.delete(file.id);
			}
			const nextActiveId = nextActiveAfterRemoval(
				this.files.map((file) => file.id),
				this.activeId,
				removed
			);
			this.files = this.files.filter((file) => !removed.has(file.id));
			this.closedFiles = this.closedFiles.filter((file) => !removed.has(file.id));
			this.selectedIds = new Set([...this.selectedIds].filter((id) => !removed.has(id)));
			this.renderAllowedIds = this.renderAllowedIds.filter((id) => !removed.has(id));
			if (this.activeId && removed.has(this.activeId)) {
				this.activeId = nextActiveId;
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
			}
			// A bulk removal is cheaper to index from scratch than per file.
			this.metaIndex.invalidateBacklinksIndex();
		});
	}

	/** Reopens a durable document without creating a new copy. */
	reopen(id: string): FileItem | null {
		const idx = this.closedFiles.findIndex((file) => file.id === id);
		if (idx === -1) return null;
		const file = this.closedFiles[idx]!;
		// A deferred body cannot move into the editor synchronously. Start the
		// read and let `openClosedDocument` reopen it when the exact text is in
		// memory.
		if (file.contentDeferred) {
			void this.openClosedDocument(id);
			return null;
		}
		this.closedFiles.splice(idx, 1);
		this.rememberActive();
		this.files.push(file);
		this.activeId = file.id;
		this.persistActiveId();
		this.metaIndex.invalidateMeta(id);
		this.saveQueue.persist(this.capturedDraftRow(file, this.files.length - 1, true));
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
			const closed = closedIndex >= 0 ? this.closedFiles[closedIndex]! : null;
			const item = closed ?? {
				id: r.id,
				name: r.name,
				content: r.content,
				...(r.projectId ? { projectId: r.projectId, relativePath: r.relativePath } : {}),
				...(r.origin ? { origin: r.origin } : {}),
				...(r.sourceFileId ? { sourceFileId: r.sourceFileId } : {}),
				...(r.kind ? { kind: r.kind } : {}),
				...(r.mime ? { mime: r.mime } : {}),
				...(r.data ? { data: r.data } : {}),
				createdAt: r.createdAt,
				updatedAt: r.updatedAt,
				dirty: false,
				linkedToDisk: false
			};
			if (closed) {
				if (closed.contentDeferred) {
					// The workspace row is the exact durable body.
					closed.content = r.content;
					if (r.data) closed.data = r.data;
					else delete closed.data;
					closed.name = r.name;
					closed.updatedAt = r.updatedAt;
					closed.contentDeferred = false;
				}
				this.closedFiles.splice(closedIndex, 1);
			}
			this.files.push(item);
			existing.add(r.id);
			this.saveQueue.persist(this.capturedDraftRow(item, this.files.length - 1, true));
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
		const nextIds = reorderedOpenIds(
			this.files.map((file) => file.id),
			orderedIds
		);
		if (!nextIds) return;
		const byId = new Map(this.files.map((file) => [file.id, file]));
		this.files = nextIds.map((id) => byId.get(id)!);
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
		this.rememberActive();
		this.files.splice(insertAt, 0, restored);
		this.activeId = restored.id;
		this.persistActiveId();
		this.metaIndex.invalidateMeta(restored.id);
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
				this.capturedDraftRow(restored, insertAt),
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
			if (this.activeId === null) {
				this.activeId = id;
				this.persistActiveId();
			}
		} else if (!wasOpen && !this.closedFiles.some((entry) => entry.id === id)) {
			this.closedFiles.push(file);
			this.metaIndex.invalidateMeta(id);
		}
		this.saveQueue.persist(this.capturedDraftRow(file, idx, wasOpen));
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

	documentRevision(id: string): DocumentRevision | null {
		const file = this.library.find((entry) => entry.id === id);
		return file ? this.documents.open(id, file.content) : null;
	}

	documentSnapshot(id: string): DocumentSnapshot | null {
		if (!this.documentRevision(id)) return null;
		const snapshot = this.documents.flush(id);
		if (!snapshot) throw new Error('document-snapshot-superseded');
		return snapshot;
	}

	isDocumentRevisionCurrent(revision: DocumentRevision): boolean {
		return (
			this.library.some((file) => file.id === revision.fileId) && this.documents.isCurrent(revision)
		);
	}

	savedDocumentRevision(id: string): DocumentRevision | null {
		return this.savedRevisions.get(id) ?? null;
	}

	applyDocumentChange(change: DocumentChange): DocumentRevision | null {
		const file = this.library.find((entry) => entry.id === change.base.fileId);
		if (!file) return null;
		const revision = this.documents.apply(change);
		if (!revision) return null;
		file.updatedAt = Date.now();
		file.dirty = true;
		this.metaIndex.invalidateMeta(file.id);
		this.scheduleSave(file.id);
		return revision;
	}

	queueEditorContent(id: string, content: string): void {
		const base = this.documentRevision(id);
		if (!base || this.documents.snapshot(id)?.text === content) return;
		this.applyDocumentChange({ base, edits: { kind: 'text' }, readText: () => content });
	}

	updateContent(id: string, content: string): void {
		const file = this.library.find((entry) => entry.id === id);
		if (!file || file.content === content) return;
		if (file.contentDeferred) {
			// Callers that transform a body must hydrate it first. Refuse the
			// write instead of replacing the durable text with a placeholder.
			void this.hydrateContent(id);
			return;
		}
		this.queueEditorContent(id, content);
		this.documents.flush(id);
	}

	async rename(id: string, name: string): Promise<boolean> {
		this.dispatchEditorFlush();
		const file = this.files.find((f) => f.id === id);
		if (!file) return Promise.resolve(false);
		if (file.projectId && file.relativePath) {
			return import('./projects').then(({ renameProjectDocument }) =>
				renameProjectDocument(id, name)
			);
		}
		const normalized = normalizeRename(name, file.name);
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
		// Link repair scans every note. Large closed bodies must be exact before
		// the plan decides which documents change.
		if (this.library.some((entry) => entry.contentDeferred)) await this.ensureLibraryContent();
		const plan = () => {
			const oldTarget = stripMdExtension(file.name).toLowerCase();
			const nextTarget = stripMdExtension(normalized);
			const rewrite = (content: string) =>
				rewriteWikiLinkTargets(content, (target) =>
					target.toLowerCase() === oldTarget ? nextTarget : target
				);
			const changes =
				documentKindForFile(file) === 'note' &&
				this.metaIndex.wikiLinkCandidates(oldTarget).length === 1
					? this.library.flatMap((entry) =>
							documentKindForFile(entry) !== 'note' || rewrite(entry.content) === entry.content
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
			if (current.linkedToDisk) {
				const { renameOnDisk } = await import('./disk-sync');
				if (!(await renameOnDisk(id, normalized, this.diskDeps))) return false;
			}

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
		this.documents.flushAll();
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
				this.documents.forget(row.id);
				this.savedRevisions.delete(row.id);
				existing.updatedAt = changed ? Date.now() : row.updatedAt;
				if (row.projectId) existing.projectId = row.projectId;
				else delete existing.projectId;
				if (row.relativePath) existing.relativePath = row.relativePath;
				else delete existing.relativePath;
				existing.contentDeferred = false;
				existing.dirty = true;
			} else if (row.open === false) this.closedFiles.push({ ...row, dirty: false });
			else this.files.push({ ...row, dirty: false });
			this.saveQueue.invalidate(row.id);
			this.saveQueue.trackPersisted(row);
			if (changed) this.scheduleSave(row.id);
			else applied.push(row.id);
		}
		for (const row of rows) this.metaIndex.invalidateMeta(row.id);
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
		if (file.contentDeferred) {
			// A metadata-only item must not rewrite the durable body with the
			// empty placeholder. Update only the fields that changed.
			void db.drafts
				.update(id, { name, updatedAt: file.updatedAt })
				.catch((error) => reportPersistenceError(error, 'save'));
			return;
		}
		if (this.closedFiles.includes(file))
			this.saveQueue.persist(this.capturedDraftRow(file, this.files.length, false));
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
		if (this.active) void this.export(this.active.id);
	}
	async export(id: string): Promise<void> {
		this.dispatchEditorFlush();
		await this.ensureContent([id]);
		exportMarkdownOp(id, this.exportDeps);
	}
	async exportAll(): Promise<void> {
		this.dispatchEditorFlush();
		await this.ensureLibraryContent();
		return exportAllZipOp(this.exportDeps);
	}
	async exportOpen(): Promise<void> {
		this.dispatchEditorFlush();
		return exportAllZipOp({ ...this.exportDeps, getFiles: () => this.files });
	}
	async exportHTML(id: string): Promise<void> {
		this.dispatchEditorFlush();
		await this.ensureContent([id]);
		return exportHTMLOp(id, this.exportDeps);
	}
	async exportActiveHTML(): Promise<void> {
		if (this.active) await this.exportHTML(this.active.id);
	}
	async exportPDF(id: string): Promise<void> {
		this.dispatchEditorFlush();
		await this.ensureContent([id]);
		return exportPDFOp(id, this.exportDeps);
	}
	async exportActivePDF(): Promise<void> {
		if (this.active) await this.exportPDF(this.active.id);
	}
	async exportSelectedZip(): Promise<void> {
		this.dispatchEditorFlush();
		await this.ensureContent([...this.selectedIds]);
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
		const reordered = [...this.files];
		const moved = reordered.splice(fromIdx, 1)[0]!;
		reordered.splice(toIdx, 0, moved);
		this.files = reordered;
		const orderedIds = this.files.map((f) => f.id);
		this.saveQueue.flushPending(orderedIds, (id) => {
			const file = this.files.find((f) => f.id === id);
			if (!file) return null;
			return this.capturedDraftRow(file, this.files.indexOf(file));
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
			getFile: (id: string) => {
				this.documentSnapshot(id);
				return this.library.find((f) => f.id === id);
			},
			getFiles: () => [...this.files, ...this.closedFiles],
			onActivate: (id: string) => {
				if (this.closedFiles.some((file) => file.id === id)) void this.openDocument(id);
				else this.setActive(id);
			},
			onCreate: (name: string, content: string) =>
				this.createNew(name, content, { origin: 'imported' }),
			onSyncName: (id: string, name: string) => this.syncDiskName(id, name),
			onUpdateContent: (id: string, content: string) => {
				this.documents.forget(id);
				this.savedRevisions.delete(id);
				this.updateContent(id, content);
			},
			scheduleSave: (id: string) => this.scheduleSave(id),
			onImportRollback: (id: string) => {
				this.documents.forget(id);
				this.savedRevisions.delete(id);
				this.detachFromView(id);
				this.saveQueue.discard(id);
				this.metaIndex.invalidateMeta(id);
			}
		};
	}

	async openFromDisk(options: ImportOptions = {}): Promise<FileItem[]> {
		const configured = this.beginImport(options);
		try {
			const { openFromDisk } = await import('./disk-sync');
			return await openFromDisk(this.diskDeps, configured);
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
			const { openPathsFromDesktop } = await import('./disk-sync');
			const result = await openPathsFromDesktop(grants, this.diskDeps, configured);
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
			for (const file of files) this.createNew(file.name, file.content, { origin: 'imported' });
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
			const { openDirectoryFromDisk } = await import('./disk-sync');
			const files = await openDirectoryFromDisk(this.diskDeps, configured);
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
	async loadDemo(): Promise<FileItem[]> {
		const { DEMO_DOCS } = await import('./demo-doc');
		const created = DEMO_DOCS.map((doc) =>
			this.createNew(doc.name, doc.content, { origin: 'created' })
		);
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
		this.dispatchEditorFlush();
		if (scope === 'library' && this.library.some((file) => file.contentDeferred))
			await this.ensureLibraryContent();
		const slices = (scope === 'library' ? this.library : this.files)
			.filter((file) => documentKindForFile(file) === 'note')
			.map((f) => ({
				id: f.id,
				name: f.name,
				content: f.content,
				revision: this.documentRevision(f.id)!
			}));
		const { replaceInFilesAsync } = await import('./replace-worker');
		const { results, total, regexError } = await replaceInFilesAsync(
			slices,
			query,
			replacement,
			opts
		);
		if (regexError) return { files: 0, occurrences: 0, regexError };
		const unchanged = () => {
			this.dispatchEditorFlush();
			return results.every((result) => {
				const before = slices.find((file) => file.id === result.id);
				const current = this.library.find((file) => file.id === result.id);

				return (
					before &&
					current &&
					this.isDocumentRevisionCurrent(before.revision) &&
					before.content === current.content &&
					before.name === current.name
				);
			});
		};
		if (!unchanged()) return { files: 0, occurrences: 0, regexError: t('files.otherTabChanges') };
		await createCheckpoints(
			slices.filter((file) => results.some((result) => result.id === file.id))
		);
		if (!unchanged()) return { files: 0, occurrences: 0, regexError: t('files.otherTabChanges') };
		for (const r of results) this.updateContent(r.id, r.content);
		return { files: results.length, occurrences: total, regexError: null };
	}

	async restoreVersion(id: string, content: string): Promise<boolean> {
		this.dispatchEditorFlush();
		const file = this.files.find((entry) => entry.id === id);
		if (!file || file.content === content) return false;
		const before = { id: file.id, name: file.name, content: file.content };
		const revision = this.documentRevision(id)!;
		await createCheckpoint(before);
		this.dispatchEditorFlush();
		const current = this.files.find((entry) => entry.id === id);
		if (
			!this.isDocumentRevisionCurrent(revision) ||
			current !== file ||
			current.content !== before.content ||
			current.name !== before.name
		) {
			throw new Error(t('files.otherTabChanges'));
		}
		this.updateContent(id, content);
		return true;
	}
	/**
	 * Saves the active document. A linked original receives the content through
	 * its granted disk link. Every other document is downloaded as a copy. The
	 * action never claims a disk write for an unlinked document.
	 */
	async saveActive(): Promise<boolean> {
		if (!browser || !this.active) return false;
		const active = this.active;
		if (active.linkedToDisk && isDiskLinkingAvailable()) return this.saveToDisk(active.id);
		this.dispatchEditorFlush();
		await exportMarkdownOp(active.id, this.exportDeps);
		return true;
	}

	async saveActiveToDisk(): Promise<boolean> {
		if (!browser || !this.active) return false;
		return this.saveToDisk(this.active.id);
	}
	async saveToDisk(id: string): Promise<boolean> {
		this.dispatchEditorFlush();
		return this.queueDiskOperation(id, async () => {
			const { saveToDisk } = await import('./disk-sync');
			return saveToDisk(id, this.diskDeps);
		});
	}

	/**
	 * Saves a copy to a new target. The source link and its revision stay
	 * unchanged. Without a disk backend, the copy becomes a download.
	 */
	async saveAs(id: string): Promise<boolean> {
		const file = this.library.find((entry) => entry.id === id);
		if (!browser || !file) return false;
		this.dispatchEditorFlush();
		if (!isDiskLinkingAvailable()) {
			await exportMarkdownOp(id, this.exportDeps);
			notify.info(t('disk.downloadedCopy', { name: file.name }));
			return true;
		}
		return this.queueDiskOperation(id, async () => {
			const { saveAsToDisk } = await import('./disk-sync');
			return saveAsToDisk(id, this.diskDeps);
		});
	}
	async saveActiveAs(): Promise<boolean> {
		if (!browser || !this.active) return false;
		return this.saveAs(this.active.id);
	}

	/** Creates a detached copy of `id`. The copy has no disk link. */
	editCopy(id: string): FileItem | null {
		const source = this.library.find((entry) => entry.id === id);
		if (!source) return null;
		this.dispatchEditorFlush();
		const extension = source.name.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? '';
		const base = stripMdExtension(source.name);
		const copy = this.createNew(`${base} ${t('files.copySuffix')}${extension}`, source.content, {
			origin: 'imported',
			...(source.kind ? { kind: source.kind } : {}),
			...(source.mime ? { mime: source.mime } : {}),
			...(source.data ? { data: source.data } : {}),
			sourceFileId: source.id
		});
		notify.info(t('files.copyCreated', { name: copy.name }));
		return copy;
	}

	/**
	 * Opens the linked original of a copy. Without a stored original, the user
	 * can pick the file again when a disk backend is available.
	 */
	async editOriginal(id: string): Promise<boolean> {
		const file = this.library.find((entry) => entry.id === id);
		if (!browser || !file) return false;
		if (file.linkedToDisk) {
			notify.info(t('files.alreadyOriginal', { name: file.name }));
			return true;
		}
		const original = file.sourceFileId
			? this.library.find((entry) => entry.id === file.sourceFileId)
			: undefined;
		if (original) {
			this.openDocument(original.id);
			notify.info(t('files.originalOpened', { name: original.name }));
			return true;
		}
		if (!isDiskLinkingAvailable()) {
			notify.info(t('files.editOriginalUnavailable'));
			return false;
		}
		const opened = await this.openFromDisk();
		return opened.length > 0;
	}
	async unlinkFromDisk(id: string): Promise<void> {
		return this.queueDiskOperation(id, async () => {
			const { unlinkFromDisk } = await import('./disk-sync');
			return unlinkFromDisk(id, this.diskDeps);
		});
	}
	async refreshBrokenLinks(): Promise<void> {
		const { refreshBrokenLinks } = await import('./disk-sync');
		return refreshBrokenLinks(this.files, (id) => this.files.find((f) => f.id === id));
	}

	// ─── MetaIndex (delegation → meta-index.ts) ──────────────────────────────

	/** Front-matter tags of file `id`. */
	getTags(id: string): string[] {
		void this.metaRev;
		return this.metaIndex.getTags(id);
	}
	/** All unique tags of the corpus, sorted alphabetically. */
	get allTags(): string[] {
		void this.metaRev;
		return this.metaIndex.allTags;
	}
	/** Title: front-matter `title` > first H1 (if FM present) > filename without extension. */
	displayTitle(id: string): string {
		void this.metaRev;
		return this.metaIndex.displayTitle(id);
	}
	documentTitle(id: string): string {
		void this.metaRev;
		return this.metaIndex.documentTitle(id);
	}
	/** Files that contain a wiki-link pointing to `targetId`. */
	backlinks(targetId: string): FileItem[] {
		void this.metaRev;
		return this.metaIndex.backlinks(targetId);
	}
	/** Resolves a wiki-link → file id, or `null` if not found. */
	resolveWikiLink(target: string, sourceId?: string): string | null {
		void this.metaRev;
		return this.metaIndex.resolveWikiLink(target, sourceId);
	}
	/**
	 * Opens a wiki-link target: activates the existing file, or creates a new one
	 * (Obsidian behavior). Returns the resolved/created id.
	 */
	openWikiLink(target: string, sourceId?: string): string | null {
		const source = this.library.find((file) => file.id === sourceId);
		if (source && documentKindForFile(source) !== 'note') return null;
		if (source?.projectId) {
			const matches = this.metaIndex.wikiLinkCandidates(target, sourceId);
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
		void this.metaRev;
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
