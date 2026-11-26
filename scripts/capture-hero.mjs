#!/usr/bin/env node
/**
 * Capture the README hero: a short product story, staged and framed live.
 *
 * The real app runs in an iframe inside a stage page. The stage draws the
 * gradient canvas, a slim browser bar that reads deckmark.dev, the window
 * shadow, one caption per beat, a pointer that travels to each control, and
 * the end card. Camera moves are CSS transforms on the window, so the app
 * keeps rendering at full resolution while the camera eases in and out.
 *
 * Beats, one idea per caption:
 *   1. Write Markdown, see it formatted: a next-steps list typed in Edit mode,
 *      with a wiki link that resolves to another note.
 *   2. Diagrams and math, rendered live: Source plus preview, a Mermaid edge
 *      typed on the left grows the flowchart on the right.
 *   3. Turn notes into slides: the ORBIT deck in the slide editor.
 *   4. Present from the browser: three slides, camera on the slide.
 *   5. End card: logo, tagline, three facts and the URL.
 *
 * Frames come from CDP `Page.startScreencast` on a browser launched at device
 * scale factor 1.5. The stage page is 1280x720 CSS pixels, so every frame is a
 * real 1920x1080 render. Screencast timestamps go to timeline.json, and the
 * compose step holds each frame for its measured interval.
 *
 * Interface fonts: see CAPTURE_FONTS_CSS in capture-helpers.mjs.
 *
 * Usage: npm run build, then
 *   CAPTURE_PORT=4901 HERO_THEME=dark node scripts/capture-hero.mjs
 *   HERO_THEME=dark node scripts/capture-hero-compose.mjs
 * CAPTURE_PORT range for this capture: 4901-4909.
 */
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

const THEME = process.env.HERO_THEME === 'light' ? 'light' : 'dark';
const OUT = join(process.env.HERO_OUT ?? join(ROOT, 'test-results', 'capture-hero'), THEME, 'work');
const FRAMES = join(OUT, 'frames');

const STAGE = { width: 1280, height: 720 };
/**
 * 1.5x renders 1920x1080 frames: supersampled for the 1280x720 output, and
 * light enough for the screencast to keep close to 30 fps on a busy host.
 */
const DPR = 1.5;
/** App viewport in CSS pixels, drawn 1.1x larger so the interface text reads. */
const APP = { width: 990, height: 552, scale: 1.1 };
const BAR = 32;

const PALETTE = {
	dark: {
		canvas:
			'radial-gradient(120% 90% at 50% 112%, rgba(199,154,85,0.20) 0%, rgba(199,154,85,0) 55%),' +
			'linear-gradient(180deg, #16191d 0%, #1d2126 100%)',
		bar: '#1b1e22',
		barLine: 'rgba(255,255,255,0.06)',
		dot: '#3a3f46',
		url: '#262a30',
		urlText: '#a9a294',
		caption: '#ece6da',
		captionBg: 'rgba(22,24,28,0.82)',
		captionLine: 'rgba(255,255,255,0.10)',
		accent: '#c79a55',
		shadow: '0 40px 90px -24px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.07)',
		muted: '#9d978b',
		logo: 'logo-dark.svg'
	},
	light: {
		canvas:
			'radial-gradient(120% 90% at 50% 112%, rgba(165,112,46,0.16) 0%, rgba(165,112,46,0) 55%),' +
			'linear-gradient(180deg, #f3f0ea 0%, #e8e3da 100%)',
		bar: '#f7f5f1',
		barLine: 'rgba(0,0,0,0.07)',
		dot: '#d6d1c7',
		url: '#ebe7df',
		urlText: '#6b645a',
		caption: '#26221c',
		captionBg: 'rgba(255,253,249,0.9)',
		captionLine: 'rgba(0,0,0,0.08)',
		accent: '#9a6a2a',
		shadow: '0 36px 80px -26px rgba(60,45,20,0.42), 0 0 0 1px rgba(0,0,0,0.08)',
		muted: '#7a7368',
		logo: 'logo-light.svg'
	}
}[THEME];

const NOTE = 'Orbit launch plan';
const NOTE_SOURCE = `# Orbit launch plan

Ship the **public beta** on Friday. Notes, slides, and assets stay on this device.

| Milestone | Owner | Status |
| --- | --- | --- |
| Copy freeze | Ana | Done |
| Briefing deck | Theo | In review |
| Launch | Team | Friday |
`;
const FLIGHT = `# Flight plan

Runway in weeks: $t = \\frac{budget}{burn}$

\`\`\`mermaid
flowchart TD
  A[Field notes] --> B[Launch plan]
  B --> C[Slide deck]
\`\`\`

Back to [[Orbit launch plan]].
`;
/** Typed on camera in Edit mode. Input rules turn the syntax into blocks. */
const TYPED_LINES = ['## Next steps', '- [ ] Rehearse the **briefing**', 'Ship the beta'];
/** Typed on camera inside the Mermaid block: a branch, so the chart grows sideways. */
const DIAGRAM_EDGE = '  B --> D[Checklist]';

const TYPE_MIN = 22;
const TYPE_MAX = 46;
/**
 * Input rules read the text around the caret. A bracket typed too soon after
 * the previous key can land after the rule has run, so brackets get a pause.
 */
const SLOW_KEYS = new Set(['[', ']', '*', '#']);
const SCREENCAST = {
	format: 'jpeg',
	quality: 86,
	everyNthFrame: 1,
	maxWidth: 1920,
	maxHeight: 1080
};

function stageHTML(appURL, logoSVG) {
	const winW = Math.round(APP.width * APP.scale);
	const winH = Math.round(APP.height * APP.scale) + BAR;
	const winX = Math.round((STAGE.width - winW) / 2);
	const winY = 30;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DeckMark hero</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${STAGE.width}px; height: ${STAGE.height}px; overflow: hidden; }
  body { background: ${PALETTE.canvas}; font-family: 'Inter', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased; }
  #cam { position: absolute; inset: 0; transform-origin: 0 0; will-change: transform; }
  #win { position: absolute; left: ${winX}px; top: ${winY}px; width: ${winW}px; height: ${winH}px;
    border-radius: 12px; overflow: hidden; box-shadow: ${PALETTE.shadow}; background: ${PALETTE.bar}; }
  #bar { height: ${BAR}px; display: flex; align-items: center; padding: 0 14px; gap: 7px;
    background: ${PALETTE.bar}; border-bottom: 1px solid ${PALETTE.barLine}; position: relative; }
  #bar i { width: 11px; height: 11px; border-radius: 50%; background: ${PALETTE.dot}; display: block; }
  #url { position: absolute; left: 50%; top: 6px; transform: translateX(-50%); height: 20px;
    min-width: 260px; padding: 0 14px; border-radius: 6px; background: ${PALETTE.url};
    color: ${PALETTE.urlText}; font-size: 11.5px; display: flex; align-items: center;
    justify-content: center; gap: 6px; letter-spacing: 0.01em; }
  #url svg { width: 10px; height: 10px; }
  #frame { width: ${APP.width}px; height: ${APP.height}px; transform: scale(${APP.scale});
    transform-origin: 0 0; }
  iframe { width: ${APP.width}px; height: ${APP.height}px; border: 0; display: block; }
  #cap { position: absolute; left: 50%; top: ${winY + winH - 22}px; transform: translateX(-50%);
    z-index: 5; pointer-events: none; }
  #cap span { display: inline-block; white-space: nowrap; padding: 10px 20px; border-radius: 999px;
    background: ${PALETTE.captionBg}; color: ${PALETTE.caption}; font-size: 19px; font-weight: 550;
    letter-spacing: -0.005em; box-shadow: 0 10px 30px -10px rgba(0,0,0,0.45),
    inset 0 0 0 1px ${PALETTE.captionLine}; backdrop-filter: blur(10px); opacity: 0; }
  #cap b { color: ${PALETTE.accent}; font-weight: 600; margin-right: 10px; font-variant-numeric: tabular-nums; }
  #cursor { position: absolute; left: 0; top: 0; width: 22px; height: 22px; z-index: 9;
    pointer-events: none; opacity: 0; will-change: transform; }
  #cursor svg { position: absolute; left: -2px; top: -1px; filter: drop-shadow(0 2px 3px rgba(0,0,0,0.35)); }
  #ripple { position: absolute; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 50%;
    border: 2px solid ${PALETTE.accent}; opacity: 0; }
  #end { position: absolute; inset: 0; display: grid; place-items: center; z-index: 8;
    pointer-events: none; opacity: 0; }
  #end .card { display: grid; justify-items: center; gap: 26px; }
  #end img { width: 420px; height: auto; display: block; }
  #end .tag { margin: 0; font-size: 30px; font-weight: 600; letter-spacing: -0.015em; color: ${PALETTE.caption}; }
  #end .facts { margin: 0; font-size: 17px; color: ${PALETTE.muted}; display: flex; gap: 12px; }
  #end .facts i { font-style: normal; color: ${PALETTE.accent}; }
  #end .url { margin: 4px 0 0; font-size: 17px; font-weight: 600; color: ${PALETTE.accent};
    letter-spacing: 0.02em; }
</style></head><body>
<div id="cam"><div id="win">
  <div id="bar"><i></i><i></i><i></i>
    <div id="url"><svg viewBox="0 0 10 12" fill="currentColor"><path d="M2 5V3.5a3 3 0 0 1 6 0V5h.5A1.5 1.5 0 0 1 10 6.5v4A1.5 1.5 0 0 1 8.5 12h-7A1.5 1.5 0 0 1 0 10.5v-4A1.5 1.5 0 0 1 1.5 5zm1.5 0h3V3.5a1.5 1.5 0 0 0-3 0z"/></svg>deckmark.dev</div>
  </div>
  <div id="frame"><iframe id="app" title="DeckMark" src="${appURL}"></iframe></div>
</div></div>
<div id="cap"><span></span></div>
<div id="cursor"><svg width="22" height="26" viewBox="0 0 22 26"><path d="M3 2 L3 21 L8 16.5 L11.4 24 L14.6 22.6 L11.3 15.3 L18 15.3 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg><div id="ripple"></div></div>
<div id="end"><div class="card">
  <img alt="DeckMark" src="data:image/svg+xml;base64,${Buffer.from(logoSVG).toString('base64')}">
  <p class="tag">Your Markdown. On your device.</p>
  <p class="facts"><span>Free and open source</span><i>·</i><span>No account</span><i>·</i><span>Works offline</span></p>
  <p class="url">deckmark.dev</p>
</div></div>
<script>
  const ease = 'cubic-bezier(0.65, 0, 0.35, 1)';
  const cam = document.getElementById('cam');
  const cursor = document.getElementById('cursor');
  const cap = document.querySelector('#cap span');
  let camState = { x: 0, y: 0, s: 1 };
  let cursorAt = { x: ${STAGE.width / 2}, y: ${STAGE.height + 40} };
  const camTransform = (v) => 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.s + ')';
  window.stage = {
    window: { x: ${winX}, y: ${winY}, width: ${winW}, height: ${winH} },
    camera(next, duration) {
      const from = camTransform(camState);
      camState = next;
      return cam.animate([{ transform: from }, { transform: camTransform(next) }],
        { duration, easing: ease, fill: 'forwards' }).finished;
    },
    get cameraState() { return camState; },
    async caption(text, step) {
      if (cap.style.opacity === '1') {
        await cap.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-6px)' }],
          { duration: 220, easing: 'ease-in', fill: 'forwards' }).finished;
      }
      cap.innerHTML = (step ? '<b>' + step + '</b>' : '') + text;
      cap.style.opacity = '1';
      return cap.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 380, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'forwards' }).finished;
    },
    hideCaption() {
      return cap.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: 'forwards' }).finished
        .then(() => { cap.style.opacity = '0'; });
    },
    showCursor(x, y) {
      cursorAt = { x, y };
      cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      return cursor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' }).finished;
    },
    hideCursor() {
      return cursor.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished;
    },
    moveCursor(x, y, duration) {
      const from = 'translate(' + cursorAt.x + 'px,' + cursorAt.y + 'px)';
      cursorAt = { x, y };
      const to = 'translate(' + x + 'px,' + y + 'px)';
      cursor.style.transform = to;
      return cursor.animate([{ transform: from }, { transform: to }],
        { duration, easing: 'cubic-bezier(0.45, 0, 0.2, 1)' }).finished;
    },
    ripple() {
      const ring = document.getElementById('ripple');
      ring.animate([{ opacity: 0.9, transform: 'scale(0.4)' }, { opacity: 0, transform: 'scale(1.4)' }],
        { duration: 420, easing: 'ease-out' });
      return cursor.querySelector('svg').animate([{ transform: 'scale(1)' }, { transform: 'scale(0.86)' },
        { transform: 'scale(1)' }], { duration: 200 }).finished;
    },
    endCard() {
      const win = document.getElementById('win');
      win.animate([{ opacity: 1, transform: 'scale(1)', filter: 'blur(0)' },
        { opacity: 0, transform: 'scale(0.94)', filter: 'blur(6px)' }],
        { duration: 650, easing: ease, fill: 'forwards' });
      const end = document.getElementById('end');
      end.style.opacity = '1';
      end.querySelector('.card').animate([{ opacity: 0, transform: 'translateY(14px)' },
        { opacity: 1, transform: 'translateY(0)' }],
        { duration: 800, delay: 380, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'both' });
      return new Promise((resolve) => setTimeout(resolve, 1200));
    }
  };
</script>
</body></html>`;
}

/**
 * A one pixel square that alternates between two tones on every animation
 * tick. It removes the compositor's idle gate, so the screencast emits a frame
 * each tick even while the scene holds still.
 */
async function startRepaintDriver(page) {
	await page.evaluate(() => {
		const el = document.createElement('div');
		el.id = 'mdsh-capture-driver';
		el.style.cssText =
			'position:fixed;left:0;bottom:0;width:1px;height:1px;z-index:2147483647;pointer-events:none';
		document.body.appendChild(el);
		let tick = 0;
		const drive = () => {
			el.style.background = tick++ % 2 ? 'rgba(0,0,0,0.02)' : 'rgba(0,0,0,0.03)';
			requestAnimationFrame(drive);
		};
		requestAnimationFrame(drive);
	});
}

/**
 * Screencast frames on disk. Each frame keeps Chrome's capture timestamp, so the
 * timeline reflects real intervals rather than an assumed frame rate.
 */
function startScreencast(cdp, dir, prefix) {
	const frames = [];
	let origin = null;
	let stopped = false;
	const inflight = [];
	cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
		if (stopped) return;
		if (origin === null) origin = metadata.timestamp;
		const file = `${prefix}-${String(frames.length).padStart(5, '0')}.jpg`;
		frames.push({ file, at: (metadata.timestamp - origin) * 1000 });
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
			return frames;
		}
	};
}

/** Frame methods for the shared helpers; keyboard and mouse stay on the page. */
function appView(page, frame) {
	return new Proxy(frame, {
		get(target, key) {
			if (key === 'keyboard' || key === 'mouse' || key === 'context') return page[key];
			const value = target[key];
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

class Director {
	constructor(page) {
		this.page = page;
	}
	stage(method, ...args) {
		return this.page.evaluate(([name, values]) => window.stage[name](...values), [method, args]);
	}
	/** Start a stage animation and return at once, so the next action overlaps it. */
	fire(method, ...args) {
		return this.page.evaluate(
			([name, values]) => {
				void window.stage[name](...values);
			},
			[method, args]
		);
	}
	async typeHuman(text) {
		for (const char of text) {
			await this.page.keyboard.type(char);
			const pause = TYPE_MIN + Math.round(Math.random() * (TYPE_MAX - TYPE_MIN));
			await this.page.waitForTimeout(SLOW_KEYS.has(char) ? pause + 110 : pause);
		}
	}
	/** Travel the pointer to the centre of a control, then click it for real. */
	async click(locator, { duration = 520, dx = 0, dy = 0 } = {}) {
		const box = await locator.boundingBox();
		if (!box) throw new Error('The click target is not visible.');
		const x = Math.round(box.x + box.width / 2 + dx);
		const y = Math.round(box.y + box.height / 2 + dy);
		await this.stage('moveCursor', x, y, duration);
		await this.page.mouse.move(x, y);
		await this.page.waitForTimeout(90);
		await this.stage('ripple');
		await this.page.mouse.click(x, y);
	}
	/**
	 * Zoom so a stage rectangle sits at the canvas centre at the given scale. The
	 * rectangle comes from a bounding box measured at the current camera, so it
	 * is first mapped back to unzoomed stage coordinates.
	 */
	async focus(box, { scale, duration = 750, anchorY = 0.5, wait = true }) {
		const current = await this.page.evaluate(() => window.stage.cameraState);
		const cx = (box.x + box.width / 2 - current.x) / current.s;
		const cy = (box.y + box.height * anchorY - current.y) / current.s;
		const x = Math.round(STAGE.width / 2 - scale * cx);
		const y = Math.round(STAGE.height / 2 - scale * cy);
		await this[wait ? 'stage' : 'fire']('camera', { x, y, s: scale }, duration);
	}
	reset(duration = 700) {
		return this.stage('camera', { x: 0, y: 0, s: 1 }, duration);
	}
}

async function seed(page, app, session) {
	await createDocument(app, 'Flight plan');
	await writeSource(app, 'Flight plan', FLIGHT);

	const { default: JSZip } = await import('jszip');
	const zip = new JSZip();
	zip.file('Launch briefing.md', launchDeck());
	const fixture = join(session.evidenceDir, 'orbit.zip');
	await writeFile(fixture, await zip.generateAsync({ type: 'nodebuffer' }));
	await app.getByTestId('projects-open').click();
	const panel = app.getByRole('dialog', { name: 'Markdown projects', exact: true });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles(fixture);
	await expect(
		panel.getByRole('button', { name: 'Open Launch briefing.md', exact: true })
	).toBeVisible({ timeout: 25_000 });
	await panel.getByRole('button', { name: 'Close projects', exact: true }).click();
	session.metadata.fixtures = { deck: await fileEvidence(fixture) };

	await createDocument(app, NOTE);
	await writeSource(app, NOTE, NOTE_SOURCE);
	await expect.poll(async () => (await readDrafts(app)).length).toBe(3);

	// Close the outline column the way a user does, so the editor gets the width.
	const palette = await openPalette(app);
	await palette.getByRole('combobox').fill('table of contents');
	await expect(palette.getByRole('option').first()).toBeVisible();
	const option = palette.getByRole('option', { name: /table of contents/i }).first();
	if (/Hide the table/i.test(await option.innerText())) await option.click();
	else await page.keyboard.press('Escape');
	await expect(app.locator('.mdsh-toc-col')).toHaveCount(0);

	// Warm the lazy split and Mermaid modules off camera.
	await ensureMode(app, 'source');
	await app.getByTestId('split-view-toggle').click();
	await expect(app.locator('.mdsh-split-view .mdsh-split-preview')).toBeVisible({
		timeout: 20_000
	});
	await app.getByTestId('split-view-toggle').click();
	await expect(app.locator('.mdsh-split-view')).toHaveCount(0);
	await ensureMode(app, 'wysiwyg');
	await expect(app.getByRole('button', { name: 'Close notification', exact: true })).toHaveCount(
		0,
		{ timeout: 20_000 }
	);
}

/** Beats 1 and 2: write in Edit mode, then Source and preview with Mermaid. */
async function recordNote(director, page, app, dir) {
	// The caret waits at the end of the note before the take starts.
	const editor = app.locator('.milkdown .ProseMirror');
	const table = editor.locator('table').last();
	const tableBox = await table.boundingBox();
	await page.mouse.click(
		Math.round(tableBox.x + tableBox.width / 2),
		Math.round(tableBox.y + tableBox.height + 34)
	);
	await page.keyboard.press('ControlOrMeta+End');
	await page.mouse.move(STAGE.width / 2, STAGE.height - 4);
	await page.waitForTimeout(300);

	const cdp = await page.context().newCDPSession(page);
	const cast = startScreencast(cdp, dir, 'note');
	await cast.start();

	// 1. Write.
	await director.fire('caption', 'Write Markdown. See it formatted.');
	await page.waitForTimeout(500);
	await director.focus(await editor.boundingBox(), {
		scale: 1.12,
		duration: 900,
		anchorY: 0.62,
		wait: false
	});
	await page.waitForTimeout(300);
	for (const [index, line] of TYPED_LINES.entries()) {
		if (index > 0) {
			await page.keyboard.press('Enter');
			await page.waitForTimeout(90);
		}
		await director.typeHuman(line);
		await page.waitForTimeout(160);
	}
	await expect(editor.locator('h2', { hasText: 'Next steps' })).toBeVisible();
	await expect(editor.locator('strong', { hasText: 'briefing' })).toBeVisible();
	await page.waitForTimeout(450);

	// 2. Another note, then Source and preview, with a diagram that grows as it is typed.
	await director.reset(550);
	await director.fire('caption', 'Diagrams and math, rendered live.');
	await director.stage('showCursor', 560, 430);
	await director.click(app.locator('aside').getByText('Flight plan', { exact: true }).first(), {
		duration: 420
	});
	await expect(editor.locator('svg').getByText('Field notes', { exact: true })).toBeVisible({
		timeout: 20_000
	});
	await page.waitForTimeout(450);
	await director.click(app.locator('button[data-mode="source"]'), { duration: 480 });
	await expect(app.locator('.cm-content')).toBeVisible();
	await director.click(app.getByTestId('split-view-toggle'), { duration: 380 });
	const split = app.locator('.mdsh-split-view');
	const preview = split.locator('.mdsh-split-preview');
	await expect(preview.locator('.mermaid-block svg')).toBeVisible({ timeout: 30_000 });
	await director.fire('hideCursor');
	// Put the caret on the last edge line, so the new edge lands inside the block.
	const source = split.locator('.mdsh-split-source .cm-content');
	await source.locator('.cm-line', { hasText: 'B --> C[Slide deck]' }).click();
	await page.keyboard.press('End');
	await director.focus(await split.boundingBox(), {
		scale: 1.12,
		duration: 700,
		anchorY: 0.5,
		wait: false
	});
	await page.waitForTimeout(350);
	await page.keyboard.press('Enter');
	await director.typeHuman(DIAGRAM_EDGE);
	await expect(
		preview.locator('.mermaid-block svg').getByText('Checklist', { exact: true })
	).toBeVisible({ timeout: 15_000 });
	await page.waitForTimeout(1200);
	return cast.stop();
}

/** Beats 3 to 5: the deck, presented, then the end card. */
async function recordDeck(director, page, app, dir) {
	await app.getByTestId('projects-open').click();
	const panel = app.getByRole('dialog', { name: 'Markdown projects', exact: true });
	await panel.getByRole('button', { name: 'Open Launch briefing.md', exact: true }).click();
	const slides = app.getByTestId('presentation-editor');
	await expect(slides.getByTestId('slide-thumbnail')).toHaveCount(3, { timeout: 25_000 });
	await expect(slides.getByTestId('slide-present')).toBeEnabled({ timeout: 20_000 });
	if (await panel.isVisible()) {
		const close = panel.getByRole('button', { name: 'Close projects', exact: true });
		if (await close.isVisible()) await close.click();
	}
	// Give the slide canvas the room: hide the presenter notes and the side panel.
	const notes = slides.getByTestId('slide-notes-toggle');
	if ((await notes.getAttribute('aria-pressed')) === 'true') await notes.click();
	const panelToggle = app.locator('button[aria-controls="files-panel"]:visible').first();
	await panelToggle.click();
	await expect(panelToggle).toHaveAttribute('aria-expanded', 'false');
	await page.mouse.move(STAGE.width / 2, STAGE.height - 4);
	await director.reset(1);
	await app.evaluate(() => {
		Element.prototype.requestFullscreen = () =>
			Promise.reject(new Error('Capture keeps the in-page surface.'));
	});
	await page.waitForTimeout(700);

	const cdp = await page.context().newCDPSession(page);
	const cast = startScreencast(cdp, dir, 'deck');
	await cast.start();
	await page.waitForTimeout(200);

	// 3. Slides.
	await director.fire('caption', 'Turn notes into slides.');
	await director.stage('showCursor', 760, 560);
	const title = slides.getByTestId('slide-canvas').locator('[data-element-id="orbit-element-2"]');
	await director.click(title, { duration: 520 });
	await page.waitForTimeout(700);
	await director.click(slides.getByTestId('slide-present'), { duration: 650 });
	await expect(slides.locator('.present-count')).toHaveText('1 / 3');
	await director.fire('hideCursor');

	// 4. Present, with the camera on the slide.
	await director.fire('caption', 'Present right from the browser.');
	const surface = app.locator('.presentation-editor.presenting .slide-render').first();
	await expect(surface).toBeVisible();
	await page.waitForTimeout(150);
	const slide = await surface.boundingBox();
	const current = await page.evaluate(() => window.stage.cameraState);
	const fit = Math.min(1120 / (slide.width / current.s), 590 / (slide.height / current.s));
	// A wrong measurement must not send the camera into the slide.
	const scale = Math.min(Math.max(fit, 1), 1.5);
	console.log(
		`[hero] slide ${Math.round(slide.width)}x${Math.round(slide.height)}, zoom ${scale.toFixed(3)}`
	);
	await director.focus(slide, { scale: Number(scale.toFixed(3)), duration: 800, wait: false });
	await page.waitForTimeout(1500);
	await page.keyboard.press('ArrowRight');
	await expect(slides.locator('.present-count')).toHaveText('2 / 3');
	await page.waitForTimeout(1300);
	await page.keyboard.press('ArrowRight');
	await expect(slides.locator('.present-count')).toHaveText('3 / 3');
	await page.waitForTimeout(1100);

	// 5. End card.
	await director.fire('hideCaption');
	await director.fire('camera', { x: 0, y: 0, s: 1 }, 650);
	await director.stage('endCard');
	await page.waitForTimeout(1700);
	return cast.stop();
}

function timeline(frames) {
	return {
		frameCount: frames.length,
		durationSeconds: Number(((frames.at(-1)?.at ?? 0) / 1000).toFixed(3)),
		frames: frames.map((frame) => ({ file: frame.file, at: Number((frame.at / 1000).toFixed(4)) }))
	};
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
	session.metadata.command = `CAPTURE_PORT=${process.env.CAPTURE_PORT ?? 4901} HERO_THEME=${THEME} node scripts/capture-hero.mjs`;
	session.metadata.script = await fileEvidence(join(ROOT, 'scripts', 'capture-hero.mjs'));
	for (const name of ['note', 'deck']) {
		await rm(join(FRAMES, name), { recursive: true, force: true });
		await mkdir(join(FRAMES, name), { recursive: true });
	}

	// Playwright's deviceScaleFactor alone does not scale the headless capture
	// surface, so this browser carries the device scale flag.
	const browser = await chromium.launch({
		args: [`--force-device-scale-factor=${DPR}`, '--high-dpi-support=1']
	});
	let page;
	try {
		page = await newCapturePage({ ...session, browser }, THEME, {
			deviceScaleFactor: DPR,
			interfaceFonts: true
		});
		await page.setViewportSize(STAGE);
		expect(await page.evaluate(() => devicePixelRatio)).toBe(DPR);

		// The stage uses another loopback origin, so the app's service worker
		// never answers for it and the route below serves the stage page.
		const stageURL = session.baseURL.replace('127.0.0.1', 'localhost') + '__hero_stage__';
		const logo = await readFile(join(ROOT, 'build', 'brand', PALETTE.logo), 'utf8');
		await page.route(stageURL, (route) =>
			route.fulfill({ contentType: 'text/html', body: stageHTML(session.baseURL, logo) })
		);
		await page.goto(stageURL);
		const frame = await (await page.locator('#app').elementHandle()).contentFrame();
		const app = appView(page, frame);
		await expect(app.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible({
			timeout: 30_000
		});
		await expect(app.locator('html')).toHaveAttribute('data-theme', THEME);
		await page.evaluate(() => document.fonts.ready);
		await startRepaintDriver(page);

		await seed(page, app, session);
		const director = new Director(page);
		const note = await recordNote(director, page, app, join(FRAMES, 'note'));
		const deck = await recordDeck(director, page, app, join(FRAMES, 'deck'));

		const segments = { note: timeline(note), deck: timeline(deck) };
		const total = segments.note.durationSeconds + segments.deck.durationSeconds;
		await writeFile(
			join(OUT, 'timeline.json'),
			JSON.stringify(
				{
					theme: THEME,
					fps: 30,
					stage: STAGE,
					deviceScaleFactor: DPR,
					totalSeconds: Number(total.toFixed(3)),
					segments
				},
				null,
				2
			) + '\n'
		);
		for (const [name, frames] of Object.entries({ note, deck })) {
			const stats = gapStats(frames);
			console.log(
				`[hero] ${name}: ${frames.length} frames, ${segments[name].durationSeconds}s, ` +
					`gap p50 ${stats.p50}ms p95 ${stats.p95}ms`
			);
		}
		console.log(`[hero] ${THEME} total ${total.toFixed(2)}s, frames in ${FRAMES}`);
		return { theme: THEME, total: Number(total.toFixed(2)) };
	} catch (error) {
		await page
			?.screenshot({ path: join(session.evidenceDir, 'failure-stage.png'), timeout: 3000 })
			.catch(() => {});
		throw error;
	} finally {
		await browser.close();
	}
}).catch((error) => {
	console.error(error);
	process.exitCode ||= 1;
});
