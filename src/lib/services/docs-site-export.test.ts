import { describe, expect, it } from 'vitest';
import {
	buildDocsSite,
	DocsSiteExportError,
	planDocsSite,
	resolveSiteDestination,
	serializeDocsSiteReport,
	type DocsSiteExportInput
} from './docs-site-export';

const PNG_BYTES = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
	),
	(character) => character.charCodeAt(0)
);

function source(overrides: Partial<DocsSiteExportInput> = {}): DocsSiteExportInput {
	return {
		name: 'Project handbook',
		documents: [
			{ id: 'home', relativePath: 'README.md', content: '# Home\n\nWelcome.\n' },
			{
				id: 'guide',
				relativePath: 'notes/guide.md',
				content: '# Guide\n\n## Install\n\n[Home](../README.md#home)\n'
			}
		],
		assets: [{ path: 'assets/logo.png', mime: 'image/png', data: PNG_BYTES }],
		locale: 'en',
		...overrides
	};
}

function text(result: Awaited<ReturnType<typeof buildDocsSite>>, path: string): string {
	const file = result.files.find((entry) => entry.path === path);
	if (!file) throw new Error(`Missing file ${path}`);
	return new TextDecoder().decode(file.data);
}

describe('documentation site plan', () => {
	it('maps nested documents to predictable page paths with stable ordering', () => {
		const plan = planDocsSite(
			source({
				documents: [
					{ id: 'b', relativePath: 'notes/guide.md', content: '# Guide\n' },
					{ id: 'a', relativePath: 'README.md', content: '# Home\n' },
					{ id: 'c', relativePath: 'notes/index.md', content: '# Notes\n' }
				]
			})
		);

		expect(plan.pages.map((page) => [page.sourcePath, page.outputPath])).toEqual([
			['README.md', 'index.html'],
			['notes/guide.md', 'notes/guide.html'],
			['notes/index.md', 'notes/index.html']
		]);
		expect(
			plan.assets.map(({ sourcePath, outputPath, mime }) => ({ sourcePath, outputPath, mime }))
		).toEqual([
			{ sourcePath: 'assets/logo.png', outputPath: 'assets/logo.png', mime: 'image/png' }
		]);
	});

	it('rewrites nested links, anchors, and local assets from the page location', () => {
		const plan = planDocsSite(
			source({
				documents: [
					{ id: 'home', relativePath: 'README.md', content: '# Home\n\n## Install\n' },
					{
						id: 'guide',
						relativePath: 'notes/guide.md',
						content:
							'# Guide\n\n[Home](../README.md#install)\n\n[Details](details.md#api)\n\n![Logo](../assets/logo.png)\n'
					},
					{ id: 'details', relativePath: 'notes/details.md', content: '# Details\n\n## API\n' }
				]
			})
		);

		expect(resolveSiteDestination(plan, 'notes/guide.md', '../README.md#install')).toMatchObject({
			kind: 'page',
			outputPath: 'index.html',
			href: '../index.html#install'
		});
		expect(resolveSiteDestination(plan, 'notes/guide.md', 'details.md#api')).toMatchObject({
			kind: 'page',
			outputPath: 'notes/details.html',
			href: 'details.html#api'
		});
		expect(resolveSiteDestination(plan, 'notes/guide.md', '../assets/logo.png')).toMatchObject({
			kind: 'asset',
			outputPath: 'assets/logo.png',
			href: '../assets/logo.png'
		});
		expect(resolveSiteDestination(plan, 'notes/guide.md', '#local')).toMatchObject({
			kind: 'fragment',
			href: '#local'
		});
	});

	it('reports missing assets, external assets, and missing anchors before writing', () => {
		const plan = planDocsSite(
			source({
				documents: [
					{
						id: 'home',
						relativePath: 'README.md',
						content: [
							'# Home',
							'',
							'![Missing](assets/missing.png)',
							'',
							'![Remote](https://example.org/figure.png)',
							'',
							'[Missing anchor](#absent)',
							''
						].join('\n')
					}
				]
			})
		);

		expect(plan.issues).toMatchObject([
			{
				code: 'image-missing',
				severity: 'error',
				path: 'README.md',
				target: 'assets/missing.png'
			},
			{
				code: 'anchor-missing',
				severity: 'warning',
				path: 'README.md',
				target: '#absent'
			},
			{
				code: 'image-external',
				severity: 'warning',
				path: 'README.md',
				target: 'https://example.org/figure.png'
			}
		]);
	});

	it('resolves wiki links and reports an ambiguous target', () => {
		const plan = planDocsSite(
			source({
				documents: [
					{ id: 'home', relativePath: 'README.md', content: '# Home\n\n[[Guide]]\n' },
					{ id: 'one', relativePath: 'notes/guide.md', content: '# Guide\n' },
					{ id: 'two', relativePath: 'archive/guide.md', content: '# Guide two\n' }
				]
			})
		);

		expect(plan.issues).toMatchObject([
			{
				code: 'link-ambiguous',
				severity: 'error',
				path: 'README.md',
				target: 'Guide'
			}
		]);
	});
});

describe('documentation site output', () => {
	it('escapes metadata and page content and produces deterministic entries', async () => {
		const input = source({
			name: '<img src=x onerror=alert(1)>',
			documents: [
				{
					id: 'home',
					relativePath: 'README.md',
					content: '---\ntitle: <script>alert(1)</script>\n---\n# Safe & sound\n'
				}
			],
			assets: []
		});
		const before = JSON.stringify(input);
		const first = await buildDocsSite(input);
		const second = await buildDocsSite(input);

		expect(first.files.map((file) => file.path)).toEqual([
			'.nojekyll',
			'_mdsh/search-index.js',
			'_mdsh/site.css',
			'_mdsh/site.js',
			'index.html'
		]);
		expect(first.files.map((file) => [file.path, Array.from(file.data)])).toEqual(
			second.files.map((file) => [file.path, Array.from(file.data)])
		);
		expect(new Uint8Array(await new Response(first.blob).arrayBuffer())).toEqual(
			new Uint8Array(await new Response(second.blob).arrayBuffer())
		);
		expect(serializeDocsSiteReport(first.report)).toBe(serializeDocsSiteReport(second.report));
		expect(JSON.stringify(input)).toBe(before);

		const index = text(first, 'index.html');
		expect(index).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(index).not.toContain('<script>alert(1)</script>');
		expect(index).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(index).toContain('Safe &amp; sound');
	});

	it('blocks remote image sources but keeps the page usable', async () => {
		const result = await buildDocsSite(
			source({
				documents: [
					{
						id: 'home',
						relativePath: 'README.md',
						content: '# Home\n\n![Remote](https://example.org/figure.png)\n'
					}
				]
			})
		);

		const index = text(result, 'index.html');
		expect(index).not.toMatch(/\ssrc="https:\/\/example\.org\/figure\.png"/);
		expect(index).toContain('data-mdsh-remote-src="https://example.org/figure.png"');
		expect(index).toContain('alt="Remote"');
		expect(result.report.issues).toMatchObject([
			{ code: 'image-external', severity: 'warning', target: 'https://example.org/figure.png' }
		]);
	});

	it('stops before ZIP creation when a local resource is missing', async () => {
		await expect(
			buildDocsSite(
				source({
					documents: [
						{
							id: 'home',
							relativePath: 'README.md',
							content: '# Home\n\n![Missing](assets/missing.png)\n'
						}
					]
				})
			)
		).rejects.toMatchObject({
			name: 'DocsSiteExportError',
			report: {
				schema: 'mdsh-docs-site/1',
				summary: { errors: 1, warnings: 0 }
			}
		});

		try {
			await buildDocsSite(
				source({
					documents: [
						{
							id: 'home',
							relativePath: 'README.md',
							content: '# Home\n\n![Missing](assets/missing.png)\n'
						}
					]
				})
			);
		} catch (error) {
			expect(error).toBeInstanceOf(DocsSiteExportError);
		}
	});

	it('stops before ZIP creation when the signal is cancelled', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(buildDocsSite(source(), { signal: controller.signal })).rejects.toMatchObject({
			name: 'AbortError'
		});
	});

	it('omits the search index when the option is off', async () => {
		const result = await buildDocsSite(source({ includeSearchIndex: false }));
		expect(result.files.map((file) => file.path)).toEqual([
			'.nojekyll',
			'_mdsh/site.css',
			'_mdsh/site.js',
			'assets/logo.png',
			'index.html',
			'notes/guide.html'
		]);
		expect(text(result, 'index.html')).not.toContain('data-site-search');
		expect(result.report.summary.searchIndex).toBe(false);
	});
});
