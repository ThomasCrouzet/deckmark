<script lang="ts">
	// Milkdown Crepe wrapper.
	// Milkdown + its CSS themes + our `milkdown.css` override are loaded
	// dynamically on first mount - kept out of the initial bundle (~500 KiB
	// estimated savings on the page chunk). The first WYSIWYG mode opening
	// pays an extra ~150 ms of loading, while the read/source modes
	// (default for onboarding) become instant.

	import type { Crepe as CrepeType } from '@milkdown/crepe';
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
	import { themeStore } from '#lib/ui/theme.svelte.js';

	interface Props {
		fileId: string;
		content: string;
		readonly?: boolean;
		onChange: (markdown: string) => void;
		// §C1 - Flush of the last keystroke to the OLD file before remount.
		// Explicitly receives the relevant fileId (unlike onChange which writes to
		// the active file): on tab switch, the outgoing instance may hold a
		// keystroke that `markdownUpdated` (asynchronous) has not yet emitted.
		onFlush?: (fileId: string, markdown: string) => void;
	}

	let { fileId, content, readonly = false, onChange, onFlush }: Props = $props();

	let container: HTMLElement;
	let crepe: CrepeType | null = null;
	let restoreMountedMarkdown: ((markdown: string) => string) | null = null;
	let imageObserver: MutationObserver | null = null;
	let imageResizeObserver: ResizeObserver | null = null;
	let loadError = $state(false);
	let retryVersion = $state(0);
	let mountToken = 0;
	let lastEditorMarkdown = '';
	let updateExternalContent: ((markdown: string) => Promise<void>) | null = null;
	let removeFlushListener: (() => void) | null = null;
	let removeHistoryListener: (() => void) | null = null;
	// §C1 - fileId associated with the currently mounted Crepe instance. Captured
	// at mount to correctly route a late keystroke (flush or asynchronous
	// `markdownUpdated`) to the right file even after a tab switch.
	let mountedFileId: string | null = null;
	let refreshMountedLocale: (() => void) | null = null;
	let saveMountedPosition: (() => void) | null = null;
	let refreshMountedDiagrams: (() => void) | null = null;

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
				commandsCtx,
				Plugin,
				Decoration,
				DecorationSet,
				prosePlugin,
				remarkPlugin,
				linkTooltipConfig: linkTooltipConfigCtx,
				imageBlockConfig: imageBlockConfigCtx,
				inlineImageConfig: inlineImageConfigCtx,
				codeBlockConfig: codeBlockConfigCtx,
				wikiLinkPlugins,
				replaceAll
			},
			{ editorImageSource, embedImageFile, ImageFileError, MAX_IMAGE_BYTES }
		] = await Promise.all([
			loadCrepeModule(),
			import('#lib/milkdown-editor-plugins.js'),
			import('#lib/render/image-media.js')
		]);
		if (token !== mountToken) return;
		// Keep YAML outside the Markdown editor so it cannot become headings or links.
		let frontmatter = stripFrontmatter(initial);
		let roundTrip = new ImageMarkdownRoundTrip(frontmatter.content);
		let sourceMarkdown = initial;
		let editorBaseline: string | null = null;
		const restoreMarkdown = (markdown: string) =>
			editorBaseline === null || markdown === editorBaseline
				? sourceMarkdown
				: frontmatter.raw + roundTrip.restore(markdown);
		lastEditorMarkdown = initial;
		const applyImageAlternatives = () => {
			const alternatives = roundTrip.alternatives;
			container
				.querySelectorAll<HTMLImageElement>('.milkdown-image-block img')
				.forEach((image, index) => {
					const alt = alternatives[index] ?? '';
					if (image.alt !== alt) image.alt = alt;
					image.referrerPolicy = 'no-referrer';
					image.crossOrigin = 'anonymous';
					const block = image.closest<HTMLElement>('.milkdown-image-block');
					if (!block || !image.naturalWidth) return;
					const ratio = Number(image.dataset.height) / Number(image.dataset.origin) || 1;
					const width = Math.min(image.naturalWidth, block.clientWidth) * ratio;
					const value = `${width}px`;
					if (image.style.width !== value) image.style.width = value;
				});
		};
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
			proxyDomURL: async (source: string) => {
				const { projectContextFor, projectImageSource } = await import('#lib/project-media.js');
				try {
					return (
						(await projectImageSource(source, await projectContextFor(idForMount))) ??
						editorImageSource(source)
					);
				} catch {
					return editorImageSource(source);
				}
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
		const imageTitlePlugin = remarkPlugin(
			'mdshNormalizeImageTitles',
			() => () => normalizeImageTitlesForMilkdown
		);
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
		instance.editor.use(wikiLinkPlugins);
		instance.editor.use(imageTitlePlugin);
		instance.editor.use(headingLevelPlugin);
		instance.on((listener) => {
			listener.markdownUpdated((_ctx, md) => {
				// A queued event must not replace a newer editor document.
				try {
					if (md !== instance.getMarkdown()) return;
				} catch {
					return;
				}
				const portableMarkdown = restoreMarkdown(md);
				if (token === mountToken) lastEditorMarkdown = portableMarkdown;
				queueMicrotask(applyImageAlternatives);
				// §C1 - If the instance is still the current one, normal keystroke ->
				// onChange (writes to the active file). Otherwise (a late event
				// arriving after a remount), we explicitly route to the file
				// associated with THIS instance so we do not drop the last keystroke.
				if (token === mountToken) onChange(portableMarkdown);
				else onFlush?.(idForMount, portableMarkdown);
			});
		});
		try {
			await instance.create();
			editorBaseline = instance.getMarkdown();
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
		instance.setReadonly(readonly);
		saveMountedPosition = () => {
			const editorView = instance.editor.action((ctx) => ctx.get(editorViewCtx));
			editorStateCache.setPosition(idForMount, 'wysiwyg', {
				anchor: editorView.state.selection.anchor,
				head: editorView.state.selection.head,
				scrollTop: container.scrollTop
			});
		};
		crepe = instance;
		restoreMountedMarkdown = restoreMarkdown;
		imageObserver = new MutationObserver(applyImageAlternatives);
		imageObserver.observe(container, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['src', 'alt', 'data-height', 'data-origin']
		});
		imageResizeObserver = new ResizeObserver(applyImageAlternatives);
		if (proseMirror) imageResizeObserver.observe(proseMirror);
		applyImageAlternatives();
		mountedFileId = idForMount;
		await restoreEditorPosition(instance, idForMount, token);
		const flushCurrentContent = () => {
			if (token !== mountToken) return;
			saveMountedPosition?.();
			const markdown = restoreMarkdown(instance.getMarkdown());
			lastEditorMarkdown = markdown;
			onFlush?.(idForMount, markdown);
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
			instance.editor.action(replaceAll(roundTrip.editorMarkdown));
			editorBaseline = instance.getMarkdown();
			applyImageAlternatives();
		};
		if (content !== initial && fileId === idForMount) await updateExternalContent(content);
	}

	async function unmount() {
		refreshMountedDiagrams = null;
		removeHistoryListener?.();
		removeHistoryListener = null;
		removeFlushListener?.();
		removeFlushListener = null;
		updateExternalContent = null;
		imageObserver?.disconnect();
		imageObserver = null;
		imageResizeObserver?.disconnect();
		imageResizeObserver = null;
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
					onFlush(id, restoreMarkdown?.(instance.getMarkdown()) ?? instance.getMarkdown());
				} catch (err) {
					reportError('Crepe flush on unmount', err);
				}
			}
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
<div bind:this={container} class="mdsh-editor"></div>

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
