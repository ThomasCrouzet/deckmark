import { browser } from '$app/env';
import { asset } from '$app/paths';
import { isDesktop } from '#lib/desktop.js';
import { t } from '#lib/i18n/index.js';
import { notify } from '#lib/notify.svelte.js';
import { reportWarning } from '#lib/report.js';
import { offlineState } from './offline.svelte.js';

const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const ACTIVATION_TIMEOUT_MS = 15_000;

/**
 * One page owns one service worker lifecycle: one update poller and one
 * `updatefound` listener. Repeated entry into the registration flow shares the
 * in-flight attempt instead of stacking pollers.
 */
interface UpdateLifecycle {
	registration: ServiceWorkerRegistration;
	timer: ReturnType<typeof setInterval>;
	onUpdateFound: () => void;
	onVisibilityChange: () => void;
	tracked: WeakSet<ServiceWorker>;
	offered: WeakSet<ServiceWorker>;
	readyAnnounced: boolean;
	/** One re-offer per foregrounding, reset when the page becomes hidden. */
	reofferedInForeground: boolean;
}

let generation = 0;
let inFlight: Promise<void> | null = null;
let lifecycle: UpdateLifecycle | null = null;

async function ensureDraftsDurable(): Promise<void> {
	const { filesStore } = await import('#lib/files.svelte.js');
	await filesStore.flushPendingAwait();
}

export async function applyPwaUpdate(
	activateUpdate: (reloadPage?: boolean) => Promise<void>,
	ensureDurable: () => Promise<void> = ensureDraftsDurable
): Promise<boolean> {
	try {
		await ensureDurable();
		await activateUpdate(true);
		return true;
	} catch {
		notify.error(t('storage.saveFailed'));
		return false;
	}
}

async function activateWorker(worker: ServiceWorker): Promise<void> {
	if (worker.state === 'activated') {
		window.location.reload();
		return;
	}

	await new Promise<void>((resolve, reject) => {
		const onControllerChange = () => {
			clearTimeout(timeout);
			resolve();
		};
		const timeout = setTimeout(() => {
			navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
			reject(new Error('Service worker activation timed out.'));
		}, ACTIVATION_TIMEOUT_MS);

		navigator.serviceWorker.addEventListener('controllerchange', onControllerChange, {
			once: true
		});
		try {
			worker.postMessage({ type: 'SKIP_WAITING' });
		} catch (error) {
			clearTimeout(timeout);
			navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
			reject(error);
		}
	});

	window.location.reload();
}

function presentUpdate(current: UpdateLifecycle, worker: ServiceWorker): void {
	current.offered.add(worker);
	notify.actionable(t('pwa.updateAvailable'), {
		label: t('pwa.reload'),
		run: () => void applyPwaUpdate(() => activateWorker(worker))
	});
}

function offerUpdate(current: UpdateLifecycle, worker: ServiceWorker): void {
	if (current.offered.has(worker)) return;
	presentUpdate(current, worker);
}

/**
 * A dismissed prompt is not recreated by `updatefound` or by the hourly
 * `registration.update()`. Offer it again when the page returns to the
 * foreground, at most once per foregrounding, while a worker still waits.
 */
function reofferUpdate(current: UpdateLifecycle, worker: ServiceWorker): void {
	if (current.reofferedInForeground) return;
	current.reofferedInForeground = true;
	presentUpdate(current, worker);
}

function trackInstallation(worker: ServiceWorker): void {
	const current = lifecycle;
	if (!current || current.tracked.has(worker)) return;
	current.tracked.add(worker);

	const handleState = () => {
		// A replaced registration must not change the visible offline state.
		if (lifecycle !== current) return;
		if (worker.state !== 'installed') return;
		if (navigator.serviceWorker.controller) {
			offerUpdate(current, worker);
			return;
		}
		if (current.readyAnnounced) return;
		current.readyAnnounced = true;
		offlineState.status = 'ready';
		notify.success(t('pwa.offlineReady'));
	};
	worker.addEventListener('statechange', handleState);
	handleState();
}

function disposeLifecycle(): void {
	if (!lifecycle) return;
	clearInterval(lifecycle.timer);
	lifecycle.registration.removeEventListener('updatefound', lifecycle.onUpdateFound);
	document.removeEventListener('visibilitychange', lifecycle.onVisibilityChange);
	lifecycle = null;
}

function attachRegistration(registration: ServiceWorkerRegistration): void {
	if (lifecycle?.registration === registration) return;
	disposeLifecycle();

	const onUpdateFound = () => {
		if (registration.installing) trackInstallation(registration.installing);
	};
	registration.addEventListener('updatefound', onUpdateFound);
	const timer = setInterval(() => {
		void registration
			.update()
			.catch((error: unknown) => reportWarning('check application update', error));
	}, UPDATE_INTERVAL_MS);
	const onVisibilityChange = () => {
		// A replaced registration must not reopen a prompt.
		const current = lifecycle;
		if (!current || current.registration !== registration) return;
		if (document.visibilityState === 'hidden') {
			current.reofferedInForeground = false;
			return;
		}
		if (document.visibilityState !== 'visible') return;
		const waiting = registration.waiting;
		if (!waiting || !navigator.serviceWorker.controller) return;
		reofferUpdate(current, waiting);
	};
	const current: UpdateLifecycle = {
		registration,
		timer,
		onUpdateFound,
		onVisibilityChange,
		tracked: new WeakSet(),
		offered: new WeakSet(),
		readyAnnounced: false,
		reofferedInForeground: false
	};
	lifecycle = current;
	document.addEventListener('visibilitychange', onVisibilityChange);
}

async function registerWorker(attempt: number): Promise<void> {
	try {
		const serviceWorkerUrl = asset('sw.js' as Parameters<typeof asset>[0]);
		const registration = await navigator.serviceWorker.register(serviceWorkerUrl, {
			updateViaCache: 'none'
		});
		// A superseded attempt must not touch the current registration,
		// timer or offline state.
		if (attempt !== generation) return;

		attachRegistration(registration);
		if (registration.active?.state === 'activated') offlineState.status = 'ready';
		const current = lifecycle;
		if (current && registration.waiting && navigator.serviceWorker.controller) {
			offerUpdate(current, registration.waiting);
		}
		if (registration.installing) trackInstallation(registration.installing);
	} catch (error) {
		if (attempt !== generation) return;
		offlineState.status = 'error';
		reportWarning('register service worker', error);
	}
}

function beginAttempt(): void {
	const attempt = ++generation;
	offlineState.status = 'preparing';
	inFlight = registerWorker(attempt).finally(() => {
		if (attempt === generation) inFlight = null;
	});
}

function startRegistration(supersede: boolean): void {
	if (!browser) return;
	if (isDesktop()) {
		offlineState.status = 'ready';
		return;
	}
	if (!('serviceWorker' in navigator)) {
		offlineState.status = 'unavailable';
		return;
	}

	if (lifecycle) return;
	// Ordinary entries share the attempt in flight. An explicit retry may
	// replace a hung attempt; only the newest generation controls the state.
	if (inFlight && !supersede) return;
	beginAttempt();
}

/** Retry service worker registration after a failed offline preparation. */
export function retryOfflineSetup(): void {
	startRegistration(true);
}

export function registerPwaUpdates(): void {
	startRegistration(false);
}
