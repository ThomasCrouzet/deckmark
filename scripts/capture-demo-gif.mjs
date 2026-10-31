#!/usr/bin/env node
/**
 * Capture the README demo from the built app with Playwright and ffmpeg.
 * After UI integration: npm run build && node scripts/capture-demo-gif.mjs
 * The script starts and stops its own preview server on port 4174.
 * CAPTURE_PORT and BASE_PATH can select another port and built base path.
 *
 * Real PNG frames have fixed display durations. Setup and load waits are omitted.
 * Keep the GIF between 20 and 35 seconds, at 960 pixels wide, below 5 MB.
 * Frames, encode commands, checksums, and results stay under test-results/.
 */
import { expect } from '@playwright/test';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	ROOT,
	VIEWPORT,
	IDEAS,
	DIAGRAMS,
	createDocument,
	ensureMode,
	fileEvidence,
	newCapturePage,
	openPalette,
	probeMedia,
	readDrafts,
	runTool,
	saveScreenshot,
	seedDocuments,
	waitForSaved,
	withCapture
} from './capture-helpers.mjs';

const GIF_WIDTH = 960;
const MAX_BYTES = 5_000_000;
const NAME = 'Field notes';
const INTRO = 'Write Markdown. Keep your drafts on this device.';
const INITIAL_MARKDOWN = `# ${NAME}\n\n${INTRO}`;
const ADDITION =
	'\n\nSee [[Ideas]] and [[Diagrams]].\n\n## Next steps\n\n- [x] Write a draft\n- [ ] Export a PDF\n';
const DEMO_DIAGRAM = {
	...DIAGRAMS,
	content: `# Diagrams

A short path from draft to document.

\`\`\`mermaid
sequenceDiagram
  participant You
  participant Draft as Local draft
  You->>Draft: Write Markdown
  Draft-->>You: Save locally
  You->>Draft: Export a document
\`\`\`

Back to [[Field notes]].
`
};

async function record(session) {
	const page = await newCapturePage(session);
	const frames = [];
	await mkdir(join(session.evidenceDir, 'frames'));
	async function frame(label, seconds) {
		const file = `frames/${String(frames.length).padStart(3, '0')}.png`;
		await saveScreenshot(page, join(session.evidenceDir, file));
		frames.push({ file, label, seconds });
		await writeFile(
			join(session.evidenceDir, 'frames.json'),
			JSON.stringify(frames, null, 2) + '\n'
		);
	}
	async function typeText(text, target) {
		let typed = '';
		for (const chunk of text.match(/.{1,4}/g) ?? []) {
			await page.keyboard.type(chunk);
			typed += chunk;
			await expect(target).toHaveText(typed);
			await frame('Type in the visual editor', 0.12);
		}
	}

	// Create linked documents through the UI, then close their tabs before capture.
	await seedDocuments(page, [IDEAS, DEMO_DIAGRAM]);
	for (let count = 2; count > 0; count--) {
		await page
			.locator('.mdsh-file-row')
			.last()
			.getByRole('button', { name: /^Close / })
			.click();
		await expect(page.locator('.mdsh-file-row')).toHaveCount(count - 1);
	}
	await expect
		.poll(async () => (await readDrafts(page)).every((row) => row.open === false))
		.toBe(true);
	// Reload clears the transient close-tab notification through normal app startup.
	await page.reload();
	await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible();
	await expect(page.getByTestId('welcome-new')).toBeVisible();
	await expect(page.locator('#welcome-title')).toBeVisible();
	await expect(page.locator('.mdsh-local-indicator')).toHaveText('Ready offline');
	await frame('Branded welcome with a local library', 2.2);

	await createDocument(page, NAME);
	await ensureMode(page, 'wysiwyg');
	const editor = page.locator('.milkdown .ProseMirror');
	await expect(editor).toHaveText('');
	await frame('Create Field notes', 0.6);
	await editor.click();
	await page.keyboard.type('/h1');
	const menu = page.locator('.milkdown-slash-menu');
	await expect(menu).toBeVisible();
	await expect(menu.locator('[data-index]')).toHaveCount(1);
	await expect(menu.locator('[data-index]')).toContainText('Heading 1');
	await frame('Select a heading with /h1', 1.2);
	await page.keyboard.press('Enter');
	await expect(menu).not.toBeVisible();
	await expect(editor.locator('h1')).toHaveText('');
	await typeText(NAME, editor.locator('h1'));
	await frame('Heading inserted', 0.6);
	await page.keyboard.press('Enter');
	await typeText(INTRO, editor.locator('p'));
	await waitForSaved(page, NAME, INITIAL_MARKDOWN);
	await frame('Visual editing with a saved local draft', 0.8);

	await ensureMode(page, 'source');
	await expect(page.locator('.cm-content')).toContainText(`# ${NAME}`);
	await frame('Switch to Markdown source', 1.2);
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText(INITIAL_MARKDOWN + ADDITION);
	await waitForSaved(page, NAME, INITIAL_MARKDOWN + ADDITION);
	await expect(page.locator('.cm-content')).toContainText('[[Diagrams]]');
	await frame('Add wiki links and a task list', 1.8);

	await ensureMode(page, 'read');
	const preview = page.locator('.mdsh-preview');
	await expect(preview.locator('h1')).toHaveText(NAME);
	await expect(preview.locator('input[type="checkbox"]')).toHaveCount(2);
	await expect(preview.locator('a.wiki-link')).toHaveCount(2);
	await frame('Read the rendered document', 2);
	await preview.getByRole('link', { name: 'Diagrams', exact: true }).click();
	await expect(page.locator('#app-toolbar input')).toHaveValue('Diagrams');
	await expect(preview.locator('h1')).toHaveText('Diagrams');
	await expect(preview.locator('.mermaid-block svg')).toBeVisible({ timeout: 20_000 });
	await expect(preview.locator('.mermaid-block')).toContainText('Save locally');
	await expect(page.locator('.mdsh-toc-col button')).toHaveText(['Diagrams']);
	session.metadata.diagram = await preview.locator('.mermaid-block svg').evaluate((svg) => {
		const box = svg.getBoundingClientRect();
		const content = svg.getBBox();
		const view = svg.viewBox.baseVal;
		return {
			attributes: Object.fromEntries(
				Array.from(svg.attributes, ({ name, value }) => [name, value])
			),
			box: { x: box.x, y: box.y, width: box.width, height: box.height },
			content: { x: content.x, y: content.y, width: content.width, height: content.height },
			inside:
				content.x >= view.x - 1 &&
				content.y >= view.y - 1 &&
				content.x + content.width <= view.x + view.width + 1 &&
				content.y + content.height <= view.y + view.height + 1
		};
	});
	expect(session.metadata.diagram.inside, 'Show the complete diagram.').toBe(true);
	await expect
		.poll(async () => (await readDrafts(page)).find((row) => row.name === 'Diagrams.md')?.open)
		.toBe(true);
	await frame('Follow a wiki link to a real Mermaid diagram', 2.2);

	await page
		.locator('aside')
		.getByRole('button', { name: /^Document library/ })
		.click();
	const library = page.getByRole('dialog', { name: 'Document library', exact: true });
	await expect(library.getByRole('textbox')).toBeFocused();
	await expect(library.getByRole('heading')).toHaveText('Document library (3)');
	for (const name of ['Ideas', 'Diagrams']) {
		await library.getByRole('checkbox', { name: `Select ${name}.md`, exact: true }).check();
	}
	await expect(library.getByRole('status')).toHaveText('2 document(s) selected');
	await frame('Select open and closed documents in the library', 1.6);
	await library.getByRole('button', { name: 'Open Field notes.md', exact: true }).click();
	await expect(page.locator('#app-toolbar input')).toHaveValue(NAME);
	await ensureMode(page, 'wysiwyg');
	await expect(editor.locator('h1')).toHaveText(NAME);

	await page.keyboard.press('ControlOrMeta+,');
	const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
	const widths = settings.getByRole('group', { name: 'Editor width', exact: true });
	const pdfWidth = widths.getByRole('button', { name: 'PDF (A4)', exact: true });
	await pdfWidth.click();
	await expect(pdfWidth).toHaveAttribute('aria-pressed', 'true');
	await expect(widths.locator('[aria-pressed="true"]')).toHaveCount(1);
	await expect(settings.locator('#editor-width-pdf-help')).toContainText('178 mm');
	await frame('Set the PDF (A4) editor width', 2.2);
	await settings.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(settings).not.toBeVisible();
	await expect
		.poll(() =>
			editor.evaluate((element) => {
				const style = getComputedStyle(element);
				const width = element.getBoundingClientRect().width;
				return Math.abs(
					width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - (178 * 96) / 25.4
				);
			})
		)
		.toBeLessThan(1);
	await frame('Use the PDF text width in the visual editor', 1.4);

	const palette = await openPalette(page);
	await palette.getByRole('combobox').fill('graph');
	const graphCommand = palette.getByRole('option', { name: 'Links graph', exact: true });
	await expect(graphCommand).toBeVisible();
	await frame('Find the link graph in the command palette', 1.4);
	await graphCommand.click();
	const graph = page.getByRole('dialog', { name: 'Link graph', exact: true });
	await expect(graph.locator('.graph-node')).toHaveCount(3);
	await expect(graph.locator('svg line').first()).toBeVisible();
	await frame('Inspect links between the three documents', 1.8);
	await graph.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(graph).not.toBeVisible();
	await expect(editor.locator('h1')).toHaveText(NAME);
	await page.getByTestId('slides-open').click();
	const slides = page.getByTestId('presentation-editor');
	await expect(slides.getByTestId('slide-canvas')).toBeVisible();
	await slides.getByTestId('slide-object-list-item').first().click();
	for (const [property, value] of [
		['width', '1040'],
		['height', '520'],
		['fontSize', '28']
	]) {
		await slides.getByTestId(`slide-prop-${property}`).fill(value);
		await slides.getByTestId(`slide-prop-${property}`).press('Tab');
	}
	await expect(slides.locator('.save-state')).toHaveText('saved');
	await frame('Arrange the same document as slides', 2.4);
	await saveScreenshot(page, join(ROOT, 'docs/screenshots/presentation-editor.png'));
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(slides.getByTestId('slide-canvas')).toBeInViewport();
	await saveScreenshot(page, join(ROOT, 'docs/screenshots/presentation-editor-mobile.png'));
	await page.setViewportSize(VIEWPORT);
	await slides.getByTestId('slide-close').click();
	await expect(slides).not.toBeVisible();
	await page.keyboard.press('ControlOrMeta+,');
	await page
		.getByRole('dialog', { name: 'Settings', exact: true })
		.getByRole('button', { name: 'Light', exact: true })
		.click();
	await page.keyboard.press('Escape');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await frame('Continue writing with the light theme', 2);
	return { frames, documents: await readDrafts(page) };
}

async function encode(session, frames) {
	const duration = frames.reduce((total, frame) => total + frame.seconds, 0);
	expect(duration).toBeGreaterThanOrEqual(20);
	expect(duration).toBeLessThanOrEqual(35);
	const concatPath = join(session.evidenceDir, 'frames.ffconcat');
	await writeFile(
		concatPath,
		'ffconcat version 1.0\n' +
			frames.map(({ file, seconds }) => `file '${file}'\nduration ${seconds}\n`).join('') +
			`file '${frames.at(-1).file}'\n`
	);
	const scale = `scale=${GIF_WIDTH}:-1:flags=lanczos`;
	const palettePath = join(session.evidenceDir, 'palette.png');
	const gifPath = join(session.evidenceDir, 'demo.gif');
	const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
	const input = ['-f', 'concat', '-safe', '0', '-i', concatPath];
	const commands = [
		[
			...common,
			...input,
			'-vf',
			`${scale},palettegen=stats_mode=diff`,
			'-frames:v',
			'1',
			palettePath
		],
		[
			...common,
			...input,
			'-i',
			palettePath,
			'-filter_complex',
			`[0:v]${scale}[scaled];[scaled][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
			'-fps_mode',
			'vfr',
			'-t',
			duration.toFixed(2),
			'-final_delay',
			String(Math.round(frames.at(-1).seconds * 100)),
			'-loop',
			'0',
			gifPath
		]
	];
	await writeFile(
		join(session.evidenceDir, 'ffmpeg-commands.json'),
		JSON.stringify(commands, null, 2) + '\n'
	);
	for (const args of commands) runTool('ffmpeg', args);
	const media = probeMedia(gifPath);
	const evidence = await fileEvidence(gifPath);
	expect(media.streams[0].width).toBe(GIF_WIDTH);
	expect(media.streams[0].height).toBe((VIEWPORT.height * GIF_WIDTH) / VIEWPORT.width);
	expect(Math.abs(Number(media.format.duration) - duration)).toBeLessThan(0.1);
	expect(evidence.bytes, 'The README GIF must be below 5 MB.').toBeLessThan(MAX_BYTES);
	expect(session.metadata.pageErrors).toEqual([]);
	expect(session.metadata.httpErrors).toEqual([]);
	await copyFile(gifPath, join(ROOT, 'docs', 'demo.gif'));
	console.log(
		`[capture] docs/demo.gif: ${Number(media.format.duration)} s, ${evidence.bytes} bytes`
	);
	return { path: 'docs/demo.gif', duration, ...evidence, media };
}

withCapture('demo', 4174, async (session) => {
	const result = await record(session);
	const output = await encode(session, result.frames);
	return { ...result, output };
}).catch((error) => {
	console.error(error);
	process.exitCode ||= 1;
});
