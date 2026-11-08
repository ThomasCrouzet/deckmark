import type { JsonAnalysis, JsonFormatOptions, JsonFormatResult } from './json-tools.js';

export interface JsonRequestIdentity {
	documentId: string;
	revision: number;
	requestId: number;
}

export type JsonWorkerRequest = JsonRequestIdentity &
	(
		| { kind: 'analyze'; text: string; includeValue: boolean }
		| { kind: 'format' | 'minify'; text: string; options: JsonFormatOptions }
	);

export type JsonWorkerReply = JsonRequestIdentity &
	(
		| { kind: 'analysis'; analysis: JsonAnalysis; schemaIssues: string[]; value?: unknown }
		| { kind: 'action'; result: JsonFormatResult }
		| { kind: 'error' }
	);
