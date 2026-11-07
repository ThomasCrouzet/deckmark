// Fail-closed CI tier policy for the Desktop and Web workflows.
// A draft pull request defers expensive jobs. Every other valid event runs the
// full tier. A missing, malformed or contradictory event exits nonzero and
// prints no tier, so a workflow step cannot fall back to the fast path.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fullEvents = new Set(['push', 'schedule', 'workflow_dispatch', 'workflow_call', 'release']);
const pullRequestActions = new Set([
	'opened',
	'synchronize',
	'reopened',
	'ready_for_review',
	'converted_to_draft'
]);
const shaPattern = /^[0-9a-f]{40}$/i;

class PolicyError extends Error {}

function reject(message) {
	throw new PolicyError(message);
}

function parseArguments(argv) {
	const parsed = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument !== '--event-name' && argument !== '--event') {
			reject(`unknown argument: ${argument}`);
		}
		const value = argv[index + 1];
		if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
			reject(`missing value for ${argument}`);
		}
		if (argument === '--event-name') parsed.eventName = value;
		else parsed.eventPath = value;
		index += 1;
	}
	return parsed;
}

function readEvent(path) {
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		reject(`cannot read event file: ${path}`);
	}
	let event;
	try {
		event = JSON.parse(text);
	} catch {
		reject('event file is not valid JSON');
	}
	if (event === null || typeof event !== 'object' || Array.isArray(event)) {
		reject('event file must contain a JSON object');
	}
	return event;
}

function pullRequestFromEnvironment() {
	const action = process.env.CI_TIER_ACTION;
	const draft = process.env.CI_TIER_DRAFT;
	const number = process.env.CI_TIER_PR_NUMBER;
	const head = process.env.CI_TIER_HEAD_SHA;
	const base = process.env.CI_TIER_BASE_SHA;
	if (draft !== 'true' && draft !== 'false') {
		reject('CI_TIER_DRAFT must be true or false');
	}
	if (typeof number !== 'string' || !/^[1-9]\d*$/.test(number)) {
		reject('CI_TIER_PR_NUMBER must be a positive integer');
	}
	return {
		action,
		pull_request: {
			number: Number(number),
			draft: draft === 'true',
			head: { sha: head },
			base: { sha: base }
		}
	};
}

function result(full, reason) {
	return { full, tier: full ? 'full' : 'draft', reason };
}

function classifyPullRequest(event) {
	const pull = event.pull_request;
	if (pull === null || typeof pull !== 'object' || Array.isArray(pull)) {
		reject('pull_request event has no pull_request object');
	}
	const action = event.action;
	if (typeof action !== 'string' || !pullRequestActions.has(action)) {
		reject(`unsupported pull request action: ${String(action)}`);
	}
	if (typeof pull.draft !== 'boolean') {
		reject('pull_request.draft must be a boolean');
	}
	const number = pull.number;
	if (!Number.isInteger(number) || number <= 0) {
		reject('pull_request.number must be a positive integer');
	}
	if (event.number !== undefined && event.number !== number) {
		reject('pull_request.number does not match the event number');
	}
	const head = pull.head?.sha;
	const base = pull.base?.sha;
	if (typeof head !== 'string' || !shaPattern.test(head)) {
		reject('pull_request.head.sha is not a commit SHA');
	}
	if (typeof base !== 'string' || !shaPattern.test(base)) {
		reject('pull_request.base.sha is not a commit SHA');
	}
	if (action === 'ready_for_review' && pull.draft !== false) {
		reject('ready_for_review requires draft false');
	}
	if (action === 'converted_to_draft' && pull.draft !== true) {
		reject('converted_to_draft requires draft true');
	}
	return result(!pull.draft, `event:pull_request:${action}:${pull.draft ? 'draft' : 'ready'}`);
}

function classifyFullEvent(eventName, event) {
	if (!fullEvents.has(eventName)) {
		reject(`unsupported event name: ${eventName}`);
	}
	if (event !== undefined) {
		if (eventName !== 'workflow_call' && event.pull_request !== undefined) {
			reject(`${eventName} event payload is a pull request`);
		}
		if (eventName === 'push') {
			if (typeof event.ref !== 'string' || !event.ref.startsWith('refs/')) {
				reject('push event has no ref');
			}
			if (event.after !== undefined) {
				if (typeof event.after !== 'string' || !shaPattern.test(event.after)) {
					reject('push after value is not a commit SHA');
				}
			}
		}
		if (eventName === 'schedule' && typeof event.schedule !== 'string') {
			reject('schedule event has no schedule value');
		}
		if (eventName === 'release') {
			const tag = event.release?.tag_name;
			if (typeof tag !== 'string' || tag === '') {
				reject('release event has no tag name');
			}
		}
	}
	return result(true, `event:${eventName}`);
}

function main() {
	const args = parseArguments(process.argv.slice(2));
	const eventName = args.eventName ?? process.env.GITHUB_EVENT_NAME;
	if (typeof eventName !== 'string' || eventName === '') {
		reject('event name is missing');
	}
	const event = args.eventPath === undefined ? undefined : readEvent(args.eventPath);
	const classified =
		eventName === 'pull_request'
			? classifyPullRequest(event ?? pullRequestFromEnvironment())
			: classifyFullEvent(eventName, event);
	process.stdout.write(
		`full=${classified.full}\ntier=${classified.tier}\nreason=${classified.reason}\n`
	);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	try {
		main();
	} catch (error) {
		const message =
			error instanceof PolicyError ? error.message : `internal error: ${error.message}`;
		process.stderr.write(`ci-tier: ${message}\n`);
		process.exit(2);
	}
}
