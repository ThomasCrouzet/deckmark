#!/usr/bin/env node
/** Capture the README story from the existing production build. */
import { expect } from '@playwright/test';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	ROOT,
	VIEWPORT,
	ensureMode,
	launchDeck,
	fileEvidence,
	newCapturePage,
	openPalette,
	probeMedia,
	readDrafts,
	runTool,
	saveScreenshot,
	waitForSaved,
	withCapture
} from './capture-helpers.mjs';

const GIF_WIDTH = 960;
const MAX_BYTES = 8_000_000;
const NAME = 'Launch log';
const INTRO = 'One small idea. Ready for orbit.';
const NOTE = `# ${NAME}\n\n${INTRO}`;
const COMPLETE_NOTE = `${NOTE}

## Orbit / launch day

Turn the plan into something we can share.

- [x] Connect the [[Flight plan]]
- [x] Review the [[Release checklist]]
- [ ] Present the launch briefing

> Keep the work close. Take the story further.
`;
const CONFIG = {
	mission: 'Orbit',
	stage: 'ready',
	launch: { date: '2026-09-24', channel: 'preview' },
	deliverables: ['field notes', 'project archive', 'launch briefing'],
	offline: true
};

async function prepareProject(session, page) {
	const { default: JSZip } = await import('jszip');
	const files = {
		'Flight plan.md': `# Flight plan

**ORBIT / LAUNCH 01**

A small launch. A clear path from idea to delivery.

\`\`\`mermaid
flowchart LR
  A[Connect the notes] --> B[Check the project]
  B --> C[Present the story]
\`\`\`

## Ready for the next step

Review the [[Release checklist]], then open the launch briefing from the project files.
`,
		'Release checklist.md': `# Release checklist

## Before we launch

- [x] Connect the project notes
- [x] Check all local links
- [x] Export a project archive
- [x] Prepare the three-slide briefing

## The handoff

The [[Flight plan]] sets the direction. The launch briefing tells the story.
`,
		'Launch briefing.md': launchDeck()
	};
	const zip = new JSZip();
	for (const [name, content] of Object.entries(files)) {
		zip.file(name, content, { date: new Date('2026-09-24T10:00:00Z') });
	}
	const fixture = join(session.evidenceDir, 'Orbit.zip');
	await writeFile(fixture, await zip.generateAsync({ type: 'nodebuffer' }));
	await writeFile(join(session.evidenceDir, 'launch.json'), JSON.stringify(CONFIG));
	await writeFile(join(session.evidenceDir, 'Launch log.md'), COMPLETE_NOTE);
	session.metadata.fixtures = {
		project: await fileEvidence(fixture),
		json: await fileEvidence(join(session.evidenceDir, 'launch.json')),
		note: await fileEvidence(join(session.evidenceDir, 'Launch log.md'))
	};
	await page.getByTestId('projects-open').click();
	const panel = page.getByRole('dialog', { name: 'Markdown projects', exact: true });
	await panel.locator('input[type=file][accept=".zip"]').setInputFiles(fixture);
	await expect(
		panel.getByRole('button', { name: 'Open Flight plan.md', exact: true })
	).toBeVisible();
	await panel.getByRole('button', { name: 'Close projects', exact: true }).click();
	await expect.poll(async () => (await readDrafts(page)).length).toBe(3);
	return files;
}

async function record(session) {
	const page = await newCapturePage(session, 'light');
	const files = await prepareProject(session, page);
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
	async function type(text, target) {
		let typed = '';
		for (const chunk of text.match(/.{1,5}/g) ?? []) {
			await page.keyboard.type(chunk);
			typed += chunk;
			await expect(target).toHaveText(typed);
			await frame('Write a short launch note', 0.12);
		}
	}
	async function projects() {
		await page.getByTestId('projects-open').click();
		return page.getByRole('dialog', { name: 'Markdown projects', exact: true });
	}
	async function download(button, name) {
		const pending = page.waitForEvent('download');
		await button.click();
		const result = await pending;
		const path = join(session.evidenceDir, name);
		await result.saveAs(path);
		expect(await result.failure()).toBeNull();
		return { filename: result.suggestedFilename(), path, ...(await fileEvidence(path)) };
	}

	await expect(page.getByTestId('welcome-new')).toBeVisible();
	await frame('A local workspace for a new launch', 1.4);
	await page.getByTestId('welcome-new').click();
	await expect(page.getByTestId('create-note')).toBeFocused();
	await expect(page.getByTestId('create-presentation')).toBeVisible();
	await frame('Choose a note or a presentation', 1.2);
	await page.getByTestId('create-note').click();
	const filename = page.locator('#app-toolbar input[aria-label^="File name"]');
	await filename.fill(NAME);
	await filename.press('Enter');
	await ensureMode(page, 'wysiwyg');
	const editor = page.locator('.milkdown .ProseMirror');
	await editor.click();
	await page.keyboard.type('/h1');
	await expect(page.locator('.milkdown-slash-menu')).toBeVisible();
	await frame('Insert a heading with the slash menu', 0.6);
	await page.keyboard.press('Enter');
	await type(NAME, editor.locator('h1'));
	await page.keyboard.press('Enter');
	await type(INTRO, editor.locator('p'));
	await waitForSaved(page, NAME, NOTE);
	await frame('A saved note in Edit mode', 1.2);
	await ensureMode(page, 'source');
	await frame('Switch to Markdown source', 0.9);
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText(COMPLETE_NOTE);
	await waitForSaved(page, NAME, COMPLETE_NOTE);
	await frame('Add linked notes and launch tasks', 2);
	await ensureMode(page, 'read');
	const preview = page.locator('.mdsh-preview');
	await expect(preview.locator('a.wiki-link')).toHaveCount(2);
	await expect(preview.locator('input[type=checkbox]')).toHaveCount(3);
	await frame('Read the launch note', 2.3);
	await preview.getByRole('link', { name: 'Flight plan', exact: true }).click();
	await expect(preview.locator('h1')).toHaveText('Flight plan');
	await expect(preview.locator('.mermaid-block svg')).toBeVisible({ timeout: 20_000 });
	await expect(preview.locator('.mermaid-block')).toContainText(/Present the\s*story/);
	await frame('Follow the plan into a rendered Mermaid diagram', 2.5);
	const palette = await openPalette(page);
	await palette.getByRole('combobox').fill('graph');
	await expect(palette.getByRole('option', { name: 'Links graph', exact: true })).toBeVisible();
	await frame('Find the link graph', 0.7);
	await palette.getByRole('option', { name: 'Links graph', exact: true }).click();
	const graph = page.getByRole('dialog', { name: 'Link graph', exact: true });
	await expect(graph.locator('.graph-node')).toHaveCount(3);
	await expect(graph.locator('svg line').first()).toBeVisible();
	await frame('See how the launch documents connect', 2.3);
	await graph.getByRole('button', { name: 'Close', exact: true }).click();

	let panel = await projects();
	await panel.getByRole('button', { name: 'Check links', exact: true }).click();
	await expect(panel.locator('[data-project-link-report]')).toHaveText('All local links resolve.');
	await frame('Review the Orbit project and its local links', 2);
	const archive = await download(
		panel.getByRole('button', { name: 'Export project', exact: true }),
		'Orbit-export.zip'
	);
	const exported = await (await import('jszip')).default.loadAsync(await readFile(archive.path));
	for (const [name, content] of Object.entries(files)) {
		expect(await exported.file(name).async('string')).toBe(content);
	}
	expect(JSON.parse(await exported.file('.mdsh/link-report.json').async('string')).issues).toEqual(
		[]
	);
	session.metadata.projectExport = archive;
	await panel.getByRole('button', { name: 'Check documentation', exact: true }).click();
	const check = page.getByRole('dialog', { name: 'Documentation check', exact: true });
	await check.getByRole('button', { name: 'Run check', exact: true }).click();
	await expect(check).toContainText('No documentation issues found.');
	await expect(check).toContainText('3 document(s), 0 error(s), 0 warning(s)');
	await frame('Check the documentation before the handoff', 2.7);
	const report = await download(
		check.getByRole('button', { name: 'Export JSON', exact: true }),
		'Orbit-docs-check.json'
	);
	expect(JSON.parse(await readFile(report.path, 'utf8')).issues).toEqual([]);
	session.metadata.documentationExport = report;
	await check.getByRole('button', { name: 'Close documentation check', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Close notification', exact: true })).toHaveCount(
		0,
		{ timeout: 15_000 }
	);

	await page
		.locator('input[type=file][accept*="text/markdown"]')
		.setInputFiles(join(session.evidenceDir, 'launch.json'));
	const importReport = page.getByRole('button', { name: 'Close import report', exact: true });
	await expect(page.getByTestId('code-language')).toHaveText('JSON');
	await expect(page.getByTestId('json-status')).toContainText('Valid JSON');
	await expect(importReport).toBeVisible();
	await importReport.click();
	await expect(importReport).not.toBeVisible();
	await frame('Open the launch configuration as code', 1.3);
	await page.getByTestId('json-format').click();
	await expect
		.poll(async () => (await readDrafts(page)).find((row) => row.name === 'launch.json')?.content)
		.toBe(JSON.stringify(CONFIG, null, 2));
	await expect(page.locator('.cm-line')).toHaveCount(14);
	await frame('Format and validate the JSON configuration', 2.4);

	panel = await projects();
	await panel.getByRole('button', { name: 'Open Launch briefing.md', exact: true }).click();
	const slides = page.getByTestId('presentation-editor');
	await expect(slides.getByTestId('slide-thumbnail')).toHaveCount(3);
	await expect(slides.getByTestId('slide-canvas')).toContainText('ORBIT');
	if (await slides.getByTestId('slide-inspector').isVisible()) {
		await slides.getByTestId('slide-properties').click();
	}
	if (await slides.getByTestId('slide-notes').isVisible()) {
		await slides.getByTestId('slide-notes-toggle').click();
	}
	await expect(slides.getByTestId('slide-overflow')).toHaveCount(0);
	await frame('Open the three-slide launch briefing', 2.7);
	await slides.getByTestId('slide-notes-toggle').click();
	await slides
		.getByTestId('slide-notes')
		.fill('Connect the notes. Check the project. Tell the story.');
	await slides.getByTestId('slide-notes').press('Tab');
	await expect(slides.locator('.save-state')).toHaveText('saved');
	await frame('Add the speaker notes', 1.5);
	await slides.getByTestId('slide-notes-toggle').click();
	await slides.getByTestId('slide-thumbnail').nth(1).click();
	await expect(slides.getByTestId('slide-canvas')).toContainText('A clear path');
	await expect(slides.getByTestId('slide-overflow')).toHaveCount(0);
	await frame('Review the plan in the slide editor', 1.8);
	await slides.getByTestId('slide-thumbnail').nth(2).click();
	await expect(slides.getByTestId('slide-canvas')).toContainText('Ready for');
	await expect(slides.getByTestId('slide-overflow')).toHaveCount(0);
	await slides.getByTestId('slide-thumbnail').first().click();
	await slides.getByTestId('slide-present').click();
	for (const [index, id, label] of [
		[0, 'orbit-cover', 'Present the launch'],
		[1, 'orbit-plan', 'Present the connected workflow'],
		[2, 'orbit-ready', 'Ready for what is next']
	]) {
		if (index) await page.keyboard.press('ArrowRight');
		await expect(slides.locator('.present-count')).toHaveText(`${index + 1} / 3`);
		await expect(
			slides.getByTestId('slide-canvas').locator(`[data-slide-id="${id}"]`)
		).toBeVisible();
		await expect(slides.getByTestId('slide-overflow')).toHaveCount(0);
		const textBoxes = slides
			.getByTestId('slide-canvas')
			.locator('.mdsh-slide-element-rich .mdsh-slide-element-content');
		await expect
			.poll(() =>
				textBoxes.evaluateAll((boxes) =>
					boxes
						.filter(
							(box) =>
								box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1
						)
						.map((box) => box.textContent)
				)
			)
			.toEqual([]);
		await frame(label, index === 2 ? 4.5 : 3.5);
	}
	await page.keyboard.press('Escape');
	await page
		.locator('.mdsh-file-row')
		.getByRole('button', { name: /^Launch log - / })
		.click();
	await ensureMode(page, 'source');
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	const finishedNote = COMPLETE_NOTE.replace('[ ]', '[x]');
	await page.keyboard.insertText(finishedNote);
	await waitForSaved(page, NAME, finishedNote);
	await frame('Mark the briefing complete', 0.6);
	await ensureMode(page, 'read');
	await expect(preview.locator('h1')).toHaveText(NAME);
	await expect(preview.locator('input[type=checkbox]:checked')).toHaveCount(3);
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await frame('Back to the notes, with the whole launch on this device', 2.3);
	return { frames, documents: await readDrafts(page) };
}

async function encode(session, frames) {
	const duration = frames.reduce((total, frame) => total + frame.seconds, 0);
	expect(duration).toBeGreaterThanOrEqual(40);
	expect(duration).toBeLessThanOrEqual(55);
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
	expect(evidence.bytes, 'The README GIF must be below 8 MB.').toBeLessThan(MAX_BYTES);
	expect(session.metadata.pageErrors).toEqual([]);
	expect(session.metadata.httpErrors).toEqual([]);
	const storyboard = [];
	let start = 0;
	for (const frame of frames) {
		storyboard.push({ start: Number(start.toFixed(2)), ...frame });
		start += frame.seconds;
	}
	await writeFile(
		join(session.evidenceDir, 'storyboard.json'),
		JSON.stringify(storyboard, null, 2) + '\n'
	);
	const holds = frames
		.map((frame, index) => ({ ...frame, index }))
		.filter((frame) => frame.seconds >= 0.6);
	const contactCommand = [
		...common,
		'-framerate',
		'1',
		'-i',
		join(session.evidenceDir, 'frames/%03d.png'),
		'-vf',
		`select='${holds.map((frame) => `eq(n,${frame.index})`).join('+')}',scale=384:240,tile=4x${Math.ceil(holds.length / 4)}:padding=8:margin=8:color=white`,
		'-frames:v',
		'1',
		join(session.evidenceDir, 'contact-sheet.png')
	];
	runTool('ffmpeg', contactCommand);
	await writeFile(
		join(session.evidenceDir, 'contact-sheet-command.json'),
		JSON.stringify(contactCommand, null, 2) + '\n'
	);
	await copyFile(gifPath, join(ROOT, 'docs/demo.gif'));
	console.log(
		`[capture] docs/demo.gif: ${Number(media.format.duration)} s, ${evidence.bytes} bytes`
	);
	return { path: 'docs/demo.gif', duration, ...evidence, media };
}

withCapture('demo', 4204, async (session) => {
	session.metadata.command = `TMPDIR=${process.env.TMPDIR} CAPTURE_PORT=${process.env.CAPTURE_PORT ?? 4204} node scripts/capture-demo-gif.mjs`;
	session.metadata.script = await fileEvidence(join(ROOT, 'scripts/capture-demo-gif.mjs'));
	session.metadata.helper = await fileEvidence(join(ROOT, 'scripts/capture-helpers.mjs'));
	await copyFile(
		join(ROOT, 'scripts/capture-demo-gif.mjs'),
		join(session.evidenceDir, 'capture-demo-gif.mjs')
	);
	const result = await record(session);
	const output = await encode(session, result.frames);
	return { ...result, output };
}).catch((error) => {
	console.error(error);
	process.exitCode ||= 1;
});
