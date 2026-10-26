import { browser } from '$app/env';
import { asset } from '$app/paths';
import { isDesktop } from '#lib/desktop.js';
import { t } from '#lib/i18n/index.js';
import { notify } from '#lib/notify.svelte.js';
import { reportWarning } from '#lib/report.js';
import { offlineState } from './offline.svelte.js';

const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const ACTIVATION_TIMEOUT_MS = 15_000;

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

function offerUpdate(worker: ServiceWorker): void {
	notify.actionable(t('pwa.updateAvailable'), {
		label: t('pwa.reload'),
		run: () => void applyPwaUpdate(() => activateWorker(worker))
	});
}

function trackInstallation(worker: ServiceWorker): void {
	const handleState = () => {
		if (worker.state !== 'installed') return;
		if (navigator.serviceWorker.controller) {
			offerUpdate(worker);
			return;
		}
		offlineState.status = 'ready';
		notify.success(t('pwa.offlineReady'));
	};
	worker.addEventListener('statechange', handleState);
	handleState();
}

export function registerPwaUpdates(): void {
	if (!browser) return;
	if (isDesktop()) {
		offlineState.status = 'ready';
		return;
	}
	if (!('serviceWorker' in navigator)) {
		offlineState.status = 'unavailable';
		return;
	}

	void (async () => {
		try {
			const serviceWorkerUrl = asset('sw.js' as Parameters<typeof asset>[0]);
			const registration = await navigator.serviceWorker.register(serviceWorkerUrl, {
				updateViaCache: 'none'
			});

			if (registration.active?.state === 'activated') offlineState.status = 'ready';
			if (registration.waiting && navigator.serviceWorker.controller) {
				offerUpdate(registration.waiting);
			}
			if (registration.installing) trackInstallation(registration.installing);
			registration.addEventListener('updatefound', () => {
				if (registration.installing) trackInstallation(registration.installing);
			});

			setInterval(() => {
				void registration
					.update()
					.catch((error: unknown) => reportWarning('check application update', error));
			}, UPDATE_INTERVAL_MS);
		} catch (error) {
			offlineState.status = 'error';
			reportWarning('register service worker', error);
		}
	})();
}
