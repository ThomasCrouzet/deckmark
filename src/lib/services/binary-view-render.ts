// Render helpers for binary documents. A decode can outlive the input that
// started it. The gate rejects that older completion. The object URL slot
// replaces one displayed URL and revokes the URL that it no longer shows.

export interface BinaryRenderGate {
	begin(): number;
	isCurrent(token: number): boolean;
	invalidate(): void;
}

export function createBinaryRenderGate(): BinaryRenderGate {
	let generation = 0;
	return {
		begin: () => ++generation,
		isCurrent: (token) => token === generation,
		invalidate: () => {
			generation += 1;
		}
	};
}

export interface BinaryObjectUrlSlot {
	readonly current: string | null;
	replace(url: string): void;
	clear(): void;
}

export function createObjectUrlSlot(
	revoke: (url: string) => void = (url) => URL.revokeObjectURL(url)
): BinaryObjectUrlSlot {
	let current: string | null = null;
	return {
		get current() {
			return current;
		},
		replace(url) {
			if (url === current) return;
			const previous = current;
			current = url;
			if (previous) revoke(previous);
		},
		clear() {
			const previous = current;
			current = null;
			if (previous) revoke(previous);
		}
	};
}

export interface LoadedBinaryImage {
	image: HTMLImageElement;
	width: number;
	height: number;
}

export interface PendingBinaryImage {
	result: Promise<LoadedBinaryImage | null>;
	release(): void;
}

/**
 * Starts an image decode. The result is null for a failed image, a zero-size
 * image, a cancelled load, or a completion from an older token.
 */
export function loadBinaryImage(
	data: string,
	token: number,
	gate: BinaryRenderGate
): PendingBinaryImage {
	const element = new Image();
	element.referrerPolicy = 'no-referrer';
	let settled = false;
	let resolveResult: (value: LoadedBinaryImage | null) => void = () => {};
	const result = new Promise<LoadedBinaryImage | null>((resolve) => {
		resolveResult = resolve;
	});
	const settle = (value: LoadedBinaryImage | null) => {
		if (settled) return;
		settled = true;
		resolveResult(value);
	};
	const release = () => {
		element.onload = null;
		element.onerror = null;
		element.removeAttribute('src');
		settle(null);
	};
	element.onload = () => {
		if (!gate.isCurrent(token)) {
			release();
			return;
		}
		const width = element.naturalWidth;
		const height = element.naturalHeight;
		settle(width && height ? { image: element, width, height } : null);
	};
	element.onerror = () => settle(null);
	element.src = data;
	return { result, release };
}
