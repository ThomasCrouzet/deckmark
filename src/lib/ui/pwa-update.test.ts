import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { notify } from '#lib/notify.svelte.js';

vi.mock('$app/paths', () => ({
	asset: (path: string) => `/mdsh/${path}`
}));

const pwa = vi.hoisted(() => ({
	registrationListeners: new Map<string, () => void>(),
	containerListeners: new Map<string, () => void>(),
	update: vi.fn(async () => undefined),
	flush: vi.fn(async () => undefined),
	register: vi.fn()
}));

vi.mock('#lib/files.svelte.js', () => ({
	filesStore: { flushPendingAwait: pwa.flush }
}));

beforeEach(() => {
	pwa.registrationListeners.clear();
	pwa.containerListeners.clear();
	const registration = {
		active: { state: 'activated' },
		installing: null,
		waiting: null,
		update: pwa.update,
		addEventListener: vi.fn((event: string, listener: () => void) => {
			pwa.registrationListeners.set(event, listener);
		})
	};
	pwa.register.mockReset().mockResolvedValue(registration);
	vi.stubGlobal('navigator', {
		serviceWorker: {
			controller: {},
			register: pwa.register,
			addEventListener: vi.fn((event: string, listener: () => void) => {
				pwa.containerListeners.set(event, listener);
			})
		}
	});
	notify.clear();
	pwa.update.mockClear();
	pwa.flush.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllGlobals());

describe('PWA update glue', () => {
	it('checks a long-lived registration periodically', async () => {
		vi.useFakeTimers();
		const { registerPwaUpdates } = await import('./pwa-update');
		registerPwaUpdates();
		await vi.waitFor(() => expect(pwa.register).toHaveBeenCalledOnce());
		expect(pwa.register.mock.calls[0]?.[0]).toMatch(/\/sw\.js$/);
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		expect(pwa.update).toHaveBeenCalledOnce();
		vi.useRealTimers();
	});

	it('uses the configured base path from a nested fallback URL', async () => {
		const base = document.createElement('base');
		base.href = 'http://localhost:5173/mdsh/fallback/';
		document.head.append(base);
		try {
			const { registerPwaUpdates } = await import('./pwa-update');
			registerPwaUpdates();
			await vi.waitFor(() => expect(pwa.register).toHaveBeenCalledOnce());
			expect(pwa.register.mock.calls[0]?.[0]).toBe('/mdsh/sw.js');
		} finally {
			base.remove();
		}
	});
});
