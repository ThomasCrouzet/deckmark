import { basename, dirname, relative, resolve } from 'node:path';
import { documentHeadings } from '../src/lib/document-navigation';
import { documentKindForFile, isTextDocumentKind } from '../src/lib/document-kind';
import { getTitle, parseFrontmatter } from '../src/lib/frontmatter';
import { projectDestinations } from '../src/lib/project-links';
import { isExternalDestination, resolveProjectPath } from '../src/lib/project-paths';
import { wikiLinkOccurrences } from '../src/lib/wiki-links';
import { CliError, EXIT } from './exit';
import { displayPath, readText, requireFile } from './paths';

export interface InspectInput {
	input: string;
	json: boolean;
}

export async function runInspect(input: InspectInput): Promise<number> {
	const absolute = await requireFile(resolve(input.input));
	if (!isTextDocumentKind(documentKindForFile({ name: absolute })))
		throw new CliError(
			EXIT.INPUT,
			'input-not-text',
			`Text inspection is not supported: ${input.input}`
		);
	const content = await readText(dirname(absolute), basename(absolute));
	const kind = documentKindForFile({ name: absolute, content });
	const parsed = await parseFrontmatter(content);
	const headings = documentHeadings(content).map((heading) => ({
		level: heading.level,
		text: heading.text,
		line: heading.line
	}));
	const fromCwd = relative(process.cwd(), absolute);
	const from =
		fromCwd && !fromCwd.startsWith('..') ? fromCwd.split('\\').join('/') : basename(absolute);
	let markdown = 0;
	let images = 0;
	let external = 0;
	let internal = 0;
	let anchors = 0;
	for (const destination of projectDestinations(content)) {
		if (destination.image) images++;
		else markdown++;
		const source = destination.source;
		if (source.startsWith('#')) anchors++;
		else if (isExternalDestination(source)) external++;
		else if (!source.startsWith('data:') && resolveProjectPath(from, source)) internal++;
	}
	const wiki = wikiLinkOccurrences(content).length;
	const body = parsed.content;
	const words = body.trim() ? body.trim().split(/\s+/u).length : 0;
	const report = {
		schema: 'deckmark-inspect/1',
		path: displayPath(absolute),
		kind,
		title: getTitle(parsed.data, parsed.content, basename(absolute)),
		frontmatter: parsed.data,
		headings,
		links: {
			markdown,
			images,
			wiki,
			external,
			internal,
			anchors,
			total: markdown + images + wiki
		},
		statistics: {
			lines: content.split('\n').length,
			words,
			characters: content.length
		}
	};
	if (input.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	else {
		const lines = [
			`Path: ${report.path}`,
			`Kind: ${report.kind}`,
			`Title: ${report.title}`,
			`Front matter keys: ${Object.keys(parsed.data).join(', ') || 'none'}`,
			`Headings: ${headings.length}`,
			...headings
				.slice(0, 20)
				.map((heading) => `  ${heading.line}: ${'#'.repeat(heading.level)} ${heading.text}`),
			`Links: ${report.links.total} (markdown ${markdown}, images ${images}, wiki ${wiki})`,
			`Lines: ${report.statistics.lines}, words: ${words}, characters: ${report.statistics.characters}`
		];
		process.stdout.write(`${lines.join('\n')}\n`);
	}
	return EXIT.OK;
}
