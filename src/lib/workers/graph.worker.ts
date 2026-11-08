/// <reference lib="webworker" />

import { computeLayout, type GraphData, type PositionedNode } from '../graph';

interface LayoutRequest {
	id: number;
	data: GraphData;
	width: number;
	height: number;
	iterations: number;
}

interface LayoutResponse {
	id: number;
	positions?: PositionedNode[];
	error?: string;
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
	const request = event.data;
	try {
		const positions = computeLayout(request.data, {
			width: request.width,
			height: request.height,
			iterations: request.iterations
		});
		const response: LayoutResponse = { id: request.id, positions };
		self.postMessage(response);
	} catch (error) {
		const response: LayoutResponse = { id: request.id, error: String(error) };
		self.postMessage(response);
	}
};
