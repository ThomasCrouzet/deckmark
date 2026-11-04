import { browser } from '$app/env';
import { IS_DESKTOP_EDITION } from '#lib/edition.js';
import { t, type MessageKey } from '#lib/i18n/index.js';
import {
	AiProviderError,
	AI_DEFAULT_SETTINGS,
	type AiChatRequest,
	type AiErrorCode,
	type AiSettings,
	type NativeAiConfig
} from './types';

const STORAGE_KEY = 'mdsh:ai';
const SECRETS_SESSION_KEY = 'mdsh:ai-key';
const DEFAULT_PROVIDER = 'default';
const MAX_PROVIDER_LENGTH = 64;

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

/** Stable vault identifier for one provider endpoint. */
export function providerIdFor(baseUrl: string): string {
	try {
		return (
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- one-shot URL read, never state
			new URL(baseUrl).hostname
				.toLowerCase()
				.replace(/[^a-z0-9._-]/g, '-')
				.slice(0, MAX_PROVIDER_LENGTH) || DEFAULT_PROVIDER
		);
	} catch {
		return DEFAULT_PROVIDER;
	}
}

/** Loads the native bridge only when a desktop action needs it. */
async function nativeBridge() {
	return import('#lib/ai/native.js');
}

const NATIVE_ERRORS: Record<string, { code: AiErrorCode; message: MessageKey }> = {
	auth: { code: 'auth', message: 'ai.errorAuth' },
	'rate-limit': { code: 'rate-limit', message: 'ai.errorRateLimit' },
	server: { code: 'server', message: 'ai.errorServer' },
	network: { code: 'network', message: 'ai.errorNetwork' },
	'invalid-endpoint': { code: 'invalid-endpoint', message: 'ai.errorInvalidEndpoint' },
	'missing-key': { code: 'missing-key', message: 'ai.errorMissingKey' },
	disabled: { code: 'disabled', message: 'ai.errorDisabled' }
};

/** Converts a native error code to a user-facing provider error. */
export function nativeAiError(error: unknown): AiProviderError {
	if (error instanceof AiProviderError) return error;
	const raw = typeof error === 'string' ? error : '';
	const known = NATIVE_ERRORS[raw];
	if (known) return new AiProviderError(known.code, t(known.message));
	return new AiProviderError('network', t('ai.errorNetwork'));
}

class AiStore {
	settings = $state<AiSettings>({ ...AI_DEFAULT_SETTINGS });
	/** Web Light only. The desktop edition never stores the key in JavaScript. */
	private browserKey = $state('');
	/** Desktop Complete only. A boolean from the native vault, never the key. */
	private vaultKeyPresent = $state(false);
	loaded = $state(false);

	/** True when this build must use the native vault. */
	get usesNativeVault(): boolean {
		// The desktop edition never falls back to JavaScript key storage. If the
		// native shell is absent, the vault call fails closed.
		return IS_DESKTOP_EDITION;
	}

	load(): void {
		if (!browser || this.loaded) return;
		this.settings = readSettings();
		if (this.usesNativeVault) void this.refreshKeyStatus();
		else this.browserKey = readSessionKey();
		this.loaded = true;
	}

	get keyConfigured(): boolean {
		return this.usesNativeVault ? this.vaultKeyPresent : this.browserKey.length > 0;
	}

	get providerHost(): string {
		try {
			return new URL(this.settings.baseUrl).host;
		} catch {
			return this.settings.baseUrl;
		}
	}

	get providerId(): string {
		return providerIdFor(this.settings.baseUrl);
	}

	get canUseBrowserKey(): boolean {
		return this.settings.privacyMode === 'direct' && this.settings.allowBrowserKey;
	}

	/** Reads the presence of the key from the native vault. */
	async refreshKeyStatus(): Promise<void> {
		if (!this.usesNativeVault) {
			this.vaultKeyPresent = false;
			return;
		}
		try {
			const { vaultStatus } = await nativeBridge();
			this.vaultKeyPresent = await vaultStatus(this.providerId);
		} catch {
			this.vaultKeyPresent = false;
		}
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
		if (patch.baseUrl !== undefined && this.usesNativeVault) void this.refreshKeyStatus();
	}

	/** Sends the key to the native vault, or keeps it in session memory for Web Light. */
	async setApiKey(value: string): Promise<void> {
		const secret = value.trim();
		if (this.usesNativeVault) {
			if (!secret) {
				await this.clearApiKey();
				return;
			}
			const { vaultSet } = await nativeBridge();
			await vaultSet(this.providerId, secret);
			await this.refreshKeyStatus();
			return;
		}
		this.browserKey = secret;
		if (!browser) return;
		try {
			if (this.browserKey) sessionStorage.setItem(SECRETS_SESSION_KEY, this.browserKey);
			else sessionStorage.removeItem(SECRETS_SESSION_KEY);
		} catch {
			/* Session storage can be unavailable in hardened browsers. */
		}
	}

	async clearApiKey(): Promise<void> {
		if (this.usesNativeVault) {
			const { vaultDelete } = await nativeBridge();
			await vaultDelete(this.providerId);
			this.vaultKeyPresent = false;
			return;
		}
		this.browserKey = '';
		if (!browser) return;
		try {
			sessionStorage.removeItem(SECRETS_SESSION_KEY);
		} catch {
			/* Session storage can be unavailable in hardened browsers. */
		}
	}

	/** Loads a model list without sending document content. */
	async listModels(): Promise<string[]> {
		this.assertUsable(false, false);
		if (this.usesNativeVault)
			throw new AiProviderError('disabled', t('settings.aiModelsDesktopUnavailable'));
		const { listModels } = await import('./openai-compatible');
		return listModels(this.settings, this.browserKey || null);
	}

	/** Streams a completion. The caller owns cancellation through request.signal. */
	async chat(request: AiChatRequest, onDelta: (text: string) => void): Promise<string> {
		this.assertUsable(true);
		if (this.usesNativeVault) {
			const reply = await this.nativeChat(request);
			if (reply) onDelta(reply);
			return reply;
		}
		const { streamChat } = await import('./openai-compatible');
		return streamChat(this.settings, this.browserKey || null, request, onDelta);
	}

	async testConnection(signal?: AbortSignal): Promise<string> {
		this.assertUsable(false, false);
		const messages = [{ role: 'user' as const, content: 'Reply with OK.' }];
		const reply = this.usesNativeVault
			? await this.nativeChat({ messages, maxTokens: 8, ...(signal ? { signal } : {}) })
			: await this.browserChat({
					messages,
					maxTokens: 8,
					...(signal ? { signal } : {})
				});
		return reply.trim() || 'OK';
	}

	private async browserChat(request: AiChatRequest): Promise<string> {
		const { streamChat } = await import('./openai-compatible');
		return streamChat(this.settings, this.browserKey || null, request, () => {});
	}

	private async nativeChat(request: AiChatRequest): Promise<string> {
		const config: NativeAiConfig = {
			enabled: this.settings.enabled,
			baseUrl: this.settings.baseUrl,
			model: this.settings.model,
			temperature: request.temperature ?? this.settings.temperature,
			maxTokens: request.maxTokens ?? this.settings.maxTokens,
			provider: this.providerId
		};
		let reply: string;
		try {
			const { aiChat } = await nativeBridge();
			reply = await aiChat(config, request.messages);
		} catch (error) {
			throw nativeAiError(error);
		}
		if (request.signal?.aborted) throw new AiProviderError('cancelled', t('ai.errorCancelled'));
		return reply;
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
		if (this.usesNativeVault) {
			if (!this.vaultKeyPresent) throw new AiProviderError('missing-key', t('ai.errorMissingKey'));
			return;
		}
		if (!this.settings.allowBrowserKey)
			throw new AiProviderError(
				'privacy-consent',
				'Confirm that a browser-resident API key is exposed to this page.'
			);
		if (!this.browserKey) throw new AiProviderError('missing-key', t('ai.errorMissingKey'));
	}
}

export const aiStore = new AiStore();

/** User-facing action text for each provider error. */
export function aiErrorMessage(error: unknown): string {
	if (typeof error === 'string') {
		const known = NATIVE_ERRORS[error];
		if (known) return `${known.code}: ${t(known.message)}`;
	}
	if (error instanceof AiProviderError) return `${error.code}: ${error.message}`;
	return error instanceof Error ? error.message : String(error);
}
