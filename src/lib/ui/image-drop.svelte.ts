// §P2.4 - Module managing the drag & drop of local images.
//
// Pure logic with no $effect - no factory needed.
// `dragOver` stays in the parent component (template reactive state).
//
// Logic extracted from `+page.svelte` (L63-112, L697-742).

import { isMarkdownFile } from '#lib/file-utils.js';
import { t } from '#lib/i18n/index.js';
import { notify } from '#lib/notify.svelte.js';
import { reportWarning } from '#lib/report.js';
import { MAX_IMAGE_BYTES } from '#lib/config.js';

// §B5.1 - Guard limit for dropped images: beyond it, we skip the file
// (with a console warn). A 2 MB image in base64 makes ~2.7 MB of
// markdown - already big but editable. Beyond that, editing perf degrades
// heavily (every keystroke re-reads this blob via Dexie).
export { MAX_IMAGE_BYTES };

export function fileToDataUri(file: File): Promise<string | null> {
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(file);
	});
}

export interface ImageDropStore {
	active: { id: string; content: string; projectId?: string; relativePath?: string } | null;
	createNew: (name: string) => void;
	updateContent: (id: string, content: string) => void;
	// Import summary: `created` (files created), `skipped` (non-markdown entries
	// ignored), `failed` (markdowns that became unreadable). We depend only on
	// the counters (not the exact type of the created FileItems) to stay
	// decoupled from the store - we now use these counters for user feedback.
	importFiles: (
		files: FileList | File[]
	) => Promise<{ created: unknown[]; skipped: number; failed: number }>;
}

/**
 * §B5.1 - Inserts one or more dropped images as data: URIs at the end of the
 * active file (`![alt](data:image/...;base64,...)`). If no file is open,
 * one is created. Portability stays total: the markdown is self-contained
 * (ZIP / HTML / PDF export includes the images without anything special).
 * Trade-off: data URIs bloat the markdown (+33 % base64) - hence the
 * MAX_IMAGE_BYTES guard.
 */
export async function appendImagesToActive(images: File[], store: ImageDropStore): Promise<void> {
	if (images.length === 0) return;
	if (!store.active) {
		store.createNew('Images.md');
	}
	if (typeof window !== 'undefined') {
		window.dispatchEvent(new Event('mdsh:flush-editor'));
	}
	const active = store.active;
	if (!active) return;
	// Image decoding is needed only after a drop, not at application startup.
	const media = await import('#lib/render/image-media.js').catch((error: unknown) => {
		reportWarning('load image decoder', error);
		notify.error(t('imageDrop.unreadable', { n: images.length }));
		return null;
	});
	if (!media) return;
	const { embedImageFile, ImageFileError } = media;

	const blocks: string[] = [];
	const tooLarge: string[] = [];
	let unreadable = 0;
	for (const img of images) {
		if (img.size > MAX_IMAGE_BYTES) {
			tooLarge.push(img.name);
			reportWarning(
				`image "${img.name}" skipped`,
				`size ${(img.size / 1024).toFixed(0)} KB > ${MAX_IMAGE_BYTES / 1024} KB`
			);
			continue;
		}
		let embedded;
		try {
			embedded = await embedImageFile(img);
		} catch (error) {
			if (error instanceof ImageFileError && error.code === 'too-large') {
				tooLarge.push(img.name);
			} else {
				unreadable++;
			}
			reportWarning(`image "${img.name}" skipped`, error);
			continue;
		}
		if (!embedded.dataUri) {
			unreadable++;
			continue;
		}
		// Strip markdown-significant chars so a hostile filename cannot break
		// the `![alt](url)` token shape (integrity; final HTML is still sanitized).
		const rawAlt = img.name.replace(/\.[^.]+$/, '');
		const alt =
			rawAlt
				.replace(/[\r\n[\]()!]/g, '')
				.trim()
				.slice(0, 80) || 'image';
		let source = embedded.dataUri;
		if (active.projectId && active.relativePath) {
			try {
				const [{ addProjectImage }, { relativeDestination }] = await Promise.all([
					import('#lib/projects.js'),
					import('#lib/project-paths.js')
				]);
				source = relativeDestination(
					active.relativePath,
					await addProjectImage(active.projectId, img)
				);
			} catch (error) {
				unreadable++;
				reportWarning('project image write', error);
				continue;
			}
		}
		blocks.push(`![${alt || embedded.alt || 'image'}](${source})`);
	}

	// §#6 - User feedback on skipped images (before the possible early
	// return): dropping an image that is too large / unreadable must not be a
	// silent non-event.
	const limitMb = (MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(0);
	if (tooLarge.length === 1) {
		notify.error(t('imageDrop.tooLargeOne', { name: tooLarge[0]!, limitMb }));
	} else if (tooLarge.length > 1) {
		notify.error(t('imageDrop.tooLargeMany', { n: tooLarge.length, limitMb }));
	}
	if (unreadable > 0) {
		notify.error(t('imageDrop.unreadable', { n: unreadable }));
	}

	if (blocks.length === 0) return;

	const sep = active.content.endsWith('\n') ? '\n' : '\n\n';
	const newContent = active.content + sep + blocks.join('\n\n') + '\n';
	store.updateContent(active.id, newContent);
}

// Window-level drag & drop must react ONLY to files coming from the OS.
// Without this filter, internal drags (Milkdown blocks via BlockEdit, tab
// reordering in Sidebar) bubble up to window and trigger the import
// overlay, which eats the events and breaks the internal drop. The
// `'Files'` marker in dataTransfer.types is set by the browser only for OS
// file drags; internal drags set `'text/plain'`, `'text/html'`, etc.
export function isFilesDrag(e: DragEvent): boolean {
	return e.dataTransfer?.types?.includes('Files') ?? false;
}

export interface ImageDropHandlers {
	handleDrop: (e: DragEvent) => Promise<void>;
	handleDragOver: (e: DragEvent) => void;
	handleDragLeave: (e: DragEvent) => void;
}

/**
 * Builds the drag & drop handlers from the injected callbacks.
 * `setDragOver` lets the parent component update its reactive state.
 */
export function buildDropHandlers(opts: {
	store: ImageDropStore;
	setDragOver: (v: boolean) => void;
}): ImageDropHandlers {
	async function handleDrop(e: DragEvent): Promise<void> {
		if (!isFilesDrag(e)) return;
		e.preventDefault();
		opts.setDragOver(false);
		const files = e.dataTransfer?.files;
		if (!files || files.length === 0) return;

		// §B5.1 - Routing by type: images are inserted as data URIs into the
		// active file, markdowns create new files. A mixed drop handles both
		// streams; files that are neither image nor markdown are ignored (cf.
		// `importFiles` which already filters on the store side). We handle
		// markdowns first so the import establishes an active file if we
		// started from the Welcome screen - the following images will append
		// to it naturally.
		const markdowns: File[] = [];
		const images: File[] = [];
		for (const f of Array.from(files)) {
			if (f.type.startsWith('image/')) images.push(f);
			else if (isMarkdownFile(f)) markdowns.push(f);
		}
		// §#6 - We capture the import summary to distinguish a markdown that
		// became unreadable (read rejected) from a drop with no recognized markdown.
		let created = 0;
		let failed = 0;
		if (markdowns.length > 0) {
			const counts = await opts.store.importFiles(markdowns);
			created = counts.created.length;
			failed = counts.failed;
		}
		if (images.length > 0) await appendImagesToActive(images, opts.store);
		if (failed > 0) {
			notify.error(t('imageDrop.markdownUnreadable', { n: failed }));
		}
		// §#6 - Files were dropped but none is markdown or image (.pdf, .docx,
		// binary…), or the only detected markdowns turned out to be unreadable:
		// a drop with no feedback looks like a bug. We notify instead of
		// ignoring silently.
		if (created === 0 && failed === 0 && images.length === 0) {
			notify.info(t('imageDrop.noMarkdown'));
		}
	}

	function handleDragOver(e: DragEvent): void {
		if (!isFilesDrag(e)) return;
		e.preventDefault();
		opts.setDragOver(true);
	}

	function handleDragLeave(e: DragEvent): void {
		// Reset if the target leaves the window entirely (relatedTarget === null).
		// No Files filter here: if dragOver was never set, it is a no-op.
		if (e.relatedTarget === null) opts.setDragOver(false);
	}

	return { handleDrop, handleDragOver, handleDragLeave };
}
