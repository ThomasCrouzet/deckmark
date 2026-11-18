// Retained source ownership for one document lifecycle.
//
// A document moves through these states:
//   active    - open in the editor.
//   pending   - a local edit, a debounce timer or a failed write holds it.
//   pinned    - an export, backup, search, AI, history or project operation
//               holds the source.
//   durable   - the exact source is in IndexedDB and no operation holds it.
//   deferred  - the body is in IndexedDB and the store keeps only derived
//               metadata.
//
// Disk dirtiness is not a memory pin. A document that still needs a disk save
// can release its body after a proven local write, because the durable row is
// the source of truth and the disk flag stays on the item.
//
// Every size here is a logical count. `utf16Bytes` is the JavaScript string
// allocation unit count. These numbers are not a heap measurement.

export type DocumentMemorySubsystem =
	'fileItem' | 'revisions' | 'saveQueue' | 'metaIndex' | 'metadataWorker';

export type DocumentState = 'active' | 'pending' | 'pinned' | 'durable' | 'deferred';

export type PinOwner = 'export' | 'history' | 'backup' | 'search' | 'ai' | 'project' | 'operation';

export const MEMORY_SUBSYSTEMS: readonly DocumentMemorySubsystem[] = [
	'fileItem',
	'revisions',
	'saveQueue',
	'metaIndex',
	'metadataWorker'
];

/**
 * Byte budgets for retained source. A body budget of 2 MiB keeps active work
 * small on a memory-constrained device. The Worker budget holds one large
 * baseline for the note in use and drops older ones.
 */
export const DOCUMENT_MEMORY = {
	closedBodyBytes: 2 * 1024 * 1024,
	metadataBaselineBytes: 16 * 1024 * 1024,
	metadataBaselineEntries: 64
} as const;

/** JavaScript strings are UTF-16 code unit sequences. */
export function utf16Bytes(chars: number): number {
	return chars * 2;
}

export interface DocumentMemoryCounters {
	evictions: number;
	rehydrations: number;
	hydrationMsTotal: number;
	hydrationMsMax: number;
	bodyReleases: number;
	revisionReleases: number;
	baselineReleases: number;
	metadataReleases: number;
	workerReleases: number;
	pinAcquires: number;
}

export interface DocumentMemoryAmount {
	chars: number;
	bytes: number;
	documents: number;
}

export interface DocumentMemoryEntry {
	id: string;
	name: string;
	state: DocumentState;
	contentDeferred: boolean;
	dirty: boolean;
	evictable: boolean;
	logicalChars: number;
	owners: DocumentMemorySubsystem[];
	chars: Record<DocumentMemorySubsystem, number>;
	bytes: Record<DocumentMemorySubsystem, number>;
}

export interface DocumentMemoryStats {
	budgetBytes: number;
	retained: Record<DocumentMemorySubsystem, DocumentMemoryAmount>;
	total: { chars: number; bytes: number };
	counters: DocumentMemoryCounters;
	heap: { usedJSHeapSize: number | null; totalJSHeapSize: number | null };
	documents: DocumentMemoryEntry[];
}

/** Explicit pin ownership. A pin blocks every eviction of that document. */
export class DocumentPins {
	private readonly owned = new Map<string, Map<PinOwner, number>>();

	/** Returns an idempotent release function. */
	pin(id: string, owner: PinOwner): () => void {
		const owners = this.owned.get(id) ?? new Map<PinOwner, number>();
		owners.set(owner, (owners.get(owner) ?? 0) + 1);
		this.owned.set(id, owners);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const current = this.owned.get(id);
			if (!current) return;
			const count = (current.get(owner) ?? 1) - 1;
			if (count <= 0) current.delete(owner);
			else current.set(owner, count);
			if (current.size === 0) this.owned.delete(id);
		};
	}

	pinAll(ids: readonly string[], owner: PinOwner): () => void {
		const releases = ids.map((id) => this.pin(id, owner));
		let released = false;
		return () => {
			if (released) return;
			released = true;
			for (const release of releases) release();
		};
	}

	isPinned(id: string): boolean {
		return this.owned.has(id);
	}

	ownersOf(id: string): PinOwner[] {
		return [...(this.owned.get(id)?.keys() ?? [])];
	}

	counts(): Record<PinOwner, number> {
		const counts: Record<PinOwner, number> = {
			export: 0,
			history: 0,
			backup: 0,
			search: 0,
			ai: 0,
			project: 0,
			operation: 0
		};
		for (const owners of this.owned.values()) {
			for (const owner of owners.keys()) counts[owner] += 1;
		}
		return counts;
	}

	clear(): void {
		this.owned.clear();
	}
}

/** Counters and pins for the retained source of the library. */
export class DocumentMemory {
	readonly pins = new DocumentPins();
	readonly counters: DocumentMemoryCounters = {
		evictions: 0,
		rehydrations: 0,
		hydrationMsTotal: 0,
		hydrationMsMax: 0,
		bodyReleases: 0,
		revisionReleases: 0,
		baselineReleases: 0,
		metadataReleases: 0,
		workerReleases: 0,
		pinAcquires: 0
	};

	pin(owner: PinOwner, ids: readonly string[]): () => void {
		this.counters.pinAcquires += ids.length;
		return this.pins.pinAll(ids, owner);
	}

	recordEviction(chars: number): void {
		this.counters.evictions += 1;
		this.counters.bodyReleases += chars;
	}

	recordHydration(durationMs: number): void {
		this.counters.rehydrations += 1;
		this.counters.hydrationMsTotal += durationMs;
		if (durationMs > this.counters.hydrationMsMax) this.counters.hydrationMsMax = durationMs;
	}

	recordRelease(subsystem: Exclude<DocumentMemorySubsystem, 'fileItem'>): void {
		if (subsystem === 'revisions') this.counters.revisionReleases += 1;
		else if (subsystem === 'saveQueue') this.counters.baselineReleases += 1;
		else if (subsystem === 'metaIndex') this.counters.metadataReleases += 1;
		else this.counters.workerReleases += 1;
	}

	clear(): void {
		this.pins.clear();
	}
}

interface HeapMemory {
	usedJSHeapSize: number;
	totalJSHeapSize: number;
}

function readHeap(): DocumentMemoryStats['heap'] {
	const memory = (performance as Performance & { memory?: HeapMemory }).memory;
	if (!memory) return { usedJSHeapSize: null, totalJSHeapSize: null };
	return {
		usedJSHeapSize: memory.usedJSHeapSize,
		totalJSHeapSize: memory.totalJSHeapSize
	};
}

/** Test and diagnostics entry point. Local runs only; it reads no storage. */
export function installDocumentMemoryProbe(read: () => Omit<DocumentMemoryStats, 'heap'>): void {
	if (typeof window === 'undefined') return;
	(
		window as unknown as { __MDSH_DOCUMENT_MEMORY__?: { stats: () => DocumentMemoryStats } }
	).__MDSH_DOCUMENT_MEMORY__ = {
		stats: () => ({ ...read(), heap: readHeap() })
	};
}
