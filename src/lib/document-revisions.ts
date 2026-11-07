import type { ChangeSet, EditorState } from '@codemirror/state';
import type { Transaction } from '@milkdown/kit/prose/state';
import { measureEditorStage } from './editor-perf';
import { reportError } from './report';

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
	| { readonly kind: 'structured'; readonly operations: readonly unknown[] };

export interface DocumentChange {
	readonly base: DocumentRevision;
	readonly edits: DocumentEdits;
	/** Capture immutable state, not a later read of the mounted editor. */
	readonly readText: () => string;
}

interface Entry {
	revision: DocumentRevision;
	readText: () => string;
	snapshot: DocumentSnapshot | null;
	pending: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}

// Do not reuse a generation after removal, reload, or a new scheduler instance.
let generation = 0;
const PUBLICATION_DELAY_MS = 100;

export class DocumentRevisions {
	private entries = new Map<string, Entry>();

	constructor(
		private publish: (snapshot: DocumentSnapshot) => void,
		private onError: (error: unknown) => void = (error) => reportError('document snapshot', error)
	) {}

	open(fileId: string, text: string): DocumentRevision {
		const existing = this.entries.get(fileId);
		if (existing) return existing.revision;
		const revision = Object.freeze({ fileId, generation: ++generation });
		this.entries.set(fileId, {
			revision,
			readText: () => text,
			snapshot: Object.freeze({ revision, text }),
			pending: false,
			timer: null
		});
		return revision;
	}

	isCurrent(revision: DocumentRevision): boolean {
		return this.entries.get(revision.fileId)?.revision.generation === revision.generation;
	}

	apply(change: DocumentChange): DocumentRevision | null {
		return measureEditorStage('documentEdit', () => {
			if (!this.isCurrent(change.base)) return null;
			const entry = this.entries.get(change.base.fileId)!;
			entry.revision = Object.freeze({ fileId: change.base.fileId, generation: ++generation });
			entry.readText = change.readText;
			entry.snapshot = null;
			entry.pending = true;
			// A fixed window coalesces work without starving continuous input.
			entry.timer ??= setTimeout(() => {
				entry.timer = null;
				try {
					this.flush(change.base.fileId);
				} catch (error) {
					this.onError(error);
				}
			}, PUBLICATION_DELAY_MS);
			return entry.revision;
		});
	}

	snapshot(fileId: string): DocumentSnapshot | null {
		const entry = this.entries.get(fileId);
		if (!entry) return null;
		if (entry.snapshot) return entry.snapshot;
		const revision = entry.revision;
		const text = measureEditorStage('documentSerialization', entry.readText);
		if (!this.isCurrent(revision)) return null;
		const snapshot = Object.freeze({ revision, text });
		entry.snapshot = snapshot;
		entry.readText = () => text;
		return snapshot;
	}

	flush(fileId: string): DocumentSnapshot | null {
		const entry = this.entries.get(fileId);
		if (!entry) return null;
		if (entry.timer !== null) clearTimeout(entry.timer);
		entry.timer = null;
		const snapshot = this.snapshot(fileId);
		if (!snapshot || !entry.pending || !this.isCurrent(snapshot.revision)) return snapshot;
		measureEditorStage('documentDerived', () => this.publish(snapshot));
		if (this.isCurrent(snapshot.revision)) entry.pending = false;
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
		if (entry?.timer !== null && entry?.timer !== undefined) clearTimeout(entry.timer);
		this.entries.delete(fileId);
	}

	clear(): void {
		for (const fileId of this.entries.keys()) this.forget(fileId);
	}
}
