import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPalette, resetAppState, seedFiles } from './helpers';

test.use({ locale: 'fr-FR', reducedMotion: 'reduce' });

const command =
	'npx playwright test e2e/export-download-lifetime.spec.ts --project=chromium --workers=1 --retries=0';

const markdown = '# Download lifetime\n\nUn changement doit survivre au telechargement.\n';
const secondMarkdown = '# Second note\n\nDeuxieme contenu exact.\n';

const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	'base64'
);

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(bytes: Buffer): number {
	let value = 0xffffffff;
	for (const byte of bytes) value = (CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)) >>> 0;
	return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typed));
	return Buffer.concat([length, typed, crc]);
}

/** A valid PNG with a 1.5 MiB text chunk, so the export blob is not small. */
function largePng(): Buffer {
	const insertAt = png.length - 12; // before the IEND chunk
	const text = Buffer.alloc(1_500_000, 0x41);
	return Buffer.concat([
		png.subarray(0, insertAt),
		pngChunk('tEXt', Buffer.concat([Buffer.from('Comment\0', 'ascii'), text])),
		png.subarray(insertAt)
	]);
}

/** A binary export above one MiB exercises a blob that needs a bounded retention. */
const largeImage = largePng();

const fixtures = [
	{ name: 'markdown', bytes: Buffer.from(markdown, 'utf8') },
	{ name: 'second-markdown', bytes: Buffer.from(secondMarkdown, 'utf8') },
	{ name: 'large.png', bytes: largeImage }
];

interface AuditEvent {
	type: 'create' | 'click' | 'revoke';
	url: string;
	at: number;
}

/**
 * Records object URL creation, revocation and anchor clicks in the page before
 * the application starts. The download flow has no other observable event.
 */
function downloadAuditScript() {
	const audit = {
		events: [] as AuditEvent[],
		failClicks: false
	};
	(window as unknown as { __downloadAudit: typeof audit }).__downloadAudit = audit;

	const create = URL.createObjectURL.bind(URL);
	URL.createObjectURL = (blob: Blob) => {
		const url = create(blob);
		audit.events.push({ type: 'create', url, at: performance.now() });
		return url;
	};

	const revoke = URL.revokeObjectURL.bind(URL);
	URL.revokeObjectURL = (url: string) => {
		audit.events.push({ type: 'revoke', url, at: performance.now() });
		revoke(url);
	};

	const click = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
		audit.events.push({ type: 'click', url: this.href, at: performance.now() });
		if (audit.failClicks) throw new DOMException('Injected click failure', 'NotSupportedError');
		return click.call(this);
	};
}

async function auditEvents(page: Page): Promise<AuditEvent[]> {
	return page.evaluate(
		() =>
			(window as unknown as { __downloadAudit: { events: AuditEvent[] } }).__downloadAudit.events
	);
}

function sha256(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

async function saveDownload(
	page: Page,
	info: TestInfo,
	name: string,
	action: () => Promise<void>
): Promise<Buffer> {
	const pending = page.waitForEvent('download');
	await action();
	const download = await pending;
	const path = info.outputPath(name);
	await download.saveAs(path);
	await info.attach(name, { path });
	return readFile(path);
}

async function latestCreatedUrl(page: Page): Promise<string> {
	const created = (await auditEvents(page)).filter((event) => event.type === 'create');
	const url = created.at(-1)?.url;
	expect(url).toBeTruthy();
	return url!;
}

async function waitForRevoke(page: Page, url: string): Promise<AuditEvent> {
	await expect
		.poll(
			async () =>
				(await auditEvents(page)).filter((event) => event.type === 'revoke' && event.url === url)
					.length,
			{ timeout: 20_000 }
		)
		.toBe(1);
	const revoke = (await auditEvents(page)).find(
		(event) => event.type === 'revoke' && event.url === url
	);
	expect(revoke).toBeTruthy();
	return revoke!;
}

function clickEvent(events: AuditEvent[], url: string): AuditEvent {
	const click = events.find((event) => event.type === 'click' && event.url === url);
	expect(click).toBeTruthy();
	return click!;
}

/** The object URL must outlive the task that starts the download. */
async function expectDelayedRevocation(page: Page, url: string): Promise<AuditEvent> {
	const events = await auditEvents(page);
	const click = clickEvent(events, url);
	const revoke = await waitForRevoke(page, url);
	expect(revoke.at - click.at).toBeGreaterThan(1_000);
	return revoke;
}

let expectedHashes: Record<string, string> = {};

test.beforeEach(async ({ page }, info) => {
	expectedHashes = Object.fromEntries(
		fixtures.map((fixture) => [fixture.name, sha256(fixture.bytes)])
	);
	await page.addInitScript(downloadAuditScript);
	await resetAppState(page);
	info.attach('download-lifetime-fixtures.json', {
		body: JSON.stringify(
			{
				command,
				source: info.config.metadata,
				markdown,
				secondMarkdown,
				fixtures: fixtures.map((fixture) => ({
					name: fixture.name,
					bytes: fixture.bytes.length,
					sha256: sha256(fixture.bytes)
				}))
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test.afterEach(async ({ page, browser }, info) => {
	let events: AuditEvent[];
	try {
		events = await auditEvents(page);
	} catch {
		events = [];
	}
	await info.attach('download-lifetime-audit.json', {
		body: JSON.stringify(
			{
				command,
				source: info.config.metadata,
				browser: browser.version(),
				platform: process.platform,
				status: info.status,
				title: info.title,
				expectedHashes,
				events
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('keeps the Markdown object URL until the download begins', async ({ page }, info) => {
	await seedFiles(page, [{ name: 'download-lifetime', content: markdown }]);
	const bytes = await saveDownload(page, info, 'download-lifetime.md', () =>
		page.getByRole('button', { name: 'Exporter' }).first().click()
	);

	expect(bytes.equals(Buffer.from(markdown, 'utf8'))).toBe(true);
	expect(sha256(bytes)).toBe(expectedHashes.markdown);
	const url = await latestCreatedUrl(page);
	await expectDelayedRevocation(page, url);
});

test('keeps each object URL across three consecutive Markdown downloads', async ({
	page
}, info) => {
	await seedFiles(page, [{ name: 'download-lifetime', content: markdown }]);
	const urls: string[] = [];
	for (let index = 0; index < 3; index += 1) {
		const bytes = await saveDownload(page, info, `consecutive-${index + 1}.md`, () =>
			page.getByRole('button', { name: 'Exporter' }).first().click()
		);
		expect(bytes.equals(Buffer.from(markdown, 'utf8'))).toBe(true);
		expect(sha256(bytes)).toBe(expectedHashes.markdown);
		urls.push(await latestCreatedUrl(page));
	}

	expect(new Set(urls).size).toBe(3);
	const events = await auditEvents(page);
	for (const url of urls) {
		const click = clickEvent(events, url);
		const revoke = await waitForRevoke(page, url);
		expect(revoke.at - click.at).toBeGreaterThan(1_000);
	}
});

test('keeps the library ZIP object URL and exact entry bytes', async ({ page }, info) => {
	await seedFiles(page, [
		{ name: 'first', content: markdown },
		{ name: 'second', content: secondMarkdown }
	]);
	const bytes = await saveDownload(page, info, 'library.zip', async () => {
		await openPalette(page);
		await page.keyboard.insertText('Exporter tous les fichiers');
		const dialog = page.getByRole('dialog', { name: 'Palette de commandes' });
		const option = dialog.getByRole('option', { name: 'Exporter tous les fichiers' });
		await expect(option).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('Enter');
	});

	const { default: JSZip } = await import('jszip');
	const zip = await JSZip.loadAsync(bytes);
	const names = Object.keys(zip.files).sort();
	expect(names).toEqual(['first.md', 'second.md']);
	expect(await zip.file('first.md')!.async('nodebuffer')).toEqual(Buffer.from(markdown, 'utf8'));
	expect(await zip.file('second.md')!.async('nodebuffer')).toEqual(
		Buffer.from(secondMarkdown, 'utf8')
	);

	const url = await latestCreatedUrl(page);
	await expectDelayedRevocation(page, url);
});

test('keeps the binary object URL for a larger image and exact bytes', async ({ page }, info) => {
	await page
		.locator('input[type="file"][accept*="text/markdown"]')
		.setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: largeImage });
	await expect(page.getByTestId('document-kind')).toHaveText('Image');
	// Force the download path so the object URL lifetime is observable.
	await page.evaluate(() => {
		Object.defineProperty(window, 'showSaveFilePicker', {
			configurable: true,
			value: async () => {
				throw new DOMException('Binary export must use a download', 'AbortError');
			}
		});
	});

	const bytes = await saveDownload(page, info, 'large.png', () =>
		page.getByTestId('save-as').click()
	);
	expect(bytes.equals(largeImage)).toBe(true);
	expect(sha256(bytes)).toBe(expectedHashes['large.png']);

	const url = await latestCreatedUrl(page);
	await expectDelayedRevocation(page, url);
});

test('revokes the object URL after a failed click', async ({ page }) => {
	await seedFiles(page, [{ name: 'download-lifetime', content: markdown }]);
	await page.evaluate(() => {
		(window as unknown as { __downloadAudit: { failClicks: boolean } }).__downloadAudit.failClicks =
			true;
	});

	await page.getByRole('button', { name: 'Exporter' }).first().click();
	await expect(page.getByRole('alert').filter({ hasText: /échoué/ })).toBeVisible();

	const url = await latestCreatedUrl(page);
	const events = await auditEvents(page);
	const click = clickEvent(events, url);
	const revoke = await waitForRevoke(page, url);
	// A failed click cannot start a download, so cleanup is immediate.
	expect(revoke.at - click.at).toBeLessThan(1_000);
});
