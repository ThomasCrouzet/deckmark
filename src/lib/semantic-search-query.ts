/**
 * Guards asynchronous semantic queries. Each query takes a token. Only the
 * latest token may publish a result, so an older, slower IndexedDB read cannot
 * replace newer results after typing, a scope change, a clear or a close.
 */
export class LatestOnly {
	private generation = 0;

	/** Starts a new job and invalidates every earlier token. */
	begin(): number {
		return ++this.generation;
	}

	/** Invalidates every pending job without starting a new one. */
	invalidate(): void {
		this.generation++;
	}

	isCurrent(token: number): boolean {
		return token === this.generation;
	}
}
