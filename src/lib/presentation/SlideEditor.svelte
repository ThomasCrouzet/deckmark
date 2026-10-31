<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { focusTrap } from '#lib/a11y/focusTrap.js';
	import { t, type MessageKey } from '#lib/i18n/index.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { notify } from '#lib/notify.svelte.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import { spinnerStore } from '#lib/spinner.svelte.js';
	import { reportError } from '#lib/report.js';
	import Toasts from '#lib/components/Toasts.svelte';
	import BrandLogo from '#lib/components/BrandLogo.svelte';
	import { PresentationEditor } from './editor.svelte';
	import { createPresentationGestures } from './gestures.svelte';
	import type { PresentationElementType } from './model';
	import SlideContent from './SlideContent.svelte';
	import SlideThumbnail from './SlideThumbnail.svelte';
	import { presentationElementStyle, presentationElementBox } from './render';
	import SlideInspector from './SlideInspector.svelte';
	import {
		Plus,
		X,
		Play,
		Undo2,
		Redo2,
		ChevronLeft,
		ChevronRight,
		SlidersHorizontal,
		Type,
		Image,
		Square,
		Circle,
		ArrowUpRight,
		Minus,
		Copy,
		Trash2,
		Code2,
		Maximize,
		ZoomIn,
		ZoomOut
	} from '@lucide/svelte';

	let { onClose, initialPresenting = false }: { onClose: () => void; initialPresenting?: boolean } =
		$props();
	const fileId = filesStore.active!.id;
	const editor = new PresentationEditor(filesStore.active?.content ?? '', (source) =>
		filesStore.updateContent(fileId, source)
	);
	let root = $state<HTMLDivElement | null>(null);
	let canvas = $state<HTMLDivElement | null>(null);
	let viewport = $state<HTMLDivElement | null>(null);
	let textInput = $state<HTMLTextAreaElement | null>(null);
	let imageInput = $state<HTMLInputElement | null>(null);
	let viewportWidth = $state(900);
	let viewportHeight = $state(600);
	let sourceOpen = $state(false);
	let inspectorOpen = $state(true);
	let multiSelect = $state(false);
	let editingId = $state<string | null>(null);
	let presenting = $state(false);
	let showNotes = $state(false);
	let busy = $state(false);
	let overflow = $state(false);
	let slideDragIndex: number | null = null;
	let thumbnailTouch: { pointerId: number; from: number; startY: number; startX: number } | null =
		null;
	let userMessage = $state('');
	type ClipboardShortcut = {
		kind: 'copy' | 'cut' | 'paste';
		payload: string | undefined;
		slideId: string;
		selectedIds: string[];
		nativeHandled: boolean;
		fallbackApplied: boolean;
	};
	let clipboardShortcut: ClipboardShortcut | null = null;
	let clipboardDisposed = false;
	const gestures = createPresentationGestures(
		editor,
		() => canvas,
		() => scale,
		finishText,
		() => multiSelect
	);
	const scale = $derived(
		Math.max(
			0.08,
			Math.min((viewportWidth - 48) / editor.deck.width, (viewportHeight - 48) / editor.deck.height)
		) * gestures.zoom
	);
	const editingElement = $derived(
		editor.slide.elements.find((element) => element.id === editingId)
	);
	const selectedBox = $derived.by(() => {
		const elements = editor.elements.map((element) => {
			const box = presentationElementBox(element, editor.slide);
			return { ...element, x: box.left, y: box.top, width: box.width, height: box.height };
		});
		if (!elements.length) return null;
		const x = Math.min(...elements.map((element) => element.x));
		const y = Math.min(...elements.map((element) => element.y));
		return {
			x,
			y,
			width: Math.max(...elements.map((element) => element.x + element.width)) - x,
			height: Math.max(...elements.map((element) => element.y + element.height)) - y,
			rotation: elements.length === 1 ? elements[0]!.rotation : 0
		};
	});
	const selectionAnnouncement = $derived.by(() => {
		const slide = t('slides.slide', { n: editor.index + 1 });
		if (editor.selected.length === 0) return slide;
		if (editor.selected.length > 1)
			return `${slide}. ${t('slides.selectionCount', { n: editor.selected.length })}`;
		const primary = editor.primary;
		if (!primary) return slide;
		const index = editor.slide.elements.findIndex((element) => element.id === primary.id) + 1;
		return `${slide}. ${t('slides.object', {
			type: t(`slides.${primary.type}` as MessageKey),
			n: index
		})}`;
	});

	$effect(() => {
		const current = filesStore.files.find((file) => file.id === fileId)?.content;
		untrack(() => {
			if (current !== undefined && current !== editor.source) {
				gestures.cancel();
				editingId = null;
				editor.receive(current);
				userMessage = t('slides.changedElsewhere');
			}
		});
	});
	$effect(() => {
		const element = viewport;
		if (!element) return;
		const observer = new ResizeObserver((entries) => {
			const box = entries[0]?.contentRect;
			if (box) {
				viewportWidth = box.width;
				viewportHeight = box.height;
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	});
	$effect(() => {
		void editor.source;
		void editor.index;
		const timer = setTimeout(() => {
			overflow = Array.from(
				canvas?.querySelectorAll<HTMLElement>('.mdsh-slide-element-content') ?? []
			).some(
				(element) =>
					element.scrollHeight > element.clientHeight + 2 ||
					element.scrollWidth > element.clientWidth + 2
			);
		}, 500);
		return () => clearTimeout(timer);
	});
	onMount(() => {
		inspectorOpen = window.innerWidth >= 768;
		presenting = initialPresenting;
		root?.focus();
		const nativeAction = (event: Event) => {
			const action = (event as CustomEvent<string>).detail;
			if (action === 'export-md') void exportFile('md');
			else if (action === 'export-html') void exportFile('html');
			else if (action === 'export-pdf') void exportFile('pdf');
			else if (action === 'save-disk') {
				finishText();
				void filesStore.saveActiveToDisk().catch((error) =>
					reportError('save presentation to disk', error, {
						notifyUser: t('page.saveToDiskError')
					})
				);
			}
		};
		window.addEventListener('mdsh:presentation-action', nativeAction);
		return () => {
			clipboardDisposed = true;
			clipboardShortcut = null;
			gestures.cancel();
			window.removeEventListener('mdsh:presentation-action', nativeAction);
		};
	});

	function nativeHistory(event: InputEvent) {
		if ((event.target as HTMLElement).closest('input,textarea,[contenteditable="true"]')) return;
		if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return;
		event.preventDefault();
		event.stopPropagation();
		finishText();
		if (event.inputType === 'historyUndo') editor.undo();
		else editor.redo();
	}

	function finishText() {
		if (!editingId) return;
		editingId = null;
		editor.commit();
	}
	async function editText(id = editor.primary?.id) {
		const element = editor.slide.elements.find((entry) => entry.id === id);
		if (!element || ['image', 'line', 'arrow'].includes(element.type)) return;
		finishText();
		editor.select(element.id);
		editor.begin();
		editingId = element.id;
		await tick();
		textInput?.focus();
		textInput?.select();
	}
	function go(index: number) {
		finishText();
		editor.selectSlide(index);
		gestures.resetView();
	}
	function add(type: PresentationElementType) {
		finishText();
		if (type === 'image') {
			imageInput?.click();
			return;
		}
		editor.add(type, type === 'text' ? t('slides.newText') : '');
	}
	async function insertImages(files: File[]) {
		if (!files.length) return;
		finishText();
		try {
			const { embedImageFile } = await import('#lib/render/image-media.js');
			for (const file of files) {
				const image = await embedImageFile(file);
				const id = editor.add('image', image.dataUri);
				const element = editor.slide.elements.find((entry) => entry.id === id)!;
				element.width = Math.min(480, editor.deck.width / 2);
				element.height = Math.min(
					editor.deck.height / 2,
					(element.width * image.height) / image.width
				);
				element.width = (element.height * image.width) / image.height;
				editor.constrain(element);
				editor.publish();
			}
		} catch (error) {
			reportError('insert slide image', error);
			notify.error(t('slides.imageError'));
		}
	}
	function dropImage(event: DragEvent) {
		event.preventDefault();
		event.stopPropagation();
		void insertImages(
			Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'))
		);
	}
	function editKey(event: KeyboardEvent) {
		event.stopPropagation();
		if (event.key === 'Escape') {
			event.preventDefault();
			finishText();
			root?.focus();
		} else if ((event.metaKey || event.ctrlKey) && ['b', 'i'].includes(event.key.toLowerCase())) {
			event.preventDefault();
			formatText(event.key.toLowerCase() === 'b' ? '**' : '*');
		}
	}
	function formatText(marker: string) {
		if (!textInput || !editingElement) return;
		const start = textInput.selectionStart;
		const end = textInput.selectionEnd;
		const content = editingElement.content;
		editingElement.content =
			content.slice(0, start) +
			marker +
			content.slice(start, end) +
			(marker === '- ' ? '' : marker) +
			content.slice(end);
		editor.publish();
		void tick().then(() => {
			textInput?.focus();
			textInput?.setSelectionRange(start + marker.length, end + marker.length);
		});
	}
	function handleKey(event: KeyboardEvent) {
		event.stopPropagation();
		if (
			event.isComposing ||
			(event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')
		)
			return;
		if (presenting) {
			if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) {
				event.preventDefault();
				go(editor.index + 1);
			} else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) {
				event.preventDefault();
				go(editor.index - 1);
			} else if (event.key === 'Home') go(0);
			else if (event.key === 'End') go(editor.deck.slides.length - 1);
			else if (event.key === 'Escape') {
				event.preventDefault();
				exitPresent();
			}
			return;
		}
		const modifier = event.ctrlKey || event.metaKey;
		if (modifier && ['c', 'x', 'v'].includes(event.key.toLowerCase())) {
			startClipboardShortcut(event.key.toLowerCase());
		} else if (modifier && event.key.toLowerCase() === 'z') {
			event.preventDefault();
			finishText();
			if (event.shiftKey) editor.redo();
			else editor.undo();
		} else if (modifier && event.key.toLowerCase() === 'y') {
			event.preventDefault();
			finishText();
			editor.redo();
		} else if (modifier && event.key.toLowerCase() === 'd') {
			event.preventDefault();
			editor.duplicate();
		} else if (modifier && event.key.toLowerCase() === 'a') {
			event.preventDefault();
			editor.selected = editor.slide.elements.map((element) => element.id);
		} else if (modifier && event.key.toLowerCase() === 'p') {
			event.preventDefault();
			void exportFile('pdf');
		} else if (modifier && event.key.toLowerCase() === 's') {
			event.preventDefault();
			finishText();
			void filesStore.flushPendingAwait().catch((error) => reportError('save presentation', error));
		} else if (event.key === 'Delete' || event.key === 'Backspace') {
			if (editor.selected.length) {
				event.preventDefault();
				editor.remove();
			}
		} else if (event.key === 'Escape') {
			if (editor.selected.length) editor.selected = [];
			else close();
		} else if (event.key.startsWith('Arrow') && editor.selected.length) {
			event.preventDefault();
			const step = event.shiftKey ? 10 : 1;
			editor.moveSelection(
				event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0,
				event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0
			);
		} else if (event.key === 'Enter' && editor.primary) {
			event.preventDefault();
			void editText();
		}
	}
	function focusClickedButton(event: MouseEvent) {
		if (event.button !== 0 || !(event.target instanceof Element)) return;
		const button = event.target.closest('button');
		if (button && !button.disabled) button.focus({ preventScroll: true });
	}
	function copySelection() {
		const payload = editor.copy();
		if (typeof navigator.clipboard?.writeText === 'function')
			void navigator.clipboard.writeText(payload).catch(() => {
				// The internal object clipboard remains available if access is denied.
			});
		return payload;
	}
	function releaseClipboardShortcut(request: ClipboardShortcut) {
		setTimeout(() => {
			if (clipboardShortcut === request) clipboardShortcut = null;
		}, 0);
	}
	function startClipboardShortcut(key: string) {
		const kind = key === 'v' ? 'paste' : key === 'x' ? 'cut' : 'copy';
		if (kind !== 'paste' && !editor.selected.length) return;
		const request: ClipboardShortcut = {
			kind,
			payload: kind === 'paste' ? undefined : copySelection(),
			slideId: editor.slide.id,
			selectedIds: [...editor.selected],
			nativeHandled: false,
			fallbackApplied: false
		};
		clipboardShortcut = request;
		// Native clipboard events run before this fallback task.
		setTimeout(() => {
			if (clipboardDisposed || request.nativeHandled) return;
			if (kind === 'paste') void pasteFromClipboard(request);
			else {
				request.fallbackApplied = true;
				if (kind === 'cut') cutSelection(request);
				releaseClipboardShortcut(request);
			}
		}, 0);
	}
	function cutSelection(request: ClipboardShortcut) {
		if (
			editor.slide.id === request.slideId &&
			editor.selected.length === request.selectedIds.length &&
			request.selectedIds.every((id) => editor.selected.includes(id))
		)
			editor.remove();
	}
	async function pasteFromClipboard(request: ClipboardShortcut) {
		const images: File[] = [];
		let text = '';
		let unavailable = false;
		try {
			if (typeof navigator.clipboard?.read === 'function') {
				const items = await navigator.clipboard.read();
				for (const item of items) {
					if (clipboardDisposed || request.nativeHandled) return;
					const type = item.types.find((value) => value.startsWith('image/'));
					if (type) images.push(new File([await item.getType(type)], 'clipboard-image', { type }));
					else if (item.types.includes('text/plain'))
						text += await (await item.getType('text/plain')).text();
				}
			} else if (typeof navigator.clipboard?.readText === 'function')
				text = await navigator.clipboard.readText();
			else unavailable = true;
		} catch {
			images.length = 0;
			try {
				if (typeof navigator.clipboard?.readText === 'function')
					text = await navigator.clipboard.readText();
				else unavailable = true;
			} catch {
				unavailable = true;
			}
		}
		if (clipboardDisposed || request.nativeHandled || editor.slide.id !== request.slideId) return;
		request.fallbackApplied = true;
		if (unavailable && !editor.clipboardAvailable) notify.error(t('palette.clipboardUnavailable'));
		else applyPaste(images, text);
		releaseClipboardShortcut(request);
	}
	function copy(event: ClipboardEvent) {
		if ((event.target as HTMLElement).closest('textarea,input,[contenteditable="true"]')) return;
		const request = clipboardShortcut?.kind === event.type ? clipboardShortcut : null;
		if (!request && !editor.selected.length) return;
		event.preventDefault();
		event.stopPropagation();
		if (request?.fallbackApplied) return;
		if (request) request.nativeHandled = true;
		event.clipboardData?.setData('text/plain', request?.payload ?? editor.copy());
		if (event.type === 'cut') {
			if (request) cutSelection(request);
			else editor.remove();
		}
		if (request) releaseClipboardShortcut(request);
	}
	function paste(event: ClipboardEvent) {
		if ((event.target as HTMLElement).closest('textarea,input,[contenteditable="true"]')) return;
		event.preventDefault();
		event.stopPropagation();
		const request = clipboardShortcut?.kind === 'paste' ? clipboardShortcut : null;
		if (request?.fallbackApplied) return;
		if (request) request.nativeHandled = true;
		const images = Array.from(event.clipboardData?.files ?? []).filter((file) =>
			file.type.startsWith('image/')
		);
		applyPaste(images, event.clipboardData?.getData('text/plain') ?? '');
		if (request) releaseClipboardShortcut(request);
	}
	function applyPaste(images: File[], text: string) {
		if (images.length) {
			void insertImages(images);
			return;
		}
		if (text.startsWith('mdsh-slide-elements\n')) editor.paste(text);
		else if (text) editor.add('text', text);
		else editor.paste();
	}
	async function exportFile(kind: 'md' | 'html' | 'pdf') {
		if (busy || editor.error) return;
		finishText();
		editor.publish();
		busy = true;
		try {
			await filesStore.flushPendingAwait();
			if (kind === 'md') filesStore.exportActive();
			else if (kind === 'html') await filesStore.exportActiveHTML();
			else await filesStore.exportActivePDF();
		} catch (error) {
			reportError('export presentation', error);
			notify.error(t('slides.exportError'));
		} finally {
			busy = false;
		}
	}
	function present() {
		finishText();
		presenting = true;
		gestures.resetView();
		void tick().then(() => root?.focus());
	}
	function exitPresent() {
		if (initialPresenting) {
			close();
			return;
		}
		presenting = false;
		if (document.fullscreenElement === root) void document.exitFullscreen?.();
	}
	function close() {
		finishText();
		if (document.fullscreenElement === root) void document.exitFullscreen?.();
		onClose();
	}
	function thumbnailPointerDown(event: PointerEvent, index: number) {
		if (event.pointerType === 'touch')
			thumbnailTouch = {
				pointerId: event.pointerId,
				from: index,
				startX: event.clientX,
				startY: event.clientY
			};
	}
	function thumbnailPointerUp(event: PointerEvent) {
		if (!thumbnailTouch || thumbnailTouch.pointerId !== event.pointerId) return;
		const target = document
			.elementFromPoint(event.clientX, event.clientY)
			?.closest<HTMLElement>('[data-slide-index]');
		if (
			target &&
			Math.hypot(event.clientX - thumbnailTouch.startX, event.clientY - thumbnailTouch.startY) > 20
		)
			editor.moveSlide(thumbnailTouch.from, Number(target.dataset.slideIndex));
		thumbnailTouch = null;
	}
</script>

<svelte:window
	onpointermove={gestures.pointerMove}
	onpointerup={(event) => {
		gestures.pointerEnd(event);
		thumbnailPointerUp(event);
	}}
	onpointercancel={(event) => gestures.pointerEnd(event, true)}
/>

{#snippet action(id: string, label: MessageKey, run: () => void, disabled = false)}
	<button type="button" data-testid={'slide-' + id} onclick={run} {disabled} title={t(label)}
		>{t(label)}</button
	>
{/snippet}

<div
	bind:this={root}
	class="presentation-editor"
	class:presenting
	role="dialog"
	aria-modal="true"
	aria-label={t('slides.title')}
	tabindex="-1"
	data-testid="presentation-editor"
	onclickcapture={focusClickedButton}
	onkeydown={handleKey}
	oncopy={copy}
	oncut={copy}
	onpaste={paste}
	onbeforeinput={nativeHistory}
	inert={promptStore.open}
	use:focusTrap
>
	<header class="presentation-header">
		<div class="presentation-brand">
			<span class="presentation-signature"><BrandLogo /></span>
			<span class="brand-label"><strong>{t('slides.open')}</strong></span>
		</div>
		{#if !presenting}
			<input
				class="presentation-name"
				data-testid="slide-title"
				aria-label={t('slides.fileName')}
				value={filesStore.files.find((file) => file.id === fileId)?.name ?? ''}
				onchange={(event) => void filesStore.rename(fileId, event.currentTarget.value)}
			/>
			<div class="header-actions">
				{@render action('source', sourceOpen ? 'slides.visual' : 'slides.source', () => {
					finishText();
					sourceOpen = !sourceOpen;
				})}
				{@render action(
					'export-md',
					'slides.exportMarkdown',
					() => void exportFile('md'),
					busy || editor.error
				)}
				{@render action(
					'export-html',
					'slides.exportHtml',
					() => void exportFile('html'),
					busy || editor.error
				)}
				{@render action(
					'export-pdf',
					'slides.exportPdf',
					() => void exportFile('pdf'),
					busy || editor.error
				)}
				<button
					class="primary"
					data-testid="slide-present"
					onclick={present}
					disabled={editor.error}><Play size={15} />{t('slides.present')}</button
				>
			</div>
		{:else}
			<span class="present-count">{editor.index + 1} / {editor.deck.slides.length}</span>
			{@render action('present-notes', showNotes ? 'slides.hideNotes' : 'slides.showNotes', () => {
				showNotes = !showNotes;
			})}
			{#if root?.requestFullscreen}<button
					title={t('slides.fullscreen')}
					aria-label={t('slides.fullscreen')}
					onclick={() => void root?.requestFullscreen().catch(() => {})}
					><Maximize size={18} /></button
				>{/if}
		{/if}
		<button
			class="icon-button"
			data-testid={presenting ? 'slide-present-exit' : 'slide-close'}
			aria-label={t(presenting ? 'slides.exitPresent' : 'slides.close')}
			onclick={presenting ? exitPresent : close}><X size={20} /></button
		>
	</header>
	<p class="sr-only" role="status" aria-live="polite" data-testid="slide-selection-status">
		{selectionAnnouncement}
	</p>
	<Toasts embedded />
	{#if userMessage}<p class="message" role="status">
			{userMessage}<button
				aria-label={t('slides.close')}
				onclick={() => {
					userMessage = '';
				}}>×</button
			>
		</p>{/if}
	{#if editor.error}<p class="error" role="alert" data-testid="slide-source-error">
			{t('slides.invalidSource')}
		</p>{/if}
	{#if busy && spinnerStore.visible}
		<div class="message" role="status">
			{spinnerStore.message}
			{#if spinnerStore.cancel}<button onclick={spinnerStore.cancel}>{t('export.cancel')}</button
				>{/if}
		</div>
	{/if}
	{#if !presenting && !sourceOpen && !editor.error}
		<div class="presentation-tools" role="toolbar" aria-label={t('slides.insert')}>
			<button
				class="icon-button"
				data-testid="slide-undo"
				aria-label={t('slides.undo')}
				title={t('slides.undo')}
				onclick={() => {
					finishText();
					editor.undo();
				}}
				disabled={!editor.undoEntries.length}><Undo2 size={18} /></button
			>
			<button
				class="icon-button"
				data-testid="slide-redo"
				aria-label={t('slides.redo')}
				title={t('slides.redo')}
				onclick={() => {
					finishText();
					editor.redo();
				}}
				disabled={!editor.redoEntries.length}><Redo2 size={18} /></button
			>
			<span class="tool-separator"></span>
			<button data-testid="slide-add-text" onclick={() => add('text')}
				><Type size={17} />{t('slides.text')}</button
			>
			<button data-testid="slide-add-image" onclick={() => add('image')}
				><Image size={17} />{t('slides.image')}</button
			>
			<button data-testid="slide-add-rectangle" onclick={() => add('rectangle')}
				><Square size={17} />{t('slides.rectangle')}</button
			>
			<button data-testid="slide-add-rounded-rectangle" onclick={() => add('rounded-rectangle')}
				><Square size={17} />{t('slides.rounded-rectangle')}</button
			>
			<button data-testid="slide-add-ellipse" onclick={() => add('ellipse')}
				><Circle size={17} />{t('slides.ellipse')}</button
			>
			<button data-testid="slide-add-line" onclick={() => add('line')}
				><Minus size={17} />{t('slides.line')}</button
			>
			<button data-testid="slide-add-arrow" onclick={() => add('arrow')}
				><ArrowUpRight size={17} />{t('slides.arrow')}</button
			>
			<span class="tool-separator"></span>
			<button
				data-testid="slide-properties"
				aria-pressed={inspectorOpen}
				onclick={() => {
					inspectorOpen = !inspectorOpen;
				}}><SlidersHorizontal size={17} />{t('slides.properties')}</button
			>
		</div>
	{/if}
	{#if sourceOpen || editor.error}
		<div class="source-panel">
			<p><Code2 size={18} />{t('slides.sourceHint')}</p>
			<textarea
				data-testid="slide-source-editor"
				aria-label={t('slides.source')}
				value={editor.source}
				spellcheck="false"
				oninput={(event) => editor.writeSource(event.currentTarget.value)}></textarea>
		</div>
	{:else}
		<div class="presentation-workspace">
			{#if !presenting}
				<aside class="slide-filmstrip" aria-label={t('slides.slides')}>
					<div class="filmstrip-actions">
						<button
							data-testid="slide-add"
							onclick={() => {
								finishText();
								editor.addSlide();
							}}><Plus size={16} />{t('slides.add')}</button
						>
					</div>
					<div class="thumbnails">
						{#each editor.deck.slides as slide, index (slide.id)}
							<button
								class="slide-thumbnail"
								class:current={index === editor.index}
								data-testid="slide-thumbnail"
								data-slide-id={slide.id}
								data-slide-index={index}
								aria-label={t('slides.slide', { n: index + 1 })}
								aria-current={index === editor.index ? 'true' : undefined}
								draggable="true"
								onclick={() => go(index)}
								onpointerdown={(event) => thumbnailPointerDown(event, index)}
								ondragstart={(event) => {
									slideDragIndex = index;
									event.dataTransfer?.setData('text/x-mdsh-slide', String(index));
									event.stopPropagation();
								}}
								ondragover={(event) => {
									event.preventDefault();
									event.stopPropagation();
								}}
								ondrop={(event) => {
									event.preventDefault();
									event.stopPropagation();
									if (slideDragIndex !== null) editor.moveSlide(slideDragIndex, index);
									slideDragIndex = null;
								}}
							>
								<span class="slide-number">{index + 1}</span><span
									class="thumbnail-preview"
									style:aspect-ratio={editor.deck.width / editor.deck.height}
									style:background={slide.background}
								>
									<SlideThumbnail deck={editor.deck} {slide} {fileId} />
								</span>
							</button>
						{/each}
					</div>
					<div class="filmstrip-bottom">
						<button
							data-testid="slide-duplicate-slide"
							aria-label={t('slides.duplicateSlide')}
							title={t('slides.duplicateSlide')}
							onclick={() => {
								finishText();
								editor.duplicateSlide();
							}}><Copy size={16} /></button
						>
						<button
							data-testid="slide-delete-slide"
							aria-label={t('slides.deleteSlide')}
							title={t('slides.deleteSlide')}
							onclick={() => {
								finishText();
								editor.deleteSlide();
							}}><Trash2 size={16} /></button
						>
						<button
							data-testid="slide-move-prev"
							aria-label={t('slides.previousSlide')}
							title={t('slides.previousSlide')}
							disabled={editor.index === 0}
							onclick={() => editor.moveSlide(editor.index, editor.index - 1)}
							><ChevronLeft size={16} /></button
						>
						<button
							data-testid="slide-move-next"
							aria-label={t('slides.nextSlide')}
							title={t('slides.nextSlide')}
							disabled={editor.index === editor.deck.slides.length - 1}
							onclick={() => editor.moveSlide(editor.index, editor.index + 1)}
							><ChevronRight size={16} /></button
						>
					</div>
				</aside>
			{/if}
			<div class="stage-column">
				{#if !presenting}<div
						class="selection-tools"
						role="toolbar"
						aria-label={t('slides.objects')}
					>
						{@render action(
							'copy',
							'slides.copy',
							() => {
								copySelection();
							},
							!editor.selected.length
						)}
						{@render action(
							'paste',
							'slides.paste',
							() => editor.paste(),
							!editor.clipboardAvailable
						)}
						{@render action(
							'duplicate',
							'slides.duplicate',
							() => editor.duplicate(),
							!editor.selected.length
						)}
						{@render action(
							'delete',
							'slides.delete',
							() => editor.remove(),
							!editor.selected.length
						)}
						{@render action(
							'edit-text',
							'slides.editText',
							() => void editText(),
							!editor.primary || ['image', 'line', 'arrow'].includes(editor.primary.type)
						)}
						<button
							data-testid="slide-multiselect"
							aria-pressed={multiSelect}
							onclick={() => {
								multiSelect = !multiSelect;
							}}>{t('slides.multiSelect')}</button
						>
						<label class="snap-control"
							><input type="checkbox" bind:checked={gestures.snap} />{t('slides.snap')}</label
						>
					</div>{/if}
				<div
					class="slide-viewport"
					bind:this={viewport}
					role="group"
					aria-label={t('slides.canvas')}
					onpointerdown={(event) => {
						if (!presenting) gestures.startBackground(event);
					}}
					ondragover={(event) => {
						event.preventDefault();
						event.stopPropagation();
					}}
					ondrop={dropImage}
				>
					<div
						class="slide-positioner"
						style:width={`${editor.deck.width * scale}px`}
						style:height={`${editor.deck.height * scale}px`}
						style:transform={`translate(${gestures.pan.x}px, ${gestures.pan.y}px)`}
					>
						<div
							class="slide-canvas"
							bind:this={canvas}
							data-testid="slide-canvas"
							style:width={`${editor.deck.width}px`}
							style:height={`${editor.deck.height}px`}
							style:transform={`scale(${scale})`}
							style:background={editor.slide.background}
							style:--slide-scale={scale}
						>
							<div class="slide-render">
								<SlideContent
									slide={editor.slide}
									deck={editor.deck}
									{fileId}
									{...editingId ? { hideTextId: editingId } : {}}
								/>
							</div>
							{#if !presenting}
								{#each editor.slide.elements as element, index (element.id)}
									<button
										type="button"
										class="slide-object"
										class:selected={editor.selected.includes(element.id)}
										data-testid="slide-object"
										data-object-id={element.id}
										data-object-type={element.type}
										aria-label={t('slides.object', {
											type: t(`slides.${element.type}`),
											n: index + 1
										})}
										aria-pressed={editor.selected.includes(element.id)}
										style={presentationElementStyle(element, editor.slide)}
										onpointerdown={(event) => {
											if (editingId !== element.id) gestures.startObject(event, element);
										}}
										onclick={(event) => {
											if (event.detail === 0) editor.select(element.id, event.shiftKey);
										}}
										onkeydown={(event) => {
											if (event.key === 'Enter' || event.key === ' ') {
												event.preventDefault();
												event.stopPropagation();
												editor.select(element.id, event.shiftKey || event.ctrlKey || event.metaKey);
											} else if (event.key === 'F2') {
												event.preventDefault();
												event.stopPropagation();
												void editText(element.id);
											}
										}}
										ondblclick={() => void editText(element.id)}
									></button>
								{/each}
								{#if !editor.slide.elements.length}<p class="empty-slide">
										{t('slides.empty')}
									</p>{/if}
								{#if selectedBox && !editingId}
									<div
										class="selection-box"
										style:left={`${selectedBox.x}px`}
										style:top={`${selectedBox.y}px`}
										style:width={`${selectedBox.width}px`}
										style:height={`${selectedBox.height}px`}
										style:transform={`rotate(${selectedBox.rotation}deg)`}
									>
										{#each ['nw', 'ne', 'sw', 'se'] as handle (handle)}<button
												class="resize-handle {handle}"
												data-testid={'slide-resize-' + handle}
												aria-label={t('slides.resize', { handle })}
												onpointerdown={(event) =>
													gestures.startHandle(
														event,
														'resize',
														handle as 'nw' | 'ne' | 'sw' | 'se'
													)}
											></button>{/each}
										<button
											class="rotate-handle"
											data-testid="slide-rotate"
											aria-label={t('slides.rotate')}
											onpointerdown={(event) => gestures.startHandle(event, 'rotate')}>↻</button
										>
									</div>
								{/if}
								{#if editingElement}
									<textarea
										class="slide-text-editor"
										bind:this={textInput}
										data-testid="slide-text-editor"
										aria-label={t('slides.editText')}
										value={editingElement.content}
										style:left={`${editingElement.x}px`}
										style:top={`${editingElement.y}px`}
										style:width={`${editingElement.width}px`}
										style:height={`${editingElement.height}px`}
										style:font-size={`${editingElement.fontSize}px`}
										style:color={editingElement.color}
										style:background={editor.slide.background}
										style:transform={`rotate(${editingElement.rotation}deg)`}
										onkeydown={editKey}
										oninput={(event) => {
											if (editingElement) editingElement.content = event.currentTarget.value;
											editor.publish();
										}}></textarea>
								{/if}
								{#if gestures.guideX !== null}<div
										class="guide vertical"
										style:left={`${gestures.guideX}px`}
									></div>{/if}
								{#if gestures.guideY !== null}<div
										class="guide horizontal"
										style:top={`${gestures.guideY}px`}
									></div>{/if}
								{#if gestures.marquee}<div
										class="marquee"
										style:left={`${gestures.marquee.x}px`}
										style:top={`${gestures.marquee.y}px`}
										style:width={`${gestures.marquee.width}px`}
										style:height={`${gestures.marquee.height}px`}
									></div>{/if}
							{/if}
						</div>
					</div>
				</div>
				{#if editingId}<div class="text-tools">
						{@render action('text-bold', 'slides.bold', () => formatText('**'))}{@render action(
							'text-italic',
							'slides.italic',
							() => formatText('*')
						)}{@render action('text-list', 'slides.bulletList', () => formatText('- '))}
						<span>{t('slides.textHint')}</span><button
							class="primary"
							data-testid="slide-text-done"
							onclick={finishText}>{t('slides.textDone')}</button
						>
					</div>{/if}
				{#if overflow && !presenting}<p
						class="overflow-warning"
						role="status"
						data-testid="slide-overflow"
					>
						{t('slides.overflow')}
					</p>{/if}
				{#if !presenting}<label class="notes"
						><span>{t('slides.notes')}</span><textarea
							data-testid="slide-notes"
							placeholder={t('slides.notesPlaceholder')}
							value={editor.slide.notes}
							onfocus={() => {
								finishText();
								editor.begin();
							}}
							oninput={(event) => {
								editor.slide.notes = event.currentTarget.value;
								editor.publish();
							}}
							onblur={() => editor.commit()}></textarea></label
					>
				{:else if showNotes}<div class="present-notes" data-testid="slide-presenter-notes">
						{editor.slide.notes}
					</div>{/if}
			</div>
			{#if inspectorOpen && !presenting}<SlideInspector {editor} {multiSelect} />{/if}
		</div>
	{/if}
	<footer class="presentation-footer">
		{#if presenting}
			<button
				data-testid="slide-present-prev"
				aria-label={t('slides.previous')}
				disabled={editor.index === 0}
				onclick={() => go(editor.index - 1)}><ChevronLeft size={20} /></button
			><span>{editor.index + 1} / {editor.deck.slides.length}</span>
			<button
				data-testid="slide-present-next"
				aria-label={t('slides.next')}
				disabled={editor.index === editor.deck.slides.length - 1}
				onclick={() => go(editor.index + 1)}><ChevronRight size={20} /></button
			>
		{:else}
			<span>{t('slides.slide', { n: editor.index + 1 })} / {editor.deck.slides.length}</span>
			<span class="save-state" role="status"
				>{filesStore.saveErrorIds.includes(fileId)
					? t('statusBar.saveFailed')
					: filesStore.hasPendingSave
						? t('statusBar.saving')
						: t('stats.saved')}</span
			>
			{#if filesStore.saveErrorIds.includes(fileId)}<button
					data-testid="slide-retry-save"
					onclick={() =>
						void filesStore
							.flushPendingAwait()
							.catch((error) => reportError('retry slide save', error))}
					>{t('statusBar.retrySave')}</button
				>{/if}
			<span class="footer-hint" title={t('slides.shortcuts')}>{t('slides.selectionHint')}</span>
			<div class="zoom-controls">
				<button
					aria-label={t('slides.zoom') + ' -'}
					onclick={() => {
						gestures.zoom = Math.max(0.5, gestures.zoom - 0.25);
					}}><ZoomOut size={16} /></button
				>
				<button data-testid="slide-fit" onclick={gestures.resetView}
					>{gestures.zoom === 1 ? t('slides.fit') : `${Math.round(gestures.zoom * 100)}%`}</button
				>
				<button
					aria-label={t('slides.zoom') + ' +'}
					onclick={() => {
						gestures.zoom = Math.min(4, gestures.zoom + 0.25);
					}}><ZoomIn size={16} /></button
				>
			</div>
		{/if}
	</footer>
	<input
		bind:this={imageInput}
		data-testid="slide-image-input"
		type="file"
		accept="image/*"
		multiple
		hidden
		onchange={(event) => {
			void insertImages(Array.from(event.currentTarget.files ?? []));
			event.currentTarget.value = '';
		}}
	/>
</div>

<style>
	.presentation-editor {
		position: fixed;
		inset: 0;
		z-index: 55;
		display: flex;
		flex-direction: column;
		background: var(--color-bg);
		color: var(--color-fg);
		font-family: var(--font-sans, system-ui, sans-serif);
		outline: none;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 36px;
		padding: 6px 10px;
		border: 1px solid transparent;
		border-radius: 6px;
		font:
			12px/1.3 system-ui,
			sans-serif;
		color: inherit;
		background: transparent;
		cursor: pointer;
		white-space: nowrap;
	}
	button:hover {
		background: var(--color-bg-3);
	}
	button:disabled {
		opacity: 0.35;
		cursor: default;
	}
	button:focus-visible,
	input:focus-visible,
	textarea:focus-visible {
		outline: 3px solid var(--color-focus);
		outline-offset: 2px;
	}
	button.primary {
		background: var(--color-accent);
		color: var(--color-on-accent);
		padding-inline: 15px;
		font-weight: 650;
	}
	.presentation-header {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 62px;
		padding: 8px 16px;
		border-bottom: 1px solid var(--color-border);
		flex: none;
	}
	.presentation-brand {
		display: flex;
		gap: 10px;
		align-items: center;
		white-space: nowrap;
	}
	.presentation-signature {
		width: 128px;
		flex: none;
	}
	.brand-label {
		font-size: 13px;
	}
	.brand-label strong {
		font-weight: 600;
	}
	.presentation-name {
		width: 180px;
		min-width: 70px;
		max-width: 260px;
		padding: 6px 8px;
		border: 1px solid transparent;
		border-radius: 5px;
		font-size: 13px;
		background: transparent;
		color: var(--color-fg);
	}
	.presentation-name:hover,
	.presentation-name:focus {
		border-color: var(--color-border);
	}
	.header-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 3px;
	}
	.icon-button {
		padding: 8px;
	}
	.presentation-tools {
		min-width: 0;
		width: 100%;
		display: flex;
		align-items: center;
		gap: 3px;
		padding: 6px 12px;
		border-bottom: 1px solid var(--color-border);
		overflow-x: auto;
		flex: none;
	}
	.tool-separator {
		height: 22px;
		width: 1px;
		background: var(--color-border);
		margin: 0 6px;
		flex: none;
	}
	.presentation-tools > button,
	.selection-tools > button {
		flex: none;
	}
	button :global(svg) {
		flex: none;
	}
	.presentation-workspace {
		display: flex;
		flex: 1;
		min-height: 0;
		min-width: 0;
	}
	.slide-filmstrip {
		width: 174px;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--color-border);
		background: var(--color-bg-1);
		flex: none;
	}
	.filmstrip-actions {
		padding: 10px 6px;
		border-bottom: 1px solid var(--color-border);
	}
	.filmstrip-actions button {
		width: 100%;
		border-color: var(--color-border);
	}
	.thumbnails {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 12px 8px;
	}
	.slide-thumbnail {
		display: flex;
		align-items: flex-start;
		width: 100%;
		gap: 7px;
		padding: 6px 3px;
		margin-bottom: 10px;
		white-space: normal;
		border: 1px solid transparent;
		border-radius: 6px;
	}
	.slide-thumbnail.current {
		border-color: var(--color-accent);
		background: var(--color-bg-3);
	}
	.slide-number {
		font-size: 10px;
		width: 14px;
		flex: none;
		text-align: center;
		padding-top: 2px;
		color: var(--color-fg-muted);
	}
	.thumbnail-preview {
		position: relative;
		display: block;
		width: 100%;
		overflow: hidden;
		box-shadow: 0 1px 4px #0002;
		pointer-events: none;
	}
	.filmstrip-bottom {
		display: flex;
		justify-content: center;
		padding: 5px;
		border-top: 1px solid var(--color-border);
	}
	.filmstrip-bottom button {
		padding: 6px;
	}
	.stage-column {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		flex: 1;
	}
	.selection-tools {
		display: flex;
		align-items: center;
		overflow: auto;
		padding: 3px 10px;
		background: var(--color-bg-1);
		border-bottom: 1px solid var(--color-border);
		flex: none;
	}
	.selection-tools button {
		font-size: 11px;
	}
	.snap-control {
		margin-left: auto;
		padding: 0 8px;
		display: flex;
		gap: 6px;
		align-items: center;
		font-size: 11px;
		white-space: nowrap;
	}
	.slide-viewport {
		flex: 1;
		min-height: 80px;
		min-width: 0;
		display: flex;
		justify-content: center;
		align-items: center;
		overflow: hidden;
		background: var(--color-bg-2);
		touch-action: none;
		user-select: none;
	}
	.slide-positioner {
		flex: none;
		position: relative;
	}
	.slide-canvas {
		position: relative;
		transform-origin: top left;
		flex: none;
		box-shadow: 0 2px 12px #0003;
		isolation: isolate;
	}
	.slide-render {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
	}
	.presenting .slide-render {
		pointer-events: auto;
	}
	button.slide-object {
		position: absolute;
		min-height: 0;
		padding: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		cursor: move;
		touch-action: none;
	}
	button.slide-object:hover {
		outline: calc(1px / var(--slide-scale)) solid #2563eb80;
	}
	button.slide-object.selected {
		outline: calc(1px / var(--slide-scale)) solid #2563eb;
	}
	button.slide-object:focus-visible {
		outline: calc(2px / var(--slide-scale)) solid #2563eb;
	}
	.selection-box {
		position: absolute;
		pointer-events: none;
		outline: calc(1px / var(--slide-scale)) solid #2563eb;
		z-index: 5;
	}
	button.resize-handle {
		position: absolute;
		width: calc(12px / var(--slide-scale));
		height: calc(12px / var(--slide-scale));
		min-height: 0;
		padding: 0;
		border: calc(1.5px / var(--slide-scale)) solid #2563eb;
		border-radius: 0;
		background: #fff;
		pointer-events: auto;
		touch-action: none;
		transform: translate(-50%, -50%);
	}
	.resize-handle.nw {
		left: 0;
		top: 0;
		cursor: nwse-resize;
	}
	.resize-handle.ne {
		left: 100%;
		top: 0;
		cursor: nesw-resize;
	}
	.resize-handle.sw {
		left: 0;
		top: 100%;
		cursor: nesw-resize;
	}
	.resize-handle.se {
		left: 100%;
		top: 100%;
		cursor: nwse-resize;
	}
	button.rotate-handle {
		position: absolute;
		left: 50%;
		top: calc(-30px / var(--slide-scale));
		width: calc(22px / var(--slide-scale));
		height: calc(22px / var(--slide-scale));
		min-height: 0;
		padding: 0;
		border: calc(1px / var(--slide-scale)) solid #2563eb;
		border-radius: 50%;
		background: #fff;
		color: #1d4ed8;
		font-size: calc(16px / var(--slide-scale));
		pointer-events: auto;
		touch-action: none;
		transform: translateX(-50%);
		cursor: grab;
	}
	.slide-text-editor {
		position: absolute;
		z-index: 10;
		resize: none;
		border: 2px solid #2563eb;
		padding: 12px;
		line-height: 1.35;
		font-family: system-ui, sans-serif;
		user-select: text;
		touch-action: auto;
	}
	.empty-slide {
		position: absolute;
		top: 45%;
		left: 8%;
		width: 84%;
		text-align: center;
		font-size: 28px;
		color: #64748b;
		pointer-events: none;
	}
	.guide {
		position: absolute;
		z-index: 7;
		pointer-events: none;
		background: #e11d48;
	}
	.guide.vertical {
		top: 0;
		height: 100%;
		width: calc(1px / var(--slide-scale));
	}
	.guide.horizontal {
		left: 0;
		width: 100%;
		height: calc(1px / var(--slide-scale));
	}
	.marquee {
		position: absolute;
		border: 1px solid #2563eb;
		background: #2563eb20;
		pointer-events: none;
		z-index: 9;
	}
	.notes {
		border-top: 1px solid var(--color-border);
		padding: 8px 14px;
		background: var(--color-bg-1);
		flex: none;
	}
	.notes span {
		display: block;
		font-size: 11px;
		color: var(--color-fg-muted);
		margin-bottom: 4px;
	}
	.notes textarea {
		display: block;
		width: 100%;
		min-height: 38px;
		max-height: 120px;
		resize: vertical;
		background: transparent;
		border: 0;
		color: var(--color-fg);
		font:
			12px/1.4 system-ui,
			sans-serif;
	}
	.text-tools {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		background: var(--color-bg-1);
		flex: none;
	}
	.text-tools span {
		font-size: 11px;
		color: var(--color-fg-muted);
		margin-left: auto;
	}
	.presentation-footer {
		display: flex;
		min-height: 38px;
		gap: 14px;
		align-items: center;
		padding: 3px 14px;
		font-size: 11px;
		border-top: 1px solid var(--color-border);
		background: var(--color-bg-1);
		flex: none;
	}
	.save-state {
		color: var(--color-fg-muted);
		white-space: nowrap;
	}
	.footer-hint {
		color: var(--color-fg-muted);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.zoom-controls {
		display: flex;
		align-items: center;
		margin-left: auto;
		flex: none;
	}
	.zoom-controls button {
		min-height: 28px;
		padding: 3px 7px;
	}
	.source-panel {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		padding: 16px;
		gap: 12px;
	}
	.source-panel p {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--color-fg-muted);
	}
	.source-panel textarea {
		flex: 1;
		min-height: 0;
		width: 100%;
		padding: 16px;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		resize: none;
		background: var(--color-bg-1);
		color: var(--color-fg);
		font: 13px/1.6 var(--font-mono, monospace);
	}
	.message,
	.error,
	.overflow-warning {
		padding: 8px 14px;
		margin: 0;
		font-size: 12px;
		flex: none;
		background: var(--color-bg-3);
		color: var(--color-fg);
	}
	.error {
		color: var(--color-danger);
	}
	.message button {
		float: right;
		min-height: 20px;
		padding: 0 6px;
	}
	.presenting .presentation-header {
		min-height: 48px;
	}
	.presenting .presentation-footer {
		justify-content: center;
	}
	.present-count {
		flex: 1;
		text-align: center;
	}
	.present-notes {
		padding: 16px;
		white-space: pre-wrap;
		max-height: 25dvh;
		overflow: auto;
		font-size: 14px;
	}
	@media (max-width: 1100px) {
		.brand-label {
			display: none;
		}
		.presentation-name {
			width: 140px;
		}
		.footer-hint {
			display: none;
		}
	}
	@media (max-width: 767px) {
		.presentation-header {
			padding: 6px 8px;
			gap: 4px;
			min-height: 48px;
			flex-wrap: wrap;
		}
		.presentation-name {
			flex: 1;
			max-width: none;
		}
		.header-actions {
			order: 3;
			width: 100%;
			overflow-x: auto;
			border-top: 1px solid var(--color-border);
			padding-top: 4px;
		}
		.header-actions button {
			flex: none;
		}
		.presentation-tools {
			padding: 4px 6px;
		}
		.presentation-tools button {
			min-height: 40px;
		}
		.presentation-workspace {
			flex-direction: column;
		}
		.slide-filmstrip {
			width: 100%;
			height: 96px;
			flex-direction: row;
			border-right: 0;
			border-bottom: 1px solid var(--color-border);
		}
		.filmstrip-actions {
			display: flex;
			align-items: center;
			width: 62px;
			padding: 5px;
			border: 0;
		}
		.filmstrip-actions button {
			white-space: normal;
			flex-direction: column;
			font-size: 10px;
			height: 76px;
			padding: 4px;
		}
		.thumbnails {
			display: flex;
			gap: 6px;
			padding: 6px;
			overflow-x: auto;
			overflow-y: hidden;
		}
		.slide-thumbnail {
			width: 118px;
			margin: 0;
			padding: 5px 2px;
			flex: none;
		}
		.slide-number {
			width: 10px;
		}
		.filmstrip-bottom {
			display: grid;
			grid-template-columns: repeat(2, 44px);
			grid-template-rows: repeat(2, 44px);
			width: 96px;
			flex: none;
			padding: 3px;
			border: 0;
		}
		.filmstrip-bottom button {
			min-height: 36px;
			padding: 5px;
		}
		.selection-tools {
			padding: 2px 5px;
		}
		.snap-control {
			display: none;
		}
		.notes {
			padding: 6px 10px;
		}
		.notes textarea {
			min-height: 24px;
			height: 24px;
		}
		.presentation-footer {
			padding: 3px 7px;
			gap: 8px;
			font-size: 10px;
		}
		.text-tools {
			flex-wrap: wrap;
		}
		.text-tools span {
			display: none;
		}
		button.resize-handle {
			width: calc(20px / var(--slide-scale));
			height: calc(20px / var(--slide-scale));
		}
	}
</style>
