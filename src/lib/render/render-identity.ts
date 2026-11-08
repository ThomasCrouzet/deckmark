let generation = 0;

export function nextRenderGeneration(): number {
	return ++generation;
}

export function createRenderInstanceId(): string {
	return `mdsh-render-${nextRenderGeneration()}`;
}
