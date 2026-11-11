import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateWorkflowCondition } from './ci-security-workflow-expression.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = readFileSync(join(ROOT, '.github', 'workflows', 'cli-package.yml'), 'utf8');
const NODE_VERSION = readFileSync(join(ROOT, '.node-version'), 'utf8').trim();

function extractAnchoredPaths(text) {
	const lines = text.split('\n');
	const start = lines.findIndex((line) => /^\s*paths: &cli-paths\s*$/.test(line));
	assert.notEqual(start, -1, 'missing anchored CLI path list');
	const indent = lines[start].match(/^\s*/)[0].length;
	const paths = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() === '') continue;
		const lineIndent = line.match(/^\s*/)[0].length;
		if (lineIndent <= indent) break;
		const match = line.match(/^\s*-\s*'([^']+)'\s*$/);
		assert.ok(match, `unexpected path entry: ${line}`);
		paths.push(match[1]);
	}
	return paths;
}

// Read the workflow_call input declarations. The check is a small YAML reader
// for the fixed indentation of this file, not a text match on one line.
function workflowCallInputs(text) {
	const lines = text.split('\n');
	const start = lines.findIndex((line) => /^ {2}workflow_call:\s*$/.test(line));
	assert.notEqual(start, -1, 'workflow_call trigger is missing');
	const section = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() !== '' && !/^ {3,}/.test(line)) break;
		section.push(line);
	}
	const inputsIndex = section.findIndex((line) => /^ {4}inputs:\s*$/.test(line));
	assert.notEqual(inputsIndex, -1, 'workflow_call declares no inputs');
	const inputs = {};
	let name = null;
	for (let index = inputsIndex + 1; index < section.length; index += 1) {
		const line = section[index];
		if (line.trim() === '') continue;
		const indent = line.match(/^ */)[0].length;
		if (indent <= 4) break;
		if (indent === 6) {
			const match = line.match(/^ {6}([A-Za-z0-9_-]+):\s*$/);
			assert.ok(match, `unexpected workflow_call input entry: ${line}`);
			name = match[1];
			inputs[name] = {};
			continue;
		}
		const match = line.match(/^ {8}([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
		assert.ok(match && name, `unexpected workflow_call input property: ${line}`);
		inputs[name][match[1]] = match[2];
	}
	return inputs;
}

// Return every upload step with its executed condition and archive path.
function uploadSteps(text) {
	const lines = text.split('\n');
	const steps = [];
	for (let index = 0; index < lines.length; index += 1) {
		const name = lines[index].match(/^\s*- name: (Upload the standalone CLI archive.*)$/);
		if (!name) continue;
		const step = { name: name[1], condition: null, path: null };
		for (let scan = index + 1; scan < lines.length; scan += 1) {
			if (/^\s*- name:/.test(lines[scan])) break;
			const condition = lines[scan].match(/^\s*if:\s*(.+?)\s*$/);
			if (condition) step.condition = condition[1];
			const archive = lines[scan].match(/^\s*path:\s*(.+?)\s*$/);
			if (archive) step.path = archive[1];
		}
		assert.ok(step.condition, `upload step has no condition: ${step.name}`);
		assert.ok(step.path, `upload step has no path: ${step.name}`);
		steps.push(step);
	}
	return steps;
}

function contextFor({ event, inputs = {}, os = 'Linux' }) {
	return {
		github: { event_name: event },
		inputs,
		runner: { os },
		matrix: { node_platform: os === 'Windows' ? 'win32' : 'linux', node_arch: 'x64' }
	};
}

test('the pull request and push filters share one complete path list', () => {
	const paths = extractAnchoredPaths(CLI);
	assert.equal((CLI.match(/paths: \*cli-paths/g) ?? []).length, 1);
	assert.deepEqual(paths, [
		'cli/**',
		'bin/deckmark.mjs',
		'bin/deckmark-mcp.mjs',
		'src/lib/**',
		'scripts/build-cli.mjs',
		'scripts/pack-cli.mjs',
		'scripts/pack-cli.test.mjs',
		'scripts/ci-cli*.mjs',
		'package.json',
		'package-lock.json',
		'.node-version',
		'.npmrc',
		'tsconfig.json',
		'.github/scripts/**',
		'.github/actions/**',
		'.github/workflows/cli-package.yml'
	]);
	assert.ok(paths.includes('.github/scripts/**'));
	assert.ok(paths.includes('.github/actions/**'));
	assert.ok(paths.includes('.github/workflows/cli-package.yml'));
});

test('the standalone bundled-runtime contract and installed suite remain', () => {
	assert.match(CLI, /runtime="\$RUNNER_TEMP\/cli-runtime"/);
	assert.match(CLI, /runtime\/bin\/\$binary/);
	assert.match(CLI, /runtime\/LICENSE/);
	assert.match(CLI, /node-version-file: \.node-version/);
	assert.equal(NODE_VERSION, '22');
	assert.match(CLI, /npm ci --legacy-peer-deps/);
	assert.match(CLI, /--test scripts\/pack-cli\.test\.mjs/);
	assert.match(CLI, /scripts\/pack-cli\.mjs verify/);
	assert.match(CLI, /installed-cli/);
	for (const runner of ['ubuntu-24.04', 'windows-2022', 'macos-15']) {
		assert.match(CLI, new RegExp(runner), runner);
	}
});

test('the workflow is callable but has no release, registry, or auth side effect', () => {
	assert.match(CLI, /workflow_call:/);
	assert.doesNotMatch(CLI, /workflow_run|^ {2}release:/m);
	assert.doesNotMatch(CLI, /npm publish|npm login|registry-url|NODE_AUTH_TOKEN|secrets\./);
	assert.doesNotMatch(CLI, /id-token:\s*write|contents:\s*write|packages:\s*write/);
	assert.match(CLI, /permissions:\n {2}contents: read/);
});

test('the reusable call declares an opt-in upload input that defaults to off', () => {
	const inputs = workflowCallInputs(CLI);
	assert.deepEqual(Object.keys(inputs), ['upload_build_artifacts']);
	const input = inputs.upload_build_artifacts;
	assert.equal(input.type, 'boolean');
	assert.equal(input.default, 'false');
});

test('the upload condition depends on the opt-in input, not on the event name', () => {
	const steps = uploadSteps(CLI);
	assert.equal(steps.length, 2);
	for (const step of steps) {
		// `github.event_name` is the caller event inside a reusable workflow, so
		// it can never equal workflow_call. A gate on it is always false.
		assert.doesNotMatch(step.condition, /event_name/, step.name);
		assert.match(step.condition, /inputs\.upload_build_artifacts/, step.name);
	}
	assert.equal((CLI.match(/uses: actions\/upload-artifact@/g) ?? []).length, 2);
});

test('standalone pull request, push, and manual runs upload no artifact', () => {
	const steps = uploadSteps(CLI);
	for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
		for (const os of ['Linux', 'Windows', 'macOS']) {
			for (const step of steps) {
				assert.equal(
					evaluateWorkflowCondition(step.condition, contextFor({ event, os })),
					false,
					`${event} ${os} ${step.name}`
				);
			}
		}
	}
});

test('a reusable call uploads only when the caller opts in', () => {
	const steps = uploadSteps(CLI);
	const tar = steps.find((step) => step.path.includes('.tar.gz'));
	const zip = steps.find((step) => step.path.includes('.zip'));
	assert.ok(tar && zip, 'missing tar or zip upload step');

	// Default off: the caller event name cannot turn the upload on by itself.
	for (const os of ['Linux', 'Windows', 'macOS']) {
		for (const step of steps) {
			assert.equal(
				evaluateWorkflowCondition(
					step.condition,
					contextFor({ event: 'workflow_call', inputs: { upload_build_artifacts: false }, os })
				),
				false,
				`${os} ${step.name}`
			);
		}
	}

	// Opted in: each platform uploads its own archive format only.
	for (const os of ['Linux', 'macOS']) {
		const context = contextFor({
			event: 'workflow_call',
			inputs: { upload_build_artifacts: true },
			os
		});
		assert.equal(evaluateWorkflowCondition(tar.condition, context), true, os);
		assert.equal(evaluateWorkflowCondition(zip.condition, context), false, os);
	}
	const windows = contextFor({
		event: 'workflow_call',
		inputs: { upload_build_artifacts: true },
		os: 'Windows'
	});
	assert.equal(evaluateWorkflowCondition(zip.condition, windows), true);
	assert.equal(evaluateWorkflowCondition(tar.condition, windows), false);

	assert.match(
		CLI,
		/name: deckmark-cli-\$\{\{ github\.sha \}\}-\$\{\{ matrix\.node_platform \}\}-\$\{\{ matrix\.node_arch \}\}/
	);
	assert.match(CLI, /if-no-files-found: error/);
	assert.doesNotMatch(CLI, /upload-sarif/);
});
