// Documentation check worker. The report logic stays pure in `docs-check.ts`.
// This bridge only moves a project snapshot in and one report out.

import { runDocsCheck, type DocsCheckInput, type DocsCheckReport } from '../docs-check';

export interface DocsCheckWorkerRequest {
	id: number;
	input: DocsCheckInput;
}

export interface DocsCheckWorkerResponse {
	id: number;
	report?: DocsCheckReport;
	error?: string;
}

self.addEventListener('message', (event: MessageEvent<DocsCheckWorkerRequest>) => {
	const { id, input } = event.data;
	void runDocsCheck(input)
		.then((report) => {
			const response: DocsCheckWorkerResponse = { id, report };
			(self as unknown as Worker).postMessage(response);
		})
		.catch((error: unknown) => {
			const response: DocsCheckWorkerResponse = {
				id,
				error: error instanceof Error ? error.message : String(error)
			};
			(self as unknown as Worker).postMessage(response);
		});
});
