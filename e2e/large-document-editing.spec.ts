import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resetAppState } from './helpers';

// The reported defect uses a 600 KB Markdown note with large inline images.
// The real file stays outside the repository; CI uses a deterministic corpus
// with the same byte and line shape.
test.use({ locale: 'en-US', reducedMotion: 'reduce' });
test.setTimeout(180_000);

interface LongTaskSample {
	start: number;
	duration: number;
}

interface InputSample {
	supported: boolean;
	changed: boolean;
	syncMs: number;
	frameMs: number;
	longTasks: LongTaskSample[];
}

const realFixture = process.env.MDSH_LARGE_DOCUMENT ?? join(homedir(), 'files', 'sapic.md');
const frameBudgetMs = 150;
const longTaskBudgetMs = 250;

function generatedLargeMarkdown(): string {
	const payload = Buffer.from('k4V2mQ9xL7pR3sT8uW1yA5bC6dE0fG2hJ4iK'.repeat(5_500)).toString(
		'base64'
	);
	const sections = Array.from(
		{ length: 60 },
		(_, index) =>
			`## Section ${index + 1}\n\n` +
			'Chaque paragraphe représente une note volumineuse et stable. '.repeat(30) +
			`\n\n![diagramme_${index}](data:image/png;base64,${payload.slice(0, 9_000 + index)})\n\n` +
			`* Point ${index + 1}\n* Garder cette ligne\n`
	);
	return `# Grand document\n\n${sections.join('\n')}`;
}

function fixture(): { content: string; source: string } {
	if (existsSync(realFixture)) {
		return { content: readFileSync(realFixture, 'utf8'), source: realFixture };
	}
	return { content: generatedLargeMarkdown(), source: 'generated:large-document' };
}

async function waitForIdle(page: import('@playwright/test').Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				const finish = () => setTimeout(resolve, 250);
				if (typeof requestIdleCallback !== 'function') {
					setTimeout(resolve, 1_000);
					return;
				}
				requestIdleCallback(finish, { timeout: 5_000 });
			})
	);
}

async function seedLargeDocument(
	page: import('@playwright/test').Page,
	content: string
): Promise<void> {
	await page.evaluate(async (text) => {
		const request = indexedDB.open('mdsh');
		await new Promise<void>((resolve, reject) => {
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction(['drafts'], 'readwrite');
				const drafts = transaction.objectStore('drafts');
				drafts.clear();
				drafts.put({
					id: 'large-editing',
					name: 'sapic.md',
					content: text,
					createdAt: 1,
					updatedAt: 1,
					order: 0,
					open: true
				});
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => reject(transaction.error);
			};
		});
		localStorage.setItem('mdsh:activeId', 'large-editing');
	}, content);
}

test('typing stays responsive in a 600 KB visual document', async ({ page }, info) => {
	const { content, source } = fixture();
	await resetAppState(page, { mode: 'source' });
	await seedLargeDocument(page, content);
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();

	await page.locator('button[data-mode="wysiwyg"]').click();
	const confirm = page.getByRole('button', { name: /Afficher le document|Render document/ });
	if (await confirm.isVisible().catch(() => false)) await confirm.click();
	await page.locator('.milkdown .ProseMirror').waitFor({ state: 'visible', timeout: 120_000 });
	await waitForIdle(page);

	await page.evaluate(() => {
		const tasks: LongTaskSample[] = [];
		(window as Window & { __mdshLongTasks?: LongTaskSample[] }).__mdshLongTasks = tasks;
		try {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					tasks.push({ start: entry.startTime, duration: entry.duration });
				}
			}).observe({ type: 'longtask', buffered: false });
		} catch {
			// Some engines do not expose long tasks. Frame samples still apply.
		}
	});

	const samples: InputSample[] = [];
	for (let index = 0; index < 12; index++) {
		const sample = await page.evaluate(
			([selector]) =>
				new Promise<InputSample>((resolve) => {
					const editor = document.querySelector(selector as string) as HTMLElement | null;
					if (!editor) {
						resolve({
							supported: false,
							changed: false,
							syncMs: 0,
							frameMs: 0,
							longTasks: []
						});
						return;
					}
					// Type in a plain paragraph. Paragraphs with links or images
					// take the slower verified source path on purpose.
					const paragraphs = [...editor.querySelectorAll<HTMLElement>('p')].filter(
						(paragraph) =>
							(paragraph.textContent?.length ?? 0) > 40 &&
							[...paragraph.childNodes].every((node) => node.nodeType === Node.TEXT_NODE)
					);
					const target = paragraphs[Math.floor(paragraphs.length / 2)] ?? editor;
					const before = target.textContent ?? '';
					editor.focus();
					const range = document.createRange();
					range.selectNodeContents(target);
					range.collapse(false);
					const selection = window.getSelection();
					selection?.removeAllRanges();
					selection?.addRange(range);
					const startedAt = performance.now();
					const supported = document.execCommand('insertText', false, 'e');
					const updatedAt = performance.now();
					requestAnimationFrame(() =>
						requestAnimationFrame(() => {
							const tasks =
								(window as Window & { __mdshLongTasks?: LongTaskSample[] }).__mdshLongTasks ?? [];
							resolve({
								supported,
								changed: (target.textContent ?? '') !== before,
								syncMs: updatedAt - startedAt,
								frameMs: performance.now() - startedAt,
								longTasks: tasks.splice(0)
							});
						})
					);
				}),
			['.milkdown .ProseMirror']
		);
		samples.push(sample);
	}

	// Milkdown emits markdown updates 200 ms after the last edit. The settle
	// window checks that source-fidelity work does not freeze the interface.
	await page.waitForTimeout(1_500);
	const settleTasks = await page.evaluate(() =>
		((window as Window & { __mdshLongTasks?: LongTaskSample[] }).__mdshLongTasks ?? []).splice(0)
	);

	expect(samples.every((sample) => sample.supported && sample.changed)).toBeTruthy();
	const frames = samples.map((sample) => sample.frameMs).sort((a, b) => a - b);
	const p95 = frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))]!;
	const typingTasks = samples.flatMap((sample) => sample.longTasks);
	const maxTypingTask = Math.max(0, ...typingTasks.map((task) => task.duration));
	const maxSettleTask = Math.max(0, ...settleTasks.map((task) => task.duration));

	const report = {
		...info.config.metadata,
		command: `npx playwright test e2e/large-document-editing.spec.ts --project=${info.project.name}`,
		fixture: {
			source,
			sha256: createHash('sha256').update(content).digest('hex'),
			bytes: Buffer.byteLength(content),
			lines: content.split('\n').length
		},
		environment: {
			...info.config.metadata.environment,
			browser: page.context().browser()?.version(),
			userAgent: await page.evaluate(() => navigator.userAgent)
		},
		samples,
		summary: {
			keys: samples.length,
			p95FrameMs: Number(p95.toFixed(1)),
			maxFrameMs: Number(frames.at(-1)?.toFixed(1)),
			maxTypingLongTaskMs: Number(maxTypingTask.toFixed(1)),
			maxSettleLongTaskMs: Number(maxSettleTask.toFixed(1)),
			frameBudgetMs,
			longTaskBudgetMs
		}
	};
	await info.attach('large-document-typing.json', {
		body: JSON.stringify(report, null, 2),
		contentType: 'application/json'
	});

	expect(p95, 'p95 key-to-frame latency').toBeLessThanOrEqual(frameBudgetMs);
	expect(maxTypingTask, 'long task while typing').toBeLessThanOrEqual(longTaskBudgetMs);
	expect(maxSettleTask, 'long task while source fidelity settles').toBeLessThanOrEqual(
		longTaskBudgetMs
	);
});
