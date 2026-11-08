// Centralized constants - values shared between store, components and renderers.
// Grouped here to ease tuning (and future configurability).

export const EDITOR = {
	defaultWidth: 820,
	minWidth: 480,
	margin: 96,
	widthPresets: {
		prose: 720,
		narrow: 640,
		pdf: 'pdf',
		medium: 820,
		wide: 1100,
		full: 9999
	}
} as const;

export const TIMERS = {
	saveDebounceMs: 400,
	trashUndoMs: 5000,
	trashRetentionMs: 30 * 24 * 60 * 60 * 1000,
	printIframeLoadMs: 3000,
	printIframeCleanupMs: 60_000
} as const;

export const READING = {
	wpm: 220
} as const;

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const IMPORT_LIMITS = {
	maxFileBytes: 16 * 1024 * 1024,
	maxBatchBytes: 64 * 1024 * 1024,
	maxFiles: 300,
	maxDepth: 8,
	largeDocumentChars: 256 * 1024
} as const;

/**
 * Closed documents keep their metadata in memory. Their body stays in Dexie
 * above these limits, and an operation that needs it reads it on demand.
 */
export const DRAFT_CONTENT = {
	/** A single closed document that stays inline at startup. */
	maxInlineChars: IMPORT_LIMITS.largeDocumentChars,
	/** Total closed body characters kept inline for a library. */
	closedBudgetChars: 8 * 1024 * 1024
} as const;

export const BACKUP_LIMITS = {
	maxDocuments: 3000,
	maxWorkspaces: 300,
	maxWorkspaceReferences: 300,
	maxTotalWorkspaceReferences: 3000
} as const;
