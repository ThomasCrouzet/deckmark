// Native AI boundary for the Desktop Complete edition.
//
// The operating system credential store holds the key. The Rust layer sends
// the request. This module never receives a key value.

import type { AiChatMessage, NativeAiConfig } from './types';

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

export async function aiChat(config: NativeAiConfig, messages: AiChatMessage[]): Promise<string> {
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke<string>('ai_chat', { config, messages });
}
