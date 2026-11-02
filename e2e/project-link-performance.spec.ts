import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { ProjectLinkIssue } from '../src/lib/project-links';
import { resetAppState } from './helpers';

// Risks: repeated unmatched suffix scans block input; a pairing change can lose
// nested destinations, escaped brackets, image references, or exact source ranges.
const pixel =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const imageSource = `data:image/png;base64,${pixel}`;
const imagePath = `assets/image-${createHash('sha256').update(Buffer.from(pixel, 'base64')).digest('hex')}.png`;
const unmatched = 'a['.repeat(32_000);
const nested = [
	'\uFEFF---',
	'title: "[Ignored](frontmatter.md)"',
	'---',
	'[Valid [nested] label](nested(target).md#part "Keep [title]")',
	'[Escaped \\[ bracket](nested\\(target\\).md)',
	'[Outer [inner](missing.md)]',
	`![Pixel [nested] label](<${imageSource}> "Keep image title")`,
	'![Reference [nested]][remote]',
	'[remote]: https://example.invalid/pixel.png "Keep reference title"',
	'`[Ignored](inline-code.md)`',
	'<!-- [Ignored](comment.md) -->',
	'```md',
	'[Ignored](fenced-code.md)',
	'```',
	''
].join('\n');

async function startHeartbeat(page: Page) {
	await page.evaluate(() => {
		const samples: number[] = [];
		let previous = performance.now();
		const timer = setInterval(() => {
			const now = performance.now();
			samples.push(now - previous);
			previous = now;
		}, 16);
		Object.assign(window, {
			projectLinkHeartbeat: () => {
				clearInterval(timer);
				samples.push(performance.now() - previous);
				return { samples, maxGapMs: Math.max(...samples) };
			}
		});
	});
}

for (const action of ['check', 'export'] as const) {
	test(`keeps ${action} responsive with 64 KB of unmatched brackets and nested links`, async ({
		page,
		browser
	}, info) => {
		test.setTimeout(90_000);
		const evidence: Record<string, unknown> = {
			command:
				process.env.PROJECT_LINK_TEST_COMMAND ??
				'npx playwright test project-link-performance.spec.ts --project=chromium --workers=1',
			revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
			sourceHashes: Object.fromEntries(
				['src/lib/project-links.ts', 'e2e/project-link-performance.spec.ts'].map((path) => [
					path,
					createHash('sha256').update(readFileSync(path)).digest('hex')
				])
			),
			environment: {
				node: process.version,
				platform: process.platform,
				browser: browser.version(),
				baseURL: info.project.use.baseURL
			},
			fixtures: {
				unmatchedBytes: Buffer.byteLength(unmatched),
				nested,
				unmatchedPattern: "'a['.repeat(32000)"
			},
			action,
			limits: { elapsedMs: 3000, heartbeatGapMs: 1000 }
		};
		try {
			await resetAppState(page);
			const zip = new (await import('jszip')).default();
			// A valid inner link after the unmatched prefix must still be found.
			const stressSource = `${unmatched}\n\n[Recovered [nested]](missing-after.md)\n`;
			zip.file('stress.md', stressSource);
			zip.file('nested.md', nested);
			zip.file('nested(target).md', '# Target\n');
			const input = await zip.generateAsync({ type: 'nodebuffer' });
			await info.attach('project-link-input.zip', { body: input, contentType: 'application/zip' });
			await page.getByTestId('projects-open').click();
			const panel = page.getByRole('dialog', { name: 'Projets Markdown' });
			await panel.locator('input[type=file][accept=".zip"]').setInputFiles({
				name: 'link-performance.zip',
				mimeType: 'application/zip',
				buffer: input
			});
			await expect(
				panel.getByRole('button', { name: 'Ouvrir stress.md', exact: true })
			).toBeVisible();
			await startHeartbeat(page);
			const start = performance.now();
			if (action === 'check') {
				await panel.getByRole('button', { name: 'Vérifier les liens', exact: true }).click();
				const report = panel.locator('[data-project-link-report]');
				await expect(report).toContainText('missing-after.md');
				await expect(report).toContainText('missing.md');
				await expect(report).toContainText('https://example.invalid/pixel.png');
				evidence.report = await report.innerText();
				await expect(report).not.toContainText('nested(target).md');
				await expect(report).not.toContainText('Ignored');
			} else {
				const pending = page.waitForEvent('download');
				await panel.getByRole('button', { name: 'Exporter le projet', exact: true }).click();
				const stream = await (await pending).createReadStream();
				const parts: Buffer[] = [];
				for await (const part of stream!) parts.push(part);
				const bytes = Buffer.concat(parts);
				await info.attach('project-link-output.zip', {
					body: bytes,
					contentType: 'application/zip'
				});
				const output = await (await import('jszip')).default.loadAsync(bytes);
				expect(await output.file('stress.md')!.async('string')).toBe(stressSource);
				// Check destination boundaries through the actual downloaded Markdown.
				expect(await output.file('nested.md')!.async('string')).toBe(
					nested.replace(imageSource, imagePath)
				);
				expect(await output.file(imagePath)!.async('nodebuffer')).toEqual(
					Buffer.from(pixel, 'base64')
				);
				const report = JSON.parse(await output.file('.mdsh/link-report.json')!.async('string'));
				// Random document IDs determine the database traversal order.
				expect(
					report.issues.toSorted((left: ProjectLinkIssue, right: ProjectLinkIssue) =>
						left.document.localeCompare(right.document)
					)
				).toEqual([
					{ document: 'nested.md', destination: 'missing.md', reason: 'missing' },
					{
						document: 'nested.md',
						destination: 'https://example.invalid/pixel.png',
						reason: 'remote'
					},
					{ document: 'stress.md', destination: 'missing-after.md', reason: 'missing' }
				]);
				evidence.report = report;
			}
			evidence.elapsedMs = performance.now() - start;
			const heartbeat = await page.evaluate(() =>
				(
					window as unknown as {
						projectLinkHeartbeat: () => { samples: number[]; maxGapMs: number };
					}
				).projectLinkHeartbeat()
			);
			evidence.heartbeat = heartbeat;
			await panel.getByRole('button', { name: 'Fermer les projets' }).click();
			await expect(panel).not.toBeVisible();
			evidence.closeResponded = true;
			expect.soft(evidence.elapsedMs).toBeLessThan(3000);
			expect.soft(heartbeat.maxGapMs).toBeLessThan(1000);
		} finally {
			evidence.errors = info.errors.map((error) => error.message);
			await info.attach('project-link-performance.json', {
				body: JSON.stringify(evidence, null, 2),
				contentType: 'application/json'
			});
			await info.attach('project-link-result.png', {
				body: await page.screenshot(),
				contentType: 'image/png'
			});
		}
	});
}
