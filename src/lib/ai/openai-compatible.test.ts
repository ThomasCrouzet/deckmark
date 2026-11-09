import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ERROR_BODY_MAX_BYTES,
	MAX_MODELS,
	MODEL_LIST_MAX_BYTES,
	listModels,
	providerEndpoint,
	streamChat
} from './openai-compatible';
import type { AiChatRequest, AiProviderConfig } from './types';

const config: AiProviderConfig = {
	baseUrl: 'https://provider.example/v1',
	model: 'test',
	temperature: 0,
	maxTokens: 128
};
const request: AiChatRequest = { messages: [{ role: 'user', content: 'hello' }] };

function streamResponse(chunks: Uint8Array[], init: ResponseInit = { status: 200 }): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		}
	});
	return new Response(body, init);
}

function hangingResponse(chunk: Uint8Array): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(chunk);
		}
	});
	return new Response(body, { status: 200 });
}

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

afterEach(() => vi.unstubAllGlobals());

describe('provider endpoints', () => {
	it('preserves query parameters and appends to the path', () => {
		expect(providerEndpoint('https://host.example/v1?api-version=1', 'models')).toBe(
			'https://host.example/v1/models?api-version=1'
		);
		expect(providerEndpoint('https://host.example/v1?api-version=1', 'chat/completions')).toBe(
			'https://host.example/v1/chat/completions?api-version=1'
		);
	});

	it('handles trailing slashes, root paths and encoded path segments', () => {
		expect(providerEndpoint('https://host.example/', 'models')).toBe('https://host.example/models');
		expect(providerEndpoint('https://host.example/v1///', '/models')).toBe(
			'https://host.example/v1/models'
		);
		expect(providerEndpoint('https://host.example/v1%2Fproxy', 'models')).toBe(
			'https://host.example/v1%2Fproxy/models'
		);
	});

	it('rejects fragments, credentials, malformed hosts and remote cleartext', () => {
		const codeOf = (input: string) => {
			try {
				providerEndpoint(input, 'models');
			} catch (error) {
				return (error as { code?: string }).code;
			}
			return 'no-error';
		};
		expect(codeOf('https://host.example/v1#frag')).toBe('invalid-endpoint');
		expect(codeOf('https://user:pass@host.example/v1')).toBe('invalid-endpoint');
		expect(codeOf('not a url')).toBe('invalid-endpoint');
		expect(codeOf('http://host.example/v1')).toBe('invalid-endpoint');
		expect(codeOf('ftp://host.example/v1')).toBe('invalid-endpoint');
	});

	it('allows local HTTP loopback providers', () => {
		expect(providerEndpoint('http://127.0.0.1:8080/v1', 'models')).toBe(
			'http://127.0.0.1:8080/v1/models'
		);
		expect(providerEndpoint('http://localhost:1234/v1', 'models')).toBe(
			'http://localhost:1234/v1/models'
		);
		expect(providerEndpoint('http://[::1]:8080/v1', 'models')).toBe('http://[::1]:8080/v1/models');
	});

	it('sends both discovery and chat to the parsed endpoint', async () => {
		const urls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				urls.push(String(input));
				const url = String(input);
				if (url.includes('/models')) return streamResponse([encode('{"data":[]}')]);
				return streamResponse([encode('data: [DONE]\n\n')]);
			})
		);
		await listModels(config, 'sk-test');
		await streamChat(config, 'sk-test', request, () => {});
		expect(urls).toEqual([
			'https://provider.example/v1/models',
			'https://provider.example/v1/chat/completions'
		]);
	});

	it('reports an invalid endpoint before sending a request', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		await expect(
			streamChat({ ...config, baseUrl: 'https://user:pass@host/v1' }, 'sk-test', request, () => {})
		).rejects.toMatchObject({ code: 'invalid-endpoint' });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('streamChat bounds', () => {
	it('rejects one oversized event before scanning it as lines', async () => {
		const encoder = new TextEncoder();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => streamResponse([encoder.encode(`data: ${'x'.repeat(9 * 1024 * 1024)}`)]))
		);
		await expect(streamChat(config, null, request, () => {})).rejects.toMatchObject({
			code: 'invalid-response',
			message: 'The provider response is too large.'
		});
	});

	it('rejects an oversized error body without echoing its content', async () => {
		const secret = 'sk-test-0000000000000000';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				streamResponse([encode(secret + 'x'.repeat(ERROR_BODY_MAX_BYTES))], { status: 500 })
			)
		);
		const error = await listModels(config, secret).catch((value: unknown) => value);
		expect(error).toMatchObject({ code: 'server' });
		expect((error as Error).message).not.toContain(secret);
	});

	it('enforces the model list cap during a stream with a false Content-Length', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				streamResponse([encode(`{"data":[${'x'.repeat(MODEL_LIST_MAX_BYTES)}]}`)], {
					status: 200,
					headers: { 'content-length': '10' }
				})
			)
		);
		await expect(listModels(config, null)).rejects.toMatchObject({
			code: 'invalid-response'
		});
	});

	it('rejects an oversized model list announced by Content-Length', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				streamResponse([encode('{"data":[]}')], {
					status: 200,
					headers: { 'content-length': String(MODEL_LIST_MAX_BYTES + 1) }
				})
			)
		);
		await expect(listModels(config, null)).rejects.toMatchObject({
			code: 'invalid-response'
		});
	});

	it('bounds the model count and identifier length', async () => {
		const entries = Array.from({ length: MAX_MODELS + 50 }, (_, index) => ({
			id: `model-${index}`
		}));
		entries.push({ id: 'x'.repeat(300) });
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => streamResponse([encode(JSON.stringify({ data: entries }))]))
		);
		const models = await listModels(config, null);
		expect(models.length).toBeLessThanOrEqual(MAX_MODELS);
		expect(models.every((id) => id.length <= 256)).toBe(true);
	});

	it('reports malformed model JSON and a missing body', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => streamResponse([encode('not json')]))
		);
		await expect(listModels(config, null)).rejects.toMatchObject({ code: 'invalid-response' });
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 200 }))
		);
		await expect(listModels(config, null)).rejects.toMatchObject({ code: 'invalid-response' });
	});

	it('cancels a model listing when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => hangingResponse(encode('{"data":[]}')))
		);
		await expect(listModels(config, null, controller.signal)).rejects.toMatchObject({
			code: 'cancelled'
		});
	});

	it('streams complete lines and keeps the concatenated reply', async () => {
		const encoder = new TextEncoder();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				streamResponse([
					encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n'),
					encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n'),
					encoder.encode('data: [DONE]\n')
				])
			)
		);
		const deltas: string[] = [];
		await expect(streamChat(config, null, request, (delta) => deltas.push(delta))).resolves.toBe(
			'Hello'
		);
		expect(deltas).toEqual(['Hel', 'lo']);
	});
});
