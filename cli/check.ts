import { dirname, relative, resolve } from 'node:path';
import {
	runDocsCheck,
	serializeDocsCheckReport,
	type DocsCheckReport
} from '../src/lib/docs-check';
import { CliError, EXIT } from './exit';
import {
	Deadline,
	isWithinRoot,
	mapPool,
	readText,
	requireDirectory,
	requireFile,
	toProjectPath,
	walkFiles
} from './paths';

const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdx|txt)$/i;

export interface CheckInput {
	input: string;
	root?: string;
	concurrency: number;
	timeoutMs: number;
	json: boolean;
	strict: boolean;
}

interface Scope {
	root: string;
	/** Relative file or directory prefix used to filter issues. Empty means all. */
	filter: string;
	files: boolean;
}

async function resolveScope(input: string, rootOption: string | undefined): Promise<Scope> {
	const absolute = resolve(input);
	let root: string;
	let filter: string;
	let files: boolean;
	try {
		const file = await requireFile(absolute);
		root = rootOption ? await requireDirectory(resolve(rootOption)) : dirname(file);
		const fromRoot = toProjectPath(relative(root, file));
		if (fromRoot === '' || !isWithinRoot(root, file))
			throw new CliError(EXIT.INPUT, 'input-outside-root', `File is outside the root: ${input}`);
		filter = fromRoot;
		files = true;
	} catch (error) {
		if (!(error instanceof CliError) || error.code !== 'input-not-found') throw error;
		const directory = await requireDirectory(absolute);
		root = rootOption ? await requireDirectory(resolve(rootOption)) : directory;
		const fromRoot = relative(root, directory);
		if (!isWithinRoot(root, directory))
			throw new CliError(
				EXIT.INPUT,
				'input-outside-root',
				`Directory is outside the root: ${input}`
			);
		filter = toProjectPath(fromRoot);
		files = false;
	}
	return { root, filter, files };
}

function countDocuments(paths: readonly string[], scope: Scope): number {
	if (!scope.filter) return paths.length;
	return paths.filter((path) =>
		scope.files
			? path === scope.filter
			: path === scope.filter || path.startsWith(`${scope.filter}/`)
	).length;
}

function filteredReport(report: DocsCheckReport, scope: Scope, documents: number): DocsCheckReport {
	if (!scope.filter) return report;
	const prefix = scope.filter;
	const issues = report.issues.filter((issue) =>
		scope.files
			? issue.path === prefix
			: issue.path === prefix || issue.path.startsWith(`${prefix}/`)
	);
	return {
		...report,
		documents,
		summary: {
			errors: issues.filter((issue) => issue.severity === 'error').length,
			warnings: issues.filter((issue) => issue.severity === 'warning').length
		},
		issues
	};
}

function humanOutput(report: DocsCheckReport): string {
	const lines = report.issues.map(
		(issue) =>
			`${issue.path}:${issue.line}:${issue.column}: ${issue.severity} ${issue.code}: ${issue.message}`
	);
	lines.push(
		`Checked ${report.documents} document${report.documents === 1 ? '' : 's'}: ${report.summary.errors} error${report.summary.errors === 1 ? '' : 's'}, ${report.summary.warnings} warning${report.summary.warnings === 1 ? '' : 's'}.`
	);
	return `${lines.join('\n')}\n`;
}

export async function runCheck(input: CheckInput): Promise<number> {
	const scope = await resolveScope(input.input, input.root);
	const deadline = new Deadline(input.timeoutMs);
	deadline.check();
	const allFiles = await walkFiles(scope.root, { deadline });
	deadline.check();
	const documentPaths = allFiles.filter((path) => MARKDOWN_EXTENSION.test(path));
	const assets = allFiles.filter((path) => !MARKDOWN_EXTENSION.test(path));
	if (documentPaths.length === 0)
		throw new CliError(EXIT.INPUT, 'no-documents', 'The input contains no Markdown documents');
	const documents = await mapPool(documentPaths, input.concurrency, deadline, async (path) => ({
		id: path,
		relativePath: path,
		content: await readText(scope.root, path)
	}));
	deadline.check();
	const rawReport = await runDocsCheck({ documents, assets });
	deadline.check();
	const report = filteredReport(rawReport, scope, countDocuments(documentPaths, scope));
	if (input.json) process.stdout.write(serializeDocsCheckReport(report));
	else process.stdout.write(humanOutput(report));
	const failed = report.summary.errors > 0 || (input.strict && report.summary.warnings > 0);
	return failed ? EXIT.CHECK_FAILED : EXIT.OK;
}
