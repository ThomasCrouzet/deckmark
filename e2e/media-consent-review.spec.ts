import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';

const pixel =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
interface Evidence {
	fixture: string;
	requests: string[];
	downloads: string[];
	saved: Promise<void>[];
	exportOutcome?: string;
	exportMessage?: string;
}
const evidence = new WeakMap<Page, Evidence>();

test.beforeEach(async ({ page }, info) => {
	const record: Evidence = { fixture: '', requests: [], downloads: [], saved: [] };
	evidence.set(page, record);
	await page.route('**/*media-consent-probe*', async (route) => {
		record.requests.push(route.request().url());
		await route.fulfill({
			status: 200,
			contentType: 'image/png',
			body: Buffer.from(pixel.split(',')[1]!, 'base64')
		});
	});
	page.on('download', (download) => {
		const path = info.outputPath(`export-${record.downloads.length}.html`);
		record.downloads.push(path);
		record.saved.push(download.saveAs(path));
	});
	await resetAppState(page);
	await createFirstFile(page);
});

test.afterEach(async ({ page, browser }, info) => {
	const record = evidence.get(page)!;
	await Promise.all(record.saved);
	await info.attach('media-consent-evidence.json', {
		body: JSON.stringify(
			{
				...info.config.metadata,
				browser: browser.version(),
				fixture: record.fixture,
				interceptedRequests: record.requests,
				downloads: record.downloads,
				exportOutcome: record.exportOutcome,
				exportMessage: record.exportMessage,
				status: info.status,
				previewHtml: await page
					.locator('.mdsh-preview')
					.innerHTML()
					.catch(() => null)
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach('media-consent.png', {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
	for (const path of record.downloads)
		await info.attach('exported-html', { path, contentType: 'text/html' });
});

async function render(page: Page, source: string) {
	evidence.get(page)!.fixture = source;
	await writeSourceContent(page, source);
	await page.locator('[data-mode="read"]').click();
	await expect(page.locator('.mdsh-preview')).toContainText('Media consent probe');
	// Give resource selection and media preload a bounded observation interval.
	await page.waitForTimeout(300);
}

async function exportHtml(page: Page, info: TestInfo): Promise<string> {
	const record = evidence.get(page)!;
	await openPalette(page);
	await page.keyboard.insertText('Exporter en HTML');
	await page.keyboard.press('Enter');
	await expect
		.poll(
			async () => {
				if (record.downloads.length) return 'download';
				if (await page.getByRole('alert').filter({ hasText: 'L’export a été annulé.' }).isVisible())
					return 'error';
				return 'pending';
			},
			{ timeout: 15_000, message: `HTML export outcome for ${info.title}` }
		)
		.not.toBe('pending');
	record.exportOutcome = record.downloads.length ? 'download' : 'error';
	if (record.exportOutcome === 'error') {
		record.exportMessage = await page
			.getByRole('alert')
			.filter({ hasText: 'L’export a été annulé.' })
			.innerText();
	}
	await Promise.all(record.saved);
	return record.exportOutcome;
}

test('blocks unsupported network media in preview and HTML export', async ({ page }, info) => {
	await render(
		page,
		`# Media consent probe

<video poster="/media-consent-probe-poster.png" preload="auto" src="/media-consent-probe-video.mp4" controls><track default src="/media-consent-probe-track.vtt"></video>
<audio src="/media-consent-probe-audio.mp3" preload="auto" controls></audio>
<video preload="auto" controls><source src="/media-consent-probe-source.mp4"></video>
<picture><source srcset="/media-consent-probe-picture.png"><img src="${pixel}" alt="Local fallback"></picture>`
	);
	expect.soft(evidence.get(page)!.requests).toEqual([]);
	await expect(page.locator('.mdsh-preview img')).toHaveJSProperty('naturalWidth', 1);
	expect(await exportHtml(page, info)).toBe('error');
	expect(evidence.get(page)!.requests).toEqual([]);
	expect(evidence.get(page)!.downloads).toEqual([]);
});

test('blocks escaped SVG paints and retains local paints in HTML export', async ({
	page
}, info) => {
	await render(
		page,
		String.raw`# Media consent probe

<svg width="100" height="40"><defs><linearGradient id="local-paint"><stop stop-color="red"/></linearGradient></defs><rect id="remote-paint" width="20" height="20" fill="u\72l(/media-consent-probe-paint.svg#p)"/><rect id="local-rect" x="30" width="20" height="20" fill="url(#local-paint)"/><rect id="solid-rect" x="60" width="20" height="20" fill="#00ff00"/></svg>`
	);
	expect.soft(evidence.get(page)!.requests).toEqual([]);
	await expect.soft(page.locator('.mdsh-preview #remote-paint')).not.toHaveAttribute('fill');
	await expect(page.locator('.mdsh-preview #local-rect')).toHaveAttribute(
		'fill',
		'url(#local-paint)'
	);
	await expect(page.locator('.mdsh-preview #solid-rect')).toHaveAttribute('fill', '#00ff00');
	expect(await exportHtml(page, info)).toBe('download');
	const html = await readFile(evidence.get(page)!.downloads[0]!, 'utf8');
	expect(html).toContain('fill="url(#local-paint)"');
	expect(html).not.toContain('media-consent-probe-paint');
});

test('reports unsupported srcset instead of exporting only its fallback', async ({
	page
}, info) => {
	await render(
		page,
		`# Media consent probe\n\n<img src="${pixel}" srcset="/media-consent-probe-hires.png 2x" alt="Detailed figure">`
	);
	await expect(page.locator('.mdsh-preview img')).toHaveJSProperty('naturalWidth', 1);
	expect(await exportHtml(page, info)).toBe('error');
	await expect(page.getByRole('alert').filter({ hasText: 'L’export a été annulé.' })).toContainText(
		'/media-consent-probe-hires.png 2x'
	);
	const firstMessage = evidence.get(page)!.exportMessage;
	const alert = page.getByRole('alert').filter({ hasText: 'L’export a été annulé.' });
	await alert.getByRole('button').click();
	await expect(alert).toHaveCount(0);
	expect(await exportHtml(page, info)).toBe('error');
	expect(evidence.get(page)!.exportMessage).toBe(firstMessage);
	await info.attach('repeated-export.json', {
		body: JSON.stringify({ firstMessage, repeatedMessage: evidence.get(page)!.exportMessage }),
		contentType: 'application/json'
	});
	expect(evidence.get(page)!.requests).toEqual([]);
	expect(evidence.get(page)!.downloads).toEqual([]);
});

test('preserves embedded media and exports an embedded image', async ({ page }, info) => {
	const wav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQAAAAA=';
	await render(
		page,
		`# Media consent probe\n\n<img src="${pixel}" alt="Embedded pixel">\n\n<audio controls src="${wav}"></audio>`
	);
	await expect(page.locator('.mdsh-preview img')).toHaveJSProperty('naturalWidth', 1);
	await expect(page.locator('.mdsh-preview audio')).toHaveAttribute('src', wav);
	expect(await exportHtml(page, info)).toBe('download');
	const html = await readFile(evidence.get(page)!.downloads[0]!, 'utf8');
	expect(html).toContain('data:image/png;base64,');
	expect(html).toContain(wav);
	expect(evidence.get(page)!.requests).toEqual([]);
});

test('fetches an ordinary image only after explicit consent', async ({ page }, info) => {
	await render(
		page,
		'# Media consent probe\n\n![Approved image](/media-consent-probe-approved.png)'
	);
	expect(evidence.get(page)!.requests).toEqual([]);
	await page.getByRole('button', { name: 'Charger les images distantes' }).click();
	await expect(page.locator('.mdsh-preview img')).toHaveJSProperty('naturalWidth', 1);
	expect(evidence.get(page)!.requests).toEqual([
		new URL('/media-consent-probe-approved.png', page.url()).href
	]);
	expect(await exportHtml(page, info)).toBe('download');
	expect(evidence.get(page)!.requests).toHaveLength(1);
});

test('removes legacy HTML backgrounds before preview and HTML export', async ({ page }, info) => {
	await render(
		page,
		'# Media consent probe\n\n<table background="/media-consent-probe-table.png"><tr><th background="/media-consent-probe-header.png">Visible header</th><td background="/media-consent-probe-cell.png">Visible cell</td></tr></table>'
	);
	expect.soft(evidence.get(page)!.requests).toEqual([]);
	await expect.soft(page.locator('.mdsh-preview [background]')).toHaveCount(0);
	await expect(page.locator('.mdsh-preview')).toContainText('Visible cell');
	await expect(page.locator('.mdsh-preview')).toContainText('Visible header');
	expect(await exportHtml(page, info)).toBe('download');
	const html = await readFile(evidence.get(page)!.downloads[0]!, 'utf8');
	expect.soft(html).not.toMatch(/\sbackground=/i);
	expect(html).toContain('Visible cell');
	expect(html).toContain('Visible header');
	expect(evidence.get(page)!.requests).toEqual([]);
});

test('keeps passive HTML URL references without fetching them', async ({ page }, info) => {
	await render(
		page,
		`# Media consent probe

<blockquote cite="/media-consent-probe-blockquote">Quoted text</blockquote>
<q cite="/media-consent-probe-quote">Short quote</q>
<del cite="/media-consent-probe-deletion">Old text</del>
<ins cite="/media-consent-probe-insertion">New text</ins>
<a href="/media-consent-probe-link">Passive link</a>
<img src="${pixel}" alt="Local mapped image" usemap="/media-consent-probe-map#map">
<map name="map"><area shape="rect" coords="0,0,1,1" href="/media-consent-probe-area" alt="Mapped link"></map>`
	);
	await expect(page.locator('.mdsh-preview img')).toHaveJSProperty('naturalWidth', 1);
	expect(evidence.get(page)!.requests).toEqual([]);
	expect(await exportHtml(page, info)).toBe('download');
	const html = await readFile(evidence.get(page)!.downloads[0]!, 'utf8');
	expect(html).toContain('cite="/media-consent-probe-blockquote"');
	expect(html).toContain('href="/media-consent-probe-link"');
	expect(evidence.get(page)!.requests).toEqual([]);
});
