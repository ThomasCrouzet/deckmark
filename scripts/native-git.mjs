// Native verification for the Git diff review path.
//
// The fixture is a real Git repository inside the approved native project root.
// It commits one small version of two files. It then writes a 2600-line
// worktree change to long.md and a distinct 2600-line staged change to
// staged.md. The workflow opens the Projects panel, selects the linked native
// project, opens Git changes, checks the worktree and staged sections, and
// returns to the worktree view. The caller runs a native-smoke binary with a
// linked native project, as scripts/native-projects.mjs does.
//
// scripts/native-smoke.mjs calls this module after the native capture scenario.
// The capture scenario uses programmatic value and input events; this module
// uses real Git processes and, when available, a real X Return key.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const worktreePath = 'long.md';
const stagedPath = 'staged.md';
const hugePath = 'huge.md';
const worktreeFirst = 'worktree line 0001';
const worktreeLast = 'worktree line 2600 WORKTREE-END';
const stagedFirst = 'staged line 0001';
const stagedLast = 'staged line 2600 STAGED-END';

function buildLines(prefix, endSuffix) {
	return Array.from({ length: 2600 }, (_, index) => {
		const line = `${prefix} line ${String(index + 1).padStart(4, '0')}`;
		return index === 2599 ? `${line} ${endSuffix}` : line;
	}).join('\n');
}

function git(cwd, args) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull }
	});
}

function gitBuffer(cwd, args) {
	return execFileSync('git', args, {
		cwd,
		maxBuffer: 8 * 1024 * 1024,
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
	const readDiff = (first = worktreeFirst, last = worktreeLast) =>
		execute(
			`const panel = document.querySelector('[data-testid=git-panel]');
			const diffSection = [...(panel?.querySelectorAll('section') ?? [])].find((section) => section.getAttribute('aria-labelledby') === 'git-diff-title');
			const list = diffSection?.querySelector('ol');
			const range = panel?.querySelector('[data-testid=git-diff-range]');
			const text = range?.textContent?.trim() ?? '';
			const total = /(?:sur|of)\\s+(\\d+)/.exec(text);
			const inView = (marker) => {
				const line = [...(list?.querySelectorAll('li') ?? [])].find((node) => node.textContent.includes(marker));
				if (!line || !list) return false;
				const listRect = list.getBoundingClientRect();
				const lineRect = line.getBoundingClientRect();
				return lineRect.top >= listRect.top - 1 && lineRect.bottom <= listRect.bottom + 1;
			};
			return {
				rows: list ? list.querySelectorAll('li').length : 0,
				state: range?.getAttribute('data-review-state') ?? null,
				text,
				total: total ? Number(total[1]) : null,
				first: !!list && list.textContent.includes(arguments[0]),
				last: !!list && list.textContent.includes(arguments[1]),
				visibleFirst: inView(arguments[0]),
				visibleLast: inView(arguments[1]),
				empty: /Aucune diff|No diff/.test(panel?.textContent ?? '')
			};`,
			[first, last]
		);
	const readLimit = () =>
		execute(
			`const panel = document.querySelector('[data-testid=git-panel]');
			const diffSection = [...(panel?.querySelectorAll('section') ?? [])].find((section) => section.getAttribute('aria-labelledby') === 'git-diff-title');
			const list = diffSection?.querySelector('ol');
			const notice = panel?.querySelector('[data-testid=git-diff-too-large]');
			const generic = panel?.querySelector('[data-testid=git-operation-error]');
			const range = panel?.querySelector('[data-testid=git-diff-range]');
			return {
				tooLarge: !!notice,
				text: notice?.textContent?.trim() ?? '',
				generic: !!generic,
				errorText: generic?.textContent?.trim() ?? '',
				rows: list ? list.querySelectorAll('li').length : 0,
				range: range?.textContent?.trim() ?? ''
			};`
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
	const clickGitButton = (pattern) =>
		until(
			() =>
				execute(
					`const panel = document.querySelector('[data-testid=git-panel]');
					const matcher = new RegExp(arguments[0], 'i');
					const element = [...(panel?.querySelectorAll('button') ?? [])].find(node => matcher.test(node.textContent.trim()));
					if (!element || element.disabled || !element.getClientRects().length) return false;
					element.click(); return true;`,
					[pattern]
				),
			`click Git button ${pattern}`,
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
	writeFileSync(join(fixtureRoot, worktreePath), base);
	writeFileSync(join(fixtureRoot, stagedPath), base);
	writeFileSync(join(fixtureRoot, hugePath), base);
	git(fixtureRoot, ['init', '-q']);
	git(fixtureRoot, ['add', '--', worktreePath, stagedPath, hugePath]);
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
	const worktreeContent = `# Native Git review\n\n${buildLines('worktree', 'WORKTREE-END')}\n`;
	const stagedContent = `# Native Git staged review\n\n${buildLines('staged', 'STAGED-END')}\n`;
	const hugeContent = `# Native Git large review\n\n${Array.from(
		{ length: 12000 },
		(_, index) => `huge line ${String(index + 1).padStart(5, '0')} ${'x'.repeat(80)}`
	).join('\n')}\n`;
	writeFileSync(join(fixtureRoot, worktreePath), worktreeContent);
	writeFileSync(join(fixtureRoot, stagedPath), stagedContent);
	writeFileSync(join(fixtureRoot, hugePath), hugeContent);
	git(fixtureRoot, ['add', '--', stagedPath]);
	const hugeDiffBytes = gitBuffer(fixtureRoot, [
		'diff',
		'--no-ext-diff',
		'--no-textconv',
		'--no-color',
		'--unified=3',
		'--',
		':(literal)huge.md'
	]).length;
	assert.ok(
		hugeDiffBytes > 1024 * 1024,
		`huge.md diff must exceed 1 MiB; got ${hugeDiffBytes} bytes`
	);
	record('fixture repository', {
		fixtureRoot,
		head: git(fixtureRoot, ['rev-parse', 'HEAD']).trim(),
		worktree: {
			path: worktreePath,
			lines: 2600,
			first: worktreeFirst,
			last: worktreeLast,
			sha256: createHash('sha256').update(worktreeContent).digest('hex')
		},
		staged: {
			path: stagedPath,
			lines: 2600,
			first: stagedFirst,
			last: stagedLast,
			sha256: createHash('sha256').update(stagedContent).digest('hex')
		},
		outputLimit: {
			path: hugePath,
			diffBytes: hugeDiffBytes,
			capBytes: 1024 * 1024,
			sha256: createHash('sha256').update(hugeContent).digest('hex')
		},
		indexStatus: git(fixtureRoot, ['status', '--porcelain']).trim()
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

	const activateLast = async (expectedRows, first, last, label) => {
		let keyboardFocused = false;
		let keyboardActivated = false;
		let pointerFallback = false;
		let nativeKey = null;
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
			if (process.platform === 'linux' && process.env.DISPLAY) {
				try {
					const windows = execFileSync(
						'xdotool',
						['search', '--onlyvisible', '--name', 'DeckMark'],
						{ encoding: 'utf8' }
					)
						.trim()
						.split('\n')
						.filter(Boolean);
					if (windows.length > 0) {
						execFileSync('xdotool', ['windowfocus', '--sync', windows[0]], {
							stdio: 'ignore'
						});
						execFileSync('xdotool', ['key', '--clearmodifiers', 'Return'], {
							stdio: 'ignore'
						});
						await delay(500);
						const afterNative = await readDiff(first, last);
						keyboardActivated =
							afterNative.state === 'complete' && afterNative.rows === expectedRows;
						nativeKey = keyboardActivated ? 'xdotool' : 'xdotool-no-activation';
					}
				} catch (error) {
					record('native key action error', String(error));
				}
			}
			if (!keyboardActivated) {
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
					const afterKey = await readDiff(first, last);
					keyboardActivated = afterKey.state === 'complete' && afterKey.rows === expectedRows;
				} catch (error) {
					record('keyboard action error', String(error));
				}
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
				const state = await readDiff(first, last);
				return state.rows === expectedRows && state.state === 'complete' && state.last;
			},
			`${label} last diff section is reachable`,
			45_000
		);
		return { keyboardFocused, keyboardActivated, pointerFallback, nativeKey };
	};

	await clickGitFile(worktreePath);
	await until(
		async () => {
			const state = await readDiff();
			return state.rows === 2000 && state.state === 'partial' && state.first && !state.last;
		},
		'worktree initial diff page is bounded',
		45_000
	);
	const worktreeInitial = record('worktree initial page', await readDiff());
	assert.equal(worktreeInitial.rows, 2000);
	assert.equal(worktreeInitial.first, true);
	assert.equal(worktreeInitial.visibleFirst, true);
	assert.equal(worktreeInitial.last, false);
	assert.equal(worktreeInitial.empty, false);
	assert.ok(worktreeInitial.total && worktreeInitial.total > 2000, JSON.stringify(worktreeInitial));
	const worktreeLastRows = worktreeInitial.total - 2000;
	const worktreeKeyboard = await activateLast(
		worktreeLastRows,
		worktreeFirst,
		worktreeLast,
		'worktree'
	);
	const worktreeLastPage = record('worktree last page', {
		...(await readDiff(worktreeFirst, worktreeLast)),
		...worktreeKeyboard
	});
	assert.equal(worktreeLastPage.rows, worktreeLastRows);
	assert.equal(worktreeLastPage.last, true);
	assert.equal(worktreeLastPage.first, false);
	assert.equal(worktreeLastPage.visibleLast, true);
	assert.equal(worktreeLastPage.visibleFirst, false);
	assert.equal(worktreeLastPage.nativeKey === 'xdotool' || worktreeLastPage.pointerFallback, true);
	await click('[data-testid=git-diff-first]');
	await until(
		async () => {
			const state = await readDiff();
			return state.rows === 2000 && state.state === 'partial' && state.first && state.visibleFirst;
		},
		'worktree first diff section returns',
		45_000
	);
	const worktreeReturned = record('worktree returned to first page', await readDiff());
	assert.equal(worktreeReturned.first, true);
	assert.equal(worktreeReturned.visibleFirst, true);
	assert.equal(worktreeReturned.total, worktreeInitial.total);

	await clickGitFile(stagedPath);
	await until(
		async () => {
			const state = await readDiff(stagedFirst, stagedLast);
			return state.rows === 2000 && state.state === 'partial' && state.first && !state.last;
		},
		'staged initial diff page is bounded',
		45_000
	);
	const stagedInitial = record('staged initial page', await readDiff(stagedFirst, stagedLast));
	assert.equal(stagedInitial.rows, 2000);
	assert.equal(stagedInitial.first, true);
	assert.equal(stagedInitial.visibleFirst, true);
	assert.equal(stagedInitial.last, false);
	assert.equal(stagedInitial.empty, false);
	assert.ok(stagedInitial.total && stagedInitial.total > 2000, JSON.stringify(stagedInitial));
	const stagedLastRows = stagedInitial.total - 2000;
	const stagedKeyboard = await activateLast(stagedLastRows, stagedFirst, stagedLast, 'staged');
	const stagedLastPage = record('staged last page', {
		...(await readDiff(stagedFirst, stagedLast)),
		...stagedKeyboard
	});
	assert.equal(stagedLastPage.rows, stagedLastRows);
	assert.equal(stagedLastPage.last, true);
	assert.equal(stagedLastPage.first, false);
	assert.equal(stagedLastPage.visibleLast, true);
	assert.equal(stagedLastPage.visibleFirst, false);
	assert.equal(stagedLastPage.nativeKey === 'xdotool' || stagedLastPage.pointerFallback, true);
	await click('[data-testid=git-diff-first]');
	await until(
		async () => {
			const state = await readDiff(stagedFirst, stagedLast);
			return state.rows === 2000 && state.state === 'partial' && state.first && state.visibleFirst;
		},
		'staged first diff section returns',
		45_000
	);
	const stagedReturned = record(
		'staged returned to first page',
		await readDiff(stagedFirst, stagedLast)
	);
	assert.equal(stagedReturned.first, true);
	assert.equal(stagedReturned.total, stagedInitial.total);

	await clickGitButton('Espace de travail|Working tree');
	await until(
		async () => {
			const state = await readDiff(stagedFirst, stagedLast);
			return state.empty && state.rows === 0;
		},
		'staged file worktree view is empty and does not show the staged diff',
		45_000
	);
	const stagedWorktree = record(
		'staged file worktree view',
		await readDiff(stagedFirst, stagedLast)
	);
	assert.equal(stagedWorktree.empty, true);
	assert.equal(stagedWorktree.first, false);

	await clickGitButton('^Index$|^Staged$');
	await until(
		async () => {
			const state = await readDiff(stagedFirst, stagedLast);
			return state.rows === 2000 && state.state === 'partial' && state.first;
		},
		'staged view returns to its own diff',
		45_000
	);
	const stagedAgain = record('staged view restored', await readDiff(stagedFirst, stagedLast));
	assert.equal(stagedAgain.first, true);

	await clickGitFile(worktreePath);
	await until(
		async () => {
			const state = await readDiff();
			return state.rows === 2000 && state.state === 'partial' && state.first && !state.last;
		},
		'worktree view returns after the staged review',
		45_000
	);
	const worktreeAgain = record('worktree view restored', await readDiff());
	assert.equal(worktreeAgain.first, true);
	assert.equal(worktreeAgain.total, worktreeInitial.total);

	await clickGitFile(hugePath);
	await until(
		async () => {
			const state = await readLimit();
			return state.tooLarge && !state.generic && state.rows === 0;
		},
		'native output cap shows the distinct size-limit state',
		45_000
	);
	const outputLimitState = record('native output cap rejection', await readLimit());
	assert.match(outputLimitState.text, /1 MiB|1 Mio/);
	assert.equal(outputLimitState.generic, false);
	assert.equal(outputLimitState.rows, 0);
	assert.equal(outputLimitState.range, '');

	const rawLimit = await executeAsync(
		`const done = arguments[arguments.length - 1];
		window.__TAURI__.core.invoke('git_diff', { rootId: arguments[0], path: arguments[1], staged: false }).then(
			(value) => done({ ok: true, valueBytes: typeof value === 'string' ? value.length : null }),
			(error) => done({ ok: false, rejection: String(error) })
		);`,
		[project.nativeRootId, hugePath]
	);
	assert.equal(rawLimit.ok, false);
	assert.match(rawLimit.rejection, /1 MiB|exceeds/i);
	record('native output cap backend rejection', rawLimit);

	await clickGitFile(worktreePath);
	await until(
		async () => {
			const state = await readDiff();
			return state.rows === 2000 && state.state === 'partial' && state.first && !state.last;
		},
		'worktree view returns after the size-limit rejection',
		45_000
	);
	const worktreeAfterLimit = record(
		'worktree view restored after the size-limit rejection',
		await readDiff()
	);
	assert.equal(worktreeAfterLimit.first, true);
	assert.equal(worktreeAfterLimit.total, worktreeInitial.total);

	writeFileSync(
		join(output, 'native-git.json'),
		JSON.stringify(
			{
				recordedAt: new Date().toISOString(),
				platform: process.platform,
				project,
				fixture: {
					worktree: {
						path: worktreePath,
						lines: 2600,
						diffLines: worktreeInitial.total,
						first: worktreeFirst,
						last: worktreeLast
					},
					staged: {
						path: stagedPath,
						lines: 2600,
						diffLines: stagedInitial.total,
						first: stagedFirst,
						last: stagedLast
					}
				},
				worktreeKeyboard,
				stagedKeyboard,
				modeDistinct: true,
				outputLimit: {
					path: hugePath,
					diffBytes: hugeDiffBytes,
					capBytes: 1024 * 1024,
					tooLarge: outputLimitState.tooLarge,
					generic: outputLimitState.generic,
					rows: outputLimitState.rows,
					range: outputLimitState.range,
					message: outputLimitState.text,
					backend: {
						command: 'git_diff',
						rootId: project.nativeRootId,
						path: hugePath,
						staged: false,
						ok: rawLimit.ok,
						rejection: rawLimit.rejection
					}
				},
				evidence
			},
			null,
			2
		)
	);
	return evidence;
}
