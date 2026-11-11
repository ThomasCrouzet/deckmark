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
	tracked: WeakSet<ServiceWorker>;
	offered: WeakSet<ServiceWorker>;
	readyAnnounced: boolean;
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

function offerUpdate(current: UpdateLifecycle, worker: ServiceWorker): void {
	if (current.offered.has(worker)) return;
	current.offered.add(worker);
	notify.actionable(t('pwa.updateAvailable'), {
		label: t('pwa.reload'),
		run: () => void applyPwaUpdate(() => activateWorker(worker))
	});
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
	lifecycle = {
		registration,
		timer,
		onUpdateFound,
		tracked: new WeakSet(),
		offered: new WeakSet(),
		readyAnnounced: false
	};
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
