// Minimal singleton store to display a spinner toast during long exports
// (PDF/HTML with Mermaid can take 1-2 s to render).
//
// 200 ms display delay so as not to flash on fast exports (trivial markdown
// without math/mermaid renders in < 50 ms).
//
// Pattern: `const dismiss = spinnerStore.show('…'); try { await … } finally { dismiss(); }`
// The return value is a closure that closes cleanly, robust to exceptions.
//
// Ref-counting: multiple exports may be in flight simultaneously (export of the
// active file + ZIP of a selection). The spinner stays visible as long as AT
// LEAST ONE export is in progress; without this counting, the first `dismiss()`
// hid the spinner while another export was still running.

class SpinnerStore {
	visible = $state(false);
	message = $state('');
	cancel = $state<(() => void) | undefined>();
	// Tokens whose 200 ms delay has expired (so actually displayed) and that are
	// not yet finished. Non-reactive internal bookkeeping - the observable state
	// is `visible` / `message`.
	private displayed = new Map<symbol, { message: string; cancel?: (() => void) | undefined }>();

	/**
	 * Schedules the spinner display after 200 ms. If the export finishes before
	 * then, `dismiss()` simply cancels the timer - the user sees nothing flicker.
	 * Otherwise, the toast stays displayed until ALL ongoing exports have called
	 * their `dismiss()`.
	 */
	show(message: string, cancel?: () => void) {
		const token = Symbol('spinner');
		const entry = { message, cancel };
		const timer = setTimeout(() => {
			this.displayed.set(token, entry);
			this.refresh();
		}, 200);
		const dismiss = () => {
			clearTimeout(timer);
			this.displayed.delete(token);
			this.refresh();
		};
		return Object.assign(dismiss, {
			disableCancel: () => {
				entry.cancel = undefined;
				this.refresh();
			}
		});
	}

	/** Recomputes the visible/message state from the exports still displayed. */
	private refresh(): void {
		if (this.displayed.size === 0) {
			this.visible = false;
			this.cancel = undefined;
			return;
		}
		// Message of the most recently displayed export (Map insertion order).
		const messages = [...this.displayed.values()];
		const latest = messages[messages.length - 1]!;
		this.message = latest.message;
		this.cancel = latest.cancel;
		this.visible = true;
	}
}

export const spinnerStore = new SpinnerStore();
