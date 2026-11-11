<script lang="ts">
	// Milkdown Crepe wrapper.
	// Milkdown + its CSS themes + our `milkdown.css` override are loaded
	// dynamically on first mount - kept out of the initial bundle (~500 KiB
	// estimated savings on the page chunk). The first WYSIWYG mode opening
	// pays an extra ~150 ms of loading, while the read/source modes
	// (default for onboarding) become instant.

	import type { Crepe as CrepeType } from '@milkdown/crepe';
	import type { EditorView } from '@milkdown/kit/prose/view';
	import type { Transaction } from '@milkdown/kit/prose/state';
	import type { Slice } from '@milkdown/kit/prose/model';
	import { onDestroy, untrack } from 'svelte';
	import { renderMermaidPreview } from '../milkdown-mermaid-preview';
	import { reportError } from '#lib/report.js';
	import { i18n, t } from '#lib/i18n/index.js';
	import { blockEditLabels, toolbarLabels } from '#lib/editor-labels.js';
	import { notify } from '#lib/notify.svelte.js';
	import { filesStore } from '#lib/files.svelte.js';
	import {
		ImageMarkdownRoundTrip,
		normalizeImageTitlesForMilkdown
	} from '#lib/render/image-markdown.js';
	import { editorStateCache } from '#lib/editor-state.js';
	import { stripFrontmatter } from '#lib/frontmatter.js';
	import { SourceFidelity, type SourceFidelityHint } from '#lib/source-fidelity.js';
	import {
		createIncrementalMarkdown,
		updateIncrementalMarkdown,
		type IncrementalMarkdownState
	} from '#lib/markdown-incremental.js';
	import { themeStore } from '#lib/ui/theme.svelte.js';
	import { consumeEditorFocus } from '#lib/ui/editor-focus.js';
	import { documentKind } from '#lib/document-kind.js';
	import { editorDocumentPolicy } from '#lib/editor-document-policy.js';
	import { measureEditorStage, recordEditorCounter } from '#lib/editor-perf.js';
	import {
		localVisualPreview,
		releaseVisualPreviews,
		resolvedVisualPreview
	} from '../../image-block/visual-preview';

	interface Props {
		fileId: string;
		content: string;
		readonly?: boolean;
		onChange: (markdown: string, fileId: string) => void;
		// A switch can precede the asynchronous Markdown callback. Flush to the
		// captured outgoing file before the view is replaced.
		onFlush?: (fileId: string, markdown: string) => void;
	}

	let { fileId, content, readonly = false, onChange, onFlush }: Props = $props();

	let container: HTMLElement;
	let crepe: CrepeType | null = null;
	let restoreMountedMarkdown: ((markdown: string) => string) | null = null;
	let serializeMountedMarkdown: (() => string) | null = null;
	let imageObserver: MutationObserver | null = null;
	let imageResizeObserver: ResizeObserver | null = null;
	let loadError = $state(false);
	let retryVersion = $state(0);
	let mountToken = 0;
	let lastEditorMarkdown = '';
	let updateExternalContent: ((markdown: string) => Promise<void>) | null = null;
	let removeFlushListener: (() => void) | null = null;
	let removeHistoryListener: (() => void) | null = null;
	let cancelPendingMarkdown: (() => void) | null = null;
	let removeImageListeners: (() => void) | null = null;
	// One block hint from the latest incremental serialization. It is consumed
	// by the matching restore call and never survives a stale publish.
	let pendingHint: (SourceFidelityHint & { markdown: string }) | null = null;
	// §C1 - fileId associated with the currently mounted Crepe instance. Captured
	// at mount to correctly route a late keystroke (flush or asynchronous
	// `markdownUpdated`) to the right file even after a tab switch.
	let mountedFileId: string | null = null;
	let refreshMountedLocale: (() => void) | null = null;
	let saveMountedPosition: (() => void) | null = null;
	let refreshMountedDiagrams: (() => void) | null = null;

	// Safari and WKWebView can keep an editable content-visibility subtree blank
	// until a forced layout. Vendor is an engine-family gate, not a version
	// guess, so every Apple WebKit build keeps live blocks in the layout tree.
	const webkitEngine = typeof navigator !== 'undefined' && /Apple/i.test(navigator.vendor ?? '');
	// Paint containment and the caret plugin follow the rendered interaction
	// surface, not the encoded length of an embedded image. The source length
	// still bounds the render confirmation and the storage/import caps.
	const documentPolicy = $derived(editorDocumentPolicy(content));

	// These tokens can start a presentation marker, an escaped line or a framed
	// presentation element. A change that touches one of them must keep the full
	// note/presentation validation.
	const PRESENTATION_TOKENS = ['mdsh-presentation', 'mdsh-element', 'mdsh-literal'] as const;
	const STRUCTURAL_TOKENS = /[`~]|<!--|mdsh-/i;

	function includesPresentationToken(value: string): boolean {
		const lower = value.toLowerCase();
		return PRESENTATION_TOKENS.some((token) => lower.includes(token));
	}

	function touchesStructuralSyntax(value: string): boolean {
		return STRUCTURAL_TOKENS.test(value);
	}

	// Module cache: loaded on first call, reused afterwards.
	// CSS import order is critical: Crepe defaults -> frame-dark -> our overrides.
	let crepeModulePromise: Promise<typeof import('@milkdown/crepe')> | null = null;
	function loadCrepeModule(): Promise<typeof import('@milkdown/crepe')> {
		if (!crepeModulePromise) {
			crepeModulePromise = (async () => {
				await import('@milkdown/crepe/theme/common/style.css');
				await import('@milkdown/crepe/theme/frame-dark.css');
				await import('../milkdown.css');
				return import('@milkdown/crepe');
			})().catch((error) => {
				crepeModulePromise = null;
				throw error;
			});
		}
		return crepeModulePromise;
	}

	async function restoreEditorPosition(
		instance: CrepeType,
		id: string,
		token: number
	): Promise<void> {
		const position = editorStateCache.getPosition(id, 'wysiwyg');
		if (!position) return;
		try {
			const { editorViewCtx, TextSelection } = await import('#lib/milkdown-editor-plugins.js');
			if (token !== mountToken) return;
			const editorView = instance.editor.action((ctx) => ctx.get(editorViewCtx));
			const maxPosition = editorView.state.doc.content.size;
			const anchor = editorView.state.doc.resolve(Math.min(position.anchor, maxPosition));
			const head = editorView.state.doc.resolve(Math.min(position.head, maxPosition));
			const selection = TextSelection.between(anchor, head);
			editorView.dispatch(editorView.state.tr.setSelection(selection));
			requestAnimationFrame(() => {
				if (token === mountToken) container.scrollTop = position.scrollTop;
			});
		} catch (error) {
			reportError('visual editor position restore', error);
		}
	}

	async function mount(initial: string, token: number, idForMount: string) {
		if (!container) return;
		loadError = false;
		const [
			{ Crepe },
			{
				editorViewCtx,
				remarkCtx,
				parserCtx,
				serializerCtx,
				commandsCtx,
				Plugin,
				TextSelection,
				AddMarkStep,
				RemoveMarkStep,
				ReplaceStep,
				ReplaceAroundStep,
				isHistoryTransaction,
				Decoration,
				DecorationSet,
				prosePlugin,
				remarkPlugin,
				remarkPreserveEmptyLinePlugin,
				syncHeadingIdPlugin,
				incrementalHeadingIds,
				listener,
				linkTooltipConfig: linkTooltipConfigCtx,
				imageBlockConfig: imageBlockConfigCtx,
				inlineImageConfig: inlineImageConfigCtx,
				codeBlockConfig: codeBlockConfigCtx,
				wikiLinkPlugins,
				installTableBreaks,
				installTableParagraph,
				installTableClipboard,
				configureTableTextSelection,
				replaceAll,
				sinkListItem,
				liftListItem
			},
			{ editorImageSource, embedImageFile, ImageFileError, MAX_IMAGE_BYTES }
		] = await Promise.all([
			loadCrepeModule(),
			import('#lib/milkdown-editor-plugins.js'),
			import('#lib/render/image-media.js')
		]);
		if (token !== mountToken) return;
		// A note may not become a presentation while the visual editor holds it.
		// Ordinary text edits and safe block splits take this fast path. Paste,
		// history replacements and marker-bearing slices keep full validation.
		const couldAffectPresentationBoundary = (transaction: Transaction): boolean => {
			if (transaction.getMeta('uiEvent') === 'paste') return true;
			if (isHistoryTransaction(transaction)) return true;
			// A structural split or join can add or remove empty blocks. Only text
			// and HTML atoms can introduce a presentation delimiter, so inspect the
			// inserted slice instead of serializing the whole note.
			const safeSlice = (slice: Slice): boolean => {
				let safe = true;
				slice.content.descendants((node) => {
					if (node.isText) return;
					const value = node.attrs.value;
					if (
						node.type.name === 'html' &&
						typeof value === 'string' &&
						(includesPresentationToken(value) || touchesStructuralSyntax(value))
					) {
						safe = false;
						return;
					}
					if (includesPresentationToken(node.textContent)) safe = false;
				});
				if (!safe) return false;
				const text = slice.content.textBetween(0, slice.content.size, '\n', '\n');
				return !includesPresentationToken(text) && !touchesStructuralSyntax(text);
			};
			for (const [index, step] of transaction.steps.entries()) {
				if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) continue;
				// Milkdown updates heading IDs with setNodeMarkup after text input.
				// This wrapper-only step cannot introduce a presentation delimiter.
				if (
					step instanceof ReplaceAroundStep &&
					step.gapFrom === step.from + 1 &&
					step.gapTo === step.to - 1 &&
					step.insert === 1 &&
					step.slice.openStart === 0 &&
					step.slice.openEnd === 0 &&
					step.slice.content.childCount === 1 &&
					step.slice.content.firstChild?.type.name === 'heading' &&
					step.slice.content.firstChild.content.size === 0 &&
					transaction.docs[index]?.nodeAt(step.from)?.type.name === 'heading'
				)
					continue;
				if (!(step instanceof ReplaceStep) && !(step instanceof ReplaceAroundStep)) return true;
				if (!safeSlice(step.slice)) return true;
				const beforeDoc = transaction.docs[index] ?? transaction.before;
				const removed = step.to > step.from ? beforeDoc.textBetween(step.from, step.to, '\n') : '';
				if (touchesStructuralSyntax(removed)) return true;
			}
			const ranges: { from: number; to: number }[] = [];
			transaction.mapping.maps.forEach((map) => {
				map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
					ranges.push({ from: newStart, to: newEnd });
				});
			});
			const size = transaction.doc.content.size;
			for (const range of ranges) {
				for (const position of [range.from, range.to]) {
					const resolved = transaction.doc.resolve(Math.max(0, Math.min(position, size)));
					for (let depth = resolved.depth; depth >= 0; depth--) {
						const node = resolved.node(depth);
						if (!node.isTextblock && node.type.name !== 'html') continue;
						if (includesPresentationToken(node.textContent)) return true;
						const value = node.attrs.value;
						if (
							node.type.name === 'html' &&
							typeof value === 'string' &&
							touchesStructuralSyntax(value)
						)
							return true;
						break;
					}
				}
			}
			return false;
		};
		// Keep YAML outside the Markdown editor so it cannot become headings or links.
		let frontmatter = stripFrontmatter(initial);
		let roundTrip = new ImageMarkdownRoundTrip(frontmatter.content);
		let sourceMarkdown = initial;
		let editorBaseline: string | null = null;
		let fidelity: SourceFidelity | null = null;
		const restoreMarkdown = (markdown: string, commit = true) =>
			measureEditorStage('restoreMarkdown', () => {
				const hint =
					commit && pendingHint?.markdown === markdown
						? {
								previousFrom: pendingHint.previousFrom,
								previousTo: pendingHint.previousTo,
								nextFrom: pendingHint.nextFrom,
								nextTo: pendingHint.nextTo
							}
						: undefined;
				if (commit) pendingHint = null;
				if (editorBaseline === null || markdown === editorBaseline) return sourceMarkdown;
				const restored = roundTrip.restore(markdown, commit, hint);
				const restoredHint = roundTrip.lastScopedHint ?? hint;
				return frontmatter.raw + (fidelity?.restore(restored, commit, restoredHint) ?? restored);
			});
		lastEditorMarkdown = initial;
		let alternativesSignature = '';
		let imageFrame = 0;
		let needsImageMapping = false;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local non-reactive observer queues
		let pendingImages = new Set<HTMLImageElement>();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local non-reactive observer queues
		let pendingListNodes = new Set<Element>();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local non-reactive observer state
		let observedImageBlocks = new Set<HTMLElement>();
		let imageAlternatives = new WeakMap<HTMLImageElement, string>();
		const imageBlockWidths = new WeakMap<HTMLElement, number>();
		const imageIntrinsicSizes = new WeakMap<HTMLElement, string>();
		const scheduleImageWork = () => {
			if (imageFrame) return;
			imageFrame = requestAnimationFrame(() => {
				imageFrame = 0;
				flushImageWork();
			});
		};
		const observeImageBlock = (block: HTMLElement | null) => {
			if (!block || observedImageBlocks.has(block)) return;
			observedImageBlocks.add(block);
			imageResizeObserver?.observe(block);
		};
		const applyImageSize = (
			image: HTMLImageElement,
			block: HTMLElement | null,
			alt: string | undefined
		): {
			image: HTMLImageElement;
			block: HTMLElement | null;
			alt: string | undefined;
			width: string | null;
		} => {
			let width: string | null = null;
			if (block) {
				let blockWidth = imageBlockWidths.get(block);
				if (blockWidth === undefined) {
					blockWidth = block.clientWidth;
					imageBlockWidths.set(block, blockWidth);
				}
				if (image.naturalWidth && blockWidth) {
					const ratio = Number(image.dataset.height) / Number(image.dataset.origin) || 1;
					width = `${Math.min(image.naturalWidth, blockWidth) * ratio}px`;
				}
			}
			return { image, block, alt, width };
		};
		const writeImageSize = (update: {
			image: HTMLImageElement;
			block: HTMLElement | null;
			alt: string | undefined;
			width: string | null;
		}) => {
			const { image, block, alt, width } = update;
			if (alt !== undefined && image.alt !== alt) image.alt = alt;
			if (image.referrerPolicy !== 'no-referrer') image.referrerPolicy = 'no-referrer';
			if (image.crossOrigin !== 'anonymous') image.crossOrigin = 'anonymous';
			if (width === null) return;
			if (image.style.width !== width) image.style.width = width;
			// Offscreen blocks keep a stable intrinsic box from the measured
			// display width and aspect ratio. This replaces the generic 2.4em
			// estimate that is far too small for an image.
			if (block) {
				const measured = Number.parseFloat(width);
				const height = Number(image.dataset.height) || measured;
				const intrinsic = `auto ${Math.round(measured)}px ${Math.round(height)}px`;
				if (imageIntrinsicSizes.get(block) !== intrinsic) {
					block.style.setProperty('contain-intrinsic-size', intrinsic);
					imageIntrinsicSizes.set(block, intrinsic);
				}
			}
		};
		const fullImageScan = () => {
			const alternatives = roundTrip.alternatives;
			const images = [...container.querySelectorAll<HTMLImageElement>('.milkdown-image-block img')];
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local scan result
			const liveBlocks = new Set<HTMLElement>();
			for (const image of images) {
				const block = image.closest<HTMLElement>('.milkdown-image-block');
				if (block) liveBlocks.add(block);
			}
			for (const block of observedImageBlocks) {
				if (!liveBlocks.has(block)) {
					imageResizeObserver?.unobserve(block);
					observedImageBlocks.delete(block);
				}
			}
			imageAlternatives = new WeakMap();
			const next = images.map((image, index) => {
				const block = image.closest<HTMLElement>('.milkdown-image-block');
				observeImageBlock(block);
				const alt = alternatives[index] ?? '';
				imageAlternatives.set(image, alt);
				return applyImageSize(image, block, alt);
			});
			// Read every size before writing any style.
			for (const update of next) writeImageSize(update);
			alternativesSignature = alternatives.join('\u0000');
			needsImageMapping = false;
		};
		const applyListRolesIn = (node: Element) => {
			const items: Element[] = [];
			if (node.matches('.milkdown-list-item-block > li:not([role="none"])')) items.push(node);
			items.push(...node.querySelectorAll('.milkdown-list-item-block > li:not([role="none"])'));
			for (const item of items) {
				item.parentElement?.setAttribute('role', 'listitem');
				item.setAttribute('role', 'none');
			}
		};
		const flushImageWork = () => {
			for (const node of pendingListNodes) {
				if (node.isConnected) applyListRolesIn(node);
			}
			pendingListNodes = new Set();
			if (needsImageMapping) {
				fullImageScan();
				pendingImages = new Set();
				return;
			}
			const updates: {
				image: HTMLImageElement;
				block: HTMLElement | null;
				alt: string | undefined;
				width: string | null;
			}[] = [];
			for (const image of pendingImages) {
				if (!image.isConnected) continue;
				const block = image.closest<HTMLElement>('.milkdown-image-block');
				observeImageBlock(block);
				updates.push(applyImageSize(image, block, imageAlternatives.get(image)));
			}
			// Read every size before writing any style.
			for (const update of updates) writeImageSize(update);
			pendingImages = new Set();
		};
		const applyImageAlternatives = () => {
			const signature = roundTrip.alternatives.join('\u0000');
			if (signature === alternativesSignature) return;
			needsImageMapping = true;
			flushImageWork();
		};
		const collectImageNode = (node: Node): boolean => {
			if (node.nodeType !== Node.ELEMENT_NODE) return false;
			const element = node as Element;
			if (element.tagName === 'IMG') pendingImages.add(element as HTMLImageElement);
			for (const image of element.querySelectorAll<HTMLImageElement>('img'))
				pendingImages.add(image);
			if (element.matches('img') || element.querySelector('img')) return true;
			return false;
		};
		const collectListNodes = (node: Node): boolean => {
			if (node.nodeType !== Node.ELEMENT_NODE) return false;
			const element = node as Element;
			if (!element.matches('li, .milkdown-list-item-block') && !element.querySelector('li'))
				return false;
			pendingListNodes.add(element);
			return true;
		};
		// Milkdown emits markdownUpdated after its own 200 ms debounce. We own the
		// same delay so the emitted snapshot carries an exact applied revision.
		// Source fidelity runs when the main thread is idle, and a newer revision
		// cancels the older result before it can reach the store.
		let markdownRevision = 0;
		let markdownTimer: ReturnType<typeof setTimeout> | null = null;
		let idleHandle: number | null = null;
		let idleKind: 'idle' | 'timeout' | null = null;
		const cancelIdleWork = () => {
			if (idleHandle === null) return;
			if (idleKind === 'idle' && typeof window.cancelIdleCallback === 'function')
				window.cancelIdleCallback(idleHandle);
			else clearTimeout(idleHandle);
			idleHandle = null;
			idleKind = null;
		};
		const cancelPendingWork = () => {
			if (markdownTimer !== null) {
				clearTimeout(markdownTimer);
				markdownTimer = null;
			}
			cancelIdleWork();
		};
		const publishMarkdown = () => {
			const revision = markdownRevision;
			const emit = () => {
				if (token !== mountToken || revision !== markdownRevision) return;
				let markdown: string;
				try {
					markdown = serializeIncrementalMarkdown();
				} catch (error) {
					reportError('visual editor serialization', error);
					return;
				}
				if (token !== mountToken || revision !== markdownRevision) return;
				recordEditorCounter('markdownUpdated');
				const portableMarkdown = restoreMarkdown(markdown);
				if (token !== mountToken || revision !== markdownRevision) return;
				lastEditorMarkdown = portableMarkdown;
				queueMicrotask(applyImageAlternatives);
				if (token === mountToken) onChange(portableMarkdown, idForMount);
				else onFlush?.(idForMount, portableMarkdown);
			};
			if (typeof window.requestIdleCallback === 'function') {
				idleKind = 'idle';
				idleHandle = window.requestIdleCallback(
					() => {
						idleHandle = null;
						idleKind = null;
						emit();
					},
					{ timeout: 1_000 }
				);
			} else {
				idleKind = 'timeout';
				idleHandle = window.setTimeout(() => {
					idleHandle = null;
					idleKind = null;
					emit();
				}, 0) as unknown as number;
			}
		};
		const scheduleMarkdownUpdate = () => {
			cancelIdleWork();
			if (markdownTimer !== null) clearTimeout(markdownTimer);
			markdownTimer = setTimeout(() => {
				markdownTimer = null;
				publishMarkdown();
			}, 200);
		};
		cancelPendingMarkdown = cancelPendingWork;
		const blockEditConfig = blockEditLabels();
		const toolbarConfig = toolbarLabels();
		const linkTooltipConfig = { inputPlaceholder: t('editor.linkPlaceholder') };
		const imageBlockConfig = {
			blockUploadButton: t('editor.imageUpload'),
			inlineUploadButton: t('editor.imageUpload'),
			blockUploadPlaceholderText: t('editor.imageLinkPlaceholder'),
			inlineUploadPlaceholderText: t('editor.imageLinkPlaceholder'),
			blockCaptionPlaceholderText: t('editor.imageCaption'),
			blockConfirmButton: t('prompt.confirm'),
			inlineConfirmButton: t('prompt.confirm'),
			proxyDomURL: (source: string) => {
				recordEditorCounter('imageProxyCall');
				const local = localVisualPreview(source);
				if (local !== null) return local;
				return (async () => {
					const { projectContextFor, projectImageSource } = await import('#lib/project-media.js');
					try {
						const resolved = await projectImageSource(source, await projectContextFor(idForMount));
						return resolved ? resolvedVisualPreview(resolved) : editorImageSource(source);
					} catch {
						return editorImageSource(source);
					}
				})();
			},
			onUpload: async (file: File) => {
				try {
					const document = filesStore.library.find((document) => document.id === idForMount);
					if (document?.projectId && document.relativePath) {
						const [{ addProjectImage }, { relativeDestination }] = await Promise.all([
							import('#lib/projects.js'),
							import('#lib/project-paths.js')
						]);
						const path = await addProjectImage(document.projectId, file);
						const source = relativeDestination(document.relativePath, path);
						roundTrip.registerUpload(source, file.name.replace(/\.[^.]+$/, ''));
						return source;
					}
					const embedded = await embedImageFile(file);
					roundTrip.registerUpload(embedded.dataUri, embedded.alt);
					return embedded.dataUri;
				} catch (error) {
					const limitMb = String(MAX_IMAGE_BYTES / (1024 * 1024));
					if (error instanceof ImageFileError && error.code === 'too-large') {
						notify.error(t('imageDrop.tooLargeOne', { name: file.name, limitMb }));
					} else {
						notify.error(t('imageDrop.unreadable', { n: 1 }));
					}
					throw error;
				}
			},
			onImageLoadError: () => {
				notify.error(t('imageDrop.unreadable', { n: 1 }));
			}
		};
		const placeholderConfig = { text: t('editor.placeholder'), mode: 'block' as const };
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- nonreactive node-view callback registry
		const previews = new Map<
			Parameters<typeof renderMermaidPreview>[2],
			{ language: string; content: string }
		>();
		const codeMirrorConfig = {
			previewLabel: t('editor.previewLabel'),
			previewLoading: t('editor.previewLoading'),
			renderPreview: (...args: Parameters<typeof renderMermaidPreview>) => {
				const [language, content, apply] = args;
				if (language.toLowerCase() === 'mermaid') previews.set(apply, { language, content });
				else previews.delete(apply);
				return renderMermaidPreview(...args);
			}
		};
		const headingLevelPlugin = prosePlugin(
			() =>
				new Plugin({
					props: {
						decorations(state) {
							const head = state.selection.$head;
							for (let depth = head.depth; depth > 0; depth--) {
								const node = head.node(depth);
								if (node.type.name !== 'heading') continue;
								const level = node.attrs.level;
								if (typeof level !== 'number' || level < 1 || level > 6) break;
								const position = head.before(depth);
								return DecorationSet.create(state.doc, [
									Decoration.node(position, position + node.nodeSize, {
										class: 'mdsh-heading-level-active'
									})
								]);
							}
							return DecorationSet.empty;
						}
					}
				})
		);
		// Tab must indent the text at the caret. The browser default moves focus to
		// the next control instead, which can scroll the page to the end. Lists keep
		// their structural indent and tables keep their cell navigation.
		const tabIndentPlugin = prosePlugin(
			() =>
				new Plugin({
					props: {
						handleKeyDown(view: EditorView, event: KeyboardEvent) {
							if (
								event.key !== 'Tab' ||
								event.altKey ||
								event.ctrlKey ||
								event.metaKey ||
								event.isComposing ||
								!view.editable
							)
								return false;
							const selection = view.state.selection;
							const from = selection.$from;
							let inList = false;
							for (let depth = from.depth; depth > 0; depth--) {
								const name = from.node(depth).type.name;
								if (name === 'table' || name === 'code_block') return false;
								if (name === 'list_item') inList = true;
							}
							if (inList) {
								const listItem = view.state.schema.nodes.list_item;
								if (!listItem) return false;
								event.preventDefault();
								return (event.shiftKey ? liftListItem : sinkListItem)(listItem)(
									view.state,
									view.dispatch
								);
							}
							if (event.shiftKey) return false;
							event.preventDefault();
							view.dispatch(view.state.tr.insertText('\t').scrollIntoView());
							return true;
						}
					}
				})
		);
		const imageTitlePlugin = remarkPlugin(
			'mdshNormalizeImageTitles',
			() => () => normalizeImageTitlesForMilkdown
		);
		const noteTypePlugin = prosePlugin(
			(ctx) =>
				new Plugin({
					filterTransaction(transaction) {
						if (!transaction.docChanged) return true;
						return measureEditorStage('filterTransaction', () => {
							if (!couldAffectPresentationBoundary(transaction)) {
								recordEditorCounter('noteTypeFast');
								return true;
							}
							recordEditorCounter('noteTypeFallback');
							// Validate with a restore that does not commit its caches. A rejected
							// transaction must not leave source-fidelity or image state on a
							// document that the editor never applied.
							const markdown = restoreMarkdown(ctx.get(serializerCtx)(transaction.doc), false);
							if (documentKind(markdown) === 'note') return true;
							notify.error(t('documents.noConversion'));
							return false;
						});
					}
				})
		);
		const markdownRevisionPlugin = prosePlugin(
			() =>
				new Plugin({
					state: {
						init: () => markdownRevision,
						apply: (transaction) => {
							if (!transaction.docChanged) return markdownRevision;
							markdownRevision += 1;
							scheduleMarkdownUpdate();
							return markdownRevision;
						}
					}
				})
		);
		const initialPolicy = editorDocumentPolicy(initial);
		const instance = new Crepe({
			root: container,
			defaultValue: roundTrip.editorMarkdown,
			features: {
				[Crepe.Feature.CodeMirror]: true,
				[Crepe.Feature.ListItem]: true,
				[Crepe.Feature.LinkTooltip]: true,
				[Crepe.Feature.Cursor]: true,
				[Crepe.Feature.ImageBlock]: true,
				[Crepe.Feature.BlockEdit]: true,
				[Crepe.Feature.Placeholder]: true,
				[Crepe.Feature.Toolbar]: true,
				[Crepe.Feature.Table]: true,
				[Crepe.Feature.Latex]: true,
				[Crepe.Feature.TopBar]: false
			},
			featureConfigs: {
				[Crepe.Feature.Cursor]: { virtual: initialPolicy.virtualCursor },
				[Crepe.Feature.BlockEdit]: blockEditConfig,
				[Crepe.Feature.Toolbar]: toolbarConfig,
				[Crepe.Feature.LinkTooltip]: linkTooltipConfig,
				[Crepe.Feature.ImageBlock]: imageBlockConfig,
				[Crepe.Feature.Placeholder]: placeholderConfig,
				// Mermaid live-preview: we hook into the Crepe code-block's
				// `renderPreview` (cf. @milkdown/components/src/code-block/config.ts).
				// Latex already uses this hook (chained via `prev.renderPreview`);
				// the chain falls through to our function when the language is not
				// `latex` - where we filter `mermaid` and lazy-load the lib.
				[Crepe.Feature.CodeMirror]: codeMirrorConfig
			}
		});
		await instance.editor.remove(remarkPreserveEmptyLinePlugin);
		// The revision plugin owns publication. The unused listener serializes
		// the complete document during initialization even with no subscribers.
		await instance.editor.remove(listener);
		await instance.editor.remove(syncHeadingIdPlugin);
		instance.editor.use(incrementalHeadingIds);
		instance.editor.use(wikiLinkPlugins);
		installTableBreaks(instance.editor);
		installTableParagraph(instance.editor);
		installTableClipboard(instance.editor);
		await configureTableTextSelection(instance.editor);
		instance.editor.use(imageTitlePlugin);
		instance.editor.use(headingLevelPlugin);
		instance.editor.use(tabIndentPlugin);
		instance.editor.use(noteTypePlugin);
		instance.editor.use(markdownRevisionPlugin);
		instance.setReadonly(true);
		try {
			await instance.create();
		} catch (err) {
			if (token === mountToken) loadError = true;
			reportError('Crepe mount', err);
			await instance.destroy().catch(() => {});
			return;
		}
		if (token !== mountToken) {
			await instance.destroy().catch(() => {});
			return;
		}
		// Reuse unchanged ProseMirror blocks instead of walking the full document
		// on every publish. This keeps a keystroke in a multi-megabyte note from
		// waiting for a multi-second Milkdown serializer pass.
		let incrementalMarkdown: IncrementalMarkdownState | null = null;
		const resetIncrementalMarkdown = () => {
			return instance.editor.action((ctx) => {
				incrementalMarkdown = createIncrementalMarkdown(
					ctx.get(editorViewCtx).state.doc,
					ctx.get(serializerCtx)
				);
				return incrementalMarkdown.markdown;
			});
		};
		const serializeIncrementalMarkdown = (): string => {
			return instance.editor.action((ctx) => {
				const doc = ctx.get(editorViewCtx).state.doc;
				const serialize = ctx.get(serializerCtx);
				if (!incrementalMarkdown) {
					incrementalMarkdown = createIncrementalMarkdown(doc, serialize);
					pendingHint = null;
					return incrementalMarkdown.markdown;
				}
				const result = updateIncrementalMarkdown(incrementalMarkdown, doc, serialize);
				incrementalMarkdown = result.state;
				if (result.full) {
					pendingHint = null;
					recordEditorCounter('markdownIncrementalFallback');
				} else {
					recordEditorCounter('markdownIncrementalBlock');
					pendingHint = result.scope ? { ...result.scope, markdown: result.state.markdown } : null;
				}
				return result.state.markdown;
			});
		};
		editorBaseline = resetIncrementalMarkdown();
		serializeMountedMarkdown = serializeIncrementalMarkdown;
		const resetFidelity = () => {
			instance.editor.action((ctx) => {
				const remark = ctx.get(remarkCtx);
				const parser = ctx.get(parserCtx);
				const serializer = ctx.get(serializerCtx);
				fidelity = new SourceFidelity(
					frontmatter.content,
					roundTrip.restore(serializeIncrementalMarkdown()),
					(markdown) => remark.parse(markdown),
					(markdown) => {
						const images = new ImageMarkdownRoundTrip(markdown);
						return images.restore(serializer(parser(images.editorMarkdown)));
					}
				);
			});
		};
		resetFidelity();
		refreshMountedLocale = () => {
			const previousSlashGroups = [
				{
					label: blockEditConfig.textGroup.label,
					items: [
						blockEditConfig.textGroup.text.label,
						blockEditConfig.textGroup.h1.label,
						blockEditConfig.textGroup.h2.label,
						blockEditConfig.textGroup.h3.label,
						blockEditConfig.textGroup.h4.label,
						blockEditConfig.textGroup.h5.label,
						blockEditConfig.textGroup.h6.label,
						blockEditConfig.textGroup.quote.label,
						blockEditConfig.textGroup.divider.label
					]
				},
				{
					label: blockEditConfig.listGroup.label,
					items: [
						blockEditConfig.listGroup.bulletList.label,
						blockEditConfig.listGroup.orderedList.label,
						blockEditConfig.listGroup.taskList.label
					]
				},
				{
					label: blockEditConfig.advancedGroup.label,
					items: [
						blockEditConfig.advancedGroup.image.label,
						blockEditConfig.advancedGroup.codeBlock.label,
						blockEditConfig.advancedGroup.table.label,
						blockEditConfig.advancedGroup.math.label
					]
				}
			];
			Object.assign(blockEditConfig, blockEditLabels());
			const previousToolbarLabels = { ...toolbarConfig };
			Object.assign(toolbarConfig, toolbarLabels());
			linkTooltipConfig.inputPlaceholder = t('editor.linkPlaceholder');
			imageBlockConfig.blockUploadButton = t('editor.imageUpload');
			imageBlockConfig.inlineUploadButton = t('editor.imageUpload');
			imageBlockConfig.blockUploadPlaceholderText = t('editor.imageLinkPlaceholder');
			imageBlockConfig.inlineUploadPlaceholderText = t('editor.imageLinkPlaceholder');
			imageBlockConfig.blockCaptionPlaceholderText = t('editor.imageCaption');
			imageBlockConfig.blockConfirmButton = t('prompt.confirm');
			imageBlockConfig.inlineConfirmButton = t('prompt.confirm');
			placeholderConfig.text = t('editor.placeholder');
			codeMirrorConfig.previewLabel = t('editor.previewLabel');
			codeMirrorConfig.previewLoading = t('editor.previewLoading');

			// Crepe resolves feature options into Milkdown context objects during
			// creation. Mutate those objects so existing node views and future views
			// use the selected locale without replacing the editor instance.
			instance.editor.action((ctx) => {
				ctx.update(linkTooltipConfigCtx.key, (current) => {
					current.inputPlaceholder = linkTooltipConfig.inputPlaceholder;
					return current;
				});
				ctx.update(imageBlockConfigCtx.key, (current) => {
					current.uploadButton = imageBlockConfig.blockUploadButton;
					current.uploadPlaceholderText = imageBlockConfig.blockUploadPlaceholderText;
					current.captionPlaceholderText = imageBlockConfig.blockCaptionPlaceholderText;
					current.confirmButton = imageBlockConfig.blockConfirmButton;
					return current;
				});
				ctx.update(inlineImageConfigCtx.key, (current) => {
					current.uploadButton = imageBlockConfig.inlineUploadButton;
					current.uploadPlaceholderText = imageBlockConfig.inlineUploadPlaceholderText;
					current.confirmButton = imageBlockConfig.inlineConfirmButton;
					return current;
				});
				ctx.update(codeBlockConfigCtx.key, (current) => {
					current.previewLabel = codeMirrorConfig.previewLabel;
					current.previewLoading = codeMirrorConfig.previewLoading;
					return current;
				});
				// Crepe bundles its placeholder slice into the main package entry.
				// Resolve this internal slice by its stable context name.
				ctx.update('placeholderConfigCtx', (current: { text: string; mode: 'doc' | 'block' }) => {
					current.text = placeholderConfig.text;
					return current;
				});
				const editorView = ctx.get(editorViewCtx);
				editorView.dispatch(editorView.state.tr);
			});

			container
				.querySelector<HTMLElement>('.ProseMirror')
				?.setAttribute('aria-label', t('editor.ariaLabel'));
			container
				.querySelectorAll<HTMLElement>('[data-placeholder]')
				.forEach((element) => element.setAttribute('data-placeholder', placeholderConfig.text));

			const slashGroups = [
				{
					label: blockEditConfig.textGroup.label,
					items: [
						blockEditConfig.textGroup.text.label,
						blockEditConfig.textGroup.h1.label,
						blockEditConfig.textGroup.h2.label,
						blockEditConfig.textGroup.h3.label,
						blockEditConfig.textGroup.h4.label,
						blockEditConfig.textGroup.h5.label,
						blockEditConfig.textGroup.h6.label,
						blockEditConfig.textGroup.quote.label,
						blockEditConfig.textGroup.divider.label
					]
				},
				{
					label: blockEditConfig.listGroup.label,
					items: [
						blockEditConfig.listGroup.bulletList.label,
						blockEditConfig.listGroup.orderedList.label,
						blockEditConfig.listGroup.taskList.label
					]
				},
				{
					label: blockEditConfig.advancedGroup.label,
					items: [
						blockEditConfig.advancedGroup.image.label,
						blockEditConfig.advancedGroup.codeBlock.label,
						blockEditConfig.advancedGroup.table.label,
						blockEditConfig.advancedGroup.math.label
					]
				}
			];
			const slashLabels = slashGroups.flatMap((group) => group.items);
			const previousSlashLabels = previousSlashGroups.flatMap((group) => group.items);
			const groupTranslations = new Map(
				previousSlashGroups.map((group, index) => [group.label, slashGroups[index]?.label])
			);
			const itemTranslations = new Map(
				previousSlashLabels.map((label, index) => [label, slashLabels[index]])
			);
			container
				.querySelectorAll<HTMLElement>(
					'.milkdown-slash-menu .tab-group li, .milkdown-slash-menu .menu-group h6'
				)
				.forEach((element) => {
					const label = groupTranslations.get(element.textContent ?? '');
					if (label) element.textContent = label;
				});
			container
				.querySelectorAll<HTMLElement>('.milkdown-slash-menu [data-index] > span:last-child')
				.forEach((element) => {
					const label = itemTranslations.get(element.textContent ?? '');
					if (label) element.textContent = label;
				});

			container.querySelectorAll<HTMLInputElement>('.milkdown-link-edit input').forEach((input) => {
				input.placeholder = linkTooltipConfig.inputPlaceholder;
				input.setAttribute('aria-label', linkTooltipConfig.inputPlaceholder);
			});
			container
				.querySelectorAll<HTMLElement>('.image-edit .placeholder .text')
				.forEach((element) => (element.textContent = t('editor.imageLinkPlaceholder')));
			container
				.querySelectorAll<HTMLInputElement>('.image-edit .link-input-area')
				.forEach((input) => input.setAttribute('aria-label', t('editor.imageLinkPlaceholder')));
			container.querySelectorAll<HTMLInputElement>('.caption-input').forEach((input) => {
				input.placeholder = imageBlockConfig.blockCaptionPlaceholderText;
				input.setAttribute('aria-label', imageBlockConfig.blockCaptionPlaceholderText);
			});
			container
				.querySelectorAll<HTMLElement>('.milkdown-code-block .preview-label')
				.forEach((element) => (element.textContent = codeMirrorConfig.previewLabel));

			const toolbarKeys = {
				bold: 'boldLabel',
				italic: 'italicLabel',
				code: 'codeLabel',
				link: 'linkLabel',
				strikethrough: 'strikethroughLabel',
				latex: 'latexLabel'
			} as const;
			for (const [item, labelKey] of Object.entries(toolbarKeys)) {
				const button = container.querySelector<HTMLButtonElement>(
					`.milkdown-toolbar [data-toolbar-item="${item}"]`
				);
				if (!button) continue;
				const previousLabel = previousToolbarLabels[labelKey];
				const nextLabel = toolbarConfig[labelKey];
				const previousTitle = button.title;
				const suffix = previousTitle.startsWith(previousLabel)
					? previousTitle.slice(previousLabel.length)
					: '';
				button.setAttribute('aria-label', nextLabel);
				button.title = nextLabel + suffix;
			}
		};
		refreshMountedLocale();
		refreshMountedDiagrams = () => {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- temporary document scan
			const liveCode = new Set<string>();
			const view = instance.editor.action((ctx) => ctx.get(editorViewCtx));
			view.state.doc.descendants((node) => {
				if (node.type.name === 'code_block') liveCode.add(node.textContent);
			});
			for (const [apply, preview] of previews) {
				if (!liveCode.has(preview.content)) previews.delete(apply);
				else renderMermaidPreview(preview.language, preview.content, apply);
			}
		};
		const proseMirror = container.querySelector<HTMLElement>('.ProseMirror');
		const handleHistory = (event: InputEvent) => {
			if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return;
			if ((event.target as HTMLElement)?.closest('input, textarea, .cm-editor')) return;
			event.preventDefault();
			instance.editor.action((ctx) =>
				ctx.get(commandsCtx).call(event.inputType === 'historyUndo' ? 'Undo' : 'Redo')
			);
		};
		proseMirror?.addEventListener('beforeinput', handleHistory);
		removeHistoryListener = () => proseMirror?.removeEventListener('beforeinput', handleHistory);
		proseMirror?.setAttribute('aria-label', t('editor.ariaLabel'));
		saveMountedPosition = () => {
			const editorView = instance.editor.action((ctx) => ctx.get(editorViewCtx));
			editorStateCache.setPosition(idForMount, 'wysiwyg', {
				anchor: editorView.state.selection.anchor,
				head: editorView.state.selection.head,
				scrollTop: container.scrollTop
			});
		};
		crepe = instance;
		if (import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1') {
			// Local diagnostic handle. A normal build never exposes the view.
			(window as unknown as { __MDSH_EDITOR_VIEW__?: unknown }).__MDSH_EDITOR_VIEW__ =
				instance.editor.action((ctx) => ctx.get(editorViewCtx));
		}
		restoreMountedMarkdown = restoreMarkdown;
		// Milkdown wraps each native list item in a direct child of its list.
		// Give that wrapper the list item role. Expose its contents only once.
		const applyListRoles = () => {
			for (const item of container.querySelectorAll(
				'.milkdown-list-item-block > li:not([role="none"])'
			)) {
				item.parentElement?.setAttribute('role', 'listitem');
				item.setAttribute('role', 'none');
			}
		};
		applyListRoles();
		imageResizeObserver = new ResizeObserver((entries) => {
			let changed = false;
			for (const entry of entries) {
				const block = entry.target as HTMLElement;
				const width = entry.contentRect.width;
				if (imageBlockWidths.get(block) === width) continue;
				imageBlockWidths.set(block, width);
				const image = block.querySelector('img');
				if (image) pendingImages.add(image);
				changed = true;
			}
			if (changed) scheduleImageWork();
		});
		imageObserver = new MutationObserver((records) => {
			let imageDirty = false;
			let listDirty = false;
			for (const record of records) {
				if (record.type === 'childList') {
					for (const node of record.addedNodes) {
						if (collectImageNode(node)) {
							// Alt text follows document order. Any image membership change
							// needs a full remap; ordinary text edits never take this path.
							needsImageMapping = true;
							imageDirty = true;
						}
						if (collectListNodes(node)) listDirty = true;
					}
					for (const node of record.removedNodes) {
						if (node.nodeType !== Node.ELEMENT_NODE) continue;
						const element = node as Element;
						if (element.tagName === 'IMG' || element.querySelector('img')) {
							needsImageMapping = true;
							imageDirty = true;
						}
					}
				} else if (record.type === 'attributes' && record.target instanceof HTMLImageElement) {
					if (record.attributeName === 'src') needsImageMapping = true;
					pendingImages.add(record.target);
					imageDirty = true;
				}
			}
			if (imageDirty || listDirty) scheduleImageWork();
		});
		imageObserver.observe(container, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['src', 'alt', 'data-height', 'data-origin']
		});
		const handleImageLoad = (event: Event) => {
			const target = event.target;
			if (!(target instanceof HTMLImageElement)) return;
			pendingImages.add(target);
			scheduleImageWork();
		};
		container.addEventListener('load', handleImageLoad, true);
		removeImageListeners = () => {
			container.removeEventListener('load', handleImageLoad, true);
			if (imageFrame) cancelAnimationFrame(imageFrame);
			imageFrame = 0;
		};
		fullImageScan();
		mountedFileId = idForMount;
		await restoreEditorPosition(instance, idForMount, token);
		// Re-enable editing before the caret request. A read-only ProseMirror
		// element cannot take focus, so the new note would lose its caret.
		instance.setReadonly(readonly);
		// A new note waits for the lazy editor before it can take the caret.
		// The request survives the modal close and the asynchronous mount.
		const focusedControl = document.activeElement;
		if (
			token === mountToken &&
			consumeEditorFocus(idForMount) &&
			(!focusedControl ||
				container.contains(focusedControl) ||
				!focusedControl.closest('input, textarea, [contenteditable="true"], [role="dialog"]'))
		) {
			const editorView = instance.editor.action((ctx) => ctx.get(editorViewCtx));
			const selection = TextSelection.atEnd(editorView.state.doc);
			editorView.dispatch(editorView.state.tr.setSelection(selection).scrollIntoView());
			editorView.focus();
		}
		const flushCurrentContent = (event: Event) => {
			if (token !== mountToken) return;
			try {
				saveMountedPosition?.();
				const markdown = restoreMarkdown(serializeIncrementalMarkdown());
				lastEditorMarkdown = markdown;
				onFlush?.(idForMount, markdown);
				cancelPendingWork();
			} catch (error) {
				event.preventDefault();
				reportError('visual editor snapshot', error);
			}
		};
		window.addEventListener('mdsh:flush-editor', flushCurrentContent);
		removeFlushListener = () =>
			window.removeEventListener('mdsh:flush-editor', flushCurrentContent);
		updateExternalContent = async (markdown: string) => {
			if (markdown === lastEditorMarkdown) return;
			if (token !== mountToken || markdown !== content || idForMount !== fileId) return;
			frontmatter = stripFrontmatter(markdown);
			roundTrip = new ImageMarkdownRoundTrip(frontmatter.content);
			lastEditorMarkdown = markdown;
			sourceMarkdown = markdown;
			editorBaseline = null;
			fidelity = null;
			instance.editor.action(replaceAll(roundTrip.editorMarkdown));
			editorBaseline = resetIncrementalMarkdown();
			resetFidelity();
			applyImageAlternatives();
		};
		if (content !== initial && fileId === idForMount) await updateExternalContent(content);
	}

	async function unmount() {
		if (import.meta.env.VITE_SOURCE_FIDELITY_METRICS === '1') {
			delete (window as unknown as { __MDSH_EDITOR_VIEW__?: unknown }).__MDSH_EDITOR_VIEW__;
		}
		refreshMountedDiagrams = null;
		cancelPendingMarkdown?.();
		cancelPendingMarkdown = null;
		removeHistoryListener?.();
		removeHistoryListener = null;
		removeFlushListener?.();
		removeFlushListener = null;
		updateExternalContent = null;
		removeImageListeners?.();
		removeImageListeners = null;
		imageObserver?.disconnect();
		imageObserver = null;
		imageResizeObserver?.disconnect();
		imageResizeObserver = null;
		releaseVisualPreviews();
		if (crepe) {
			const instance = crepe;
			const id = mountedFileId;
			crepe = null;
			refreshMountedLocale = null;
			saveMountedPosition?.();
			saveMountedPosition = null;
			const restoreMarkdown = restoreMountedMarkdown;
			restoreMountedMarkdown = null;
			mountedFileId = null;
			// §C1 - Before destroying the outgoing instance, we re-read its current
			// markdown (synchronous Crepe API) and flush it one last time to ITS
			// file. Milkdown emits `markdownUpdated` asynchronously: without this
			// flush, the keystroke typed just before a tab switch would be lost
			// (the late event is rejected by the `token === mountToken` guard).
			if (id && onFlush) {
				try {
					const markdown = serializeMountedMarkdown?.() ?? instance.getMarkdown();
					onFlush(id, restoreMarkdown?.(markdown) ?? markdown);
				} catch (err) {
					reportError('Crepe flush on unmount', err);
				}
			}
			serializeMountedMarkdown = null;
			await instance.destroy().catch(() => {});
		}
	}

	$effect(() => {
		const id = fileId;
		void retryVersion;
		const snapshot = untrack(() => content);
		const token = ++mountToken;
		void (async () => {
			await unmount();
			if (token !== mountToken) return;
			await mount(snapshot, token, id);
		})().catch((error) => {
			if (token !== mountToken) return;
			loadError = true;
			reportError('visual editor load', error);
		});
	});

	$effect(() => {
		void i18n.locale;
		refreshMountedLocale?.();
	});

	$effect(() => {
		void themeStore.effective;
		refreshMountedDiagrams?.();
	});

	$effect(() => {
		const ro = readonly;
		if (crepe) crepe.setReadonly(ro);
	});

	$effect(() => {
		const incoming = content;
		if (incoming === lastEditorMarkdown || !updateExternalContent) return;
		void updateExternalContent(incoming).catch((error) =>
			reportError('visual editor update', error)
		);
	});

	onDestroy(() => {
		mountToken++;
		void unmount();
	});
</script>

{#if loadError}
	<div class="mdsh-editor-error" role="alert">
		<p>{t('editor.loadErrorTitle')}</p>
		<p>{t('source.loadErrorHint')}</p>
		<button type="button" onclick={() => retryVersion++}>{t('source.retry')}</button>
	</div>
{/if}
<!-- The scroll region accepts focus so keyboard users can read the document without moving the caret. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={container}
	class="mdsh-editor"
	class:mdsh-long-document={documentPolicy.longDocument}
	class:mdsh-webkit-engine={webkitEngine}
	role="region"
	aria-label={t('editor.ariaLabel')}
	tabindex="0"
></div>

<style>
	.mdsh-editor {
		height: 100%;
		width: 100%;
		overflow-y: auto;
	}
	.mdsh-editor-error {
		margin: 1rem;
		padding: 1rem;
		border: 1px solid var(--color-border);
		color: var(--color-fg);
		background: var(--color-bg-1);
	}
	.mdsh-editor-error button {
		margin-top: 0.75rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border-strong);
		background: var(--color-bg-2);
		color: var(--color-fg);
	}
</style>
