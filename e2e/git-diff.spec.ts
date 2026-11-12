import { expect, test, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resetAppState } from './helpers';

// Git belongs to the Desktop Complete edition. The default Playwright server
// builds Web Light, where the panel cannot mount. Set GIT_REVIEW_DESKTOP=1 and
// serve a desktop build to run this workflow. The retained failure risks are in
// docs/TESTING.md. A browser result does not replace native WebView evidence.

const projectId = 'native-git-review-project';
const rootId = 'native-git-review-root';
const longPath = 'long.md';
const hugePath = 'huge.md';
const longDiff = Array.from({ length: 2600 }, (_, index) => {
	const line = `line ${String(index + 1).padStart(4, '0')}`;
	return index === 2599 ? `${line} END` : line;
}).join('\n');
const diffFixture = `${longDiff}\n`;

const status = {
	repository: 'self',
	repositoryName: null,
	branch: 'main',
	head: 'a'.repeat(40),
	detached: false,
	initial: false,
	stagedTree: 'b'.repeat(40),
	clean: false,
	dirty: true,
	conflicts: [],
	nestedRepositories: [],
	nestedScanTruncated: false,
	outsideChanges: 0,
	files: [
		{
			path: longPath,
			originalPath: null,
			index: '.',
			worktree: 'M',
			untracked: false,
			conflicted: false
		},
		{
			path: hugePath,
			originalPath: null,
			index: '.',
			worktree: 'M',
			untracked: false,
			conflicted: false
		}
	]
};

test('reviews the final hunk of a 2600-line diff and reports the native size limit', async ({
	page,
	context
}, info: TestInfo) => {
	test.skip(
		process.env.GIT_REVIEW_DESKTOP !== '1',
		'Requires a Desktop Complete build and GIT_REVIEW_DESKTOP=1.'
	);
	await page.addInitScript(
		({ diff, status, rootId }) => {
			const invoke = async (command: string, args: Record<string, unknown> = {}) => {
				switch (command) {
					case 'git_status':
						return status;
					case 'git_log':
						return [];
					case 'git_diff':
						if (args.path === 'huge.md') throw 'Git output exceeds the 1 MiB limit';
						return diff;
					case 'project_open_root':
						return {
							rootId,
							token: 'native-git-review-token',
							name: 'Native Git review',
							entries: []
						};
					case 'project_refresh':
						return {
							rootId,
							token: 'native-git-review-token',
							name: 'Native Git review',
							entries: []
						};
					case 'project_manifest':
						return { rootId, token: 'native-git-review-token', entries: [] };
					case 'plugin:event|listen':
						return 1;
					case 'plugin:event|unlisten':
						return undefined;
					default:
						return null;
				}
			};
			Object.defineProperty(window, '__TAURI_INTERNALS__', {
				value: { transformCallback: () => 1, invoke },
				configurable: true
			});
			Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
				value: { unregisterListener: () => {} },
				configurable: true
			});
		},
		{ diff: diffFixture, status, rootId }
	);

	await resetAppState(page);
	await page.evaluate(
		({ projectId, rootId }) =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('projects', 'readwrite');
					transaction.objectStore('projects').put({
						id: projectId,
						name: 'Native Git review',
						createdAt: Date.now(),
						updatedAt: Date.now(),
						nativeRootId: rootId
					});
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => {
						database.close();
						reject(transaction.error);
					};
				};
			}),
		{ projectId, rootId }
	);

	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
	await expect(panel).toBeVisible();
	await panel.locator('select').first().selectOption(projectId);
	const gitButton = panel.getByTestId('project-git');
	await expect(gitButton).toBeVisible();
	await gitButton.click();

	const gitPanel = page.getByTestId('git-panel');
	await expect(gitPanel).toBeVisible({ timeout: 15_000 });
	await gitPanel.getByRole('button', { name: new RegExp(longPath.replace('.', '\\.')) }).click();

	const diffList = gitPanel.getByRole('list', { name: new RegExp(longPath.replace('.', '\\.')) });
	await expect(diffList).toBeVisible();
	await expect(diffList.locator('li')).toHaveCount(2000);
	await expect(gitPanel.getByText('line 2600 END')).toHaveCount(0);
	await expect(gitPanel.getByTestId('git-diff-range')).toHaveAttribute(
		'data-review-state',
		'partial'
	);

	const last = gitPanel.getByTestId('git-diff-last');
	await last.focus();
	await page.keyboard.press('Enter');
	await expect(gitPanel.getByTestId('git-diff-range')).toHaveAttribute(
		'data-review-state',
		'complete'
	);
	await expect(diffList.locator('li')).toHaveCount(600);
	await expect(gitPanel.getByText('line 2600 END')).toBeVisible();
	await expect(
		gitPanel.getByRole('heading', { name: new RegExp(longPath.replace('.', '\\.')) })
	).toBeVisible();
	await expect(gitPanel.getByRole('button', { name: 'Espace de travail' })).toBeVisible();

	await gitPanel.getByTestId('git-diff-first').click();
	await expect(gitPanel.getByTestId('git-diff-range')).toHaveAttribute(
		'data-review-state',
		'partial'
	);
	await expect(gitPanel.getByText('line 0001')).toBeVisible();
	await expect(gitPanel.getByText('line 2600 END')).toHaveCount(0);

	await gitPanel.getByRole('button', { name: new RegExp(hugePath.replace('.', '\\.')) }).click();
	const tooLarge = gitPanel.getByTestId('git-diff-too-large');
	await expect(tooLarge).toBeVisible();
	await expect(tooLarge).toContainText(/1 MiB|1 Mio/);
	await expect(gitPanel.getByTestId('git-operation-error')).toHaveCount(0);

	await gitPanel.getByRole('button', { name: new RegExp(longPath.replace('.', '\\.')) }).click();
	await expect(gitPanel.getByTestId('git-diff-range')).toHaveAttribute(
		'data-review-state',
		'partial'
	);
	await expect(gitPanel.getByText('line 0001')).toBeVisible();

	await info.attach('git-diff-review-evidence.json', {
		body: JSON.stringify(
			{
				command:
					process.env.GIT_REVIEW_COMMAND ??
					'GIT_REVIEW_DESKTOP=1 npx playwright test e2e/git-diff.spec.ts --project=chromium --workers=1 --retries=0',
				revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
				diff: execFileSync('git', ['diff', '--', 'src/lib/components/GitPanel.svelte'], {
					encoding: 'utf8'
				}),
				environment: {
					node: process.version,
					platform: process.platform,
					browser: context.browser()?.version(),
					baseURL: info.project.use.baseURL,
					edition: 'desktop',
					nativeBridge: 'Git and project command fixture'
				},
				fixture: {
					path: longPath,
					lines: 2600,
					first: 'line 0001',
					last: 'line 2600 END',
					sha256: createHash('sha256').update(diffFixture).digest('hex')
				},
				observations: {
					initialRows: 2000,
					lastPageRows: 600,
					firstPageState: 'partial',
					lastPageState: 'complete',
					selectedPathRetained: true,
					worktreeModeRetained: true,
					keyboardActivation: true,
					nativeSizeLimitState: true
				},
				test: info.title,
				status: info.status
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('git-diff-review.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
});
