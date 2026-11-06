// §1.3 - Centralized error logging.
//
// Single entry point for all nonfatal app errors and warnings. It replaces
// separate console calls in file, export, front-matter, and image-drop code.
// Always log for debugging. Show a toast only when the user can act on it.
//
// Do not send telemetry. This module only routes messages to the console and
// local notification toasts.
//
// IndexedDB persistence uses `reportPersistenceError` in storage.ts. That helper
// maps quota and write failures to messages. The functions here handle other errors.

import { notify } from './notify.svelte';

// Small in-memory diagnostic event ring. Keep it tiny: this module is in the
// startup graph. The report builder loads on demand from Settings.
export interface DiagnosticEvent {
	at: string;
	level: 'error' | 'warning';
	scope: string;
	code: string;
}

const diagnosticLog: DiagnosticEvent[] = [];
const safeText = (value: string, fallback: string) =>
	/^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : fallback;

function pushDiagnostic(level: 'error' | 'warning', scope: string, error?: unknown): void {
	if (diagnosticLog.length >= 80) diagnosticLog.shift();
	diagnosticLog.push({
		at: new Date().toISOString(),
		level,
		scope: safeText(scope.replaceAll(' ', '_'), 'unknown_operation'),
		code:
			typeof error === 'object' && error !== null && 'code' in error
				? safeText(String((error as { code?: unknown }).code ?? ''), 'unknown_error')
				: error instanceof Error
					? safeText(error.name, 'unknown_error')
					: 'unknown_error'
	});
}

export function diagnosticEvents(): readonly DiagnosticEvent[] {
	return diagnosticLog;
}

export function clearDiagnostics(): void {
	diagnosticLog.length = 0;
}

export interface ReportOptions {
	/**
	 * Message to show in a toast. If absent, log only to the console.
	 */
	notifyUser?: string;
	/** Toast level (default `error`). `info` for a non-blocking warning. */
	level?: 'error' | 'info';
}

/**
 * Logs an error with a `[mdsh] <scope>` prefix. Shows a toast when
 * `notifyUser` is present.
 *
 * @param scope  Short, stable context, for example `export ZIP` or `load IndexedDB`.
 * @param err    The captured error (or any thrown value).
 */
export function reportError(scope: string, err: unknown, opts: ReportOptions = {}): void {
	console.error(`[mdsh] ${scope} :`, err);
	pushDiagnostic('error', scope, err);
	if (opts.notifyUser) {
		if (opts.level === 'info') notify.info(opts.notifyUser);
		else notify.error(opts.notifyUser);
	}
}

/**
 * Logs a nonfatal warning to the console. Use it when the app can safely
 * continue, such as after invalid YAML or an oversized image.
 *
 * @param scope   Short context.
 * @param detail  Optional detail (message, value) attached to the log.
 */
export function reportWarning(scope: string, detail?: unknown): void {
	if (detail !== undefined) console.warn(`[mdsh] ${scope} :`, detail);
	else console.warn(`[mdsh] ${scope}`);
	pushDiagnostic('warning', scope, detail);
}
