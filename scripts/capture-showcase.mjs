#!/usr/bin/env node
/**
 * Capture the README showcase stills in dark and light themes.
 *
 * Run against the production build:
 *   CAPTURE_PORT=4912 node scripts/capture-showcase.mjs
 *
 * Every still is a raw 2304x1440 PNG: the real interface at a 1152x720 CSS
 * viewport with a device pixel ratio of 2, so the type stays large inside the
 * composed window. A browser launched with `--force-device-scale-factor=2`
 * carries the scale; the viewport is asserted to report ratio 2 before a shot.
 *
 * Framing is ffmpeg only, and reuses the hero composition: the app frame is
 * scaled to 1088x680, rounded at 14 px through an alpha mask, given a soft
 * shadow, and centred on a 1280x760 canvas with the graphite or warm paper
 * gradient. The composition renders at 2x (2560x1520 canvas, 2176x1360 window,
 * 28 px radius, shadow sigma 36). cwebp writes a WebP at 1600 px wide.
 *
 * Outputs land in $SHOWCASE_OUT, raw frames in $SHOWCASE_WORK.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import {
	ROOT,
	ensureMode,
	launchDeck,
	newCapturePage,
	openPalette,
	runTool,
	saveScreenshot,
	waitForSaved,
	withCapture
} from './capture-helpers.mjs';

const run = promisify(execFile);

const OUT_DIR = process.env.SHOWCASE_OUT ?? join(ROOT, 'test-results', 'capture-showcase');
const WORK_DIR =
	process.env.SHOWCASE_WORK ?? join(ROOT, 'test-results', 'capture-showcase', 'work');
/** CSS viewport of the app beats. 1.6 aspect matches the 1088x680 compose box. */
const VIEWPORT = { width: 1152, height: 720 };
const MAX_BYTES = 400 * 1024;
const WEBP_WIDTH = 1600;
const WEBP_QUALITY = 90;
/** The write shot may scroll a little so the diagram clears the status bar. */
const WRITE_SCROLL = 40;

/* ------------------------------------------------------------------ framing */

/** Hero geometry at 1x, scaled by RENDER_SCALE for the still. */
const CANVAS = { width: 1280, height: 760 };
const APP = { width: 1088, height: 680, radius: 14 };
const PAD = { x: 56, top: 30, bottom: 50 };
const SHADOW_SIGMA = 18;
const RENDER_SCALE = 2;

const CANVAS_2X = { width: CANVAS.width * RENDER_SCALE, height: CANVAS.height * RENDER_SCALE };
const APP_2X = {
	width: APP.width * RENDER_SCALE,
	height: APP.height * RENDER_SCALE,
	radius: APP.radius * RENDER_SCALE
};
const PAD_2X = {
	x: PAD.x * RENDER_SCALE,
	top: PAD.top * RENDER_SCALE,
	bottom: PAD.bottom * RENDER_SCALE
};

const FRAME_THEME = {
	dark: { base: '0x121417', shadowAlpha: 0.6 },
	light: { base: '0xf1ece1', shadowAlpha: 0.35 }
};

async function ffmpeg(args, label) {
	try {
		await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
			maxBuffer: 64 * 1024 * 1024
		});
	} catch (error) {
		throw new Error(`${label} failed:\n${error.stderr || error.message}`, { cause: error });
	}
}

/**
 * Rounded rectangle as a greyscale mask. A 4x supersample keeps the arc smooth;
 * the alpha merge later multiplies the app frame by this value.
 */
function roundedMaskExpression(width, height, radius, supersample = 4) {
	const w = width * supersample;
	const h = height * supersample;
	const r = radius * supersample;
	const terms = [
		`(${r})*(gte(X,${r})*lte(X,${w - 1 - r}))`,
		`(${r})*(gte(Y,${r})*lte(Y,${h - 1 - r}))`
	];
	for (const [cx, cy] of [
		[r, r],
		[w - 1 - r, r],
		[r, h - 1 - r],
		[w - 1 - r, h - 1 - r]
	]) {
		terms.push(`(${r})*(lte(hypot(X-${cx},Y-${cy}),${r}))`);
	}
	return terms.map((term) => `if(gt(${term},0),255,0)`).join('+');
}

async function buildMask(path, width, height, radius) {
	const s = 4;
	const lum = roundedMaskExpression(width, height, radius, s);
	await ffmpeg(
		[
			'-f',
			'lavfi',
			'-i',
			`color=c=black:s=${width * s}x${height * s}:d=1`,
			'-vf',
			`format=gray,geq=lum='${lum}',scale=${width}:${height}:flags=lanczos`,
			'-frames:v',
			'1',
			path
		],
		'mask'
	);
}

/**
 * Hero canvas gradient. Dark keeps the graphite ramp with the amber spill;
 * light uses a warm paper ramp with a narrower spill, as reviewed.
 */
function canvasExpression(theme, canvas) {
	const t = `(Y/${canvas.height - 1})`;
	const gx = `pow((X-${canvas.width / 2})/${(canvas.width * 0.62).toFixed(1)},2)`;
	const gy = `pow((Y-${(canvas.height * 0.56).toFixed(1)})/${(canvas.height * 0.75).toFixed(1)},2)`;
	const glow = `exp(-((${gx}+${gy})*1.5))`;
	if (theme === 'light') {
		return (
			`geq=r='236+6*${t}+10*${glow}'` + `:g='231+6*${t}+6*${glow}'` + `:b='222+6*${t}+2*${glow}'`
		);
	}
	return (
		`geq=r='26+14*${t}+40*${glow}'` + `:g='29+15*${t}+28*${glow}'` + `:b='34+18*${t}+14*${glow}'`
	);
}

/**
 * Round the app frame, cast its shadow, compose it on the canvas. The window is
 * centred on both axes, and the pad offset is positive so nothing leaves frame.
 */
function framedTail(theme, canvas, app, pad, input, out) {
	const pw = app.width + 2 * pad.x;
	const ph = app.height + pad.top + pad.bottom;
	const padFilter = `pad=${pw}:${ph}:${pad.x}:${pad.top}:color=black@0`;
	const padMask = `pad=${pw}:${ph}:${pad.x}:${pad.top}:color=black`;
	const x = Math.round((canvas.width - app.width) / 2) - pad.x;
	const y = Math.round((canvas.height - app.height) / 2) - pad.top;
	const sigma = SHADOW_SIGMA * RENDER_SCALE;
	const dropY = 7 * RENDER_SCALE;
	const alpha = FRAME_THEME[theme].shadowAlpha;
	return [
		`[${input}]scale=${app.width}:${app.height}:flags=lanczos,${padFilter},format=rgba[app]`,
		`[1:v]format=gray,${padMask}[mask]`,
		`[app][mask]alphamerge,split[rounded][silhouette]`,
		// Keep the rounded alpha: black colour, alpha scaled down, then blurred.
		`[silhouette]colorchannelmixer=rr=0:gg=0:bb=0:aa=${alpha},gblur=sigma=${sigma}:steps=3[shadow]`,
		`color=c=${FRAME_THEME[theme].base}:s=${canvas.width}x${canvas.height}:d=1,${canvasExpression(theme, canvas)},format=rgba[base]`,
		`[base][shadow]overlay=x=${x}:y=${y + dropY}:format=auto[withshadow]`,
		`[withshadow][rounded]overlay=x=${x}:y=${y}:format=auto,format=rgba[${out}]`
	].join(';');
}

async function frameStill(rawPath, framedPath, theme, maskPath) {
	await ffmpeg(
		[
			'-i',
			rawPath,
			'-loop',
			'1',
			'-i',
			maskPath,
			'-filter_complex',
			framedTail(theme, CANVAS_2X, APP_2X, PAD_2X, '0:v', 'v'),
			'-map',
			'[v]',
			'-frames:v',
			'1',
			framedPath
		],
		`frame ${theme}`
	);
}

/** cwebp at quality 90, resized to 1600 px wide, then probed. */
function encodeWebp(framedPath, webpPath) {
	runTool('cwebp', [
		'-quiet',
		'-q',
		String(WEBP_QUALITY),
		'-m',
		'6',
		'-metadata',
		'none',
		'-resize',
		String(WEBP_WIDTH),
		'0',
		framedPath,
		'-o',
		webpPath
	]);
	return JSON.parse(
		runTool('ffprobe', [
			'-v',
			'error',
			'-select_streams',
			'v:0',
			'-show_entries',
			'stream=width,height:format=size',
			'-of',
			'json',
			webpPath
		])
	);
}

/* ----------------------------------------------------------------- fixtures */

const PROJECT = 'Orbit launch';

/** The link target. It exists, so the link in the write note resolves. */
const PLAN_DOC = `# Flight plan

## Sequence

Launch window opens at 14:20 UTC. Stage two separates eight minutes later.

## Checks

- [x] Freeze the copy
- [x] Confirm the downrange forecast
- [ ] Book the range slot
`;

const WRITE_DOC = `# Orbit launch brief

The [Flight plan](Flight%20plan.md) sets the order for launch week.

| Phase | Owner | Window |
| --- | --- | --- |
| Freeze | Priya | Mon 09:00 |
| Preview | Jonas | Tue 14:00 |
| Launch | Mira | Thu 08:00 |

- [x] Review the release checklist
- [ ] Send the launch note

\`\`\`mermaid
flowchart TD
  A[Field notes] --> D[Launch deck]
  B[Flight plan] --> D
  C[Release checks] --> D
\`\`\`
`;

const SPLIT_DOC = `# Launch window model

The ascent budget sets the window. Stage two needs 3.1 km/s to reach the parking orbit, and the margin narrows after each hold.

$$ v = \\sqrt{GM/r} $$

\`\`\`mermaid
flowchart TD
  A[Telemetry] --> D[Window]
  B[Ascent model] --> D
  C[Weather check] --> D
\`\`\`
`;

const CHECK_DOC = `# Release checklist

## Before launch

- [x] Archive the source
- [x] Check every local link
- [ ] Brief the team
`;

const SIGNAL_DOC = `# Orbit telemetry

## Signal drift

The rolling error stays under the 2 percent budget for the whole window.
`;

/* --------------------------------------------------------------- page helpers */

async function dismissBackupReminder(page) {
	const dismiss = page.getByRole('button', { name: 'Remind me about backups next week' });
	if (await dismiss.count()) await dismiss.click();
	await expect(page.getByRole('button', { name: 'Back up your documents' })).toHaveCount(0);
}

async function submitPrompt(page, value, confirmLabel) {
	const prompt = page.getByRole('dialog').filter({ has: page.getByRole('textbox') });
	await expect(prompt).toHaveCount(1);
	await prompt.getByRole('textbox').fill(value);
	await prompt.getByRole('button', { name: confirmLabel, exact: true }).click();
	await expect(prompt).toHaveCount(0);
}

/** Creates the project and its documents through the projects dialog. */
async function seedProject(page, session) {
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Markdown projects', exact: true });
	await panel.getByRole('button', { name: 'New project', exact: true }).click();
	await submitPrompt(page, PROJECT, 'New project');

	// The deck arrives through the project panel before capture starts.
	const { default: JSZip } = await import('jszip');
	const zip = new JSZip();
	zip.file('Launch briefing.md', launchDeck());
	const fixture = join(session.evidenceDir, 'orbit.zip');
	await writeFile(fixture, await zip.generateAsync({ type: 'nodebuffer' }));
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles(fixture);
	// The importer can drop a second upload while the first one is still
	// unpacking; retry once before failing the take.
	const deckButton = panel.getByRole('button', { name: 'Open Launch briefing.md', exact: true });
	for (let attempt = 1; ; attempt += 1) {
		try {
			await expect(deckButton).toBeVisible({ timeout: 20_000 });
			break;
		} catch (error) {
			if (attempt >= 2) {
				console.error('[showcase] deck import failed:', await panel.innerText());
				throw error;
			}
			await panel.locator('input[type=file][accept=".zip"]').setInputFiles(fixture);
		}
	}
	await panel.getByRole('button', { name: 'Close projects', exact: true }).click();
	await expect(panel).toHaveCount(0);

	// The sidebar explorer creates each document without closing the workflow.
	const root = page.locator('[data-sidebar-projects] summary').first();
	await expect(root).toBeVisible({ timeout: 20_000 });
	if ((await root.getAttribute('aria-expanded')) !== 'true') await root.click();
	for (const name of ['Flight plan', 'Orbit brief', 'Window model', 'Release checks', 'Signals']) {
		await page
			.locator('[data-sidebar-projects] [data-project-action="new-document"]')
			.first()
			.click();
		await submitPrompt(page, name, 'New project document');
		await expect(
			page.locator('[data-sidebar-projects] button[data-file-id]').filter({ hasText: name })
		).toHaveCount(1);
	}
}

async function openProjectDoc(page, name) {
	await page
		.locator('[data-sidebar-projects] button[data-file-id]')
		.filter({ hasText: name })
		.first()
		.click();
}

async function fillProjectDocuments(page) {
	const docs = [
		{ name: 'Flight plan', content: PLAN_DOC },
		{ name: 'Orbit brief', content: WRITE_DOC },
		{ name: 'Window model', content: SPLIT_DOC },
		{ name: 'Release checks', content: CHECK_DOC },
		{ name: 'Signals', content: SIGNAL_DOC }
	];
	for (const doc of docs) {
		await openProjectDoc(page, doc.name);
		await ensureMode(page, 'source');
		await page.locator('.cm-content').click();
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.insertText(doc.content);
		await waitForSaved(page, doc.name, doc.content);
	}
}

/** Reloads so autosaved drafts lose their pending markers. */
async function settleDrafts(page) {
	await page.evaluate(() => document.activeElement?.blur());
	await page.waitForTimeout(1200);
	await page.reload();
	await expect(page.locator('.mdsh-shell[aria-busy="false"]:not([inert])')).toBeVisible();
	await expect(page.locator('.mdsh-local-indicator')).toHaveText('Ready offline', {
		timeout: 60_000
	});
	await expect
		.poll(() =>
			page.evaluate(() =>
				Array.from(document.querySelectorAll('.file-status')).every(
					(status) => status.getAttribute('data-sync') === 'saved'
				)
			)
		)
		.toBe(true);
}

/** The outline column is a preference toggle; the palette item closes it. */
async function hideOutline(page) {
	if ((await page.locator('.mdsh-toc-col').count()) === 0) return;
	const palette = await openPalette(page);
	await palette.getByRole('combobox').fill('table of contents');
	await expect(palette.getByRole('option').first()).toBeVisible();
	await palette
		.getByRole('option', { name: /table of contents/i })
		.first()
		.click();
	await expect(page.locator('.mdsh-toc-col')).toHaveCount(0);
}

async function createDeck(page) {
	await page
		.locator('aside')
		.getByRole('button', { name: /^New file, shortcut / })
		.click();
	await page.getByTestId('create-presentation').click();
	const nameInput = page.locator('#app-toolbar input[aria-label^="File name"]');
	await expect(nameInput).toBeEnabled();
	await nameInput.fill('Launch briefing');
	await nameInput.press('Enter');
	await expect(page.getByTestId('presentation-editor')).toBeVisible();
	await page.getByTestId('slide-advanced').click();
	await page
		.getByRole('button', { name: /^(Markdown )?source$/i })
		.first()
		.click();
	const source = page.getByTestId('slide-source-editor');
	await expect(source).toBeVisible();
	await source.fill(launchDeck());
	await page.getByTestId('slide-source-apply').click();
	await expect(page.locator('details:has([data-testid="slide-advanced"])[open]')).toHaveCount(0);
	await expect(page.getByTestId('slide-thumbnail')).toHaveCount(3);
	await expect(page.getByTestId('slide-canvas')).toContainText('ORBIT');
	await expect(page.getByRole('status').filter({ hasText: 'Source applied' })).toHaveCount(0, {
		timeout: 15_000
	});
}

/* ------------------------------------------------------------------ recording */

async function captureTheme(session, theme) {
	await mkdir(WORK_DIR, { recursive: true });
	const shots = [];
	// A second browser carries the device scale flag. Playwright's
	// deviceScaleFactor alone does not scale the headless capture surface.
	const browser = await chromium.launch({
		args: ['--force-device-scale-factor=2', '--high-dpi-support=1']
	});
	try {
		const page = await newCapturePage(
			{ browser, baseURL: session.baseURL, metadata: session.metadata },
			theme,
			{ interfaceFonts: true }
		);
		await page.setViewportSize(VIEWPORT);
		expect(await page.evaluate(() => devicePixelRatio), 'The capture surface must be 2x.').toBe(2);

		await seedProject(page, session);
		await fillProjectDocuments(page);
		await settleDrafts(page);
		await dismissBackupReminder(page);

		async function shot(name) {
			const raw = join(WORK_DIR, `${name}-${theme}.png`);
			await saveScreenshot(page, raw);
			shots.push({ name, theme, raw });
			console.log(`[showcase] raw ${name}-${theme}.png`);
		}

		// 1. A rich note in the WYSIWYG editor. The page scrolls a little so the
		//    diagram clears the status bar with a real margin.
		await openProjectDoc(page, 'Orbit brief');
		await ensureMode(page, 'wysiwyg');
		const editor = page.locator('.milkdown .ProseMirror');
		await expect(editor.locator('h1')).toContainText('Orbit launch brief');
		await expect(editor.locator('.mdsh-mermaid-svg svg')).toBeVisible({ timeout: 25_000 });
		await expect(editor.locator('.milkdown-table-block')).toHaveCount(1);
		await expect(editor.locator('.milkdown-list-item-block')).toHaveCount(2);
		await hideOutline(page);
		// The caret lands in the code block after a reload and opens its source
		// pane. Preview only keeps the note inside one screen, the way a reader
		// sees it, and it leaves the diagram as the largest block on the page.
		const collapse = page.locator('.ProseMirror .milkdown-code-block').first();
		await expect(collapse).toHaveCount(1);
		const toggle = collapse.locator('.preview-toggle-button');
		await expect(toggle).toHaveCount(1);
		if ((await toggle.innerText()).trim() === 'Hide') {
			await toggle.click();
			await expect(toggle).toHaveText('Edit');
			await page.waitForTimeout(400);
		}
		// Put the caret at the top of the note so no block shows an insert bar.
		await editor.locator('h1').click();
		await page.waitForTimeout(700);

		const link = await page.evaluate(() => {
			const anchor = document.querySelector('.ProseMirror a');
			if (!anchor) return null;
			const style = getComputedStyle(anchor);
			return {
				text: anchor.textContent,
				color: style.color,
				decoration: style.textDecorationLine
			};
		});
		console.log(`[showcase] ${theme} link`, JSON.stringify(link));
		expect(link?.text).toBe('Flight plan');
		expect(link?.color, 'The link must use the accent colour.').not.toBe('rgb(238, 232, 221)');
		expect(link?.decoration, 'The link must read as a link.').toContain('underline');

		const fit = await page.evaluate((scroll) => {
			const scroller = document.querySelector('.mdsh-editor');
			if (scroller) scroller.scrollTop = scroll;
			const statusTop = document.querySelector('#app-statusbar')?.getBoundingClientRect().top ?? 0;
			const root = document.querySelector('.ProseMirror');
			const kids = root ? Array.from(root.children) : [];
			const svg = root?.querySelector('.mdsh-mermaid-svg svg');
			const heading = kids.find((el) => /^H[12]$/.test(el.tagName));
			return {
				scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
				scrollMax: scroller ? Math.round(scroller.scrollHeight - scroller.clientHeight) : null,
				headingTop: heading ? Math.round(heading.getBoundingClientRect().top) : -1,
				lastBottom: kids.length ? Math.round(kids.at(-1).getBoundingClientRect().bottom) : -1,
				svgBox: svg
					? {
							w: Math.round(svg.getBoundingClientRect().width),
							h: Math.round(svg.getBoundingClientRect().height),
							bottom: Math.round(svg.getBoundingClientRect().bottom)
						}
					: null,
				statusTop: Math.round(statusTop),
				margin: svg ? Math.round(statusTop - svg.getBoundingClientRect().bottom) : -1
			};
		}, WRITE_SCROLL);
		console.log(`[showcase] ${theme} write fit`, JSON.stringify(fit));
		expect(fit.svgBox, 'The write note must render the flowchart.').not.toBeNull();
		expect(fit.margin, 'The diagram must clear the status bar.').toBeGreaterThan(10);
		expect(fit.headingTop, 'The heading must stay below the toolbar.').toBeGreaterThan(95);
		await page.waitForTimeout(300);
		await shot('write');

		// 2. Split view: source on the left, rendered math and diagram on the right.
		await openProjectDoc(page, 'Window model');
		await ensureMode(page, 'source');
		await page.getByTestId('split-view-toggle').click();
		const split = page.getByTestId('split-view');
		await expect(split).toBeVisible();
		await page.locator('.mdsh-split-separator').focus();
		for (let step = 0; step < 4; step += 1) await page.keyboard.press('ArrowLeft');
		await expect(split.locator('.mdsh-split-preview .katex')).toBeVisible({ timeout: 20_000 });
		await expect(split.locator('.mdsh-split-preview .mermaid-block svg')).toBeVisible({
			timeout: 25_000
		});
		await page.waitForTimeout(1400);
		const splitFit = await page.evaluate(() => {
			const preview = document.querySelector('.mdsh-split-preview');
			const svg = preview?.querySelector('.mermaid-block svg');
			const source = document.querySelector('.mdsh-split-source');
			const katex = preview?.querySelector('.katex-display');
			return {
				sourceW: source ? Math.round(source.getBoundingClientRect().width) : -1,
				previewW: preview ? Math.round(preview.getBoundingClientRect().width) : -1,
				svg: svg
					? {
							w: Math.round(svg.getBoundingClientRect().width),
							h: Math.round(svg.getBoundingClientRect().height)
						}
					: null,
				katex: katex
					? {
							w: Math.round(katex.getBoundingClientRect().width),
							h: Math.round(katex.getBoundingClientRect().height)
						}
					: null
			};
		});
		console.log(`[showcase] ${theme} split`, JSON.stringify(splitFit));
		expect(splitFit.svg, 'The split preview must render the diagram.').not.toBeNull();
		expect(splitFit.svg.w, 'The diagram must fill the preview pane.').toBeGreaterThan(380);
		expect(splitFit.katex, 'The split preview must render the formula.').not.toBeNull();
		await shot('split');
		await page.getByTestId('split-view-toggle').click();
		await expect(split).toHaveCount(0);

		// 3. The command palette over the note, filtered to eight export commands.
		await openProjectDoc(page, 'Orbit brief');
		await ensureMode(page, 'wysiwyg');
		await expect(editor.locator('.mdsh-mermaid-svg svg')).toBeVisible({ timeout: 25_000 });
		await page.evaluate((scroll) => {
			const scroller = document.querySelector('.mdsh-editor');
			if (scroller) scroller.scrollTop = scroll;
		}, WRITE_SCROLL);
		const palette = await openPalette(page);
		await palette.getByRole('combobox').fill('export');
		await expect(palette.getByRole('option')).toHaveCount(8);
		await expect(palette.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
		await page.waitForTimeout(450);
		await shot('palette');
		await page.keyboard.press('Escape');
		await expect(palette).toHaveCount(0);

		// 4. The slide editor with the launch deck, then Present mode.
		await createDeck(page);
		const slides = page.getByTestId('presentation-editor');
		await page.getByTestId('slide-thumbnail').nth(1).click();
		await expect(slides.getByTestId('slide-canvas')).toContainText('A clear path');
		await expect(slides.getByTestId('slide-overflow')).toHaveCount(0);
		await page.mouse.move(4, 4);
		await page.waitForTimeout(450);
		await shot('present');
		await page.getByTestId('slide-present').click();
		await expect(page.getByTestId('slide-present-exit')).toBeVisible();
		await expect(slides.locator('.present-count')).toHaveText('2 / 3');
		await page.waitForTimeout(800);
		await shot('present-mode');
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('slide-present-exit')).toHaveCount(0);

		await page.context().close();
		return shots;
	} finally {
		await browser.close();
	}
}

/* ------------------------------------------------------------------- overview */

/** All dark stills, two per row, each 760 px wide. */
async function buildOverview(paths, outPath) {
	const tile = { width: 760, height: 451 };
	const gap = 22;
	const margin = 24;
	const rows = Math.ceil(paths.length / 2);
	const width = margin * 2 + tile.width * 2 + gap;
	const height = margin * 2 + tile.height * rows + gap * (rows - 1);
	const inputs = paths.flatMap((path) => ['-i', path]);
	const scaled = paths.map(
		(_, index) => `[${index}:v]scale=${tile.width}:${tile.height}:flags=lanczos[s${index}]`
	);
	const overlays = paths.map((_, index) => {
		const column = index % 2;
		const row = Math.floor(index / 2);
		const x = margin + column * (tile.width + gap);
		const y = margin + row * (tile.height + gap);
		return `[step${index}][s${index}]overlay=x=${x}:y=${y}:format=auto[step${index + 1}]`;
	});
	const filter = [`color=c=0x101316:s=${width}x${height}:d=1[step0]`, ...scaled, ...overlays].join(
		';'
	);
	await ffmpeg(
		[
			...inputs,
			'-filter_complex',
			filter,
			'-map',
			`[step${paths.length}]`,
			'-frames:v',
			'1',
			outPath
		],
		'overview'
	);
	return { width, height };
}

withCapture('showcase', 4912, async (session) => {
	await mkdir(OUT_DIR, { recursive: true });
	await mkdir(WORK_DIR, { recursive: true });
	session.metadata.command = `CAPTURE_PORT=${process.env.CAPTURE_PORT ?? 4912} node scripts/capture-showcase.mjs`;
	session.metadata.cwebpVersion = runTool('cwebp', ['-version']);
	session.metadata.outputDir = OUT_DIR;

	const themes = (process.env.SHOWCASE_THEMES ?? 'dark,light').split(',').filter(Boolean);
	const raws = [];
	for (const theme of themes) raws.push(...(await captureTheme(session, theme)));
	expect(session.metadata.pageErrors).toEqual([]);
	expect(session.metadata.httpErrors).toEqual([]);

	const maskPath = join(WORK_DIR, 'mask-2x.png');
	await rm(maskPath, { force: true });
	await buildMask(maskPath, APP_2X.width, APP_2X.height, APP_2X.radius);

	const outputs = [];
	const darkFrames = [];
	for (const shot of raws) {
		const framed = join(WORK_DIR, `${shot.name}-${shot.theme}-framed.png`);
		await frameStill(shot.raw, framed, shot.theme, maskPath);
		const webp = join(OUT_DIR, `${shot.name}-${shot.theme}.webp`);
		const media = encodeWebp(framed, webp);
		const bytes = Number(media.format.size);
		expect(bytes, `${shot.name}-${shot.theme}.webp must stay under 400 KB.`).toBeLessThan(
			MAX_BYTES
		);
		expect(media.streams[0].width).toBe(WEBP_WIDTH);
		if (shot.theme === 'dark') darkFrames.push(framed);
		outputs.push({
			file: `${shot.name}-${shot.theme}.webp`,
			bytes,
			width: media.streams[0].width,
			height: media.streams[0].height
		});
		console.log(
			`[showcase] ${shot.name}-${shot.theme}.webp ${Math.round(bytes / 1024)} KB ${media.streams[0].width}x${media.streams[0].height}`
		);
	}

	const overview = join(OUT_DIR, 'overview.png');
	const box = await buildOverview(darkFrames, overview);
	outputs.push({ file: 'overview.png', ...box });

	await writeFile(join(WORK_DIR, 'showcase.json'), JSON.stringify(outputs, null, 2) + '\n');
	return { outputs };
}).catch((error) => {
	console.error(error);
	process.exitCode ||= 1;
});
