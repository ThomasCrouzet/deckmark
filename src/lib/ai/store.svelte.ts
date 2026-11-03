import { browser } from '$app/env';
import { AiProviderError, AI_DEFAULT_SETTINGS, type AiChatRequest, type AiSettings } from './types';

const STORAGE_KEY = 'mdsh:ai';
const SECRETS_SESSION_KEY = 'mdsh:ai-key';

function readSettings(): AiSettings {
	if (!browser) return { ...AI_DEFAULT_SETTINGS };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...AI_DEFAULT_SETTINGS };
		const value = JSON.parse(raw) as Partial<AiSettings>;
		return {
			...AI_DEFAULT_SETTINGS,
			enabled: value.enabled === true,
			privacyMode: value.privacyMode === 'local' ? 'local' : 'direct',
			allowBrowserKey: value.allowBrowserKey === true,
			baseUrl:
				typeof value.baseUrl === 'string' && value.baseUrl.trim()
					? value.baseUrl.trim()
					: AI_DEFAULT_SETTINGS.baseUrl,
			model: typeof value.model === 'string' ? value.model : '',
			temperature:
				typeof value.temperature === 'number' && value.temperature >= 0
					? Math.min(2, value.temperature)
					: AI_DEFAULT_SETTINGS.temperature,
			maxTokens:
				typeof value.maxTokens === 'number' && value.maxTokens > 0
					? Math.min(32000, Math.trunc(value.maxTokens))
					: AI_DEFAULT_SETTINGS.maxTokens
		};
	} catch {
		return { ...AI_DEFAULT_SETTINGS };
	}
}

function readSessionKey(): string {
	if (!browser) return '';
	try {
		return sessionStorage.getItem(SECRETS_SESSION_KEY) ?? '';
	} catch {
		return '';
	}
}

class AiStore {
	settings = $state<AiSettings>({ ...AI_DEFAULT_SETTINGS });
	/** Session-only secret. Never written to localStorage or IndexedDB. */
	private apiKey = $state('');
	loaded = $state(false);

	load(): void {
		if (!browser || this.loaded) return;
		this.settings = readSettings();
		this.apiKey = readSessionKey();
		this.loaded = true;
	}

	get keyConfigured(): boolean {
		return this.apiKey.length > 0;
	}

	get providerHost(): string {
		try {
			return new URL(this.settings.baseUrl).host;
		} catch {
			return this.settings.baseUrl;
		}
	}

	get canUseBrowserKey(): boolean {
		return this.settings.privacyMode === 'direct' && this.settings.allowBrowserKey;
	}

	update(patch: Partial<AiSettings>): void {
		this.settings = { ...this.settings, ...patch };
		if (browser) {
			try {
				const { enabled, privacyMode, allowBrowserKey, baseUrl, model, temperature, maxTokens } =
					this.settings;
				localStorage.setItem(
					STORAGE_KEY,
					JSON.stringify({
						enabled,
						privacyMode,
						allowBrowserKey,
						baseUrl,
						model,
						temperature,
						maxTokens
					})
				);
			} catch {
				/* A blocked preference store keeps the session configuration only. */
			}
		}
	}

	setApiKey(value: string): void {
		this.apiKey = value.trim();
		if (!browser) return;
		try {
			if (this.apiKey) sessionStorage.setItem(SECRETS_SESSION_KEY, this.apiKey);
			else sessionStorage.removeItem(SECRETS_SESSION_KEY);
		} catch {
			/* Session storage can be unavailable in hardened browsers. */
		}
	}

	clearApiKey(): void {
		this.setApiKey('');
	}

	/** Loads a model list without sending document content. */
	async listModels(): Promise<string[]> {
		this.assertUsable(false, false);
		const { listModels } = await import('./openai-compatible');
		return listModels(this.settings, this.apiKey || null);
	}

	/** Streams a completion. The caller owns cancellation through request.signal. */
	async chat(request: AiChatRequest, onDelta: (text: string) => void): Promise<string> {
		this.assertUsable(true);
		const { streamChat } = await import('./openai-compatible');
		return streamChat(this.settings, this.apiKey || null, request, onDelta);
	}

	async testConnection(signal?: AbortSignal): Promise<string> {
		this.assertUsable(false, false);
		const { streamChat } = await import('./openai-compatible');
		const reply = await streamChat(
			this.settings,
			this.apiKey || null,
			{
				messages: [{ role: 'user', content: 'Reply with OK.' }],
				maxTokens: 8,
				...(signal ? { signal } : {})
			},
			() => {}
		);
		return reply.trim() || 'OK';
	}

	assertUsable(requiresModel: boolean, requiresEnabled = true): void {
		if (requiresEnabled && !this.settings.enabled)
			throw new AiProviderError('disabled', 'AI is disabled. Enable it in Settings.');
		if (this.settings.privacyMode === 'local')
			throw new AiProviderError(
				'disabled',
				'Local inference is not available in this build. Use a local provider base URL with the direct mode.'
			);
		if (!this.settings.baseUrl.trim())
			throw new AiProviderError('invalid-response', 'Set a provider base URL.');
		if (requiresModel && !this.settings.model.trim())
			throw new AiProviderError('invalid-response', 'Select a model before sending a request.');
		if (!this.settings.allowBrowserKey)
			throw new AiProviderError(
				'privacy-consent',
				'Confirm that a browser-resident API key is exposed to this page.'
			);
		if (!this.apiKey)
			throw new AiProviderError('missing-key', 'Enter an API key for this provider.');
	}
}

export const aiStore = new AiStore();

/** User-facing action text for each provider error. */
export function aiErrorMessage(error: unknown): string {
	if (error instanceof AiProviderError) return `${error.code}: ${error.message}`;
	return error instanceof Error ? error.message : String(error);
}
