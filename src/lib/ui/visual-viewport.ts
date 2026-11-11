import type { Action } from 'svelte/action';

/**
 * Keep a fixed dialog inside the visible viewport when an on-screen keyboard,
 * browser chrome or pinch zoom changes the visual viewport. A fixed overlay
 * follows the layout viewport, so the focused field and the close control can
 * stay under the keyboard without this correction.
 */
export const visualViewportPanel: Action<HTMLElement> = (node) => {
	let frame = 0;
	const viewport = window.visualViewport;
	const panel = () => node.querySelector<HTMLElement>('.mdsh-dialog-panel');
	const clear = () => {
		node.style.removeProperty('top');
		node.style.removeProperty('height');
		panel()?.style.removeProperty('max-height');
	};
	const apply = () => {
		frame = 0;
		if (!viewport) return;
		if (viewport.height >= window.innerHeight - 1 && viewport.offsetTop <= 0) {
			clear();
			return;
		}
		const top = Math.max(0, Math.round(viewport.offsetTop));
		const height = Math.max(120, Math.round(viewport.height));
		node.style.top = `${top}px`;
		node.style.height = `${height}px`;
		const target = panel();
		if (target) {
			const style = getComputedStyle(node);
			const padding =
				(Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
			target.style.maxHeight = `${Math.max(120, height - padding)}px`;
		}
	};
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(apply);
	};
	viewport?.addEventListener('resize', schedule);
	viewport?.addEventListener('scroll', schedule);
	window.addEventListener('resize', schedule);
	schedule();
	return {
		destroy() {
			if (frame) cancelAnimationFrame(frame);
			viewport?.removeEventListener('resize', schedule);
			viewport?.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
			clear();
		}
	};
};
