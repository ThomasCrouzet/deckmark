import { parseMarkdownSource, type MarkdownParserInput } from './markdown-parser';

self.onmessage = (event: MessageEvent<MarkdownParserInput>) => {
	try {
		const output = parseMarkdownSource(event.data);
		for (const stage of output.stages) stage.thread = 'worker';
		self.postMessage({ output });
	} catch (error) {
		self.postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
};
