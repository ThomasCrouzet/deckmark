import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';
import { editSentence, exportSource, importSource } from './source-fidelity-harness';

// Issue #572: an ordinary text edit inside a paragraph with unchanged inline
// marks must keep the bounded source restoration. A whole-source parse or
// normalization for that edit is the failure this case keeps.

interface ObservedEdit {
	documentId: string;
	revision: number;
	space: string;
	kind: string;
	previous: { from: number; to: number };
	next: { from: number; to: number };
}

interface EditorPerfProbe {
	scoped: number;
	full: number;
	paths: Record<string, number>;
	stages: Array<{ kind: string; name: string; value?: number }>;
	edits: ObservedEdit[];
}

declare global {
	interface Window {
		__i572Perf?: EditorPerfProbe;
	}
}

async function installProbe(page: Page) {
	await page.addInitScript(() => {
		const probe: EditorPerfProbe = { scoped: 0, full: 0, paths: {}, stages: [], edits: [] };
		window.__i572Perf = probe;
		window.addEventListener('deckmark:editor-perf', (event) => {
			const detail = (
				event as CustomEvent<{
					kind: string;
					name?: string;
					value?: number;
					edit?: ObservedEdit;
				}>
			).detail;
			if (detail.kind === 'counter') {
				if (detail.name === 'sourceFidelityScoped') probe.scoped += 1;
				if (detail.name === 'sourceFidelityFull') probe.full += 1;
			} else if (detail.kind === 'edit') {
				if (detail.edit) probe.edits.push(detail.edit);
			} else if (probe.stages.length < 2_000) {
				probe.stages.push({ kind: detail.kind, name: detail.name ?? '', value: detail.value });
			}
		});
		window.addEventListener('deckmark:source-fidelity', (event) => {
			const path = (event as CustomEvent<string>).detail;
			probe.paths[path] = (probe.paths[path] ?? 0) + 1;
		});
	});
}

/** A valid 1x1 PNG followed by harmless base64 padding. */
function mediaDataUrl(bytes: number): string {
	const png =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
	const padding = Math.max(0, bytes - Math.floor((png.length * 3) / 4));
	return `data:image/png;base64,${png}${'A'.repeat(padding)}`;
}

function mixedNote(mediaBytes: number): { source: string; cases: Array<[string, string]> } {
	const cases: Array<[string, string]> = [
		['Near start bold tail A.', 'Near start bold tail Ax.'],
		['Middle emphasis tail B.', 'Middle emphasis tail Bx.'],
		['End link tail C.', 'End link tail Cx.'],
		['Last code tail D.', 'Last code tail Dx.']
	];
	const source = [
		'---',
		'title: Mixed inline publication',
		'tags: [benchmark, mixed]',
		'---',
		'',
		'## Near start',
		'',
		'Near start bold tail A. with **bold words** kept.',
		'',
		`![Figure](${mediaDataUrl(mediaBytes)})`,
		'',
		'## Middle',
		'',
		'Middle emphasis tail B. with _emphasis words_ kept.',
		'',
		'## End',
		'',
		'End link tail C. with [link text](https://example.invalid/) kept.',
		'',
		'## Last',
		'',
		'Last code tail D. with `inline code` kept.',
		''
	].join('\n');
	return { source, cases };
}

async function readProbe(page: Page): Promise<EditorPerfProbe> {
	return page.evaluate(() => structuredClone(window.__i572Perf!));
}

async function resetProbe(page: Page) {
	await page.evaluate(() => {
		const probe = window.__i572Perf;
		if (!probe) return;
		probe.scoped = 0;
		probe.full = 0;
		probe.paths = {};
		probe.stages = [];
		probe.edits = [];
	});
}

async function attachEvidence(
	info: TestInfo,
	page: Page,
	id: string,
	fixtureBytes: number,
	expected: string,
	actual: string
) {
	const probe = await readProbe(page);
	const stages = probe.stages
		.filter((stage) => stage.kind === 'duration')
		.map((stage) => ({ name: stage.name, ms: stage.value }));
	const mediaStages = stages.filter((stage) =>
		['restoreMarkdown', 'sourceFidelityScopeAttempt', 'sourceFidelityFull'].includes(stage.name)
	);
	await info.attach(`${id}-publication.json`, {
		body: JSON.stringify(
			{
				fixtureBytes,
				sourceChars: expected.length,
				actualChars: actual.length,
				exactBytes: actual === expected,
				scoped: probe.scoped,
				full: probe.full,
				paths: probe.paths,
				edits: probe.edits,
				stages: mediaStages,
				allStageCount: stages.length
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach(`${id}-expected.md`, { body: expected, contentType: 'text/markdown' });
	await info.attach(`${id}-actual.md`, { body: actual, contentType: 'text/markdown' });
}

async function editMixed(page: Page, before: string, after: string, id: string): Promise<void> {
	await resetProbe(page);
	await editSentence(page, before, after);
	await expect
		.poll(async () => (await readProbe(page)).scoped, {
			message: `${id}: the edit must publish through the scoped restoration`,
			timeout: 30_000
		})
		.toBeGreaterThan(0);
	const probe = await readProbe(page);
	const edit = probe.edits.at(-1);
	expect(edit, `${id}: the publication must carry one accepted edit`).toBeDefined();
	expect(edit!.space).toBe('editor-markdown');
	expect(edit!.kind).toBe('replace');
	expect(edit!.documentId).toBeTruthy();
	expect(edit!.previous.to).toBeGreaterThanOrEqual(edit!.previous.from);
	expect(edit!.next.to).toBeGreaterThanOrEqual(edit!.next.from);
	expect(
		edit!.next.to - edit!.next.from - (edit!.previous.to - edit!.previous.from),
		`${id}: the appended letter must be the only span size change`
	).toBe(1);
}

for (const size of [1, 5]) {
	test(`mixed inline edits keep exact bytes and bounded source work at ${size} MB`, async ({
		page
	}, info) => {
		test.slow();
		test.setTimeout(size === 5 ? 900_000 : 420_000);
		await installProbe(page);
		await resetAppState(page);
		const { source, cases } = mixedNote(size * 1024 * 1024);
		await importSource(page, source, `mixed-${size}mb`);
		await page.locator('[data-mode=wysiwyg]').click();
		const largeDialog = page.getByRole('dialog', { name: 'Afficher ce document volumineux ?' });
		if (
			await largeDialog
				.waitFor({ state: 'visible', timeout: 3_000 })
				.then(() => true)
				.catch(() => false)
		)
			await largeDialog.getByRole('button', { name: 'Afficher le document', exact: true }).click();
		await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 180_000 });
		let expected = source;
		for (const [before, after] of cases) {
			await editMixed(page, before, after, `${size}mb`);
			expected = expected.replace(before, after);
			const probe = await readProbe(page);
			expect(probe.full, `${before}: a mixed inline edit must not parse the whole source`).toBe(0);
			expect(
				probe.paths.fullSerializer ?? 0,
				`${before}: a mixed inline edit must not use the full serializer fallback`
			).toBe(0);
		}
		const actual = await exportSource(page, `mixed-${size}mb.md`);
		await attachEvidence(info, page, `mixed-${size}mb`, size * 1024 * 1024, expected, actual);
		expect(actual, 'the exported source must keep every unchanged byte').toBe(expected);
	});
}
