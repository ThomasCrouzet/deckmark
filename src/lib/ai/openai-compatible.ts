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

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		host === 'localhost' || host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
	);
}

/**
 * Builds a provider endpoint from a parsed URL. The path is appended to the
 * pathname and the query string is preserved, matching the native adapter.
 * Fragments and credentials are refused, and remote cleartext HTTP is blocked
 * because the browser key travels in an authenticated header.
 */
export function providerEndpoint(baseUrl: string, path: string): string {
	let url: URL;
	try {
		url = new URL(baseUrl.trim());
	} catch {
		throw new AiProviderError('invalid-endpoint', 'The provider base URL is not a valid URL.');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		throw new AiProviderError('invalid-endpoint', 'The provider base URL must use HTTP or HTTPS.');
	if (!url.hostname)
		throw new AiProviderError('invalid-endpoint', 'The provider base URL has no host.');
	if (url.username || url.password)
		throw new AiProviderError(
			'invalid-endpoint',
			'The provider base URL must not contain credentials.'
		);
	if (url.hash)
		throw new AiProviderError(
			'invalid-endpoint',
			'The provider base URL must not contain a fragment.'
		);
	if (url.protocol === 'http:' && !isLoopbackHost(url.hostname))
		throw new AiProviderError(
			'invalid-endpoint',
			'Remote provider endpoints must use HTTPS. HTTP is allowed only for local loopback.'
		);
	const basePath = url.pathname.replace(/\/+$/, '');
	url.pathname = `${basePath}/${path.replace(/^\/+/, '')}`;
	return url.toString();
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
		response = await fetch(providerEndpoint(config.baseUrl, path), {
			method: 'POST',
			headers: headers(apiKey),
			body: JSON.stringify(body),
			...(signal ? { signal } : {})
		});
	} catch (error) {
		if (error instanceof AiProviderError) throw error;
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
		response = await fetch(providerEndpoint(config.baseUrl, 'models'), {
			headers: headers(apiKey),
			...(signal ? { signal } : {})
		});
	} catch (error) {
		if (error instanceof AiProviderError) throw error;
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
	error?: unknown;
	choices?: Array<{
		delta?: { content?: unknown };
		message?: { content?: unknown };
		finish_reason?: unknown;
	}>;
}

/** Maps a provider stream error object to an actionable, redacted error. */
function streamFailure(value: unknown): AiProviderError {
	const record = (typeof value === 'object' && value !== null ? value : {}) as {
		message?: unknown;
		code?: unknown;
		type?: unknown;
	};
	const message =
		typeof record.message === 'string' && record.message.trim()
			? redactDetail(record.message)
			: 'The provider reported a stream error.';
	const code =
		`${typeof record.code === 'string' ? record.code : ''} ${typeof record.type === 'string' ? record.type : ''}`.toLowerCase();
	if (/rate|quota|limit/.test(code)) return new AiProviderError('rate-limit', message);
	if (/auth|permission|key|forbidden/.test(code)) return new AiProviderError('auth', message);
	return new AiProviderError('server', message);
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
	let seenDone = false;
	let finished = false;
	let eventName = '';
	let eventData: string[] = [];
	const tooLarge = async () => {
		throw new AiProviderError('invalid-response', 'The provider response is too large.');
	};
	const dispatch = async () => {
		if (eventData.length === 0) {
			eventName = '';
			return;
		}
		const payload = eventData.join('\n').trim();
		const name = eventName;
		eventData = [];
		eventName = '';
		if (!payload) return;
		if (payload === '[DONE]') {
			seenDone = true;
			return;
		}
		let chunk: StreamChunk;
		try {
			chunk = JSON.parse(payload) as StreamChunk;
		} catch {
			throw new AiProviderError('invalid-response', 'The provider sent a malformed stream event.');
		}
		if (
			name === 'error' ||
			(typeof chunk === 'object' && chunk !== null && chunk.error !== undefined)
		)
			throw streamFailure(chunk.error ?? chunk);
		const choice = chunk.choices?.[0];
		if (choice?.finish_reason !== undefined && choice.finish_reason !== null) finished = true;
		const text = choice?.delta?.content ?? choice?.message?.content;
		if (typeof text === 'string' && text.length > 0) {
			full += text;
			if (full.length > maxResponseChars) await tooLarge();
			onDelta(text);
		}
	};
	const processLine = async (line: string) => {
		if (line === '') {
			await dispatch();
			return;
		}
		if (line.startsWith(':')) return;
		if (line.startsWith('event:')) {
			eventName = line.slice(6).trim();
			return;
		}
		if (line.startsWith('data:')) {
			eventData.push(line.slice(5).replace(/^ /, ''));
			// Standard SSE aggregates data lines until a blank line. Some
			// compatible providers send one complete event per bare newline.
			// Dispatch as soon as the accumulated data parses, otherwise keep
			// collecting a multi-line event.
			const joined = eventData.join('\n').trim();
			if (joined === '[DONE]') {
				await dispatch();
				return;
			}
			let complete = false;
			try {
				JSON.parse(joined);
				complete = true;
			} catch {
				/* A multi-line event continues on the next data line. */
			}
			if (complete) await dispatch();
		}
	};
	try {
		for (;;) {
			if (requestConfig.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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
				await processLine(line);
				newline = buffer.indexOf('\n');
			}
		}
		// Flush a split multi-byte character and treat EOF as an event boundary
		// for a complete final frame that has no trailing newline.
		const tail = decoder.decode();
		if (tail) buffer += tail;
		if (buffer.length > 0) {
			await processLine(buffer.replace(/\r$/, ''));
			buffer = '';
		}
		if (eventData.length > 0) await dispatch();
		if (!seenDone && !finished)
			throw new AiProviderError('invalid-response', 'The provider stream ended before completion.');
	} catch (error) {
		if (error instanceof AiProviderError) throw error;
		if (error instanceof DOMException && error.name === 'AbortError') {
			await reader.cancel().catch(() => {});
			throw new AiProviderError('cancelled', 'Request cancelled');
		}
		throw new AiProviderError('network', error instanceof Error ? error.message : String(error));
	} finally {
		await reader.cancel().catch(() => {});
	}
	return full;
}
