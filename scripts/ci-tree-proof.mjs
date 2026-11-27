#!/usr/bin/env node
// Decide whether a push to main may reuse the validation of a pull request
// run on the identical tree.
//
// A squash merge of an up-to-date pull request creates a main commit with the
// same tree as the pull request head. The pull request run already validated
// that tree, so a second full run proves nothing new. This script accepts the
// earlier run only when every condition holds:
//
// 1. The event is a push to refs/heads/main.
// 2. The API lists exactly one merged pull request whose merge commit is this
//    commit, with base main and a head branch in this repository (no fork).
// 3. refs/pull/<n>/head fetches to the head SHA that the API reports.
// 4. The tree of this commit equals the tree of that head.
// 5. The first parent of this commit is an ancestor of that head. The pull
//    request run then tested a merge ref with the same tree, because its base
//    was an ancestor of the first parent.
// 6. The newest successful pull_request run of the same workflow file for
//    that head, from this repository, has every required job (latest attempt)
//    with conclusion success.
//
// Any failed condition, API error or Git error gives reuse=false, and the
// workflow runs full validation. The script never fails the job.
//
// Usage:
//   node scripts/ci-tree-proof.mjs --event <name> --ref <ref> --sha <sha>
//     --repository <owner/name> --workflow <deploy.yml|desktop.yml> [--output <file>]
// Environment: GH_TOKEN (read token), GITHUB_API_URL (optional).
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHA = /^[0-9a-f]{40}$/;

/**
 * Jobs that must have succeeded in the pull request run. `prefix` entries
 * match matrix jobs; `count` is exact and `min` is a lower bound.
 */
export const REQUIREMENTS = Object.freeze({
	'deploy.yml': [
		{ name: 'check' },
		{ name: 'e2e' },
		{ name: 'lighthouse' },
		{ name: 'e2e-build' },
		{ name: 'e2e-manifest' },
		{ prefix: 'e2e-shard (', min: 1 },
		{ prefix: 'build (', count: 2 }
	],
	'desktop.yml': [
		{ name: 'desktop-validation' },
		{ name: 'web-build' },
		{ prefix: 'validate-desktop (', count: 3 },
		{ prefix: 'web-benchmark (', count: 3 },
		{ prefix: 'native-smoke (', count: 3 },
		{ prefix: 'native-benchmark (', count: 3 }
	]
});

class Refusal extends Error {}

function refuse(message) {
	throw new Refusal(message);
}

/**
 * Check the required jobs of one run.
 * @param {{ name: string, conclusion: string | null }[]} jobs
 * @param {(typeof REQUIREMENTS)[keyof typeof REQUIREMENTS]} requirements
 */
export function missingJobs(jobs, requirements) {
	const problems = [];
	for (const requirement of requirements) {
		const matched = jobs.filter((job) =>
			'name' in requirement
				? job.name === requirement.name
				: job.name.startsWith(requirement.prefix)
		);
		const label = 'name' in requirement ? requirement.name : `${requirement.prefix}*`;
		const failed = matched.filter((job) => job.conclusion !== 'success');
		if (matched.length === 0) problems.push(`${label} did not run`);
		else if (failed.length > 0) {
			problems.push(`${failed.map((job) => `${job.name}=${job.conclusion}`).join(', ')}`);
		} else if ('count' in requirement && matched.length !== requirement.count) {
			problems.push(`${label} ran ${matched.length} times, expected ${requirement.count}`);
		} else if ('min' in requirement && matched.length < requirement.min) {
			problems.push(`${label} ran ${matched.length} times, expected at least ${requirement.min}`);
		}
	}
	return problems;
}

/**
 * @param {{
 *   event: string, ref: string, sha: string, repository: string, workflow: string,
 *   api: (path: string) => Promise<any>, git: (args: string[]) => string
 * }} input
 * @returns {Promise<{ reuse: boolean, reason: string, proofRun?: number, proofSha?: string, pull?: number }>}
 */
export async function proveTree({ event, ref, sha, repository, workflow, api, git }) {
	try {
		if (event !== 'push' || ref !== 'refs/heads/main')
			refuse(`event ${event} ${ref} is not a push to main`);
		if (!SHA.test(sha)) refuse(`invalid commit ${sha}`);
		const requirements = REQUIREMENTS[workflow];
		if (!requirements) refuse(`no requirements for workflow ${workflow}`);

		const pulls = await api(`repos/${repository}/commits/${sha}/pulls?per_page=100`);
		if (!Array.isArray(pulls)) refuse('the pull request list is not an array');
		const merged = pulls.filter(
			(pull) =>
				pull?.merged_at &&
				pull.merge_commit_sha === sha &&
				pull.base?.ref === 'main' &&
				pull.base?.repo?.full_name === repository
		);
		if (merged.length !== 1) refuse(`${merged.length} merged pull requests have this merge commit`);
		const [pull] = merged;
		if (pull.head?.repo?.full_name !== repository)
			refuse(`pull request #${pull.number} comes from a fork`);
		const head = pull.head?.sha;
		if (!SHA.test(head ?? '')) refuse(`pull request #${pull.number} has no head commit`);

		git([
			'fetch',
			'--no-tags',
			'--quiet',
			'origin',
			`+refs/pull/${pull.number}/head:refs/remotes/proof/head`
		]);
		const fetched = git(['rev-parse', 'refs/remotes/proof/head']).trim();
		if (fetched !== head)
			refuse(`refs/pull/${pull.number}/head is ${fetched}, the API reports ${head}`);
		const tree = git(['rev-parse', `${sha}^{tree}`]).trim();
		const headTree = git(['rev-parse', `${head}^{tree}`]).trim();
		if (tree !== headTree) refuse(`the merged tree ${tree} differs from the head tree ${headTree}`);
		try {
			git(['merge-base', '--is-ancestor', `${sha}^1`, head]);
		} catch {
			refuse(`the head of #${pull.number} did not contain main before the merge (BEHIND)`);
		}

		const listing = await api(
			`repos/${repository}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${head}&per_page=50`
		);
		const path = `.github/workflows/${workflow}`;
		const runs = (listing?.workflow_runs ?? [])
			.filter(
				(run) =>
					run.head_sha === head &&
					run.event === 'pull_request' &&
					run.conclusion === 'success' &&
					run.head_repository?.full_name === repository &&
					String(run.path ?? '').split('@')[0] === path
			)
			.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
		if (runs.length === 0) refuse(`no successful pull_request run of ${workflow} for ${head}`);
		const [run] = runs;
		const jobs = await api(
			`repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`
		);
		const problems = missingJobs(jobs?.jobs ?? [], requirements);
		if (problems.length > 0)
			refuse(`run ${run.id} is not a complete proof: ${problems.join('; ')}`);
		return {
			reuse: true,
			reason: `tree ${tree} of #${pull.number} passed in run ${run.id}`,
			proofRun: run.id,
			proofSha: head,
			pull: pull.number
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { reuse: false, reason: error instanceof Refusal ? message : `error: ${message}` };
	}
}

/** @param {string[]} argv */
function parseArguments(argv) {
	/** @type {Record<string, string>} */
	const values = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument ${key}`);
		values[key.slice(2)] = value;
	}
	return values;
}

async function main() {
	let values = {};
	let result;
	try {
		values = parseArguments(process.argv.slice(2));
		const base = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
		const token = process.env.GH_TOKEN ?? '';
		const api = async (path) => {
			const response = await fetch(`${base}/${path}`, {
				headers: {
					accept: 'application/vnd.github+json',
					'x-github-api-version': '2022-11-28',
					...(token ? { authorization: `Bearer ${token}` } : {})
				}
			});
			if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
			return response.json();
		};
		const git = (args) =>
			execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		result = await proveTree({
			event: values.event ?? '',
			ref: values.ref ?? '',
			sha: values.sha ?? '',
			repository: values.repository ?? '',
			workflow: values.workflow ?? '',
			api,
			git
		});
	} catch (error) {
		result = {
			reuse: false,
			reason: `error: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	const lines = [
		`reuse=${result.reuse}`,
		`proof_run=${result.proofRun ?? ''}`,
		`proof_sha=${result.proofSha ?? ''}`,
		`reason=${result.reason.replace(/[\r\n]+/g, ' ')}`
	];
	const repository = values.repository ?? '';
	if (result.reuse) {
		console.log(
			`Reuse: ${result.reason}. Proof: https://github.com/${repository}/actions/runs/${result.proofRun}`
		);
	} else {
		console.log(`Full validation: ${result.reason}.`);
	}
	if (values.output) appendFileSync(values.output, `${lines.join('\n')}\n`);
	else console.log(lines.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	await main();
}
