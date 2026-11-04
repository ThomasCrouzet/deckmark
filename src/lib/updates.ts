// Signed desktop update checks.
//
// The project still ships unsigned installers, so every path stays closed
// until a public signing key is configured. The native layer verifies the
// ed25519 signature, the platform and the version; this module only drives the
// user-triggered check and never installs anything.

import { IS_DESKTOP_EDITION } from './edition';

export interface UpdateStatus {
	configured: boolean;
	channel: string;
	publicKeyFingerprint?: string | null;
	blockedReason?: string | null;
}

export interface VerifiedUpdate {
	version: string;
	channel: string;
	platform: string;
	url: string;
	sha256: string;
	notes: string;
}

export function updatesSupported(): boolean {
	return IS_DESKTOP_EDITION;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
	if (!IS_DESKTOP_EDITION) throw new Error('desktop-only');
	const { invoke: call } = await import('@tauri-apps/api/core');
	return call<T>(command, args);
}

export async function updateStatus(): Promise<UpdateStatus> {
	return invoke<UpdateStatus>('update_status');
}

/** Verifies a manifest and its signature in the native layer. */
export async function verifyUpdateManifest(
	manifest: string,
	signature: string
): Promise<VerifiedUpdate> {
	return invoke<VerifiedUpdate>('update_verify_manifest', { manifest, signature });
}

/** Fetches and verifies the manifest of the configured channel. */
export async function checkForUpdates(): Promise<VerifiedUpdate> {
	return invoke<VerifiedUpdate>('update_check');
}

/**
 * Automatic installation is intentionally unavailable. The caller shows the
 * release page so the user installs a signed package outside the app.
 */
export async function installUpdate(): Promise<never> {
	await invoke('update_install');
	throw new Error('manual-install-required');
}
