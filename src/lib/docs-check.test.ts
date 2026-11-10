import { describe, expect, it } from 'vitest';
import {
	createDeck,
	createElement,
	createSlide,
	serializePresentation
} from './presentation/model';
import {
	runDocsCheck,
	serializeDocsCheckReport,
	type DocsCheckDocument,
	type DocsCheckReport
} from './docs-check';

function document(relativePath: string, content: string): DocsCheckDocument {
	return { id: relativePath, relativePath, content };
}

function codes(report: DocsCheckReport): string[] {
	return report.issues.map((issue) => issue.code);
}

function issuesFor(report: DocsCheckReport, path: string) {
	return report.issues.filter((issue) => issue.path === path);
}

describe('documentation check', () => {
	it('ignores links and images inside closed code fences', async () => {
		const report = await runDocsCheck({
			documents: [
				document(
					'README.md',
					[
						'# Readme',
						'',
						'```md',
						'[Broken](missing.md)',
						'![Broken](assets/missing.png)',
						'```',
						'',
						'[Also broken](missing-two.md)'
					].join('\n')
				)
			],
			assets: []
		});

		expect(codes(report)).toEqual(['link-missing']);
		expect(report.issues[0]).toMatchObject({
			path: 'README.md',
			line: 8,
			severity: 'error'
		});
		expect(report.issues[0]?.target).toBe('missing-two.md');
	});

	it('reports an unclosed fence at its opening line', async () => {
		const report = await runDocsCheck({
			documents: [document('guide.md', '# Guide\n\n```js\nconst value = 1;\n')],
			assets: []
		});

		expect(report.issues).toHaveLength(1);
		expect(report.issues[0]).toMatchObject({
			code: 'fence-unclosed',
			path: 'guide.md',
			line: 3,
			severity: 'warning'
		});
	});

	it('resolves heading anchors, duplicate anchors, and skipped levels', async () => {
		const report = await runDocsCheck({
			documents: [
				document(
					'notes/guide.md',
					[
						'# Top',
						'',
						'### Skipped level',
						'',
						'## Duplicate',
						'',
						'## Duplicate',
						'',
						'[Good](#top)',
						'[Also good](#duplicate-2)',
						'[Missing](#absent)'
					].join('\n')
				)
			],
			assets: []
		});

		expect(issuesFor(report, 'notes/guide.md')).toMatchObject([
			{ code: 'heading-hierarchy', line: 3, severity: 'warning' },
			{ code: 'heading-duplicate', line: 7, severity: 'warning' },
			{ code: 'anchor-missing', line: 11, severity: 'warning' }
		]);
	});

	it('checks anchors in another document', async () => {
		const report = await runDocsCheck({
			documents: [
				document('index.md', '[Good](guide.md#install)\n[Bad](guide.md#install-two)\n'),
				document('guide.md', '# Guide\n\n## Install\n')
			],
			assets: []
		});

		expect(report.issues).toMatchObject([
			{
				code: 'anchor-missing',
				path: 'index.md',
				line: 2,
				target: 'guide.md#install-two'
			}
		]);
	});

	it('decodes percent-escaped fragments once before checking anchors', async () => {
		const report = await runDocsCheck({
			documents: [
				document(
					'index.md',
					[
						'# Index',
						'',
						'## Install Guide',
						'',
						'[Same](#install%2Dguide)',
						'[Cross](guide.md#install%2Dguide)',
						'[Absent](guide.md#missing%2Danchor)',
						'[Twice](guide.md#install%252Dguide)',
						'[Malformed](#install%ZZguide)'
					].join('\n')
				),
				document('guide.md', '# Guide\n\n## Install Guide\n')
			],
			assets: []
		});

		expect(report.issues).toMatchObject([
			{
				code: 'anchor-missing',
				path: 'index.md',
				line: 7,
				target: 'guide.md#missing%2Danchor'
			},
			{
				code: 'anchor-missing',
				path: 'index.md',
				line: 8,
				target: 'guide.md#install%252Dguide'
			},
			{
				code: 'anchor-missing',
				path: 'index.md',
				line: 9,
				target: '#install%ZZguide'
			}
		]);
	});

	it('reports broken images, missing alt text, and traversal', async () => {
		const report = await runDocsCheck({
			documents: [
				document(
					'notes/guide.md',
					[
						'# Guide',
						'',
						'![Logo](../assets/missing.png)',
						'',
						'![](../assets/present.png)',
						'',
						'![Reference][logo]',
						'',
						'[Escape](../../secret.md)'
					].join('\n')
				)
			],
			assets: ['assets/present.png']
		});

		expect(issuesFor(report, 'notes/guide.md')).toMatchObject([
			{ code: 'image-missing', line: 3, severity: 'error' },
			{ code: 'image-alt-missing', line: 5, severity: 'warning' },
			{ code: 'image-missing', line: 7, severity: 'error' },
			{ code: 'link-outside-project', line: 9, severity: 'error' }
		]);
	});

	it('reports ambiguous wiki targets once', async () => {
		const report = await runDocsCheck({
			documents: [
				document('index.md', '# Index\n\n[[alpha]]\n'),
				document('notes/alpha.md', '# Alpha\n'),
				document('archive/alpha.md', '# Alpha archive\n')
			],
			assets: []
		});

		expect(report.issues).toMatchObject([
			{ code: 'link-ambiguous', path: 'index.md', line: 3, target: 'alpha' }
		]);
	});

	it('keeps remote images as warnings and never downloads them', async () => {
		const report = await runDocsCheck({
			documents: [document('index.md', '# Index\n\n![Remote](https://example.test/image.png)\n')],
			assets: []
		});

		expect(report.issues).toMatchObject([{ code: 'image-remote', line: 3, severity: 'warning' }]);
		expect(report.issues.some((issue) => issue.severity === 'error')).toBe(false);
	});

	it('reports invalid and unclosed front matter', async () => {
		const report = await runDocsCheck({
			documents: [
				document('invalid.md', '---\ntitle: [unclosed\n---\n# Invalid\n'),
				document('unclosed.md', '---\ntitle: Missing end\n# Unclosed\n')
			],
			assets: []
		});

		expect(report.issues).toMatchObject([
			{ code: 'frontmatter-invalid', path: 'invalid.md', line: 1, severity: 'error' },
			{ code: 'frontmatter-unclosed', path: 'unclosed.md', line: 1, severity: 'error' }
		]);
	});

	it('reports missing presentation image resources and skips layout checks', async () => {
		const deck = createDeck({
			slides: [
				createSlide({
					id: 'slide-one',
					elements: [
						createElement('image', {
							id: 'missing-image',
							content: 'assets/missing.png',
							x: 10,
							y: 10,
							width: 80,
							height: 80
						}),
						createElement('image', {
							id: 'present-image',
							content: 'assets/present.png',
							x: 100,
							y: 10,
							width: 80,
							height: 80
						}),
						createElement('image', {
							id: 'remote-image',
							content: 'https://example.test/image.png',
							x: 200,
							y: 10,
							width: 80,
							height: 80
						})
					]
				})
			]
		});
		const report = await runDocsCheck({
			documents: [document('slides.md', serializePresentation(deck))],
			assets: ['assets/present.png']
		});

		expect(issuesFor(report, 'slides.md')).toMatchObject([
			{ code: 'presentation-resource-missing', line: 4, severity: 'error' },
			{ code: 'image-remote', line: 12, severity: 'warning' }
		]);
		expect(report.skipped).toContainEqual({
			check: 'presentation-layout',
			reason: 'Text overflow needs layout measurement. The model clamps element bounds.'
		});
	});

	it('exports a stable report without timestamps', async () => {
		const input = {
			documents: [
				document('b.md', '# B\n\n[Missing](b-missing.md)\n'),
				document('a.md', '# A\n\n[Missing](a-missing.md)\n')
			],
			assets: []
		};
		const first = await runDocsCheck(input);
		const second = await runDocsCheck({
			documents: [...input.documents].reverse(),
			assets: []
		});

		expect(serializeDocsCheckReport(first)).toBe(serializeDocsCheckReport(second));
		expect(JSON.parse(serializeDocsCheckReport(first))).toMatchObject({
			schema: 'mdsh-docs-check/1',
			summary: { errors: 2, warnings: 0 },
			documents: 2
		});
		expect(serializeDocsCheckReport(first)).not.toContain('generatedAt');
	});
});
