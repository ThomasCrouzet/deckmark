export function withGestureRoot(create: () => void): () => void {
	return $effect.root(create);
}
