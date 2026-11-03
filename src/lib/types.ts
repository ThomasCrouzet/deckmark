export type EditMode = 'wysiwyg' | 'source' | 'read';

export interface FileItem {
	id: string;
	name: string;
	content: string;
	projectId?: string;
	relativePath?: string;
	createdAt: number;
	updatedAt: number;
	dirty: boolean;
	/** Explicit document type. Missing means derive it from the name and content. */
	kind?: 'note' | 'presentation' | 'code' | 'image';
	/** MIME type for binary image documents. */
	mime?: string;
	/** Data URL for binary image documents. Content stays empty. */
	data?: string;
	/** How the document first entered the library. */
	origin?: 'created' | 'imported' | 'template';
	linkedToDisk?: boolean;
	// "Broken disk link" flag - true if an FSA handle was associated but is no
	// longer resolvable (file deleted/moved, IDB purged…). Managed by
	// `filesStore.refreshBrokenLinks()` on load and by `saveActiveToDisk` when a
	// write fails. Reset to false when the link is restored.
	brokenLink?: boolean;
	// §C2 - Anti-overwrite disk guard: `lastModified` (and size) of the disk file
	// at the time of the last read/write by mdsh. Before rewriting the file, we
	// re-read the `File` and compare: if the disk changed outside the app (cloud
	// sync, git, another editor), we don't silently overwrite it. `undefined`
	// as long as the file has never been linked to disk.
	diskLastModified?: number | undefined;
	diskSize?: number | undefined;
	/** Content-addressed revision returned by the native disk boundary. */
	diskRevision?: string | undefined;
}

export interface TrashedFile {
	file: FileItem;
	order: number;
	trashedAt: number;
}

export interface Hit {
	fileId: string;
	name: string;
	line: number;
	snippet: string;
	matchStart: number;
	matchEnd: number;
}
