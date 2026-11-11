// Fail-closed change classifier for the Web CI route.
// A pull request that changes only documentation files may skip the browser
// matrix. Every other event, every other path and every malformed input
// selects full validation. The script prints two workflow outputs and prints
// nothing when it rejects the input, so a step cannot fall back to the cheap
// route.
import { resolve } from 'node:path';

const fullEvents = new Set(['push', 'schedule', 'workflow_dispatch', 'workflow_call', 'release']);

const eventNamePattern = /^[a-z][a-z0-9_]*$/;
const documentationExtensions = new Set([
	'gif',
	'ico',
	'jpeg',
	'jpg',
	'markdown',
	'md',
	'pdf',
	'png',
	'svg',
	'txt',
	'webp'
]);
// Repository-root documentation files. The pattern cannot match a path with a
// slash, so a same-named file in another directory keeps full validation.
const rootDocumentationPattern =
	/^(?:AGENTS|ARCHITECTURE|CHANGELOG|CODE_OF_CONDUCT|CONTRIBUTING|GOVERNANCE|LICENSE|README|SECURITY|SUPPORT|THIRD_PARTY_NOTICES)(?:\.[A-Za-z0-9.+-]+)?$/;

class ClassifierError extends Error {}

function reject(message) {
	throw new ClassifierError(message);
}

function parseArguments(argv) {
	const parsed = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument !== '--event-name') {
			reject(`unknown argument: ${argument}`);
		}
		const value = argv[index + 1];
		if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
			reject(`missing value for ${argument}`);
		}
		parsed.eventName = value;
		index += 1;
	}
	return parsed;
}

async function readPaths() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks)
		.toString('utf8')
		.split('\0')
		.filter((path) => path !== '');
}

function isDocumentation(path) {
	// Reject absolute, trailing-slash, control-character, backslash and
	// unsatisfiable paths. A crafted path must not reach the cheap route.
	if (path.startsWith('/') || path.endsWith('/')) return false;
	if (/[\u0000-\u001f\u007f]/.test(path)) return false;
	if (path.includes('\\')) return false;
	const segments = path.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		return false;
	}
	if (rootDocumentationPattern.test(path)) return true;
	if (segments[0] !== 'docs') return false;
	const name = segments[segments.length - 1];
	const dot = name.lastIndexOf('.');
	if (dot <= 0 || dot === name.length - 1) return false;
	return documentationExtensions.has(name.slice(dot + 1).toLowerCase());
}

function classify(eventName, paths) {
	if (!eventNamePattern.test(eventName)) {
		reject(`invalid event name: ${JSON.stringify(eventName)}`);
	}
	if (eventName !== 'pull_request') {
		const reason = fullEvents.has(eventName)
			? `event:${eventName}`
			: `event:${eventName}:default-full`;
		return { className: 'full', reason };
	}
	if (paths.length === 0) {
		return { className: 'full', reason: 'full:no-paths' };
	}
	if (paths.some((path) => !isDocumentation(path))) {
		return { className: 'full', reason: 'full:non-documentation' };
	}
	return { className: 'docs', reason: `docs-only:${paths.length}` };
}

async function main() {
	const args = parseArguments(process.argv.slice(2));
	const eventName = args.eventName ?? process.env.GITHUB_EVENT_NAME;
	if (typeof eventName !== 'string' || eventName === '') {
		reject('event name is missing');
	}
	// Only a pull request needs the changed paths. Every other event is full.
	const paths = eventName === 'pull_request' ? await readPaths() : [];
	const classified = classify(eventName, paths);
	process.stdout.write(`class=${classified.className}\nreason=${classified.reason}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	try {
		await main();
	} catch (error) {
		const message =
			error instanceof ClassifierError ? error.message : `internal error: ${error.message}`;
		process.stderr.write(`ci-changes: ${message}\n`);
		process.exit(2);
	}
}
