// Pure open-tab lifecycle policy for FilesStore.
//
// Svelte 5 keeps the reactive arrays and the active id in the store. This
// module decides which tab becomes active after a close or a batch removal,
// and how the recent-tab history and tab order change. The store applies the
// decision, persists the active id, flushes the editor, and invalidates
// metadata. Keeping the decision here makes the transitions testable without
// mounting the rune store.

/** Maximum number of recent active tabs kept for close navigation. */
export const ACTIVE_HISTORY_LIMIT = 20;

/** Records the tab that is about to lose the active state. */
export function rememberActiveTab(
	history: readonly string[],
	id: string | null,
	limit = ACTIVE_HISTORY_LIMIT
): string[] {
	if (!id) return [...history];
	return [...history.filter((entry) => entry !== id), id].slice(-Math.max(1, limit));
}

/** Returns the most recent recorded tab that is still open. */
export function previousOpenTab(
	history: readonly string[],
	excludeId: string,
	isOpen: (id: string) => boolean
): string | null {
	for (let index = history.length - 1; index >= 0; index--) {
		const candidate = history[index]!;
		if (candidate !== excludeId && isOpen(candidate)) return candidate;
	}
	return null;
}

export interface DetachedTab {
	id: string;
	/** Index of the tab before it left the open list. */
	index: number;
}

/**
 * Chooses the active tab after one tab leaves the open list. `remainingIds`
 * is the open list after removal. The recent history wins over the positional
 * neighbour, which matches browser tab behaviour. The neighbour at the removed
 * position is the fallback for a tab that was never recorded in the history.
 */
export function nextActiveAfterDetach(
	remainingIds: readonly string[],
	history: readonly string[],
	activeId: string | null,
	detached: DetachedTab
): string | null {
	if (activeId !== detached.id) return activeId;
	return (
		previousOpenTab(history, detached.id, (id) => remainingIds.includes(id)) ??
		remainingIds[Math.min(detached.index, remainingIds.length - 1)] ??
		null
	);
}

/**
 * Chooses the active tab after a batch removal. The next open tab wins, then
 * the previous open tab. A tab that is not removed keeps the active state.
 */
export function nextActiveAfterRemoval(
	openIds: readonly string[],
	activeId: string | null,
	removedIds: ReadonlySet<string>
): string | null {
	if (!activeId || !removedIds.has(activeId)) return activeId;
	const activeIndex = openIds.indexOf(activeId);
	const next =
		openIds.slice(activeIndex + 1).find((id) => !removedIds.has(id)) ??
		openIds.slice(0, activeIndex).findLast((id) => !removedIds.has(id));
	return next ?? null;
}

/**
 * Applies the requested tab order. Known ids form the prefix; open tabs that
 * the request omits keep their relative order in the tail. Returns null when
 * the request is empty, the list has one tab, or the order does not change.
 */
export function reorderedOpenIds(
	openIds: readonly string[],
	orderedIds: readonly string[]
): string[] | null {
	if (orderedIds.length === 0 || openIds.length <= 1) return null;
	const known = new Set(openIds);
	const seen = new Set<string>();
	const next: string[] = [];
	for (const id of orderedIds) {
		if (!known.has(id) || seen.has(id)) continue;
		next.push(id);
		seen.add(id);
	}
	for (const id of openIds) {
		if (!seen.has(id)) next.push(id);
	}
	if (next.length !== openIds.length) return null;
	const unchanged = next.every((id, index) => id === openIds[index]);
	return unchanged ? null : next;
}

/** Cycles to the previous or next open tab, with wrap-around. */
export function cycleOpenTab(
	openIds: readonly string[],
	activeId: string | null,
	direction: 1 | -1
): string | null {
	if (openIds.length < 2 || !activeId) return null;
	const index = openIds.indexOf(activeId);
	if (index < 0) return null;
	return openIds[(index + direction + openIds.length) % openIds.length] ?? null;
}
