// Singleton store of transient notifications (toasts) - errors, successes, infos.
//
// Distinct from the two other feedback channels:
//   - `spinnerStore` (persistent spinner toast during long exports),
//   - `Toast.svelte` (undo-close toasts driven by `filesStore.trash`).
//
// This store covers one-off operation feedback: IDB write failure, full quota,
// finished export, disk save error… Each toast is announced to screen readers
// via the `role` of the display component (`alert` = assertive for errors,
// `status` = polite otherwise).

export type ToastLevel = 'error' | 'success' | 'info';

/** Optional action attached to a toast (e.g. "Recharger" for the PWA update). */
export interface ToastAction {
	label: string;
	run: () => void;
	/** Set false when successful completion must dismiss the notification. */
	dismissOnRun?: boolean;
}

export interface NotifyToast {
	id: number;
	level: ToastLevel;
	message: string;
	action?: ToastAction | undefined;
	key?: string | undefined;
}

interface ToastOptions {
	action?: ToastAction;
	ttl?: number;
	key?: string;
}

// Display duration per level (ms). Errors stay longer: they often require an
// action (export, free up space).
const TTL: Record<ToastLevel, number> = {
	error: 8000,
	success: 3500,
	info: 4500
};

class NotifyStore {
	toasts = $state<NotifyToast[]>([]);
	private nextId = 1;
	private timers = new Map<number, ReturnType<typeof setTimeout>>();

	/**
	 * Drops a toast. Deduplication: a toast already displayed with the same
	 * `(level, message)` is not duplicated - its timer is simply restarted.
	 * Avoids the avalanche when an error repeats (e.g. full quota → failure on
	 * every saved keystroke).
	 */
	private push(level: ToastLevel, message: string, opts: ToastOptions = {}): number {
		const existing = this.toasts.find(
			(t) =>
				t.level === level && t.key === opts.key && (opts.key !== undefined || t.message === message)
		);
		if (existing) {
			this.arm(existing.id, level, opts.ttl);
			return existing.id;
		}
		const id = this.nextId++;
		this.toasts = [...this.toasts, { id, level, message, action: opts.action, key: opts.key }];
		this.arm(id, level, opts.ttl);
		return id;
	}

	/**
	 * (Re)schedules the auto-close of toast `id` after `ttl` ms (default
	 * `TTL[level]`). A `ttl` of `0` makes the toast persistent (no timer):
	 * useful for an action-carrying toast (e.g. "Recharger" of the PWA update),
	 * which must not disappear before the user acts.
	 */
	private arm(id: number, level: ToastLevel, ttl = TTL[level]): void {
		const prev = this.timers.get(id);
		if (prev) clearTimeout(prev);
		if (ttl <= 0) {
			this.timers.delete(id);
			return;
		}
		this.timers.set(
			id,
			setTimeout(() => this.dismiss(id), ttl)
		);
	}

	/** Error notification (announced assertively, long TTL). */
	error(message: string, opts: ToastOptions = {}): number {
		return this.push('error', message, opts);
	}
	/** Success notification (announced politely). */
	success(message: string): number {
		return this.push('success', message);
	}
	/** Neutral information (announced politely). */
	info(message: string): number {
		return this.push('info', message);
	}

	/**
	 * PERSISTENT info toast carrying an action (button). Does not auto-close
	 * (TTL 0) - the user acts or closes. Used for "Nouvelle version
	 * disponible - Recharger" (§1.2).
	 */
	actionable(message: string, action: ToastAction): number {
		return this.push('info', message, { action, ttl: 0 });
	}

	/** Closes a toast (click on the cross or timer expiration). */
	dismiss(id: number): void {
		const t = this.timers.get(id);
		if (t) {
			clearTimeout(t);
			this.timers.delete(id);
		}
		this.toasts = this.toasts.filter((t) => t.id !== id);
	}

	/** Closes all toasts (used by tests / reset). */
	clear(): void {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		this.toasts = [];
	}
}

export const notify = new NotifyStore();
