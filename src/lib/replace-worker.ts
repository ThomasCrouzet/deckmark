import { t } from '#lib/i18n/index.js';
import {
	replaceInFiles,
	type FileSlice,
	type ReplaceOptions,
	type ReplaceOutcome
} from './replace';

export const REGEX_EXECUTION_TIMEOUT_MS = 1000;

export interface ReplaceWorkerRequest {
	files: readonly FileSlice[];
	query: string;
	replacement: string;
	opts: ReplaceOptions;
}

type WorkerHost = Pick<
	Worker,
	'postMessage' | 'addEventListener' | 'removeEventListener' | 'terminate'
>;

export interface ReplaceWorkerOptions {
	createWorker?: () => WorkerHost;
	timeoutMs?: number;
}

/** Runs user regular expressions in an isolated worker with a hard deadline. */
export function replaceInFilesAsync(
	files: readonly FileSlice[],
	query: string,
	replacement: string,
	opts: ReplaceOptions,
	workerOptions: ReplaceWorkerOptions = {}
): Promise<ReplaceOutcome> {
	if (!opts.useRegex) return Promise.resolve(replaceInFiles(files, query, replacement, opts));
	return new Promise((resolve) => {
		let worker: WorkerHost;
		try {
			worker = workerOptions.createWorker
				? workerOptions.createWorker()
				: new Worker(new URL('./workers/replace.worker.ts', import.meta.url), { type: 'module' });
		} catch {
			resolve({ results: [], total: 0, regexError: t('search.unavailable') });
			return;
		}
		let settled = false;
		const finish = (outcome: ReplaceOutcome): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			worker.removeEventListener('message', onMessage);
			worker.removeEventListener('error', onError);
			worker.terminate();
			resolve(outcome);
		};
		const onMessage = ((event: MessageEvent<ReplaceOutcome>) =>
			finish(event.data)) as EventListener;
		const onError = (() =>
			finish({ results: [], total: 0, regexError: t('search.unavailable') })) as EventListener;
		worker.addEventListener('message', onMessage);
		worker.addEventListener('error', onError);
		const timer = setTimeout(
			() => finish({ results: [], total: 0, regexError: t('search.timeout') }),
			workerOptions.timeoutMs ?? REGEX_EXECUTION_TIMEOUT_MS
		);
		try {
			worker.postMessage({ files, query, replacement, opts } satisfies ReplaceWorkerRequest);
		} catch {
			finish({ results: [], total: 0, regexError: t('search.unavailable') });
		}
	});
}
