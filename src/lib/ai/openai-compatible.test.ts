import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamChat } from './openai-compatible';
import type { AiChatRequest, AiProviderConfig } from './types';

const config: AiProviderConfig = {
	baseUrl: 'https://provider.example/v1',
	model: 'test',
	temperature: 0,
	maxTokens: 128
};
const request: AiChatRequest = { messages: [{ role: 'user', content: 'hello' }] };

function streamResponse(chunks: Uint8Array[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		}
	});
	return new Response(body, { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

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
