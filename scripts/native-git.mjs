// Native verification for the Git diff review path.
//
// The fixture is a real Git repository inside the approved native project root.
// It commits one small file, then writes a 2600-line change. The workflow opens
// the Projects panel, selects the linked native project, opens Git changes, and
// checks the first and last diff sections. The caller runs a native-smoke binary
// with a linked native project, as scripts/native-projects.mjs does.
//
// This module is not wired into scripts/native-smoke.mjs yet. The parent stream
// owns that integration. Pass `request` and `session` to use real WebDriver key
// events; without them the workflow records a pointer-only result.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const firstLine = 'line 0001';
const lastLine = 'line 2600 END';

function buildDiff() {
	return Array.from({ length: 2600 }, (_, index) => {
		const line = `line ${String(index + 1).padStart(4, '0')}`;
		return index === 2599 ? `${line} END` : line;
	}).join('\n');
}

function git(cwd, args) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull }
	});
}

/**
 * Exercise the Git diff review path through the native WebDriver.
 * @param {{
 *   execute: (script: string, args?: unknown[]) => Promise<any>,
 *   executeAsync: (script: string, args?: unknown[]) => Promise<any>,
 *   until: (check: () => Promise<unknown>, label: string, timeout?: number) => Promise<any>,
 *   request?: (path: string, body?: unknown, method?: string) => Promise<any>,
 *   session?: string,
 *   fixtureRoot: string,
 *   output: string
 * }} context
 */
export async function nativeGit({
	execute,
	executeAsync,
	until,
	request,
	session,
	fixtureRoot,
	output
}) {
	const evidence = [];
	const record = (scenario, result) => {
		evidence.push({ scenario, result });
		return result;
	};
	const click = (selector) =>
		until(
			() =>
				execute(
					`const element = document.querySelector(arguments[0]);
					if (!element || element.disabled || element.closest('[inert]') || !element.getClientRects().length) return false;
					element.click(); return true;`,
					[selector]
				),
			`click ${selector}`,
			45_000
		);
	const readDiff = () =>
		execute(
			`const panel = document.querySelector('[data-testid=git-panel]');
			const list = panel?.querySelector('ol');
			const range = panel?.querySelector('[data-testid=git-diff-range]');
			const text = range?.textContent?.trim() ?? '';
			const total = /(?:sur|of)\\s+(\\d+)/.exec(text);
			return {
				rows: list ? list.querySelectorAll('li').length : 0,
				state: range?.getAttribute('data-review-state') ?? null,
				text,
				total: total ? Number(total[1]) : null,
				first: !!list && list.textContent.includes(arguments[0]),
				last: !!list && list.textContent.includes(arguments[1])
			};`,
			[firstLine, lastLine]
		);
	const clickGitFile = (name) =>
		until(
			() =>
				execute(
					`const panel = document.querySelector('[data-testid=git-panel]');
					const element = [...(panel?.querySelectorAll('button') ?? [])].find(node => node.textContent.trim() === arguments[0]);
					if (!element || element.disabled || !element.getClientRects().length) return false;
					element.click(); return true;`,
					[name]
				),
			`click Git file ${name}`,
			45_000
		);
	const readProjects = () =>
		executeAsync(`const done = arguments[arguments.length - 1];
		const request = indexedDB.open('mdsh');
		request.onerror = () => done({ error: String(request.error) });
		request.onsuccess = () => {
			const database = request.result;
			const query = database.transaction('projects').objectStore('projects').getAll();
			query.onerror = () => { database.close(); done({ error: String(query.error) }); };
			query.onsuccess = () => {
				database.close();
				done(query.result.map(({ id, name, nativeRootId }) => ({ id, name, nativeRootId })));
			};
		};`);

	const base = `# Native Git review\n\nBase body.\n`;
	writeFileSync(join(fixtureRoot, 'long.md'), base);
	git(fixtureRoot, ['init', '-q']);
	git(fixtureRoot, ['add', '--', 'long.md']);
	git(fixtureRoot, [
		'-c',
		'user.name=DeckMark native smoke',
		'-c',
		'user.email=native-smoke@example.invalid',
		'commit',
		'-q',
		'-m',
		'fixture base'
	]);
	const content = `# Native Git review\n\n${buildDiff()}\n`;
	writeFileSync(join(fixtureRoot, 'long.md'), content);
	record('fixture repository', {
		fixtureRoot,
		path: 'long.md',
		lines: 2600,
		sha256: createHash('sha256').update(content).digest('hex'),
		head: git(fixtureRoot, ['rev-parse', 'HEAD']).trim()
	});

	await click('[data-testid=projects-open]');
	await until(
		() => execute('return !!document.getElementById("projects-title")'),
		'Projects panel opens',
		45_000
	);
	let projects = await readProjects();
	assert.ok(Array.isArray(projects), JSON.stringify(projects));
	let project = projects.find((row) => row.nativeRootId);
	if (!project) {
		await until(
			() =>
				execute(
					`const element = [...document.querySelectorAll('button')].find(node => /dossier du disque|disk folder/i.test(node.textContent));
					if (!element || element.disabled || element.closest('[inert]') || !element.getClientRects().length) return false;
					element.click(); return true;`
				),
			'open the native project folder',
			60_000
		);
		project = await until(
			async () => {
				const rows = await readProjects();
				if (!Array.isArray(rows)) return false;
				return rows.find((row) => row.nativeRootId) ?? false;
			},
			'native project becomes linked',
			60_000
		);
	}
	await until(
		() =>
			execute(
				`const select = document.querySelector('[role="dialog"] select');
				if (!select) return false;
				select.value = arguments[0];
				select.dispatchEvent(new Event('change', { bubbles: true }));
				return select.value === arguments[0];`,
				[project.id]
			),
		'linked native project selected',
		45_000
	);
	await click('[data-testid=project-git]');
	await until(
		() => execute('return !!document.querySelector("[data-testid=git-panel]")'),
		'Git panel opens',
		45_000
	);
	await clickGitFile('long.md');
	await until(
		async () => {
			const state = await readDiff();
			return state.rows === 2000 && state.state === 'partial';
		},
		'initial diff page is bounded',
		45_000
	);
	const initial = record('initial page', await readDiff());
	assert.equal(initial.rows, 2000);
	assert.equal(initial.first, true);
	assert.equal(initial.last, false);
	assert.ok(initial.total && initial.total > 2000, JSON.stringify(initial));
	const expectedLastRows = initial.total - 2000;

	let keyboardFocused = false;
	let keyboardActivated = false;
	let pointerFallback = false;
	if (request && session) {
		keyboardFocused = await execute(
			`const element = document.querySelector('[data-testid=git-diff-last]');
			element?.focus();
			return document.activeElement === element;`
		);
		const element = await request(
			`/session/${session}/element`,
			{ using: 'css selector', value: '[data-testid=git-diff-last]' },
			'POST'
		);
		const elementId = element?.['element-6066-11e4-a52e-4f735466cecf'];
		assert.ok(elementId, JSON.stringify(element));
		try {
			await request(
				`/session/${session}/actions`,
				{
					actions: [
						{
							type: 'key',
							id: 'keyboard',
							actions: [
								{ type: 'keyDown', value: '\uE007' },
								{ type: 'keyUp', value: '\uE007' }
							]
						}
					]
				},
				'POST'
			);
			await delay(500);
			const afterKey = await readDiff();
			keyboardActivated = afterKey.state === 'complete' && afterKey.rows === expectedLastRows;
		} catch (error) {
			record('keyboard action error', String(error));
		}
		if (!keyboardActivated) {
			await request(`/session/${session}/element/${elementId}/click`, {}, 'POST');
			pointerFallback = true;
		}
	} else {
		await click('[data-testid=git-diff-last]');
		pointerFallback = true;
	}
	await until(
		async () => {
			const state = await readDiff();
			return state.rows === expectedLastRows && state.state === 'complete' && state.last;
		},
		'last diff section is reachable',
		45_000
	);
	const last = record('last page', {
		...(await readDiff()),
		keyboardFocused,
		keyboardActivated,
		pointerFallback
	});
	assert.equal(last.rows, expectedLastRows);
	assert.equal(last.last, true);
	assert.equal(last.first, false);
	if (request && session) assert.equal(last.keyboardFocused, true);

	await click('[data-testid=git-diff-first]');
	await until(
		async () => {
			const state = await readDiff();
			return state.rows === 2000 && state.state === 'partial' && state.first;
		},
		'first diff section returns',
		45_000
	);
	const returned = record('returned to first page', await readDiff());
	assert.equal(returned.first, true);
	assert.equal(returned.last, false);
	assert.equal(returned.total, initial.total);

	writeFileSync(
		join(output, 'native-git.json'),
		JSON.stringify(
			{
				recordedAt: new Date().toISOString(),
				platform: process.platform,
				project,
				fixture: {
					path: 'long.md',
					lines: 2600,
					diffLines: initial.total,
					firstLine,
					lastLine
				},
				keyboardFocused,
				keyboardActivated,
				pointerFallback,
				evidence
			},
			null,
			2
		)
	);
	return evidence;
}
