#!/usr/bin/env node
/**
 * Capture a short motion hero for the README top.
 *
 * Beat flow, one idea per beat:
 *   a) empty note, type a level-one heading in Edit mode
 *   b) a sentence, a two-item task list, then a wiki-link that resolves live
 *   c) split view: source on the left, rendered Mermaid flowchart on the right
 *   d) the ORBIT launch deck, presented across three slides
 *   e) end card: logo and tagline on the dark background
 *
 * Frames come from CDP `Page.startScreencast` (jpeg, quality 92, everyNthFrame
 * 1) on a browser launched at device scale factor 2, so every frame is a real
 * 2304x1440 render of the 1152x720 viewport. The smaller CSS viewport keeps the
 * type large in the composed 1088x680 window. Chrome only paints a compositor
 * frame when something changes, and a keystroke alone yields about 15 fps, so a
 * 1 px repaint driver runs in the page frame and asks for a frame every
 * animation tick. Capture then holds 30 to 34 fps while text is typed.
 *
 * Screencast timestamps go to timeline.json, so post holds every frame for its
 * measured interval and the typing rhythm survives instead of snapping to a
 * nominal 30 fps grid.
 *
 * Segments: beats a to c play continuously. Beat d opens the deck while capture
 * is paused, so no file picker reaches the video, then records the presentation.
 * Beat e renders on its own page at the canvas size.
 *
 * Run `node scripts/capture-hero-compose.mjs` afterwards to style and encode.
 * CAPTURE_PORT range for this capture: 4901-4909.
 */
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
	ROOT,
	createDocument,
	ensureMode,
	fileEvidence,
	launchDeck,
	newCapturePage,
	openPalette,
	readDrafts,
	withCapture,
	writeSource
} from './capture-helpers.mjs';

const OUT = join(process.env.HERO_OUT ?? join(ROOT, 'test-results', 'capture-hero'), 'work');
const FRAMES = join(OUT, 'frames');
/** CSS viewport of the app beats. 1.6 aspect matches the 1088x680 compose box. */
const APP_VIEWPORT = { width: 1152, height: 720 };

const NOTE = 'Launch plan';
const FLIGHT = `# Flight plan

Launch in two weeks. Three checkpoints.

\`\`\`mermaid
flowchart LR
  Plan --> Review
  Review --> Launch
\`\`\`

Back to [[Release checklist]].
`;
const CHECKLIST = `# Release checklist

## Before launch

- [x] Freeze the copy
- [x] Check every local link
- [ ] Present the briefing
`;
const MERMAID_BLOCK = `
\`\`\`mermaid
flowchart TD
  A[Field notes] --> B[Launch plan]
  B --> C[Slide deck]
  C --> D((Launch))
\`\`\`
`;

/** Per-key delay bounds in milliseconds. Jitter keeps the rhythm uneven. */
const TYPE_MIN = 40;
const TYPE_MAX = 70;
const SCREENCAST = {
	format: 'jpeg',
	quality: 92,
	everyNthFrame: 1,
	maxWidth: 4096,
	maxHeight: 2560
};

async function typeHuman(page, text) {
	for (const char of text) {
		await page.keyboard.type(char);
		await page.waitForTimeout(TYPE_MIN + Math.round(Math.random() * (TYPE_MAX - TYPE_MIN)));
	}
}

/**
 * A one pixel square that alternates between two dark tones on every animation
 * tick. It is invisible at capture scale, and it removes the compositor's idle
 * gate so the screencast emits a frame each tick. The node re-homes into the
 * fullscreen element, because only that subtree paints during a presentation.
 */
async function startRepaintDriver(page) {
	await page.evaluate(() => {
		const el = document.createElement('div');
		el.id = 'mdsh-capture-driver';
		el.style.cssText =
			'position:fixed;left:0;bottom:0;width:1px;height:1px;background:#0b0c0d;' +
			'z-index:2147483647;pointer-events:none';
		let host = null;
		const home = () => {
			const next = document.fullscreenElement ?? document.body;
			if (next === host && el.isConnected) return;
			host = next;
			host.appendChild(el);
		};
		home();
		let tick = 0;
		const drive = () => {
			home();
			el.style.background = tick++ % 2 ? '#0b0c0d' : '#0d0e0f';
			requestAnimationFrame(drive);
		};
		requestAnimationFrame(drive);
	});
}

async function stopRepaintDriver(page) {
	await page.evaluate(() => document.getElementById('mdsh-capture-driver')?.remove());
}

/**
 * Screencast frames on disk. Each frame keeps Chrome's capture timestamp, so the
 * timeline reflects real intervals rather than an assumed frame rate. The ack is
 * sent after the write, which throttles capture to disk speed, not the reverse.
 */
function startScreencast(cdp, dir, prefix) {
	const frames = [];
	let origin = null;
	let nodeOrigin = null;
	let stopped = false;
	const inflight = [];
	cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
		if (origin === null) {
			origin = metadata.timestamp;
			// Node clock at the first frame, so page-side marks can align with it.
			nodeOrigin = performance.now();
		}
		const at = (metadata.timestamp - origin) * 1000;
		const file = `${prefix}-${String(frames.length).padStart(5, '0')}.jpg`;
		frames.push({
			file,
			at,
			bytes: data.length,
			width: metadata.deviceWidth,
			height: metadata.deviceHeight
		});
		inflight.push(
			writeFile(join(dir, file), Buffer.from(data, 'base64'))
				.catch(() => {})
				.finally(async () => {
					if (stopped) return;
					try {
						await cdp.send('Page.screencastFrameAck', { sessionId });
					} catch {
						// The session can close mid-frame at the end of a take.
					}
				})
		);
	});
	return {
		async start() {
			await cdp.send('Page.startScreencast', SCREENCAST);
		},
		async stop() {
			stopped = true;
			try {
				await cdp.send('Page.stopScreencast');
			} catch {
				// Already stopped.
			}
			await Promise.allSettled(inflight);
			if (!frames.length) throw new Error('The screencast produced no frames.');
			return { frames, nodeOrigin };
		}
	};
}

async function seedProject(page, session) {
	await createDocument(page, 'Flight plan');
	await writeSource(page, 'Flight plan', FLIGHT);
	await createDocument(page, 'Release checklist');
	await writeSource(page, 'Release checklist', CHECKLIST);

	// The deck arrives through the project panel before capture starts.
	const { default: JSZip } = await import('jszip');
	const zip = new JSZip();
	zip.file('Launch briefing.md', launchDeck());
	const fixture = join(session.evidenceDir, 'orbit.zip');
	await writeFile(fixture, await zip.generateAsync({ type: 'nodebuffer' }));
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Markdown projects', exact: true });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles(fixture);
	await expect(
		panel.getByRole('button', { name: 'Open Launch briefing.md', exact: true })
	).toBeVisible({
		timeout: 25_000
	});
	await panel.getByRole('button', { name: 'Close projects', exact: true }).click();
	await expect.poll(async () => (await readDrafts(page)).length).toBe(3);
	session.metadata.fixtures = { deck: await fileEvidence(fixture) };
}

/**
 * The outline column is a preference toggle with no header button. The command
 * palette item is the UI path that the app itself exposes, so the panel is
 * closed the way a user closes it, and the editor gets the width back.
 */
async function hideOutline(page) {
	const palette = await openPalette(page);
	await palette.getByRole('combobox').fill('table of contents');
	await expect(palette.getByRole('option').first()).toBeVisible();
	const option = palette.getByRole('option', { name: /table of contents/i }).first();
	if (/Hide the table/i.test(await option.innerText())) await option.click();
	else await page.keyboard.press('Escape');
	await expect(page.locator('.mdsh-toc-col')).toHaveCount(0);
}

/** Beats a to c: one note, typed, then split view with a rendered diagram. */
async function recordNote(session, page, dir) {
	await seedProject(page, session);

	await createDocument(page, NOTE);
	await ensureMode(page, 'wysiwyg');
	const editor = page.locator('.milkdown .ProseMirror');
	await editor.click();
	await expect(page.getByRole('button', { name: 'Close notification', exact: true })).toHaveCount(
		0,
		{
			timeout: 20_000
		}
	);
	await expect(page.getByRole('alert')).toHaveCount(0);
	await hideOutline(page);

	// Warm the lazy SplitEditor module off camera, so the split view opens at
	// once on screen instead of showing an empty pane while the chunk loads.
	await ensureMode(page, 'source');
	await page.getByTestId('split-view-toggle').click();
	await expect(page.locator('.mdsh-split-view .mdsh-split-preview')).toBeVisible({
		timeout: 20_000
	});
	await page.getByTestId('split-view-toggle').click();
	await expect(page.locator('.mdsh-split-view')).toHaveCount(0);
	await ensureMode(page, 'wysiwyg');
	await editor.click();
	await page.waitForTimeout(500);

	const marks = [];
	const cdp = await page.context().newCDPSession(page);
	await startRepaintDriver(page);
	const cast = startScreencast(cdp, dir, 'note');
	const base = performance.now();
	const stamp = (label) => marks.push({ label, at: performance.now() - base });
	await cast.start();

	stamp('empty');
	await page.waitForTimeout(430);

	// a) The heading renders as it is typed.
	stamp('heading');
	await typeHuman(page, '# Launch plan');
	await page.waitForTimeout(300);

	// b) A sentence and a two-item task list.
	stamp('line');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(160);
	await typeHuman(page, 'Launch in two weeks.');
	await page.waitForTimeout(160);

	stamp('tasks');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(140);
	await typeHuman(page, '- [ ] Review the flight plan');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(120);
	await typeHuman(page, 'Present the briefing');
	await page.waitForTimeout(160);
	// Two Enters leave the list, so the next line is a plain paragraph.
	await page.keyboard.press('Enter');
	await page.waitForTimeout(100);
	await page.keyboard.press('Enter');
	await page.waitForTimeout(180);

	// The wiki-link resolves to a real note once the closing brackets land.
	stamp('wikilink');
	await typeHuman(page, 'Plan: [[Flight plan]]');
	await expect(editor.locator('[data-mdsh-wiki-link]')).toHaveCount(1, { timeout: 10_000 });
	await page.waitForTimeout(620);

	// c) Source left, rendered Markdown and Mermaid right.
	stamp('split');
	await ensureMode(page, 'source');
	await page.getByTestId('split-view-toggle').click();
	const split = page.locator('.mdsh-split-view');
	await expect(split).toBeVisible({ timeout: 20_000 });
	await expect(split.locator('.mdsh-split-preview h1')).toBeVisible({ timeout: 20_000 });
	await page.waitForTimeout(340);

	stamp('mermaid');
	await split.locator('.mdsh-split-source .cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(MERMAID_BLOCK);
	// Hold the finished split until the flowchart is drawn and readable.
	const diagram = split.locator('.mdsh-split-preview .mermaid-block svg');
	await expect(diagram).toBeVisible({ timeout: 30_000 });
	await expect(diagram).toHaveCount(1);
	await page.waitForTimeout(1800);
	const box = await diagram.boundingBox();
	console.log(
		`[hero] mermaid svg ${Math.round(box?.width ?? 0)}x${Math.round(box?.height ?? 0)} CSS px`
	);
	expect(box?.height ?? 0).toBeGreaterThan(290);

	const { frames, nodeOrigin } = await cast.stop();
	await stopRepaintDriver(page);
	// Rebase marks from the Node clock onto the screencast's first frame.
	const shift = nodeOrigin - base;
	return { frames, marks: marks.map((mark) => ({ ...mark, at: mark.at - shift })) };
}

/** Beat d: presentation, opened off camera, then three slides. */
async function recordDeck(page, dir) {
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Markdown projects', exact: true });
	await panel.getByRole('button', { name: 'Open Launch briefing.md', exact: true }).click();
	const slides = page.getByTestId('presentation-editor');
	await expect(slides.getByTestId('slide-thumbnail')).toHaveCount(3, { timeout: 25_000 });
	await expect(slides.getByTestId('slide-present')).toBeEnabled({ timeout: 20_000 });
	if (await panel.isVisible()) {
		const close = panel.getByRole('button', { name: 'Close projects', exact: true });
		if (await close.isVisible()) await close.click();
	}
	await page.waitForTimeout(900);

	// Fullscreen swaps the compositor surface and the screencast stops emitting
	// frames, so the present view runs in-page. It still fills the editor pane.
	await page.evaluate(() => {
		Element.prototype.requestFullscreen = () =>
			Promise.reject(new Error('Capture keeps the in-page surface.'));
	});

	const marks = [];
	const cdp = await page.context().newCDPSession(page);
	await startRepaintDriver(page);
	const cast = startScreencast(cdp, dir, 'deck');
	await cast.start();
	const base = performance.now();
	const stamp = (label) => marks.push({ label, at: performance.now() - base });

	stamp('deck');
	await page.waitForTimeout(520);
	stamp('present');
	await slides.getByTestId('slide-present').click();
	await expect(slides.locator('.present-count')).toHaveText('1 / 3');
	await expect(slides.locator('.present-count')).toBeVisible();
	await page.waitForTimeout(1330);
	stamp('slide2');
	await page.keyboard.press('ArrowRight');
	await expect(slides.locator('.present-count')).toHaveText('2 / 3');
	await page.waitForTimeout(1330);
	stamp('slide3');
	await page.keyboard.press('ArrowRight');
	await expect(slides.locator('.present-count')).toHaveText('3 / 3');
	await page.waitForTimeout(1330);

	const { frames, nodeOrigin } = await cast.stop();
	await stopRepaintDriver(page);
	const shift = nodeOrigin - base;
	return { frames, marks: marks.map((mark) => ({ ...mark, at: mark.at - shift })) };
}

/** Beat e: the real logo and tagline, drawn at the final canvas size. */
async function recordEndCard(browser, dir) {
	const logo = await readFile(join(ROOT, 'build', 'brand', 'logo-dark.svg'), 'utf8');
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DeckMark</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body {
    display: grid; place-items: center;
    background: radial-gradient(125% 95% at 50% 6%, #262b31 0%, #1d2126 34%, #101214 100%);
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card { display: grid; justify-items: center; gap: 34px; will-change: opacity, transform; }
  .logo { width: 438px; height: auto; display: block; }
  .rule { width: 44px; height: 2px; border-radius: 2px; background: #c79a55; opacity: 0.85; }
  .line { margin: 0; font-size: 28px; letter-spacing: 0.01em; color: #d9d2c5; }
</style></head>
<body><div class="card">
  <img class="logo" alt="DeckMark" src="data:image/svg+xml;base64,${Buffer.from(logo).toString('base64')}">
  <div class="rule"></div>
  <p class="line">Your Markdown. On your device.</p>
</div></body></html>`;

	const context = await browser.newContext({
		viewport: APP_VIEWPORT,
		deviceScaleFactor: 2,
		locale: 'en-US',
		colorScheme: 'dark'
	});
	const page = await context.newPage();
	await page.setContent(html, { waitUntil: 'load' });
	await page.evaluate(async () => {
		await document.fonts.ready;
		await Promise.all(Array.from(document.images).map((image) => image.decode()));
		// One slow lift so the cut from the app does not feel abrupt.
		document.querySelector('.card')?.animate(
			[
				{ opacity: 0, transform: 'translateY(12px)' },
				{ opacity: 1, transform: 'translateY(0)' }
			],
			{ duration: 850, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'both' }
		);
	});
	const cdp = await context.newCDPSession(page);
	await startRepaintDriver(page);
	const cast = startScreencast(cdp, dir, 'end');
	await cast.start();
	await page.waitForTimeout(1520);
	const { frames } = await cast.stop();
	await stopRepaintDriver(page);
	await context.close();
	return { frames, marks: [] };
}

/** Frame timings relative to each segment's first frame. */
function timeline(segment, dir) {
	const { frames, marks } = segment;
	const last = frames.at(-1)?.at ?? 0;
	const size = frameSize(join(dir, frames[0].file));
	return {
		frameCount: frames.length,
		durationSeconds: Number((last / 1000).toFixed(3)),
		frames: frames.map((frame) => ({
			file: frame.file,
			at: Number((frame.at / 1000).toFixed(4))
		})),
		marks: marks.map((entry) => ({
			label: entry.label,
			at: Number((entry.at / 1000).toFixed(4))
		})),
		source: size
	};
}

/** Real pixel size of a captured frame. CDP metadata reports CSS pixels only. */
function frameSize(path) {
	const out = execFileSync('ffprobe', [
		'-v',
		'error',
		'-select_streams',
		'v:0',
		'-show_entries',
		'stream=width,height',
		'-of',
		'csv=p=0',
		path
	])
		.toString()
		.trim();
	const [width, height] = out.split(',').map(Number);
	return { width, height };
}

function gapStats(frames) {
	const gaps = frames
		.slice(1)
		.map((frame, index) => frame.at - frames[index].at)
		.sort((a, b) => a - b);
	return {
		p50: Math.round(gaps[Math.floor(gaps.length / 2)] ?? 0),
		p95: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0)
	};
}

withCapture('hero', 4901, async (session) => {
	session.metadata.command = `CAPTURE_PORT=${process.env.CAPTURE_PORT ?? 4901} node scripts/capture-hero.mjs`;
	session.metadata.script = await fileEvidence(join(ROOT, 'scripts', 'capture-hero.mjs'));

	for (const name of ['note', 'deck', 'end']) {
		await rm(join(FRAMES, name), { recursive: true, force: true });
		await mkdir(join(FRAMES, name), { recursive: true });
	}

	// A second browser carries the device scale flag. Playwright's
	// deviceScaleFactor alone does not scale the headless capture surface.
	const captureBrowser = await chromium.launch({
		args: ['--force-device-scale-factor=2', '--high-dpi-support=1']
	});
	try {
		const page = await newCapturePage(
			{ browser: captureBrowser, baseURL: session.baseURL, metadata: session.metadata },
			'dark'
		);
		// The shared helper builds a 1280x800 context. Shrink to the 1.6 aspect
		// viewport that matches the composed window, so the type reads large.
		await page.setViewportSize(APP_VIEWPORT);
		expect(await page.evaluate(() => devicePixelRatio)).toBe(2);

		const note = await recordNote(session, page, join(FRAMES, 'note'));
		const deck = await recordDeck(page, join(FRAMES, 'deck'));
		const end = await recordEndCard(captureBrowser, join(FRAMES, 'end'));

		const segments = {
			note: timeline(note, join(FRAMES, 'note')),
			deck: timeline(deck, join(FRAMES, 'deck')),
			end: timeline(end, join(FRAMES, 'end'))
		};
		const total = Object.values(segments).reduce((sum, part) => sum + part.durationSeconds, 0);
		await writeFile(
			join(OUT, 'timeline.json'),
			JSON.stringify(
				{
					fps: 30,
					width: APP_VIEWPORT.width,
					height: APP_VIEWPORT.height,
					deviceScaleFactor: 2,
					canvas: { width: 1280, height: 760 },
					totalSeconds: Number(total.toFixed(3)),
					segments
				},
				null,
				2
			) + '\n'
		);

		expect(note.frames.length).toBeGreaterThan(280);
		expect(deck.frames.length).toBeGreaterThan(90);
		expect(end.frames.length).toBeGreaterThan(40);
		for (const [name, frames] of Object.entries({
			note: note.frames,
			deck: deck.frames,
			end: end.frames
		})) {
			const stats = gapStats(frames);
			console.log(
				`[hero] ${name}: ${frames.length} frames, ${segments[name].durationSeconds}s, ` +
					`gap p50 ${stats.p50}ms p95 ${stats.p95}ms`
			);
		}
		console.log(`[hero] total ${total.toFixed(2)}s, frames in ${FRAMES}`);
		return {
			total: Number(total.toFixed(2)),
			segments: Object.fromEntries(
				Object.entries(segments).map(([key, part]) => [key, part.durationSeconds])
			)
		};
	} finally {
		await captureBrowser.close();
	}
}).catch((error) => {
	console.error(error);
	process.exitCode ||= 1;
});
