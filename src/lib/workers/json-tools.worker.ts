import {
	analyzeJsonDocument,
	prepareJsonAction,
	validateJsonValueAgainstSchema
} from '../code/json-tools.js';
import type { JsonWorkerReply, JsonWorkerRequest } from '../code/json-worker-protocol.js';

self.addEventListener('message', (event: MessageEvent<JsonWorkerRequest>) => {
	const request = event.data;
	const identity = {
		documentId: request.documentId,
		revision: request.revision,
		requestId: request.requestId
	};
	let reply: JsonWorkerReply;
	try {
		if (request.kind === 'analyze') {
			const { analysis, value } = analyzeJsonDocument(request.text);
			reply = {
				...identity,
				kind: 'analysis',
				analysis,
				schemaIssues: analysis.valid ? validateJsonValueAgainstSchema(value) : [],
				...(request.includeValue && analysis.valid ? { value } : {})
			};
		} else {
			reply = {
				...identity,
				kind: 'action',
				result: prepareJsonAction(request.text, request.kind, request.options)
			};
		}
	} catch {
		reply = { ...identity, kind: 'error' };
	}
	(self as unknown as Worker).postMessage(reply);
});
