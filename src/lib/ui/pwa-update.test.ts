import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The service worker lifecycle is a page singleton. Reload the module for each
 * case so a successful registration from one case cannot satisfy the next one.
 */
const pwa = vi.hoisted(() => ({
	basePath: '',
	update: vi.fn(async () => undefined),
	flush: vi.fn(async () => undefined),
	register: vi.fn()
}));

vi.mock('$app/paths', () => ({
	asset: (path: string) => `${pwa.basePath}/${path}`
}));

vi.mock('#lib/files.svelte.js', () => ({
	filesStore: { flushPendingAwait: pwa.flush }
}));

type Listener = () => void;

function makeWorker(initialState: ServiceWorker['state'] = 'installing') {
	const listeners = new Set<Listener>();
	const worker = {
		state: initialState,
		addEventListener: vi.fn((event: string, listener: Listener) => {
			if (event === 'statechange') listeners.add(listener);
		}),
		removeEventListener: vi.fn((_event: string, listener: Listener) => {
			listeners.delete(listener);
		}),
		emitStateChange() {
			for (const listener of listeners) listener();
		}
	};
	return worker;
}

type Registration = ReturnType<typeof makeRegistration>;

function makeRegistration() {
	const listeners = new Map<string, Set<Listener>>();
	const registration = {
		active: { state: 'activated' } as ServiceWorker | null,
		installing: null as ServiceWorker | null,
		waiting: null as ServiceWorker | null,
		update: pwa.update,
		addEventListener: vi.fn((event: string, listener: Listener) => {
			const set = listeners.get(event) ?? new Set<Listener>();
			set.add(listener);
			listeners.set(event, set);
		}),
		removeEventListener: vi.fn((event: string, listener: Listener) => {
			listeners.get(event)?.delete(listener);
		}),
		emit(event: string) {
			for (const listener of [...(listeners.get(event) ?? [])]) listener();
		},
		listenerCount(event: string) {
			return listeners.get(event)?.size ?? 0;
		}
	};
	return registration;
}

async function loadModule() {
	vi.resetModules();
	const [module, { offlineState }, { notify }] = await Promise.all([
		import('./pwa-update'),
		import('./offline.svelte.js'),
		import('#lib/notify.svelte.js')
	]);
	return { ...module, offlineState, notify };
}

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
	pwa.basePath = '';
	pwa.register.mockReset();
	pwa.update.mockReset().mockResolvedValue(undefined);
	pwa.flush.mockReset().mockResolvedValue(undefined);
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	vi.stubGlobal('navigator', {
		serviceWorker: {
			controller: {},
			register: (...args: unknown[]) => pwa.register(...args),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn()
		}
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('PWA update glue', () => {
	it('shares one registration and one hourly poller across repeated entry', async () => {
		vi.useFakeTimers();
		const registration = makeRegistration();
		pwa.register.mockResolvedValue(registration);
		const { registerPwaUpdates, retryOfflineSetup, offlineState } = await loadModule();

		registerPwaUpdates();
		registerPwaUpdates();
		await vi.waitFor(() => expect(offlineState.status).toBe('ready'));
		retryOfflineSetup();

		expect(pwa.register).toHaveBeenCalledTimes(1);
		expect(registration.listenerCount('updatefound')).toBe(1);

		await vi.advanceTimersByTimeAsync(3 * HOUR);
		expect(pwa.update).toHaveBeenCalledTimes(3);
	});

	it('keeps one poller when a retry supersedes a pending attempt', async () => {
		vi.useFakeTimers();
		const stale = makeRegistration();
		const current = makeRegistration();
		let resolveStale: (registration: Registration) => void = () => undefined;
		pwa.register
			.mockImplementationOnce(
				() =>
					new Promise<Registration>((resolve) => {
						resolveStale = resolve;
					})
			)
			.mockResolvedValueOnce(current);
		const { registerPwaUpdates, retryOfflineSetup, offlineState } = await loadModule();

		registerPwaUpdates();
		retryOfflineSetup();
		await vi.waitFor(() => expect(pwa.register).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(offlineState.status).toBe('ready'));

		resolveStale(stale);
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		expect(stale.listenerCount('updatefound')).toBe(0);
		expect(current.listenerCount('updatefound')).toBe(1);
		expect(pwa.update).toHaveBeenCalledTimes(2);
	});

	it('retries a failed setup without stacking pollers', async () => {
		vi.useFakeTimers();
		const registration = makeRegistration();
		pwa.register.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(registration);
		const { registerPwaUpdates, retryOfflineSetup, offlineState } = await loadModule();

		registerPwaUpdates();
		await vi.waitFor(() => expect(offlineState.status).toBe('error'));

		retryOfflineSetup();
		await vi.waitFor(() => expect(offlineState.status).toBe('ready'));
		expect(pwa.register).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(2 * HOUR);
		expect(pwa.update).toHaveBeenCalledTimes(2);
	});

	it('ignores a late failure from a superseded attempt', async () => {
		vi.useFakeTimers();
		const registration = makeRegistration();
		let rejectStale: (error: Error) => void = () => undefined;
		pwa.register
			.mockImplementationOnce(
				() =>
					new Promise<Registration>((_resolve, reject) => {
						rejectStale = reject;
					})
			)
			.mockResolvedValueOnce(registration);
		const { registerPwaUpdates, retryOfflineSetup, offlineState } = await loadModule();

		registerPwaUpdates();
		retryOfflineSetup();
		await vi.waitFor(() => expect(pwa.register).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(offlineState.status).toBe('ready'));

		rejectStale(new Error('stale failure'));
		await vi.advanceTimersByTimeAsync(0);
		expect(offlineState.status).toBe('ready');
		expect(registration.listenerCount('updatefound')).toBe(1);
	});

	it('offers one update action for a waiting worker', async () => {
		const registration = makeRegistration();
		pwa.register.mockResolvedValue(registration);
		const { registerPwaUpdates, notify } = await loadModule();
		registerPwaUpdates();
		await vi.waitFor(() => expect(registration.listenerCount('updatefound')).toBe(1));

		const installing = makeWorker('installing');
		registration.installing = installing as unknown as ServiceWorker;
		registration.emit('updatefound');
		registration.emit('updatefound');
		installing.state = 'installed';
		installing.emitStateChange();
		installing.emitStateChange();

		const actions = notify.toasts.filter((toast) => toast.action);
		expect(actions).toHaveLength(1);
	});

	it('flushes draft changes before update activation', async () => {
		const order: string[] = [];
		pwa.flush.mockImplementation(async () => {
			order.push('flush');
		});
		const activate = vi.fn(async () => {
			order.push('activate');
		});
		const { applyPwaUpdate } = await loadModule();

		expect(await applyPwaUpdate(activate)).toBe(true);
		expect(order).toEqual(['flush', 'activate']);
	});

	it('keeps the page on a failed draft flush', async () => {
		pwa.flush.mockRejectedValue(new Error('quota'));
		const activate = vi.fn(async () => undefined);
		const { applyPwaUpdate, notify } = await loadModule();

		expect(await applyPwaUpdate(activate)).toBe(false);
		expect(activate).not.toHaveBeenCalled();
		expect(notify.toasts.some((toast) => toast.level === 'error')).toBe(true);
	});

	it.each([
		['', '/sw.js'],
		['/deckmark', '/deckmark/sw.js']
	])('uses the base path %j for registration', async (basePath, expected) => {
		pwa.basePath = basePath;
		const registration = makeRegistration();
		pwa.register.mockResolvedValue(registration);
		const { registerPwaUpdates } = await loadModule();

		registerPwaUpdates();
		await vi.waitFor(() => expect(pwa.register).toHaveBeenCalledOnce());
		expect(pwa.register.mock.calls[0]?.[0]).toBe(expected);
	});
});
