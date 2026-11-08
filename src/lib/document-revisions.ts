import type { ChangeSet, EditorState } from '@codemirror/state';
import type { Transaction } from '@milkdown/kit/prose/state';

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
	read: () => string;
	snapshot: DocumentSnapshot | null;
	pending: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}

// A removed or replaced document must never make an old handle current again.
let generation = 0;
const METRICS = import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1';
const DELAY = 100;

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
			read: () => text,
			snapshot: { revision, text },
			pending: false,
			timer: null
		});
		return revision;
	}

	isCurrent(revision: DocumentRevision): boolean {
		return this.entries.get(revision.fileId)?.revision.generation === revision.generation;
	}

	apply(change: DocumentChange): DocumentRevision | null {
		if (!this.isCurrent(change.base)) return null;
		const entry = this.entries.get(change.base.fileId)!;
		entry.revision = { fileId: change.base.fileId, generation: ++generation };
		entry.read = change.readText;
		entry.snapshot = null;
		entry.pending = true;
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
		const snapshot = { revision, text };
		entry.snapshot = snapshot;
		entry.read = () => text;
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
