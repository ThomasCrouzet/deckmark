export type AiPrivacyMode = 'direct' | 'local';

export interface AiProviderConfig {
	/** OpenAI-compatible API base URL, for example https://api.openai.com/v1. */
	baseUrl: string;
	model: string;
	temperature: number;
	maxTokens: number;
}

export interface AiSettings extends AiProviderConfig {
	enabled: boolean;
	privacyMode: AiPrivacyMode;
	/** Explicit opt-in for a browser-resident remote key. */
	allowBrowserKey: boolean;
}

export interface AiChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface AiChatRequest {
	messages: AiChatMessage[];
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
}

/** Configuration for the native chat command. It has no key field. */
export interface NativeAiConfig {
	enabled: boolean;
	baseUrl: string;
	model: string;
	temperature: number;
	maxTokens: number;
}

export interface AiProviderCapabilities {
	streaming: boolean;
	modelDiscovery: boolean;
}

export type AiErrorCode =
	| 'disabled'
	| 'missing-key'
	| 'privacy-consent'
	| 'network'
	| 'cors'
	| 'auth'
	| 'rate-limit'
	| 'server'
	| 'invalid-endpoint'
	| 'invalid-response'
	| 'cancelled';

export class AiProviderError extends Error {
	constructor(
		readonly code: AiErrorCode,
		message: string,
		readonly status?: number
	) {
		super(message);
		this.name = 'AiProviderError';
	}
}

export const AI_DEFAULT_SETTINGS: AiSettings = {
	enabled: false,
	privacyMode: 'direct',
	allowBrowserKey: false,
	baseUrl: 'https://api.openai.com/v1',
	model: '',
	temperature: 0.2,
	maxTokens: 1024
};
