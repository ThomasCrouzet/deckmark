#!/usr/bin/env node
// Build and check the release-please override block of a pull request body.
//
// The repository merges by squash with the pull request body as the commit
// message. release-please 17 reads a BEGIN_COMMIT_OVERRIDE ... END_COMMIT_OVERRIDE
// block in the body of the merged pull request instead of the commit message.
// It splits the block into entries at each blank line that a conventional
// type follows, and its changelog prints every issue reference outside a
// header as "closes #N". These rules keep one correct changelog line per
// change:
//
// 1. Exactly one block. Entries are separated by one blank line and each
//    starts with a conventional header. Body lines under a header are allowed;
//    they do not reach the changelog.
// 2. Types: feat, fix, perf, revert (visible); docs, style, refactor, test,
//    build, ci, chore (hidden). Never `deps:`: use fix(deps) or build(deps).
// 3. An issue number appears only in a header, as (#N). A Refs, Closes or
//    Fixes line, or any other #N, inside the block fails. Write GitHub
//    closing keywords above the block.
// 4. A breaking header (`!`) needs a BREAKING-CHANGE: line under it.
// 5. Every releasable branch commit (feat, fix, perf, revert, or breaking)
//    has an entry with the same header, apart from (#N) suffixes.
//
// Usage:
//   node scripts/ci-pr-override.mjs print [--base <ref>] [--head <ref>]
//   PR_BODY="..." node scripts/ci-pr-override.mjs check [--base <ref>] [--head <ref>]
// The default range is origin/main..HEAD. Merge commits are ignored.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const BEGIN = 'BEGIN_COMMIT_OVERRIDE';
export const END = 'END_COMMIT_OVERRIDE';
const TYPES = [
	'feat',
	'fix',
	'docs',
	'style',
	'refactor',
	'perf',
	'test',
	'build',
	'ci',
	'chore',
	'revert'
];
const VISIBLE = new Set(['feat', 'fix', 'perf', 'revert']);
export const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([^()\\s][^()]*\\))?(!)?: (\\S.*)$`);
const DEPS = /^deps(\([^()]*\))?!?:/;
const ISSUE = /#\d+\b/;
const REFERENCE_FOOTER =
	/^(refs?|references?|closes?|closed|fix(?:es|ed)?|resolves?|resolved|see|related(?: to)?)\b[:\s]+(?:[\w.-]+\/[\w.-]+)?#(\d+)/i;
const CLOSING = /^(closes?|closed|fix(?:es|ed)?|resolves?|resolved)$/i;
const BREAKING = /^BREAKING[- ]CHANGE: \S/;

/** Normalize a header for matching: no (#N) suffix, no `!`, one space, lowercase. */
export function headerKey(header) {
	return header
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/(?:\s*\((?:#\d+(?:,\s*)?)+\))+$/, '')
		.replace(/\.$/, '')
		.replace(/^([a-z]+(?:\([^()]*\))?)!:/, '$1:')
		.trim();
}

/**
 * Read the branch commits, oldest first.
 * @param {string} base @param {string} head
 * @returns {{ sha: string, message: string }[]}
 */
export function readCommits(base, head) {
	const output = execFileSync(
		'git',
		['log', '--no-merges', '--reverse', '--format=%H%x1f%B%x1e', `${base}..${head}`],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
	);
	return output
		.split('\x1e')
		.map((record) => record.replace(/^\n+/, ''))
		.filter((record) => record.includes('\x1f'))
		.map((record) => {
			const [sha, message] = record.split('\x1f');
			return { sha: sha.trim(), message: message.replace(/\r\n/g, '\n').trim() };
		});
}

/** @param {string} message */
function describeCommit(message) {
	const [first = '', ...rest] = message.split('\n');
	let header = first.trim();
	if (DEPS.test(header)) header = header.replace(DEPS, 'build(deps):');
	const match = HEADER.exec(header);
	if (!match) return null;
	const issues = [];
	const closing = [];
	for (const line of rest) {
		const footer = REFERENCE_FOOTER.exec(line.trim());
		if (!footer) continue;
		for (const number of line.matchAll(/#(\d+)/g)) {
			if (!issues.includes(number[1])) issues.push(number[1]);
			if (CLOSING.test(footer[1]) && !closing.includes(number[1])) closing.push(number[1]);
		}
	}
	const breaking = match[3] === '!' || rest.some((line) => BREAKING.test(line.trim()));
	return { header, type: match[1], breaking, issues, closing, body: rest };
}

/**
 * Print the closing lines and the override block for the branch commits.
 * @param {{ sha: string, message: string }[]} commits
 */
export function renderOverride(commits) {
	const entries = [];
	const seen = new Set();
	const closing = [];
	for (const commit of commits) {
		const described = describeCommit(commit.message);
		if (!described) continue;
		const key = headerKey(described.header);
		if (seen.has(key)) continue;
		seen.add(key);
		const present = new Set([...described.header.matchAll(/#(\d+)/g)].map((match) => match[1]));
		const missing = described.issues.filter((number) => !present.has(number));
		let header = described.header.replace(/\s*\.$/, '');
		if (missing.length > 0) header += ` (${missing.map((number) => `#${number}`).join(', ')})`;
		if (described.breaking && !header.includes('!:')) {
			header = header.replace(/^([a-z]+(?:\([^()]*\))?):/, '$1!:');
		}
		const lines = [header];
		if (described.breaking) {
			const note = described.body.find((line) => BREAKING.test(line.trim()));
			lines.push(
				note
					? note.trim().replace(/^BREAKING CHANGE:/, 'BREAKING-CHANGE:')
					: 'BREAKING-CHANGE: describe the change.'
			);
		}
		entries.push(lines.join('\n'));
		for (const number of described.closing) if (!closing.includes(number)) closing.push(number);
	}
	const parts = [];
	if (closing.length > 0) parts.push(closing.map((number) => `Closes #${number}`).join('\n'));
	parts.push([BEGIN, entries.join('\n\n'), END].filter(Boolean).join('\n'));
	return `${parts.join('\n\n')}\n`;
}

/**
 * Check a pull request body against the branch commits.
 * @param {string} body
 * @param {{ sha: string, message: string }[]} commits
 * @returns {string[]} problems
 */
export function checkOverride(body, commits) {
	const text = String(body ?? '').replace(/\r\n/g, '\n');
	const problems = [];
	const begins = text.split(BEGIN).length - 1;
	const ends = text.split(END).length - 1;
	if (begins === 0 && ends === 0) {
		return [
			`The body has no ${BEGIN} block. Add the output of node scripts/ci-pr-override.mjs print.`
		];
	}
	if (begins !== 1 || ends !== 1) {
		return [`The body must hold exactly one ${BEGIN} and one ${END} line.`];
	}
	const start = text.indexOf(BEGIN) + BEGIN.length;
	const stop = text.indexOf(END);
	if (stop < start) return [`${END} comes before ${BEGIN}.`];
	const block = text.slice(start, stop).trim();
	if (block === '') return ['The override block is empty.'];

	const paragraphs = block.split(/\n[ \t]*\n/).map((paragraph) => paragraph.split('\n'));
	/** @type {{ header: string, breaking: boolean, lines: string[] }[]} */
	const entries = [];
	for (const lines of paragraphs) {
		const first = lines[0].trim();
		if (lines[0] !== first) problems.push(`An entry must start at the line start: "${lines[0]}".`);
		if (DEPS.test(first)) {
			problems.push(`"${first}": deps is not a release-please type. Use fix(deps) or build(deps).`);
			continue;
		}
		const match = HEADER.exec(first);
		if (match) entries.push({ header: first, breaking: match[3] === '!', lines: lines.slice(1) });
		else if (entries.length === 0) {
			problems.push(`The block must start with a conventional header, not "${first}".`);
			continue;
		} else entries.at(-1).lines.push('', ...lines);
		for (const line of match ? lines.slice(1) : lines) {
			const trimmed = line.trim();
			if (HEADER.test(trimmed) || DEPS.test(trimmed)) {
				problems.push(
					`"${trimmed}" needs a blank line before it, or release-please merges it into the previous entry.`
				);
			}
		}
	}
	for (const entry of entries) {
		for (const line of entry.lines) {
			const trimmed = line.trim();
			if (REFERENCE_FOOTER.test(trimmed) || ISSUE.test(trimmed)) {
				problems.push(
					`"${trimmed}" under "${entry.header}": release-please prints it as "closes". Put the issue in the header as (#N) and closing keywords above the block.`
				);
			}
		}
		if (entry.breaking && !entry.lines.some((line) => BREAKING.test(line.trim()))) {
			problems.push(`"${entry.header}" is breaking and needs a BREAKING-CHANGE: line under it.`);
		}
	}

	const keys = new Set(entries.map((entry) => headerKey(entry.header)));
	for (const commit of commits) {
		const described = describeCommit(commit.message);
		if (!described) continue;
		if (!VISIBLE.has(described.type) && !described.breaking) continue;
		if (!keys.has(headerKey(described.header))) {
			problems.push(
				`Releasable commit ${commit.sha.slice(0, 7)} "${described.header}" has no entry. Add it, or regenerate the block with node scripts/ci-pr-override.mjs print.`
			);
		}
	}
	return problems;
}

/** @param {string[]} argv */
function parseArguments(argv) {
	const values = { base: 'origin/main', head: 'HEAD' };
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!['--base', '--head'].includes(key) || value === undefined) {
			throw new Error(
				'Usage: node scripts/ci-pr-override.mjs print|check [--base <ref>] [--head <ref>]'
			);
		}
		values[key.slice(2)] = value;
	}
	return values;
}

function main(argv) {
	const [mode, ...rest] = argv;
	const { base, head } = parseArguments(rest);
	if (mode === 'print') {
		process.stdout.write(renderOverride(readCommits(base, head)));
		return 0;
	}
	if (mode === 'check') {
		if (process.env.PR_BODY === undefined) throw new Error('PR_BODY is not set.');
		const problems = checkOverride(process.env.PR_BODY, readCommits(base, head));
		for (const problem of problems) console.error(`::error::${problem}`);
		if (problems.length > 0) return 1;
		console.log('The override block is valid for every releasable commit.');
		return 0;
	}
	throw new Error(
		'Usage: node scripts/ci-pr-override.mjs print|check [--base <ref>] [--head <ref>]'
	);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
