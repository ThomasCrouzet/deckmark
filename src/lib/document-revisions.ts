import type { ChangeSet, EditorState } from '@codemirror/state';
import type { Transaction } from '@milkdown/kit/prose/state';
import { createSourceEditFromChanges, type SourceEdit } from './source-edit';

/** One changed range in an accepted source, with its replacement text. */
export interface DocumentEditSpan {
	readonly from: number;
	readonly to: number;
	readonly insert: string;
}

export interface DocumentRevision {
	readonly fileId: string;
	readonly generation: number;
}

export interface DocumentSnapshot {
	readonly revision: DocumentRevision;
	readonly text: string;
}

export type DocumentEdits =
	| { readonly kind: 'text' }
	| { readonly kind: 'codemirror'; readonly changes: ChangeSet; readonly state: EditorState }
	| { readonly kind: 'prosemirror'; readonly transaction: Transaction }
	| { readonly kind: 'structured'; readonly operations: readonly unknown[] }
	/** A rendered publication that carries its accepted span and revision. */
	| { readonly kind: 'source-edit'; readonly edit: SourceEdit };

export interface DocumentChange {
	readonly base: DocumentRevision;
	readonly edits: DocumentEdits;
	/** Capture immutable state, not a later read of the mounted editor. */
	readonly readText: () => string;
}

interface Entry {
	revision: DocumentRevision;
	/** Revision of the text in `lastText` and of the first pending change. */
	baseRevision: DocumentRevision;
	read: () => string;
	snapshot: DocumentSnapshot | null;
	/** Latest accepted producer span for this revision. */
	edit: SourceEdit | null;
	/** Accepted CodeMirror change set for the latest revision. */
	changes?: ChangeSet | null;
	pending: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	/** Last materialized or opened text. It is the base for the next record. */
	lastText: string;
	/** Accepted CodeMirror changes since `baseRevision`. */
	pendingChanges: ChangeSet[];
	lastKind: DocumentEdits['kind'];
}

interface RevisionProbeRecord {
	fileId: string;
	baseGeneration: number;
	generation: number;
	kind: SourceEdit['kind'];
	space: SourceEdit['space'];
	previousFrom: number;
	previousTo: number;
	nextFrom: number;
	nextTo: number;
	previousLength: number | null;
	nextLength: number | null;
	exact: boolean | null;
}

// A removed or replaced document must never make an old handle current again.
let generation = 0;
const METRICS = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';
const DELAY = 100;
const PROBE_LIMIT = 100;

// The instrumented build exposes one record per materialized accepted edit.
// The probe stays inert in a normal build and does not change accepted bytes.
const probeRecords: RevisionProbeRecord[] = [];
if (METRICS && typeof window !== 'undefined') {
	(
		window as unknown as {
			__MDSH_REVISION_CONTRACT__?: {
				records: RevisionProbeRecord[];
				clear: () => void;
			};
		}
	).__MDSH_REVISION_CONTRACT__ = {
		records: probeRecords,
		clear: () => {
			probeRecords.length = 0;
		}
	};
}

function exactLocalSpan(edit: SourceEdit): boolean | null {
	if (edit.space !== 'portable-source' || edit.kind === 'full') return null;
	const previousLength = edit.previousLength;
	const nextLength = edit.nextLength;
	if (previousLength === undefined || nextLength === undefined) return null;
	const previousWidth = edit.previous.to - edit.previous.from;
	const nextWidth = edit.next.to - edit.next.from;
	return (
		edit.previous.from >= 0 &&
		edit.previous.to >= edit.previous.from &&
		edit.previous.to <= previousLength &&
		edit.next.from >= 0 &&
		edit.next.to >= edit.next.from &&
		edit.next.to <= nextLength &&
		previousLength - previousWidth + nextWidth === nextLength
	);
}

function recordProbe(edit: SourceEdit, baseGeneration: number): void {
	if (!METRICS) return;
	if (probeRecords.length >= PROBE_LIMIT) probeRecords.shift();
	probeRecords.push({
		fileId: edit.documentId,
		baseGeneration: edit.baseRevision ?? baseGeneration,
		generation: edit.revision,
		kind: edit.kind,
		space: edit.space,
		previousFrom: edit.previous.from,
		previousTo: edit.previous.to,
		nextFrom: edit.next.from,
		nextTo: edit.next.to,
		previousLength: edit.previousLength ?? null,
		nextLength: edit.nextLength ?? null,
		exact: exactLocalSpan(edit)
	});
}

export class DocumentRevisions {
	private entries = new Map<string, Entry>();

	constructor(
		private publish: (snapshot: DocumentSnapshot) => void,
		private fail: (error: unknown) => void
	) {}

	open(fileId: string, text: string): DocumentRevision {
		const current = this.entries.get(fileId);
		if (current) return current.revision;
		const revision = { fileId, generation: ++generation };
		this.entries.set(fileId, {
			revision,
			baseRevision: revision,
			read: () => text,
			snapshot: { revision, text },
			edit: null,
			pending: false,
			timer: null,
			lastText: text,
			pendingChanges: [],
			lastKind: 'text'
		});
		return revision;
	}

	isCurrent(revision: DocumentRevision): boolean {
		return this.entries.get(revision.fileId)?.revision.generation === revision.generation;
	}

	/** Latest accepted producer span, or null after a plain text change. */
	edit(fileId: string): SourceEdit | null {
		return this.entries.get(fileId)?.edit ?? null;
	}

	/** Latest accepted CodeMirror change set of this file. */
	editChanges(fileId: string): ChangeSet | null {
		return this.entries.get(fileId)?.changes ?? null;
	}

	apply(change: DocumentChange): DocumentRevision | null {
		if (!this.isCurrent(change.base)) return null;
		const entry = this.entries.get(change.base.fileId)!;
		entry.revision = { fileId: change.base.fileId, generation: ++generation };
		entry.read = change.readText;
		entry.snapshot = null;
		entry.edit = change.edits.kind === 'source-edit' ? change.edits.edit : null;
		entry.changes = change.edits.kind === 'codemirror' ? change.edits.changes : null;
		entry.pending = true;
		entry.lastKind = change.edits.kind;
		if (change.edits.kind === 'codemirror') entry.pendingChanges.push(change.edits.changes);
		else entry.pendingChanges = [];
		if (METRICS) performance.mark('mdsh:document-edit');
		entry.timer ??= setTimeout(() => {
			entry.timer = null;
			try {
				this.flush(change.base.fileId);
			} catch (error) {
				this.fail(error);
			}
		}, DELAY);
		return entry.revision;
	}

	snapshot(fileId: string): DocumentSnapshot | null {
		const entry = this.entries.get(fileId);
		if (!entry) return null;
		if (entry.snapshot) return entry.snapshot;
		const revision = entry.revision;
		const started = METRICS ? performance.now() : 0;
		const text = entry.read();
		if (METRICS)
			performance.measure('mdsh:document-serialization', {
				start: started,
				end: performance.now()
			});
		if (!this.isCurrent(revision)) return null;
		if (entry.pendingChanges.length) {
			const edit = createSourceEditFromChanges(
				revision.fileId,
				revision.generation,
				entry.baseRevision.generation,
				entry.pendingChanges,
				entry.lastText.length,
				text.length
			);
			if (edit) entry.edit = edit;
		}
		if (entry.edit) recordProbe(entry.edit, entry.baseRevision.generation);
		const snapshot = { revision, text };
		entry.snapshot = snapshot;
		entry.read = () => text;
		entry.lastText = text;
		entry.baseRevision = revision;
		entry.pendingChanges = [];
		return snapshot;
	}

	flush(fileId: string): DocumentSnapshot | null {
		const entry = this.entries.get(fileId);
		if (!entry) return null;
		if (entry.timer !== null) clearTimeout(entry.timer);
		entry.timer = null;
		const snapshot = this.snapshot(fileId);
		if (!snapshot || !entry.pending || !this.isCurrent(snapshot.revision)) return snapshot;
		const started = METRICS ? performance.now() : 0;
		this.publish(snapshot);
		if (METRICS)
			performance.measure('mdsh:document-derived', { start: started, end: performance.now() });
		if (this.isCurrent(snapshot.revision)) entry.pending = false;
		if (METRICS && entry.edit) {
			try {
				const at = performance.now();
				performance.measure('mdsh:derived-edit', {
					start: at,
					end: at,
					detail: {
						id: fileId,
						revision: entry.edit.revision,
						space: entry.edit.space,
						kind: entry.edit.kind
					}
				});
			} catch {
				// Diagnostics must not change the publication.
			}
		}
		return snapshot;
	}

	flushAll(): void {
		for (const fileId of this.entries.keys()) {
			if (!this.flush(fileId) && this.entries.has(fileId)) {
				throw new Error('document-snapshot-superseded');
			}
		}
	}

	forget(fileId: string): void {
		const entry = this.entries.get(fileId);
		if (entry?.timer != null) clearTimeout(entry.timer);
		this.entries.delete(fileId);
	}

	clear(): void {
		for (const fileId of this.entries.keys()) this.forget(fileId);
	}
}
