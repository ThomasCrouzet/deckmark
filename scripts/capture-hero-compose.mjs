#!/usr/bin/env node
/**
 * Encode the hero capture.
 *
 * Input is the frame set and timeline.json that `capture-hero.mjs` writes for
 * one theme. The stage page already draws the canvas, the window, captions and
 * the end card, so this step only retimes and encodes. Each segment goes
 * through a concat demuxer list, so every frame is held for its measured
 * interval and typing keeps its real rhythm. A short cross-fade joins the note
 * segment to the deck segment.
 *
 * Outputs, written to test-results/capture-hero/<theme>/:
 *   hero.mp4     H.264, yuv420p, crf 20, 30 fps, 1280x720, for the website
 *   hero.webp    animated, loop, 1280 px wide, for the README
 *   hero.gif     palettegen/paletteuse, 880 px wide, 12 fps, under 8 MB
 *   contact.png  4x4 tile of evenly spaced frames, for review
 *
 * Usage: HERO_THEME=dark node scripts/capture-hero-compose.mjs
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from './capture-helpers.mjs';

const run = promisify(execFile);

const THEME = process.env.HERO_THEME === 'light' ? 'light' : 'dark';
const OUT = join(process.env.HERO_OUT ?? join(ROOT, 'test-results', 'capture-hero'), THEME);
const WORK = join(OUT, 'work');
const PARTS = join(WORK, 'parts');
const FRAMES = join(WORK, 'frames');
const SEGMENTS = ['note', 'deck'];

const SIZE = { width: 1280, height: 720 };
const FPS = 30;
const CROSSFADE = 0.3;
const WEBP_QUALITY = 72;
const GIF_WIDTH = 880;
const GIF_FPS = 12;
const MAX_GIF_BYTES = 8_000_000;
const MAX_WEBP_BYTES = 6_000_000;

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
		duration: Number(data.format.duration),
		bytes: Number(data.format.size)
	};
}

/** Concat list that holds every frame for its measured interval. */
async function writeConcat(name, segment, listPath) {
	const dir = join(FRAMES, name);
	const lines = ['ffconcat version 1.0'];
	const deltas = segment.frames
		.slice(1)
		.map((frame, index) => frame.at - segment.frames[index].at)
		.sort((a, b) => a - b);
	const median = deltas[Math.floor(deltas.length / 2)] ?? 1 / FPS;
	segment.frames.forEach((frame, index) => {
		const next = segment.frames[index + 1]?.at;
		const hold = Math.max(next ? next - frame.at : median, 0.004);
		lines.push(`file '${join(dir, frame.file)}'`, `duration ${hold.toFixed(4)}`);
	});
	lines.push(`file '${join(dir, segment.frames.at(-1).file)}'`);
	await writeFile(listPath, lines.join('\n') + '\n');
	return { frames: segment.frames.length, medianMs: Math.round(median * 1000) };
}

async function renderSegment(listPath, partPath, duration) {
	await ffmpeg(
		[
			'-f',
			'concat',
			'-safe',
			'0',
			'-i',
			listPath,
			'-vf',
			`fps=${FPS},scale=${SIZE.width}:${SIZE.height}:flags=lanczos,format=yuv420p`,
			'-t',
			duration.toFixed(3),
			'-c:v',
			'libx264',
			'-preset',
			'medium',
			'-crf',
			'14',
			partPath
		],
		`segment ${partPath}`
	);
}

async function main() {
	const timeline = JSON.parse(await readFile(join(WORK, 'timeline.json'), 'utf8'));
	if (timeline.theme !== THEME) throw new Error(`timeline.json is for ${timeline.theme}.`);
	await mkdir(PARTS, { recursive: true });

	const parts = [];
	for (const name of SEGMENTS) {
		const segment = timeline.segments[name];
		const listPath = join(PARTS, `${name}.ffconcat`);
		const partPath = join(PARTS, `${name}.mp4`);
		const stats = await writeConcat(name, segment, listPath);
		await renderSegment(listPath, partPath, segment.durationSeconds);
		const info = await ffprobe(partPath);
		parts.push({ name, path: partPath, ...info });
		console.log(
			`[compose] ${name}: ${info.duration.toFixed(2)}s from ${stats.frames} frames ` +
				`(${stats.medianMs}ms median hold)`
		);
	}

	const master = join(WORK, 'master.mp4');
	const offset = (parts[0].duration - CROSSFADE).toFixed(3);
	await ffmpeg(
		[
			'-i',
			parts[0].path,
			'-i',
			parts[1].path,
			'-filter_complex',
			`[0:v][1:v]xfade=transition=fade:duration=${CROSSFADE}:offset=${offset},format=yuv420p[v]`,
			'-map',
			'[v]',
			'-r',
			String(FPS),
			'-c:v',
			'libx264',
			'-preset',
			'medium',
			'-crf',
			'14',
			master
		],
		'master'
	);
	const masterInfo = await ffprobe(master);

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
			'-c:v',
			'libwebp_anim',
			'-quality',
			String(WEBP_QUALITY),
			'-compression_level',
			'6',
			'-loop',
			'0',
			'-an',
			webp
		],
		'hero.webp'
	);

	const palette = join(WORK, 'palette.png');
	const scaleGif = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
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
			gif
		],
		'hero.gif'
	);

	const contact = join(OUT, 'contact.png');
	const total = Math.round(masterInfo.duration * FPS);
	const picks = Array.from({ length: 16 }, (_, index) =>
		Math.min(Math.round(((index + 0.5) * total) / 16), total - 1)
	);
	await ffmpeg(
		[
			'-i',
			master,
			'-vf',
			`select='${picks.map((frame) => `eq(n,${frame})`).join('+')}',` +
				`scale=320:-1:flags=lanczos,tile=4x4:padding=6:margin=10:color=0x0e1013`,
			'-frames:v',
			'1',
			'-update',
			'1',
			contact
		],
		'contact sheet'
	);

	const report = { master: masterInfo };
	for (const path of [mp4, webp, gif]) {
		const info = await ffprobe(path).catch(() => ({}));
		report[path.split('/').pop()] = { ...info, bytes: (await stat(path)).size };
	}
	await writeFile(join(WORK, 'encode-report.json'), JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 1));
	if (report['hero.gif'].bytes > MAX_GIF_BYTES) {
		throw new Error(`hero.gif is ${report['hero.gif'].bytes} bytes, above the 8 MB limit.`);
	}
	if (report['hero.webp'].bytes > MAX_WEBP_BYTES) {
		throw new Error(`hero.webp is ${report['hero.webp'].bytes} bytes, above the 6 MB limit.`);
	}
}

await main().catch((error) => {
	console.error(error);
	process.exitCode ||= 1;
});
