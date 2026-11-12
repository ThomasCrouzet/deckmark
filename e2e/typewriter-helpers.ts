import { expect, type Page } from '@playwright/test';
import type { EditorView } from '@codemirror/view';

type QueuedMeasureView = EditorView & { measureRequests?: unknown[] };

export interface TypewriterSamples {
	frames: number[];
	maxPending: number;
	centerHeads: number[];
	detachedDispatches: number;
	head: number;
	anchor: number;
	centerError: number | null;
}

declare global {
	interface Window {
		typewriterProbe: {
			ready: () => Promise<void>;
			burst: (count: number, select: boolean) => void;
			sample: () => TypewriterSamples;
			settle: () => Promise<void>;
		};
	}
}

export async function installTypewriterProbe(page: Page) {
	await page.locator('.cm-content').evaluate((element) => {
		// The DOM tile gives the probe the mounted view without a shipped test API.
		const view = (element as HTMLElement & { cmTile: { root: { view: EditorView } } }).cmTile.root
			.view;
		const originalFrame = window.requestAnimationFrame.bind(window);
		const originalCancel = window.cancelAnimationFrame.bind(window);
		const pending = new Set<number>();
		let maxPending = 0;
		let frames: number[] = [];
		let centerHeads: number[] = [];
		let detachedDispatches = 0;
		let centerSerial = 0;
		window.requestAnimationFrame = (callback) => {
			const id = originalFrame((time) => {
				pending.delete(id);
				callback(time);
			});
			pending.add(id);
			maxPending = Math.max(maxPending, pending.size);
			return id;
		};
		window.cancelAnimationFrame = (id) => {
			pending.delete(id);
			originalCancel(id);
		};
		view.dispatch = new Proxy(view.dispatch, {
			apply(target, receiver, args) {
				if (!view.dom.isConnected) detachedDispatches += 1;
				for (const argument of args) {
					const effects = argument.effects ? [argument.effects].flat() : [];
					for (const effect of effects) {
						if (effect.value?.y === 'center') {
							centerSerial += 1;
							centerHeads.push(effect.value.range.head);
						}
					}
				}
				return Reflect.apply(target, receiver, args);
			}
		});
		window.typewriterProbe = {
			async ready() {
				const deadline = performance.now() + 2_000;
				const fail = (reason: string): never => {
					const queue = (view as QueuedMeasureView).measureRequests;
					throw new Error(
						`typewriter probe ready: ${reason} (queue=${
							Array.isArray(queue) ? queue.length : 'unavailable'
						} centerSerial=${centerSerial})`
					);
				};
				let quietFrames = 0;
				let framesWaited = 0;
				let lastSerial = centerSerial;
				while (quietFrames < 2) {
					if (!view.dom.isConnected) fail('view is detached');
					const queue = (view as QueuedMeasureView).measureRequests;
					if (!Array.isArray(queue)) fail('measure queue is unavailable');
					if (framesWaited >= 120 || performance.now() >= deadline) fail('deadline expired');
					await new Promise<number>((resolve) => originalFrame(resolve));
					framesWaited += 1;
					if (!view.dom.isConnected) fail('view is detached after a frame');
					const measuredQueue = (view as QueuedMeasureView).measureRequests;
					if (!Array.isArray(measuredQueue)) fail('measure queue is unavailable after a frame');
					const serial = centerSerial;
					if (measuredQueue.length === 0 && serial === lastSerial) quietFrames += 1;
					else quietFrames = 0;
					lastSerial = serial;
				}
			},
			burst(count, select) {
				maxPending = pending.size;
				centerHeads = [];
				frames = [];
				view.focus();
				for (let i = 0; i < count; i += 1) {
					view.contentDOM.dispatchEvent(
						new KeyboardEvent('keydown', {
							key: 'ArrowRight',
							code: 'ArrowRight',
							keyCode: 39,
							shiftKey: select,
							bubbles: true,
							cancelable: true
						})
					);
				}
			},
			async settle() {
				let previous = performance.now();
				for (let i = 0; i < 20; i += 1) {
					const now = await new Promise<number>((resolve) => originalFrame(resolve));
					frames.push(now - previous);
					previous = now;
				}
			},
			sample() {
				const { head, anchor } = view.state.selection.main;
				const caret = view.dom.isConnected ? view.coordsAtPos(head) : null;
				const bounds = view.scrollDOM.getBoundingClientRect();
				return {
					frames,
					maxPending,
					centerHeads,
					detachedDispatches,
					head,
					anchor,
					centerError: caret ? (caret.top + caret.bottom - bounds.top - bounds.bottom) / 2 : null
				};
			}
		};
	});
}

export async function enableTypewriter(page: Page) {
	await page.getByRole('button', { name: 'Palette de commandes', exact: true }).click();
	await page.getByRole('dialog').getByRole('combobox').fill('typewriter');
	await page.getByRole('option', { name: /Activer le mode typewriter/ }).click();
	await expect(page.locator('body')).toHaveClass(/typewriter-mode/);
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}
