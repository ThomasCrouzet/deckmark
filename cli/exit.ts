/** Stable exit codes for scripts and CI pipelines. */
export const EXIT = {
	OK: 0,
	FAILURE: 1,
	USAGE: 2,
	INPUT: 3,
	UNSAFE_PATH: 4,
	CHECK_FAILED: 5,
	OUTPUT: 6,
	ABORTED: 7
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
	readonly exitCode: ExitCode;
	readonly code: string;

	constructor(exitCode: ExitCode, code: string, message: string) {
		super(message);
		this.name = 'CliError';
		this.exitCode = exitCode;
		this.code = code;
	}
}
