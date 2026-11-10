// Native AI boundary for the Desktop Complete edition.
//
// The operating system credential store holds the key. The Rust layer sends
// the request. This module never receives a key value.

import { AiProviderError, type AiChatMessage, type NativeAiConfig } from './types';

export async function vaultSet(baseUrl: string, secret: string): Promise<void> {
	const { invoke } = await import('@tauri-apps/api/core');
	await invoke('vault_set', { baseUrl, secret });
}

export async function vaultStatus(baseUrl: string): Promise<boolean> {
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke<boolean>('vault_status', { baseUrl });
}

export async function vaultDelete(baseUrl: string): Promise<void> {
	const { invoke } = await import('@tauri-apps/api/core');
	await invoke('vault_delete', { baseUrl });
}

function createRequestId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
		return crypto.randomUUID();
	return `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Sends a native chat request. The request ID lets the Rust side cancel the
 * actual HTTP future when the caller aborts the signal.
 */
export async function aiChat(
	config: NativeAiConfig,
	messages: AiChatMessage[],
	signal?: AbortSignal
): Promise<string> {
	const { invoke } = await import('@tauri-apps/api/core');
	if (signal?.aborted) throw new AiProviderError('cancelled', 'cancelled');
	const requestId = createRequestId();
	const onAbort = () => {
		void invoke('ai_cancel', { requestId }).catch(() => {});
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		return await invoke<string>('ai_chat', { requestId, config, messages });
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}
