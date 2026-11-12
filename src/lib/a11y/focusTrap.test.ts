import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { focusTrap } from './focusTrap';

// Treat connected elements as visible because jsdom does not calculate layout.
let original: PropertyDescriptor | undefined;
beforeAll(() => {
	original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getClientRects');
	Object.defineProperty(HTMLElement.prototype, 'getClientRects', {
		configurable: true,
		value(this: HTMLElement) {
			return this.isConnected ? [{}] : [];
		}
	});
});
afterAll(() => {
	if (original) Object.defineProperty(HTMLElement.prototype, 'getClientRects', original);
});

beforeEach(() => {
	document.body.innerHTML = '';
});

function makeContainer(n: number): { container: HTMLElement; buttons: HTMLElement[] } {
	const container = document.createElement('div');
	const buttons: HTMLElement[] = [];
	for (let i = 0; i < n; i++) {
		const b = document.createElement('button');
		b.textContent = `b${i}`;
		container.appendChild(b);
		buttons.push(b);
	}
	document.body.appendChild(container);
	return { container, buttons };
}

function tab(node: HTMLElement, shift = false): KeyboardEvent {
	const e = new KeyboardEvent('keydown', {
		key: 'Tab',
		shiftKey: shift,
		bubbles: true,
		cancelable: true
	});
	node.dispatchEvent(e);
	return e;
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('focusTrap', () => {
	it('prevents Tab without an error when the container has no focusable element', () => {
		const container = document.createElement('div');
		document.body.appendChild(container);
		focusTrap(container);
		const e = tab(container, false);
		expect(e.defaultPrevented).toBe(true);
	});

	it('attaches and detaches the trap when active changes', () => {
		const trigger = document.createElement('button');
		document.body.appendChild(trigger);
		trigger.focus();
		const { container, buttons } = makeContainer(2);
		const trap = focusTrap(container, { active: false });

		trap.update({ active: true });
		buttons[1]!.focus();
		const e1 = tab(container, false);
		expect(e1.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(buttons[0]);

		trap.update({ active: false });
		expect(document.activeElement).toBe(buttons[0]);
		const e2 = tab(container, false);
		expect(e2.defaultPrevented).toBe(false);
	});
});

describe('focusTrap initial focus', () => {
	it('moves focus to the first tabbable element after one frame', async () => {
		const trigger = document.createElement('button');
		document.body.appendChild(trigger);
		trigger.focus();
		const { container, buttons } = makeContainer(2);
		focusTrap(container);

		await nextFrame();
		expect(document.activeElement).toBe(buttons[0]);
	});

	it('focuses the container when no tabbable element exists', async () => {
		const container = document.createElement('div');
		container.tabIndex = -1;
		document.body.appendChild(container);
		focusTrap(container);

		await nextFrame();
		expect(document.activeElement).toBe(container);
	});

	it('keeps focus that is already inside the trap', async () => {
		const { container, buttons } = makeContainer(2);
		buttons[1]!.focus();
		focusTrap(container);

		await nextFrame();
		expect(document.activeElement).toBe(buttons[1]);
	});

	it('does not move focus when the trap mounts inactive and activates later', async () => {
		const trigger = document.createElement('button');
		document.body.appendChild(trigger);
		trigger.focus();
		const { container } = makeContainer(2);
		const trap = focusTrap(container, { active: false });

		trap.update({ active: true });
		await nextFrame();
		expect(document.activeElement).toBe(trigger);
	});

	it('does not focus a trap that is destroyed before its first frame', async () => {
		const trigger = document.createElement('button');
		document.body.appendChild(trigger);
		trigger.focus();
		const { container, buttons } = makeContainer(2);
		const trap = focusTrap(container);

		trap.destroy();
		await nextFrame();
		expect(document.activeElement).toBe(trigger);
		expect(document.activeElement).not.toBe(buttons[0]);
	});

	it('gives the newest trap the initial focus', async () => {
		const trigger = document.createElement('button');
		document.body.appendChild(trigger);
		trigger.focus();
		const { container: parent } = makeContainer(2);
		const child = document.createElement('div');
		const input = document.createElement('input');
		child.appendChild(input);
		document.body.appendChild(child);

		focusTrap(parent);
		focusTrap(child);

		await nextFrame();
		expect(document.activeElement).toBe(input);
	});
});

it('excludes tabindex=-1 results from the last Tab target', () => {
	const { container, buttons } = makeContainer(3);
	buttons[2]!.tabIndex = -1;
	focusTrap(container);
	buttons[1]!.focus();
	expect(tab(container).defaultPrevented).toBe(true);
	expect(document.activeElement).toBe(buttons[0]);
});

function makeDisclosure(
	container: HTMLElement,
	label: string,
	open = false
): { details: HTMLDetailsElement; summary: HTMLElement; action: HTMLElement } {
	const details = document.createElement('details');
	if (open) details.open = true;
	const summary = document.createElement('summary');
	summary.textContent = label;
	const action = document.createElement('button');
	action.textContent = `${label} action`;
	details.append(summary, action);
	container.appendChild(details);
	return { details, summary, action };
}

describe('focusTrap with native details summaries', () => {
	it('reaches collapsed summaries in forward order and wraps at them', () => {
		const { container, buttons } = makeContainer(2);
		makeDisclosure(container, 'Pages');
		const second = makeDisclosure(container, 'Assets');
		focusTrap(container);

		// The last button is no longer the end of the order: native Tab must run.
		buttons[1]!.focus();
		expect(tab(container).defaultPrevented).toBe(false);

		// The final summary is the real last tab stop.
		second.summary.focus();
		const wrap = tab(container);
		expect(wrap.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(buttons[0]);

		// Reverse traversal from the first control reaches the same summary.
		buttons[0]!.focus();
		const reverse = tab(container, true);
		expect(reverse.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(second.summary);
	});

	it('keeps expanded descendants in DOM order at the end of the loop', () => {
		const { container, buttons } = makeContainer(1);
		makeDisclosure(container, 'Pages', true);
		const second = makeDisclosure(container, 'Assets', true);
		focusTrap(container);

		// The last expanded action is the real end of the loop.
		second.action.focus();
		const forward = tab(container);
		expect(forward.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(buttons[0]);

		buttons[0]!.focus();
		const reverse = tab(container, true);
		expect(reverse.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(second.action);

		// The summary is an ordinary stop before its expanded content.
		second.summary.focus();
		expect(tab(container).defaultPrevented).toBe(false);
	});
});
