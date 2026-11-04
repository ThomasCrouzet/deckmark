// Web Light boundary for the native AI bridge. This edition has no credential
// vault and no Rust request layer, so each call fails closed.

import type { AiChatMessage, NativeAiConfig } from '../../ai/types';

function unavailable(): Error {
	return new Error('The native AI boundary is not available in Web Light.');
}

export async function vaultSet(_provider: string, _secret: string): Promise<void> {
	throw unavailable();
}

export async function vaultStatus(_provider: string): Promise<boolean> {
	throw unavailable();
}

export async function vaultDelete(_provider: string): Promise<void> {
	throw unavailable();
}

export async function aiChat(_config: NativeAiConfig, _messages: AiChatMessage[]): Promise<string> {
	throw unavailable();
}
