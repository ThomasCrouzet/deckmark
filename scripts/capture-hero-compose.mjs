#!/usr/bin/env node
/**
 * Style and encode the hero capture.
 *
 * Input is the frame set and timeline.json that `capture-hero.mjs` writes. Each
 * segment goes through a concat demuxer list, so every frame is held for its
 * measured interval and typing keeps its real rhythm.
 *
 * Look, all local ffmpeg:
 *   - the app frame scaled to 1088 px wide with 14 px rounded corners through an
 *     alpha mask, a soft drop shadow, centred on a 1280x760 canvas
 *   - cool graphite gradient (#1a1d22 to #2e333a) with a faint amber spill
 *   - eased zoom from 1.00 to 1.05 over the typing beats, held, then out before
 *     the split view. On the split beat a second eased zoom reaches 1.18,
 *     anchored on the preview pane, so the rendered diagram reads. The deck
 *     stays still, the end card is full bleed.
 *
 * Outputs, written to draft-hero/:
 *   hero.mp4   H.264, yuv420p, crf 20, 30 fps
 *   hero.webp  animated, quality 75, loop, 1200 px wide
 *   hero.gif   palettegen/paletteuse, width 880, 12 fps, under 8 MB
 *   contact.png 4x4 tile of evenly spaced frames
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from './capture-helpers.mjs';

const run = promisify(execFile);

const OUT = process.env.HERO_OUT ?? join(ROOT, 'test-results', 'capture-hero');
const WORK = join(OUT, 'work');
const PARTS = join(WORK, 'parts');
const FRAMES = join(WORK, 'frames');
const SEGMENTS = ['note', 'deck', 'end'];

const CANVAS = { width: 1280, height: 760 };
const APP = { width: 1088, height: 680, top: 30, radius: 14 };
/**
 * Room around the app frame for its blurred shadow. `top` matches the canvas
 * margin exactly, so the overlay offset stays at zero or positive: a negative
 * offset would push the window's title bar out of the canvas.
 */
const SHADOW_PAD = { x: 56, top: 30, bottom: 50 };
const FPS = 30;
const GIF_WIDTH = 880;
/**
 * 12 fps keeps the longer split beat (1.8 s hold plus the zoom) inside the 8 MB
 * GIF ceiling at full 880 px width. 15 fps measured 9.08 MB.
 */
const GIF_FPS = 12;
const WEBP_WIDTH = 1200;
const MAX_GIF_BYTES = 8_000_000;
/**
 * Zoom applies to the finished composition, not to a crop of the app frame, so
 * the window, its rounded corners, the shadow and the canvas margin all stay in
 * view. The typing ceiling keeps the 1088 px window inside the 1280 px canvas
 * with its shadow, and the crop is anchored at the centre so the title bar
 * never leaves frame.
 */
const ZOOM_MAX = 1.05;
const ZOOM_ANCHOR = { x: 0.5, y: 0.5 };
/** Eased zoom in, hold, then eased out. Seconds from the segment start. */
const ZOOM = { inEnd: 4.6, holdEnd: 8.4, outEnd: 9.6 };
/**
 * Second zoom on the split beat, anchored on the preview pane so the rendered
 * Mermaid diagram reads at the composed size. It rises in 0.6 s just after the
 * split opens, holds while the diagram is on screen, and falls in 0.6 s at the
 * cut. The crop is allowed to reach the title bar here.
 */
const SPLIT_ZOOM = {
	max: 1.18,
	anchor: { x: 0.68, y: 0.45 },
	rise: 0.6,
	fall: 0.6
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

async function ffprobe(path) {
	const { stdout } = await run('ffprobe', [
		'-v',
		'error',
		'-select_streams',
		'v:0',
		'-show_entries',
		'stream=codec_name,width,height,pix_fmt:format=duration,size',
		'-of',
		'json',
		path
	]);
	const data = JSON.parse(stdout);
	return {
		codec: data.streams[0]?.codec_name,
		width: data.streams[0]?.width,
		height: data.streams[0]?.height,
		pixFmt: data.streams[0]?.pix_fmt,
		duration: Number(data.format.duration),
		bytes: Number(data.format.size)
	};
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

async function buildMask(path) {
	const s = 4;
	const lum = roundedMaskExpression(APP.width, APP.height, APP.radius, s);
	await ffmpeg(
		[
			'-f',
			'lavfi',
			'-i',
			`color=c=black:s=${APP.width * s}x${APP.height * s}:d=1`,
			'-vf',
			`format=gray,geq=lum='${lum}',scale=${APP.width}:${APP.height}:flags=lanczos`,
			'-frames:v',
			'1',
			path
		],
		'mask'
	);
}

/** Vertical graphite ramp plus a wide amber spill behind the window. */
function canvasExpression() {
	const t = `(Y/${CANVAS.height - 1})`;
	const gx = `pow((X-${CANVAS.width / 2})/${(CANVAS.width * 0.62).toFixed(1)},2)`;
	const gy = `pow((Y-${(CANVAS.height * 0.56).toFixed(1)})/${(CANVAS.height * 0.75).toFixed(1)},2)`;
	const glow = `exp(-((${gx}+${gy})*1.5))`;
	return (
		`geq=r='26+14*${t}+40*${glow}'` + `:g='29+15*${t}+28*${glow}'` + `:b='34+18*${t}+14*${glow}'`
	);
}

/** Round the app frame, cast its shadow, compose it on the canvas. */
function framedTail(input, out) {
	const pw = APP.width + 2 * SHADOW_PAD.x;
	const ph = APP.height + SHADOW_PAD.top + SHADOW_PAD.bottom;
	const pad = `pad=${pw}:${ph}:${SHADOW_PAD.x}:${SHADOW_PAD.top}:color=black@0`;
	const padMask = `pad=${pw}:${ph}:${SHADOW_PAD.x}:${SHADOW_PAD.top}:color=black`;
	// Both overlays land at zero or above, so nothing leaves the canvas.
	const x = Math.round((CANVAS.width - APP.width) / 2) - SHADOW_PAD.x;
	const y = 0;
	return [
		`[${input}]scale=${APP.width}:${APP.height}:flags=lanczos,${pad},format=rgba[app]`,
		`[1:v]format=gray,${padMask}[mask]`,
		`[app][mask]alphamerge,split[rounded][silhouette]`,
		// Keep the rounded alpha: black colour, alpha scaled down, then blurred.
		`[silhouette]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.6,gblur=sigma=18:steps=3[shadow]`,
		`color=c=0x121417:s=${CANVAS.width}x${CANVAS.height}:d=1,${canvasExpression()},format=rgba[base]`,
		`[base][shadow]overlay=x=${x}:y=${y + 7}:format=auto[withshadow]`,
		`[withshadow][rounded]overlay=x=${x}:y=${y}:format=auto,format=yuv420p[${out}]`
	].join(';');
}

/**
 * Trapezoid easing over the output time in seconds: 0 before `start`, a raised
 * cosine up to 1 over `rise`, flat until `fallStart`, then a raised cosine back
 * to 0 at `end`. Everything is clamped, so a short segment cannot overshoot.
 */
function trapezoid(seconds, start, rise, fallStart, end) {
	const up = `(0.5-0.5*cos(PI*(${seconds}-${start.toFixed(2)})/${rise.toFixed(2)}))`;
	const down = `(0.5+0.5*cos(PI*(${seconds}-${fallStart.toFixed(2)})/${(end - fallStart).toFixed(2)}))`;
	return (
		`if(lt(${seconds},${start.toFixed(2)}),0,` +
		`if(lt(${seconds},${(start + rise).toFixed(2)}),${up},` +
		`if(lt(${seconds},${fallStart.toFixed(2)}),1,` +
		`if(lt(${seconds},${end.toFixed(2)}),${down},0))))`
	);
}

/**
 * Zoom curve for the note segment: the typing zoom, then the split zoom on the
 * preview pane. Both are trapezoid ramps of the output time, so the hold lengths
 * follow the measured beats instead of a fixed schedule. The split ramp starts
 * after the typing ramp has cleared, and it falls back to 1 before the cut.
 */
function noteZoom(segment) {
	const marks = new Map(segment.marks.map((mark) => [mark.label, mark.at]));
	const seconds = `(on/${FPS})`;
	const splitAt = marks.get('split') ?? Math.max(segment.durationSeconds - 2.6, ZOOM.outEnd);
	const start = Math.max(splitAt + 0.15, ZOOM.outEnd);
	const end = segment.durationSeconds;
	const typing = trapezoid(seconds, 0, ZOOM.inEnd, ZOOM.holdEnd, ZOOM.outEnd);
	const split = trapezoid(
		seconds,
		Math.min(start, end - 1.25),
		SPLIT_ZOOM.rise,
		end - SPLIT_ZOOM.fall,
		end
	);
	return {
		z: `1+${(ZOOM_MAX - 1).toFixed(3)}*${typing}+${(SPLIT_ZOOM.max - 1).toFixed(3)}*${split}`,
		// The anchor slides onto the preview pane only while the split ramp runs.
		x: `(iw-iw/zoom)*(${ZOOM_ANCHOR.x}+${(SPLIT_ZOOM.anchor.x - ZOOM_ANCHOR.x).toFixed(2)}*${split})`,
		y: `(ih-ih/zoom)*(${ZOOM_ANCHOR.y}+${(SPLIT_ZOOM.anchor.y - ZOOM_ANCHOR.y).toFixed(2)}*${split})`
	};
}

async function renderNote(listPath, partPath, maskPath, segment) {
	// Compose first at full canvas size, then ease the zooms over the result.
	const zoom = noteZoom(segment);
	const filter = [
		`[0:v]fps=${FPS}[steady]`,
		framedTail('steady', 'framed'),
		`[framed]zoompan=z='${zoom.z}':x='${zoom.x}':y='${zoom.y}'` +
			`:d=1:s=${CANVAS.width}x${CANVAS.height}:fps=${FPS}[v]`
	].join(';');
	await ffmpeg(
		[
			'-f',
			'concat',
			'-safe',
			'0',
			'-i',
			listPath,
			'-loop',
			'1',
			'-i',
			maskPath,
			'-filter_complex',
			filter,
			'-map',
			'[v]',
			'-t',
			segment.durationSeconds.toFixed(3),
			'-r',
			String(FPS),
			'-c:v',
			'libx264',
			'-preset',
			'medium',
			'-crf',
			'17',
			'-pix_fmt',
			'yuv420p',
			partPath
		],
		'note segment'
	);
}

async function renderFramed(listPath, partPath, maskPath, duration) {
	const filter = [`[0:v]fps=${FPS}[steady]`, framedTail('steady', 'v')].join(';');
	await ffmpeg(
		[
			'-f',
			'concat',
			'-safe',
			'0',
			'-i',
			listPath,
			'-loop',
			'1',
			'-i',
			maskPath,
			'-filter_complex',
			filter,
			'-map',
			'[v]',
			'-t',
			duration.toFixed(3),
			'-r',
			String(FPS),
			'-c:v',
			'libx264',
			'-preset',
			'medium',
			'-crf',
			'17',
			'-pix_fmt',
			'yuv420p',
			partPath
		],
		'framed segment'
	);
}

/**
 * The end card already fills the canvas at 1280x760, so it keeps its own
 * background. A short fade from the graphite keeps the cut soft.
 */
async function renderEndCard(listPath, partPath, duration) {
	const filter =
		`[0:v]fps=${FPS},scale=${CANVAS.width}:${CANVAS.height}:flags=lanczos,` +
		`format=yuv420p,fade=t=in:st=0:d=0.12,fade=t=out:st=${Math.max(duration - 0.28, 0).toFixed(2)}:d=0.28[v]`;
	await ffmpeg(
		[
			'-f',
			'concat',
			'-safe',
			'0',
			'-i',
			listPath,
			'-filter_complex',
			filter,
			'-map',
			'[v]',
			'-t',
			duration.toFixed(3),
			'-r',
			String(FPS),
			'-c:v',
			'libx264',
			'-preset',
			'medium',
			'-crf',
			'17',
			'-pix_fmt',
			'yuv420p',
			partPath
		],
		'end card'
	);
}

/** Concat list that holds every frame for its measured interval. */
async function writeConcat(name, segment, listPath) {
	const dir = join(FRAMES, name);
	const files = (await readdir(dir))
		.filter((file) => file.startsWith(`${name}-`) && file.endsWith('.jpg'))
		.sort();
	if (!files.length) throw new Error(`No frames for ${name} in ${dir}.`);
	const deltas = segment.frames
		.slice(1)
		.map((frame, index) => frame.at - segment.frames[index].at)
		.sort((a, b) => a - b);
	const median = deltas[Math.floor(deltas.length / 2)] ?? 1 / FPS;
	const lines = ['ffconcat version 1.0'];
	segment.frames.forEach((frame, index) => {
		const next = segment.frames[index + 1]?.at;
		// Timeline timestamps are already in seconds.
		const hold = Math.max(next ? next - frame.at : median, 0.004);
		lines.push(`file '${join(dir, files[index])}'`, `duration ${hold.toFixed(4)}`);
	});
	lines.push(`file '${join(dir, files.at(-1))}'`);
	await writeFile(listPath, lines.join('\n') + '\n');
	return { frames: files.length, medianMs: Math.round(median * 1000) };
}

async function main() {
	const timeline = JSON.parse(await readFile(join(WORK, 'timeline.json'), 'utf8'));
	await mkdir(PARTS, { recursive: true });

	const maskPath = join(WORK, 'mask.png');
	await buildMask(maskPath);

	const parts = [];
	for (const name of SEGMENTS) {
		const segment = timeline.segments[name];
		const listPath = join(PARTS, `${name}.ffconcat`);
		const partPath = join(PARTS, `${name}.mp4`);
		const stats = await writeConcat(name, segment, listPath);
		const duration = segment.durationSeconds;
		if (name === 'note') await renderNote(listPath, partPath, maskPath, segment);
		else if (name === 'end') await renderEndCard(listPath, partPath, duration);
		else await renderFramed(listPath, partPath, maskPath, duration);
		const info = await ffprobe(partPath);
		parts.push({ name, path: partPath, ...info });
		console.log(
			`[compose] ${name}: ${info.duration.toFixed(2)}s ${info.width}x${info.height} ` +
				`from ${stats.frames} frames (${stats.medianMs}ms median hold)`
		);
	}

	const listPath = join(PARTS, 'all.ffconcat');
	await writeFile(
		listPath,
		'ffconcat version 1.0\n' + parts.map((part) => `file '${part.path}'`).join('\n') + '\n'
	);
	const master = join(WORK, 'master.mp4');
	await ffmpeg(
		[
			'-f',
			'concat',
			'-safe',
			'0',
			'-i',
			listPath,
			'-c:v',
			'libx264',
			'-preset',
			'medium',
			'-crf',
			'16',
			'-pix_fmt',
			'yuv420p',
			'-r',
			String(FPS),
			'-movflags',
			'+faststart',
			master
		],
		'master'
	);
	const masterInfo = await ffprobe(master);
	console.log(
		`[compose] master: ${masterInfo.duration.toFixed(2)}s ${masterInfo.width}x${masterInfo.height}`
	);

	const mp4 = join(OUT, 'hero.mp4');
	await ffmpeg(
		[
			'-i',
			master,
			'-c:v',
			'libx264',
			'-preset',
			'slow',
			'-crf',
			'20',
			'-pix_fmt',
			'yuv420p',
			'-profile:v',
			'high',
			'-level',
			'4.0',
			'-r',
			String(FPS),
			'-movflags',
			'+faststart',
			'-an',
			mp4
		],
		'hero.mp4'
	);

	const webp = join(OUT, 'hero.webp');
	await ffmpeg(
		[
			'-i',
			master,
			'-vf',
			`scale=${WEBP_WIDTH}:-1:flags=lanczos`,
			'-c:v',
			'libwebp_anim',
			'-quality',
			'75',
			'-compression_level',
			'6',
			'-loop',
			'0',
			'-an',
			webp
		],
		'hero.webp'
	);

	// GIF: one palette for the whole clip, spatial dither, diff-mode stats.
	const palette = join(WORK, 'palette.png');
	const scaleGif = `scale=${GIF_WIDTH}:-1:flags=lanczos,fps=${GIF_FPS}`;
	await ffmpeg(
		['-i', master, '-vf', `${scaleGif},palettegen=stats_mode=diff`, '-frames:v', '1', palette],
		'palette'
	);
	const gif = join(OUT, 'hero.gif');
	await ffmpeg(
		[
			'-i',
			master,
			'-i',
			palette,
			'-filter_complex',
			`[0:v]${scaleGif}[s];[s][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
			'-loop',
			'0',
			'-fps_mode',
			'vfr',
			gif
		],
		'hero.gif'
	);

	// Contact sheet: 16 evenly spaced frames, 4x4.
	const contact = join(OUT, 'contact.png');
	const picks = Array.from({ length: 16 }, (_, index) =>
		Math.min(
			Math.round(((index + 0.5) * masterInfo.duration * FPS) / 16),
			Math.round(masterInfo.duration * FPS) - 1
		)
	);
	await ffmpeg(
		[
			'-i',
			master,
			'-vf',
			`select='${picks.map((frame) => `eq(n,${frame})`).join('+')}',` +
				`scale=308:-1:flags=lanczos,tile=4x4:padding=6:margin=10:color=0x0e1013`,
			'-frames:v',
			'1',
			'-update',
			'1',
			contact
		],
		'contact sheet'
	);

	const report = {};
	for (const path of [mp4, webp, gif, contact]) {
		const info = await ffprobe(path).catch(() => ({ width: null, height: null, duration: null }));
		report[path.split('/').pop()] = { ...info, bytes: (await stat(path)).size };
	}
	if (report['hero.gif'].bytes > MAX_GIF_BYTES) {
		throw new Error(`hero.gif is ${report['hero.gif'].bytes} bytes, above the 8 MB limit.`);
	}
	await writeFile(join(WORK, 'encode-report.json'), JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 1));
}

await main().catch((error) => {
	console.error(error);
	process.exitCode ||= 1;
});
