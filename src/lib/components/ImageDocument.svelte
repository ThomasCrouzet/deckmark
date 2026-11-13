<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		Download,
		Eraser,
		Highlighter,
		Image as ImageIcon,
		Pen,
		Redo2,
		Trash2,
		Undo2,
		ZoomIn,
		ZoomOut
	} from '@lucide/svelte';
	import type { FileItem } from '#lib/types.js';
	import { t } from '#lib/i18n/index.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { notify } from '#lib/notify.svelte.js';
	import { planBinaryView, type BinaryViewSnapshot } from '#lib/services/binary-view-plan.js';
	import {
		createBinaryRenderGate,
		loadBinaryImage,
		type PendingBinaryImage
	} from '#lib/services/binary-view-render.js';

	let { file }: { file: FileItem } = $props();

	const MAX_RENDER_PIXELS = 16_000_000;
	const MAX_EXPORT_PIXELS = 24_000_000;
	const COLORS = ['#f5c542', '#ff6b6b', '#4dabf7', '#51cf66'];

	interface Point {
		x: number;
		y: number;
	}
	interface Stroke {
		tool: 'pen' | 'highlighter' | 'eraser';
		color: string;
		size: number;
		points: Point[];
	}

	let canvas = $state<HTMLCanvasElement | null>(null);
	let scroller = $state<HTMLDivElement | null>(null);
	let tool = $state<'pen' | 'highlighter' | 'eraser'>('pen');
	let color = $state(COLORS[0]!);
	let size = $state(4);
	let zoom = $state(1);
	let strokes = $state<Stroke[]>([]);
	let redoStack = $state<Stroke[]>([]);
	let current: Stroke | null = null;
	let activePointer: number | null = null;
	let image: HTMLImageElement | null = null;
	let width = $state(0);
	let height = $state(0);
	let renderScale = 1;
	let loadError = $state(false);
	let pointerRect: DOMRect | null = null;
	let loadedGeneration = $state(-1);
	let replacing = $state(false);
	let replacedNotice = $state(false);
	let payload = $state<BinaryViewSnapshot | null>(null);
	let previousSnapshot: BinaryViewSnapshot | null = null;
	const decodeGate = createBinaryRenderGate();
	let pendingLoad: PendingBinaryImage | null = null;

	const exportReady = $derived(
		payload !== null && loadedGeneration === payload.generation && !replacing && !loadError
	);

	function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, scale: number) {
		if (stroke.points.length === 0) return;
		context.save();
		context.scale(scale, scale);
		context.lineCap = 'round';
		context.lineJoin = 'round';
		context.lineWidth =
			stroke.tool === 'highlighter'
				? stroke.size * 4
				: stroke.tool === 'eraser'
					? stroke.size * 5
					: stroke.size;
		context.strokeStyle = stroke.color;
		context.globalAlpha = stroke.tool === 'highlighter' ? 0.35 : 1;
		context.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
		context.beginPath();
		const [first, ...rest] = stroke.points;
		context.moveTo(first!.x, first!.y);
		for (const point of rest) context.lineTo(point.x, point.y);
		if (stroke.points.length === 1) context.lineTo(first!.x + 0.1, first!.y + 0.1);
		context.stroke();
		context.restore();
	}

	function redraw() {
		const element = canvas;
		if (!element) return;
		const context = element.getContext('2d');
		if (!context) return;
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, element.width, element.height);
		if (image) context.drawImage(image, 0, 0, element.width, element.height);
		for (const stroke of strokes) drawStroke(context, stroke, renderScale);
	}

	function pointFrom(event: PointerEvent): Point {
		const rect = pointerRect ?? canvas!.getBoundingClientRect();
		return {
			x: ((event.clientX - rect.left) / rect.width) * width,
			y: ((event.clientY - rect.top) / rect.height) * height
		};
	}

	function start(event: PointerEvent) {
		if (!canvas || !image || replacing || activePointer !== null || event.button !== 0) return;
		event.preventDefault();
		canvas.setPointerCapture(event.pointerId);
		activePointer = event.pointerId;
		pointerRect = canvas.getBoundingClientRect();
		current = { tool, color, size, points: [pointFrom(event)] };
		const context = canvas.getContext('2d');
		if (context) drawStroke(context, current, renderScale);
	}

	function move(event: PointerEvent) {
		if (activePointer !== event.pointerId || !current || !canvas) return;
		event.preventDefault();
		const context = canvas.getContext('2d');
		if (!context) return;
		context.save();
		context.scale(renderScale, renderScale);
		context.lineCap = 'round';
		context.lineJoin = 'round';
		context.lineWidth =
			current.tool === 'highlighter'
				? current.size * 4
				: current.tool === 'eraser'
					? current.size * 5
					: current.size;
		context.strokeStyle = current.color;
		context.globalAlpha = current.tool === 'highlighter' ? 0.35 : 1;
		context.globalCompositeOperation =
			current.tool === 'eraser' ? 'destination-out' : 'source-over';
		// One path per animation frame sample instead of one per pointer event.
		const samples =
			typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
		for (const sample of samples.length ? samples : [event]) {
			const point = pointFrom(sample);
			const previous = current.points[current.points.length - 1]!;
			if (point.x === previous.x && point.y === previous.y) continue;
			current.points.push(point);
			context.beginPath();
			context.moveTo(previous.x, previous.y);
			context.lineTo(point.x, point.y);
			context.stroke();
		}
		context.restore();
	}

	function end(event: PointerEvent) {
		if (activePointer !== event.pointerId) return;
		activePointer = null;
		if (current) {
			strokes = [...strokes, current];
			redoStack = [];
		}
		current = null;
		pointerRect = null;
		if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
	}

	function cancel(event: PointerEvent) {
		if (activePointer !== event.pointerId) return;
		activePointer = null;
		current = null;
		pointerRect = null;
		if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
		redraw();
	}

	function undo() {
		if (strokes.length === 0) return;
		redoStack = [...redoStack, strokes[strokes.length - 1]!];
		strokes = strokes.slice(0, -1);
		redraw();
	}

	function redo() {
		if (redoStack.length === 0) return;
		strokes = [...strokes, redoStack[redoStack.length - 1]!];
		redoStack = redoStack.slice(0, -1);
		redraw();
	}

	function clearInk() {
		strokes = [];
		redoStack = [];
		redraw();
	}

	function fitZoom() {
		const container = scroller;
		if (!container || !width || !height) return;
		const scale = Math.min(
			(container.clientWidth - 32) / width,
			(container.clientHeight - 32) / height,
			1
		);
		zoom = Math.max(0.1, Math.min(4, Number(scale.toFixed(2))));
	}

	$effect(() => {
		const plan = planBinaryView(previousSnapshot, { data: file.data, mime: file.mime });
		previousSnapshot = plan.snapshot;
		payload = plan.snapshot;
		if (plan.empty) {
			decodeGate.invalidate();
			pendingLoad?.release();
			pendingLoad = null;
			image = null;
			width = 0;
			height = 0;
			loadedGeneration = -1;
			loadError = true;
			replacing = false;
			return;
		}
		if (!plan.decode) return;
		const token = decodeGate.begin();
		replacing = true;
		loadError = false;
		if (plan.resetAnnotations) {
			strokes = [];
			redoStack = [];
			replacedNotice = true;
		}
		pendingLoad?.release();
		const request = loadBinaryImage(plan.snapshot.data!, token, decodeGate);
		pendingLoad = request;
		void request.result.then((loaded) => {
			if (pendingLoad === request) pendingLoad = null;
			if (!decodeGate.isCurrent(token)) return;
			if (!loaded) {
				image = null;
				width = 0;
				height = 0;
				loadedGeneration = -1;
				loadError = true;
				replacing = false;
				return;
			}
			image = loaded.image;
			width = loaded.width;
			height = loaded.height;
			loadedGeneration = plan.generation;
			renderScale = Math.min(1, Math.sqrt(MAX_RENDER_PIXELS / (width * height)));
			const target = canvas;
			if (!target) {
				replacing = false;
				return;
			}
			target.width = Math.max(1, Math.round(width * renderScale));
			target.height = Math.max(1, Math.round(height * renderScale));
			fitZoom();
			redraw();
			replacing = false;
		});
	});

	onDestroy(() => {
		decodeGate.invalidate();
		pendingLoad?.release();
		pendingLoad = null;
	});

	async function exportFlattened() {
		const current = payload;
		if (!image || !current || loadedGeneration !== current.generation || replacing) {
			notify.error(t('documents.imageExportStale'));
			return;
		}
		const exportName = file.name;
		const exportData = current.data;
		const exportWidth = width;
		const exportHeight = height;
		const exportImage = image;
		const exportStrokes = strokes.map((stroke) => ({
			...stroke,
			points: stroke.points.map((point) => ({ ...point }))
		}));
		if (exportWidth * exportHeight > MAX_EXPORT_PIXELS) {
			notify.error(t('documents.imageTooLarge'));
			return;
		}
		const output = document.createElement('canvas');
		output.width = exportWidth;
		output.height = exportHeight;
		const context = output.getContext('2d');
		if (!context) return;
		context.drawImage(exportImage, 0, 0, exportWidth, exportHeight);
		for (const stroke of exportStrokes) drawStroke(context, stroke, 1);
		const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
		if (!blob) {
			notify.error(t('documents.imageExportFailed'));
			return;
		}
		if (payload?.data !== exportData || file.data !== exportData) {
			notify.error(t('documents.imageExportStale'));
			return;
		}
		const { sanitizeFilename, triggerDownload } = await import('#lib/services/export.js');
		const name = exportName.replace(/\.[^.]+$/, '') || 'image';
		await triggerDownload(blob, sanitizeFilename(`${name}-annotated.png`));
	}

	const zoomPercent = $derived(Math.round(zoom * 100));
</script>

<div class="image-document" data-testid="image-document">
	<div class="image-toolbar">
		<span class="image-kind"><ImageIcon size={14} aria-hidden="true" />{t('documents.image')}</span>
		<span class="image-meta" data-testid="image-meta">{file.mime ?? 'image'} · {file.name}</span>
		<div class="ink-tools" role="toolbar" aria-label={t('annotations.toolbar')}>
			<button
				type="button"
				aria-pressed={tool === 'pen'}
				onclick={() => (tool = 'pen')}
				title={t('annotations.pen')}
				data-testid="image-pen"><Pen size={14} /></button
			>
			<button
				type="button"
				aria-pressed={tool === 'highlighter'}
				onclick={() => (tool = 'highlighter')}
				title={t('annotations.highlighter')}
				data-testid="image-highlighter"><Highlighter size={14} /></button
			>
			<button
				type="button"
				aria-pressed={tool === 'eraser'}
				onclick={() => (tool = 'eraser')}
				title={t('annotations.eraser')}
				data-testid="image-eraser"><Eraser size={14} /></button
			>
			{#each COLORS as swatch (swatch)}
				<button
					type="button"
					class="ink-color"
					class:active={color === swatch}
					style:background={swatch}
					aria-label={swatch}
					onclick={() => (color = swatch)}
				></button>
			{/each}
			<label class="ink-size">
				<input type="range" min="1" max="16" bind:value={size} aria-label={t('annotations.size')} />
			</label>
			<button
				type="button"
				onclick={undo}
				disabled={strokes.length === 0}
				title={t('annotations.undo')}
			>
				<Undo2 size={14} />
			</button>
			<button
				type="button"
				onclick={redo}
				disabled={redoStack.length === 0}
				title={t('annotations.redo')}
			>
				<Redo2 size={14} />
			</button>
			<button
				type="button"
				onclick={clearInk}
				title={t('annotations.clear')}
				data-testid="image-clear"
			>
				<Trash2 size={14} />
			</button>
		</div>
		<div class="zoom-controls">
			<button
				type="button"
				onclick={() => (zoom = Math.max(0.1, zoom - 0.1))}
				title={t('documents.zoomOut')}
			>
				<ZoomOut size={14} />
			</button>
			<span data-testid="image-zoom">{zoomPercent}%</span>
			<button
				type="button"
				onclick={() => (zoom = Math.min(4, zoom + 0.1))}
				title={t('documents.zoomIn')}
			>
				<ZoomIn size={14} />
			</button>
			<button type="button" onclick={fitZoom}>{t('documents.fit')}</button>
		</div>
		<button
			type="button"
			onclick={() => void exportFlattened()}
			disabled={!exportReady}
			data-testid="image-export"
		>
			<Download size={14} aria-hidden="true" />
			{t('documents.exportAnnotated')}
		</button>
		<button type="button" onclick={() => filesStore.export(file.id)}>{t('toolbar.export')}</button>
	</div>
	<div bind:this={scroller} class="image-viewport">
		{#if replacing}
			<p class="image-status" role="status" data-testid="image-loading">
				{t('documents.imageLoading')}
			</p>
		{/if}
		{#if replacedNotice && !loadError}
			<p class="image-status" role="status" data-testid="image-replaced-notice">
				{t('documents.imageReplaced')}
			</p>
		{/if}
		{#if loadError}
			<p role="alert">{t('documents.imageUnavailable')}</p>
		{:else}
			<canvas
				bind:this={canvas}
				class="image-canvas"
				style:width="{width * zoom}px"
				style:height="{height * zoom}px"
				data-testid="image-canvas"
				onpointerdown={start}
				onpointermove={move}
				onpointerup={end}
				onpointercancel={cancel}
				onlostpointercapture={cancel}
			></canvas>
		{/if}
	</div>
</div>

<style>
	.image-document {
		display: flex;
		height: 100%;
		min-height: 0;
		flex-direction: column;
	}
	.image-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-1);
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.image-kind {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--color-fg);
		font-weight: 500;
	}
	.image-meta {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 10px;
	}
	.ink-tools,
	.zoom-controls {
		display: flex;
		align-items: center;
		gap: 3px;
	}
	.image-toolbar button {
		display: inline-flex;
		min-height: 30px;
		align-items: center;
		justify-content: center;
		gap: 4px;
		padding: 3px 7px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		font-size: 11px;
		cursor: pointer;
	}
	.image-toolbar button[aria-pressed='true'] {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}
	.ink-color {
		width: 22px;
		padding: 0 !important;
	}
	.ink-color.active {
		outline: 2px solid var(--color-fg);
		outline-offset: 1px;
	}
	.ink-size input {
		width: 60px;
	}
	.image-viewport {
		display: block;
		min-height: 0;
		flex: 1;
		overflow: auto;
		padding: 16px;
		background: var(--color-bg);
	}
	.image-canvas {
		display: block;
		margin: 0 auto;
		touch-action: none;
		cursor: crosshair;
		box-shadow: var(--shadow-lg);
	}
	.image-status {
		margin: 0 0 8px;
		padding: 6px 10px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-1);
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	@media (max-width: 700px) {
		.image-meta {
			display: none;
		}
	}
</style>
