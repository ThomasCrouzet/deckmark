// Bounded termination for the native smoke application.
//
// The smoke run and the benchmark share one runner and one fixed WebDriver
// port (4457). The smoke process must be gone before the benchmark starts, so
// teardown waits for the real child `exit` event. A child that ignores the
// close signal is escalated after a bounded grace period. Only the owned
// ChildProcess is signalled: this module never searches for or kills a pid
// that the smoke run does not own.

const WINDOWS = process.platform === 'win32';

/** @param {import('node:child_process').ChildProcess} child */
export function childExited(child) {
	return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Wait for the child `exit` event. Resolve true on a real exit and false on
 * the bounded timeout. The listener is always removed.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 */
function waitForExit(child, timeoutMs) {
	if (childExited(child)) return Promise.resolve(true);
	return new Promise((resolve) => {
		/** @type {NodeJS.Timeout | undefined} */
		let timer;
		const complete = () => {
			if (timer) clearTimeout(timer);
			child.removeListener('exit', complete);
			resolve(true);
		};
		timer = setTimeout(() => {
			child.removeListener('exit', complete);
			resolve(false);
		}, timeoutMs);
		child.once('exit', complete);
	});
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals | undefined} signal
 */
function signalOwnedChild(child, signal) {
	try {
		return signal === undefined ? child.kill() : child.kill(signal);
	} catch (error) {
		// ESRCH means the owned process already exited. The exit wait decides.
		if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH') return false;
		throw error;
	}
}

/**
 * Stop one owned child and wait for its real exit.
 *
 * POSIX sends the close signal (SIGTERM by default), waits `graceMs`, then
 * sends the kill signal (SIGKILL by default) and waits `killMs`. Windows has
 * no SIGTERM; `child.kill()` maps to TerminateProcess, so the same bounded
 * wait applies and a second kill is the escalation.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{
 *   label?: string,
 *   graceMs?: number,
 *   killMs?: number,
 *   termSignal?: NodeJS.Signals,
 *   killSignal?: NodeJS.Signals
 * }} [options]
 * @returns {Promise<{ pid: number, label: string, exitCode: number | null, signal: NodeJS.Signals | null, escalated: boolean }>}
 */
export async function stopChild(
	child,
	{
		label = 'child',
		graceMs = 10_000,
		killMs = 5_000,
		termSignal = 'SIGTERM',
		killSignal = 'SIGKILL'
	} = {}
) {
	if (!child || typeof child.kill !== 'function') {
		throw new TypeError('stopChild needs an owned ChildProcess');
	}
	if (!Number.isInteger(child.pid)) {
		throw new Error(`${label} has no owned pid`);
	}
	/** @param {boolean} escalated */
	const result = (escalated) => ({
		pid: /** @type {number} */ (child.pid),
		label,
		exitCode: child.exitCode,
		signal: child.signalCode,
		escalated
	});
	if (childExited(child)) return result(false);

	const startedAt = performance.now();
	const closeSent = signalOwnedChild(child, WINDOWS ? undefined : termSignal);
	if (await waitForExit(child, graceMs)) return result(false);

	const killSent = WINDOWS
		? signalOwnedChild(child, undefined)
		: signalOwnedChild(child, killSignal);
	if (await waitForExit(child, killMs)) return result(true);

	throw new Error(
		`${label} (pid ${child.pid}) did not exit after ${graceMs + killMs} ms; ` +
			`close signal sent=${closeSent}, kill signal sent=${killSent}, ` +
			`exitCode=${String(child.exitCode)}, signal=${String(child.signalCode)}, ` +
			`elapsed=${Math.round(performance.now() - startedAt)} ms`
	);
}
