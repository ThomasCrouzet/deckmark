// Lazy OpenAI-compatible adapter. No AI module loads until a user action.

import {
	AiProviderError,
	type AiChatRequest,
	type AiProviderCapabilities,
	type AiProviderConfig
} from './types';

export const CAPABILITIES: AiProviderCapabilities = {
	streaming: true,
	modelDiscovery: true
};

function endpoint(baseUrl: string, path: string): string {
	const base = baseUrl.trim().replace(/\/+$/, '');
	if (!/^https?:\/\//i.test(base)) throw new AiProviderError('invalid-response', 'Invalid URL');
	return `${base}/${path.replace(/^\/+/, '')}`;
}

function headers(apiKey: string | null): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
	};
}

async function failure(response: Response): Promise<AiProviderError> {
	let detail = '';
	try {
		detail = (await response.text()).slice(0, 400);
	} catch {
		/* The status remains actionable. */
	}
	const message = detail || `Provider returned ${response.status}`;
	if (response.status === 401 || response.status === 403)
		return new AiProviderError('auth', message, response.status);
	if (response.status === 429) return new AiProviderError('rate-limit', message, response.status);
	if (response.status >= 500) return new AiProviderError('server', message, response.status);
	return new AiProviderError('invalid-response', message, response.status);
}

async function request(
	config: AiProviderConfig,
	apiKey: string | null,
	path: string,
	body: unknown,
	signal?: AbortSignal
): Promise<Response> {
	if (typeof fetch !== 'function') throw new AiProviderError('network', 'Fetch is unavailable.');
	let response: Response;
	try {
		response = await fetch(endpoint(config.baseUrl, path), {
			method: 'POST',
			headers: headers(apiKey),
			body: JSON.stringify(body),
			...(signal ? { signal } : {})
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError')
			throw new AiProviderError('cancelled', 'Request cancelled');
		if (error instanceof TypeError)
			throw new AiProviderError(
				'cors',
				'Network or CORS failure. Check the base URL and provider CORS policy.'
			);
		throw new AiProviderError('network', error instanceof Error ? error.message : String(error));
	}
	if (!response.ok) throw await failure(response);
	return response;
}

/** Lists model identifiers exposed by the provider. */
export async function listModels(
	config: AiProviderConfig,
	apiKey: string | null,
	signal?: AbortSignal
): Promise<string[]> {
	let response: Response;
	try {
		response = await fetch(endpoint(config.baseUrl, 'models'), {
			headers: headers(apiKey),
			...(signal ? { signal } : {})
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError')
			throw new AiProviderError('cancelled', 'Request cancelled');
		if (error instanceof TypeError)
			throw new AiProviderError('cors', 'Network or CORS failure while listing models.');
		throw new AiProviderError('network', error instanceof Error ? error.message : String(error));
	}
	if (!response.ok) throw await failure(response);
	const data = (await response.json()) as { data?: Array<{ id?: unknown }> };
	if (!Array.isArray(data.data))
		throw new AiProviderError('invalid-response', 'The provider did not return a model list.');
	return data.data
		.map((entry) => entry.id)
		.filter((id): id is string => typeof id === 'string' && id.length > 0)
		.sort();
}

interface StreamChunk {
	choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
}

/** Streams a chat completion and forwards text deltas. */
export async function streamChat(
	config: AiProviderConfig,
	apiKey: string | null,
	requestConfig: AiChatRequest,
	onDelta: (text: string) => void
): Promise<string> {
	const response = await request(
		config,
		apiKey,
		'chat/completions',
		{
			model: config.model,
			messages: requestConfig.messages,
			temperature: requestConfig.temperature ?? config.temperature,
			max_tokens: requestConfig.maxTokens ?? config.maxTokens,
			stream: true
		},
		requestConfig.signal
	);
	if (!response.body)
		throw new AiProviderError('invalid-response', 'The provider returned no body.');
	const reader = response.body.getReader();
	const maxResponseChars = 2_000_000;
	const decoder = new TextDecoder();
	let buffer = '';
	let full = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? '';
			if (buffer.length > maxResponseChars || full.length > maxResponseChars) {
				await reader.cancel().catch(() => {});
				throw new AiProviderError('invalid-response', 'The provider response is too large.');
			}
			for (const line of lines) {
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (!payload || payload === '[DONE]') continue;
				let chunk: StreamChunk;
				try {
					chunk = JSON.parse(payload) as StreamChunk;
				} catch {
					continue;
				}
				const choice = chunk.choices?.[0];
				const text = choice?.delta?.content ?? choice?.message?.content;
				if (typeof text === 'string' && text.length > 0) {
					full += text;
					if (full.length > maxResponseChars) {
						await reader.cancel().catch(() => {});
						throw new AiProviderError('invalid-response', 'The provider response is too large.');
					}
					onDelta(text);
				}
			}
		}
	} catch (error) {
		if (error instanceof AiProviderError) throw error;
		if (error instanceof DOMException && error.name === 'AbortError') {
			reader.cancel().catch(() => {});
			throw new AiProviderError('cancelled', 'Request cancelled');
		}
		throw new AiProviderError('network', error instanceof Error ? error.message : String(error));
	}
	return full;
}
