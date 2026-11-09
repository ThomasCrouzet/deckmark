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

/** Model discovery is an id list, not a document. Keep it small and bounded. */
export const MODEL_LIST_MAX_BYTES = 512 * 1024;
/** An HTTP error detail is diagnostic text only. Never buffer the full body. */
export const ERROR_BODY_MAX_BYTES = 4 * 1024;
export const MAX_MODELS = 2000;
export const MAX_MODEL_ID_CHARS = 256;

class BodyTooLargeError extends Error {
	constructor() {
		super('The provider response is too large.');
		this.name = 'BodyTooLargeError';
	}
}

function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Reads a response with a true byte cap that applies during the stream, not
 * only after buffering. A declared Content-Length is an early hint, and a
 * chunked or misreported body still stops as soon as the cap is crossed.
 */
async function readBoundedText(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal
): Promise<string> {
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new BodyTooLargeError();
	}
	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let received = 0;
	let text = '';
	try {
		for (;;) {
			if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > maxBytes) throw new BodyTooLargeError();
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		return text;
	} finally {
		await reader.cancel().catch(() => {});
	}
}

/** Removes common credential shapes before any detail reaches a message. */
function redactDetail(text: string): string {
	return text
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
		.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
		.replace(
			/("?(?:api[_-]?key|authorization|token|secret|password)"?\s*[:=]\s*")([^"]{4,})(")/gi,
			'$1[redacted]$3'
		)
		.slice(0, 400);
}

/** Extracts a short provider message instead of echoing the complete body. */
function errorDetail(text: string): string {
	const value = text.trim();
	if (value.startsWith('{')) {
		try {
			const parsed = JSON.parse(value) as {
				error?: string | { message?: unknown };
				message?: unknown;
			};
			const message =
				typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message);
			if (typeof message === 'string' && message.trim()) return redactDetail(message);
		} catch {
			/* Fall back to the bounded text. */
		}
	}
	return redactDetail(value);
}

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

async function failure(response: Response, signal?: AbortSignal): Promise<AiProviderError> {
	let detail = '';
	try {
		detail = errorDetail(await readBoundedText(response, ERROR_BODY_MAX_BYTES, signal));
	} catch (error) {
		if (isAbort(error)) throw new AiProviderError('cancelled', 'Request cancelled');
		/* An oversized or unreadable detail keeps only the status. */
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
	if (!response.ok) throw await failure(response, signal);
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
	if (!response.ok) throw await failure(response, signal);
	let data: { data?: Array<{ id?: unknown }> };
	try {
		data = JSON.parse(await readBoundedText(response, MODEL_LIST_MAX_BYTES, signal)) as {
			data?: Array<{ id?: unknown }>;
		};
	} catch (error) {
		if (isAbort(error)) throw new AiProviderError('cancelled', 'Request cancelled');
		if (error instanceof BodyTooLargeError)
			throw new AiProviderError('invalid-response', 'The model list is too large.');
		throw new AiProviderError('invalid-response', 'The provider returned an invalid model list.');
	}
	if (!Array.isArray(data.data))
		throw new AiProviderError('invalid-response', 'The provider did not return a model list.');
	return data.data
		.slice(0, MAX_MODELS)
		.map((entry) => entry.id)
		.filter(
			(id): id is string =>
				typeof id === 'string' && id.length > 0 && id.length <= MAX_MODEL_ID_CHARS
		)
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
	const maxResponseBytes = 8 * 1024 * 1024;
	const decoder = new TextDecoder();
	let buffer = '';
	let full = '';
	let receivedBytes = 0;
	const tooLarge = async () => {
		await reader.cancel().catch(() => {});
		throw new AiProviderError('invalid-response', 'The provider response is too large.');
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			receivedBytes += value.byteLength;
			if (receivedBytes > maxResponseBytes) await tooLarge();
			const decoded = decoder.decode(value, { stream: true });
			if (buffer.length + decoded.length > maxResponseChars) await tooLarge();
			buffer += decoded;
			// Process complete lines incrementally. Splitting a huge chunk into
			// an event array would allocate before the byte check can reject it.
			let newline = buffer.indexOf('\n');
			while (newline >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, '');
				buffer = buffer.slice(newline + 1);
				if (line.startsWith('data:')) {
					const payload = line.slice(5).trim();
					if (payload && payload !== '[DONE]') {
						let chunk: StreamChunk;
						try {
							chunk = JSON.parse(payload) as StreamChunk;
						} catch {
							chunk = {};
						}
						const choice = chunk.choices?.[0];
						const text = choice?.delta?.content ?? choice?.message?.content;
						if (typeof text === 'string' && text.length > 0) {
							full += text;
							if (full.length > maxResponseChars) await tooLarge();
							onDelta(text);
						}
					}
				}
				newline = buffer.indexOf('\n');
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
