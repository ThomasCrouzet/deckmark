// Local diagnostic surface for the retained source of the library.
//
// The store loads this module on demand so the boot graph keeps only the
// lifecycle and the counters. The probe reads the store state and never touches
// storage. Every value is a logical count; none of them is a heap measurement.

import {
	utf16Bytes,
	type DocumentMemoryCounters,
	type DocumentMemorySubsystem,
	type DocumentState
} from './document-memory';

/** Owner order for the report. The probe is lazy, so this array is not in boot. */
const MEMORY_SUBSYSTEMS: readonly DocumentMemorySubsystem[] = [
	'fileItem',
	'revisions',
	'saveQueue',
	'metaIndex',
	'metadataWorker'
];

/** One document as the probe reads it. No source text is copied. */
export interface DocumentMemorySample {
	id: string;
	name: string;
	contentDeferred: boolean;
	dirty: boolean;
	active: boolean;
	pinned: boolean;
	pending: boolean;
	chars: Record<DocumentMemorySubsystem, number>;
}

export interface DocumentMemoryProbeSource {
	budgetBytes: number;
	counters: () => DocumentMemoryCounters;
	samples: () => DocumentMemorySample[];
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
	retained: Record<DocumentMemorySubsystem, { chars: number; bytes: number; documents: number }>;
	total: { chars: number; bytes: number };
	counters: DocumentMemoryCounters;
	heap: { usedJSHeapSize: number | null; totalJSHeapSize: number | null };
	documents: DocumentMemoryEntry[];
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

function stateOf(sample: DocumentMemorySample): DocumentState {
	if (sample.contentDeferred) return 'deferred';
	if (sample.active) return 'active';
	if (sample.pinned) return 'pinned';
	if (sample.pending) return 'pending';
	return 'durable';
}

function entryOf(sample: DocumentMemorySample): DocumentMemoryEntry {
	const chars = { ...sample.chars };
	const bytes = Object.fromEntries(
		MEMORY_SUBSYSTEMS.map((subsystem) => [subsystem, utf16Bytes(chars[subsystem])])
	) as Record<DocumentMemorySubsystem, number>;
	return {
		id: sample.id,
		name: sample.name,
		state: stateOf(sample),
		contentDeferred: sample.contentDeferred,
		dirty: sample.dirty,
		evictable: !sample.active && !sample.contentDeferred && !sample.pinned && !sample.pending,
		logicalChars: chars.fileItem,
		owners: MEMORY_SUBSYSTEMS.filter((subsystem) => chars[subsystem] > 0),
		chars,
		bytes
	};
}

function report(source: DocumentMemoryProbeSource): DocumentMemoryStats {
	const retained = Object.fromEntries(
		MEMORY_SUBSYSTEMS.map((subsystem) => [subsystem, { chars: 0, bytes: 0, documents: 0 }])
	) as DocumentMemoryStats['retained'];
	const documents = source.samples().map(entryOf);
	for (const document of documents) {
		for (const subsystem of MEMORY_SUBSYSTEMS) {
			if (document.chars[subsystem] > 0) retained[subsystem].documents += 1;
			retained[subsystem].chars += document.chars[subsystem];
			retained[subsystem].bytes += document.bytes[subsystem];
		}
	}
	const total = { chars: 0, bytes: 0 };
	for (const subsystem of MEMORY_SUBSYSTEMS) {
		total.chars += retained[subsystem].chars;
		total.bytes += retained[subsystem].bytes;
	}
	return {
		budgetBytes: source.budgetBytes,
		retained,
		total,
		counters: { ...source.counters() },
		heap: readHeap(),
		documents
	};
}

export function installDocumentMemoryProbe(source: DocumentMemoryProbeSource): void {
	if (typeof window === 'undefined') return;
	(
		window as unknown as { __MDSH_DOCUMENT_MEMORY__?: { stats: () => DocumentMemoryStats } }
	).__MDSH_DOCUMENT_MEMORY__ = {
		stats: () => report(source)
	};
}
