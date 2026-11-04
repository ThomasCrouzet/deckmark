import { IS_DESKTOP_EDITION } from './edition';

/**
 * Project scale limits. Web Light keeps bounded operations for its storage and
 * startup budgets. Desktop Complete raises the limits for large local repos.
 */
export const PROJECT_SCALE_LIMITS = IS_DESKTOP_EDITION
	? {
			maxDocuments: 3000,
			maxEntries: 6500,
			maxBytes: 256 * 1024 * 1024,
			maxDepth: 16,
			boundedFolderRows: 250
		}
	: {
			maxDocuments: 300,
			maxEntries: 1300,
			maxBytes: 64 * 1024 * 1024,
			maxDepth: 8,
			boundedFolderRows: 150
		};

export function projectDocumentLimit(): number {
	return PROJECT_SCALE_LIMITS.maxDocuments;
}
