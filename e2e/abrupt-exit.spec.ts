import { chromium, expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFirstFile, openPalette, writeSourceContent } from './helpers';
import { databaseState, deferSaveTimer, editWithoutWaiting } from './storage-evidence';

for (const stage of ['debounce', 'transaction', 'backup', 'workspace', 'conflict'] as const) {
	test(`process kill at ${stage} retains the committed recovery point`, async ({
		baseURL
	}, info) => {
		test.setTimeout(90_000);
		const profile = info.outputPath('profile');
		await mkdir(profile, { recursive: true });
		let child: ChildProcess | undefined;
		const launches: { pid: number | undefined; signal?: string | null }[] = [];
		const launch = async () => {
			await rm(join(profile, 'DevToolsActivePort'), { force: true });
			child = spawn(
				chromium.executablePath(),
				[
					'--headless',
					'--no-sandbox',
					'--no-first-run',
					'--disable-dev-shm-usage',
					'--remote-debugging-port=0',
					`--user-data-dir=${profile}`,
					'about:blank'
				],
				{ stdio: 'ignore', detached: process.platform !== 'win32' }
			);
			launches.push({ pid: child.pid });
			let port = '';
			await expect
				.poll(
					async () => {
						port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
						return port.split('\n')[0];
					},
					{ timeout: 20_000 }
				)
				.toMatch(/^\d+$/);
			return chromium.connectOverCDP(`http://127.0.0.1:${port.split('\n')[0]}`);
		};
		const kill = async () => {
			if (!child || child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, 'exit');
			// Include Chromium utility processes. They also write into this owned profile.
			if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
			else child.kill('SIGKILL');
			const [, signal] = await exited;
			launches.at(-1)!.signal = signal;
			expect(signal).toBe('SIGKILL');
		};
		const baseline = '# Durable baseline';
		const revision = `# Revision at ${stage}`;
		let before: unknown;
		let after: Awaited<ReturnType<typeof databaseState>> | undefined;
		try {
			const browser = await launch();
			const context = browser.contexts()[0]!;
			const page = await context.newPage();
			// Persistent contexts do not inherit the runner base URL.
			await page.goto(baseURL!);
			await page.evaluate(() => {
				localStorage.setItem('mdsh:mode', 'source');
				localStorage.setItem('mdsh:locale', 'fr');
			});
			await page.reload();
			await createFirstFile(page);
			await writeSourceContent(page, baseline);
			await expect.poll(async () => (await databaseState(page)).drafts[0]?.content).toBe(baseline);
			before = await databaseState(page);
			const other = stage === 'conflict' ? await context.newPage() : null;
			if (other) {
				await other.goto(baseURL!);
				await expect(other.locator('.cm-content')).toContainText(baseline);
			}
			await deferSaveTimer(page);
			if (stage === 'transaction') {
				await page.evaluate((target) => {
					const put = IDBObjectStore.prototype.put;
					IDBObjectStore.prototype.put = function (value, key) {
						const result = key === undefined ? put.call(this, value) : put.call(this, value, key);
						if (this.name === 'drafts' && value.content === target) {
							const keepAlive = () => {
								this.get(value.id).onsuccess = keepAlive;
							};
							keepAlive();
							document.documentElement.dataset.saveStage = 'transaction';
						}
						return result;
					};
				}, revision);
			}
			await editWithoutWaiting(page, revision);
			if (other) {
				await writeSourceContent(other, '# Concurrent durable branch');
				await expect
					.poll(async () => (await databaseState(other)).drafts[0]?.content)
					.toBe('# Concurrent durable branch');
			}
			if (stage === 'transaction' || stage === 'conflict') {
				await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
				if (stage === 'transaction') {
					await expect(page.locator('html')).toHaveAttribute('data-save-stage', 'transaction');
				} else {
					await expect
						.poll(async () => (await databaseState(page)).drafts.map((row) => row.content).sort())
						.toEqual(['# Concurrent durable branch', revision].sort());
				}
			} else if (stage === 'backup') {
				await page.keyboard.press('ControlOrMeta+,');
				const download = page.waitForEvent('download');
				await page.getByRole('button', { name: 'Exporter une sauvegarde', exact: true }).click();
				const path = info.outputPath('durable-backup.json');
				await (await download).saveAs(path);
				expect(JSON.parse(await readFile(path, 'utf8')).drafts[0].content).toBe(revision);
				await info.attach('backup', { path, contentType: 'application/json' });
			} else if (stage === 'workspace') {
				await openPalette(page);
				await page.getByRole('combobox').fill('Sauvegarder l’espace de travail courant');
				await page.keyboard.press('Enter');
				const prompt = page.getByRole('dialog', { name: 'Nom de l’espace de travail ?' });
				await prompt.getByRole('textbox').fill('Crash recovery');
				await prompt.getByRole('textbox').press('Enter');
				await expect.poll(async () => (await databaseState(page)).workspaces.length).toBe(1);
			}
			await kill();
			const restarted = await launch();
			await restarted.contexts()[0]!.addInitScript(() => {
				localStorage.setItem('mdsh:mode', 'source');
			});
			const restored = await restarted.contexts()[0]!.newPage();
			await restored.goto(baseURL!);
			await expect(restored.locator('.cm-content')).toBeVisible();
			const state = await databaseState(restored);
			after = state;
			const expected = stage === 'debounce' || stage === 'transaction' ? baseline : revision;
			expect(state.drafts.find((row) => row.open !== false)?.content).toBe(expected);
			await expect(restored.locator('.cm-content')).toContainText(expected);
			if (stage === 'workspace') expect(state.workspaces[0]?.name).toBe('Crash recovery');
			if (stage === 'conflict') {
				expect(
					state.drafts.some(
						(row) => row.open === false && row.content === '# Concurrent durable branch'
					)
				).toBe(true);
				expect(state.versions.some((row) => row.content === '# Concurrent durable branch')).toBe(
					true
				);
			}
		} finally {
			await kill();
			const artifact = info.outputPath('abrupt-exit.json');
			await writeFile(
				artifact,
				JSON.stringify(
					{
						stage,
						termination: process.platform === 'win32' ? 'process' : 'process-group',
						launches,
						fixture: { baseline, revision },
						before,
						after,
						recoverableUnsavedRevisions: after?.versions.filter((row) => row.content === revision),
						memoryOnlyRevisionLost: after
							? ![...after.drafts, ...after.versions].some((row) => row.content === revision)
							: null
					},
					null,
					2
				)
			);
			await info.attach('abrupt-exit.json', { path: artifact, contentType: 'application/json' });
			await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
}
