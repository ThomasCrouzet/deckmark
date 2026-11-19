import { createHash } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { resetAppState } from './helpers';

// Lane W2 (issue #709): paint containment follows the rendered structure, not
// only the 256 KiB source threshold. A note under that threshold can build tens
// of thousands of rendered elements and pay a full layout pass per keystroke.
// These cases prove the gate, the per-block intrinsic sizes and the visible
// stability while offscreen blocks render.

const noteId = 'containment-structure';

function tableSection(index: number): string {
	return [
		`## Table ${index}`,
		'',
		'| Lot | Owner | Share | Amount | Status |',
		'| --- | --- | --- | --- | --- |',
		...Array.from(
			{ length: 6 },
			(_, row) =>
				`| ${index}-${row} | M. Dupont ${row} | ${(row + 1) * 137} / 10000 | ${
					(row + 1) * 214.5
				} EUR | validated |`
		),
		'',
		'Closing line for the table block.'
	].join('\n');
}

/** Tables under the source threshold with a rendered tree above the budget. */
function tallTables(sections: number): string {
	return `${Array.from({ length: sections }, (_, index) => tableSection(index)).join('\n\n')}\n`;
}

/** Plain prose under the 256 KiB source threshold with a very small tree. */
function longProse(bytes: number): string {
	const sentence =
		'A shared note keeps the same words in every run so a measurement stays comparable. The paragraph is long enough to keep the block count low. ';
	let content = '# Long prose note\n\n';
	let index = 0;
	while (content.length < bytes) {
		content += `${sentence.repeat(3)}\n\n`;
		index += 1;
		if (index % 40 === 0) content += `## Section ${index}\n\n`;
	}
	return content;
}

/** Many small blocks under the source threshold and under the element budget. */
function manyParagraphs(paragraphs: number): string {
	return `${Array.from(
		{ length: paragraphs },
		(_, index) => `Short paragraph ${index} keeps one measured line of text.`
	).join('\n\n')}\n`;
}

async function seedNote(page: Page, content: string, id = noteId) {
	await page.evaluate(
		async ({ id: rowId, source }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const transaction = database.transaction('drafts', 'readwrite');
					transaction.objectStore('drafts').put({
						id: rowId,
						name: `${rowId}.md`,
						content: source,
						createdAt: 1_700_000_000_000,
						updatedAt: 1_700_000_000_000,
						order: 0,
						open: true
					});
					transaction.oncomplete = () => {
						database.close();
						resolve();
					};
					transaction.onerror = () => reject(transaction.error);
				};
			});
			localStorage.setItem('mdsh:activeId', rowId);
			localStorage.setItem('mdsh:mode', 'wysiwyg');
		},
		{ id, source: content }
	);
}

async function openVisualEditor(page: Page) {
	await page.locator('[data-mode=wysiwyg]').click();
	const dialog = page.getByRole('dialog', {
		name: /Render this large document|Afficher ce document volumineux/
	});
	await dialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
	if (await dialog.isVisible().catch(() => false)) {
		await dialog.getByRole('button', { name: /Render document|Afficher ce document/ }).click();
	}
	await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true', {
		timeout: 180_000
	});
}

const nextFrames = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);

type GateState = {
	elements: number;
	topLevelBlocks: number;
	longDocument: boolean;
	contentVisibility: string;
	containmentRules: number;
	tableIntrinsicSize: string;
};

async function gateState(page: Page): Promise<GateState> {
	return page.evaluate(() => {
		const host = document.querySelector<HTMLElement>('.mdsh-editor');
		const root = document.querySelector<HTMLElement>('.milkdown .ProseMirror');
		const children = root ? [...root.children] : [];
		const first = children[0] as HTMLElement | undefined;
		const table = children.find((child) => child.querySelector('table')) as HTMLElement | undefined;
		const sheet = document.querySelector<HTMLStyleElement>('style[data-mdsh-containment]');
		return {
			elements: root ? root.getElementsByTagName('*').length : 0,
			topLevelBlocks: children.length,
			longDocument: Boolean(host?.classList.contains('mdsh-long-document')),
			contentVisibility: first ? getComputedStyle(first).contentVisibility : 'missing',
			containmentRules: sheet?.sheet?.cssRules.length ?? 0,
			tableIntrinsicSize: table ? getComputedStyle(table).containIntrinsicSize : 'missing'
		};
	});
}

type ScrollCheck = {
	ratio: number;
	requested: number;
	settled: number;
	height: number;
	anchorText: string;
	anchorShift: number | null;
};

/**
 * Scrolls to one document ratio, then waits for the offscreen blocks to render
 * and reports how far the block under the viewport centre moved on screen.
 */
async function scrollCheck(page: Page, ratio: number): Promise<ScrollCheck> {
	const before = await page.evaluate((target) => {
		const host = document.querySelector<HTMLElement>('.mdsh-editor');
		if (!host) throw new Error('missing scroll region');
		const requested = Math.round((host.scrollHeight - host.clientHeight) * target);
		host.scrollTop = requested;
		return { requested, height: host.scrollHeight };
	}, ratio);
	await nextFrames(page);
	// The block is remembered by its document index: the editor can replace the
	// element while the offscreen blocks render.
	const anchor = await page.evaluate(() => {
		const host = document.querySelector<HTMLElement>('.mdsh-editor');
		const root = document.querySelector<HTMLElement>('.milkdown .ProseMirror');
		if (!host || !root) throw new Error('missing scroll region');
		const box = host.getBoundingClientRect();
		const middle = box.top + host.clientHeight / 2;
		const element = document.elementFromPoint(box.left + box.width / 2, middle);
		const children = [...root.children];
		// The centre can fall in the margin gap between two blocks, where the hit
		// test returns the editor root. Then the nearest block is the anchor.
		const gaps = children.map((child) => ({
			child,
			rect: child.getBoundingClientRect()
		}));
		const nearest = gaps.reduce<{ child: Element; rect: DOMRect } | null>(
			(best, entry) =>
				!best || Math.abs(entry.rect.top - middle) < Math.abs(best.rect.top - middle)
					? entry
					: best,
			null
		);
		const block =
			element?.closest('.milkdown .ProseMirror > *') ??
			gaps.find((entry) => entry.rect.top <= middle && entry.rect.bottom >= middle)?.child ??
			nearest?.child ??
			null;
		if (!block) return { index: -1, top: null, text: '' };
		return {
			index: [...root.children].indexOf(block),
			top: block.getBoundingClientRect().top,
			text: (block.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 48)
		};
	});
	await page.waitForTimeout(600);
	await nextFrames(page);
	const settled = await page.evaluate((index) => {
		const host = document.querySelector<HTMLElement>('.mdsh-editor');
		const root = document.querySelector<HTMLElement>('.milkdown .ProseMirror');
		if (!host || !root) throw new Error('missing scroll region');
		const block = index < 0 ? null : (root.children[index] ?? null);
		return {
			top: block ? block.getBoundingClientRect().top : null,
			scrollTop: Math.round(host.scrollTop),
			height: host.scrollHeight
		};
	}, anchor.index);
	return {
		ratio,
		requested: before.requested,
		settled: settled.scrollTop,
		height: settled.height,
		anchorText: anchor.text,
		anchorShift:
			anchor.top === null || settled.top === null
				? null
				: Number((settled.top - anchor.top).toFixed(2))
	};
}

async function attachEvidence(
	info: TestInfo,
	page: Page,
	label: string,
	payload: Record<string, unknown>
) {
	await info.attach(`${label}.json`, {
		body: JSON.stringify(
			{
				...info.config.metadata,
				browser: info.project.name,
				browserVersion: page.context().browser()?.version(),
				...payload
			},
			null,
			2
		),
		contentType: 'application/json'
	});
	await info.attach(`${label}.png`, {
		body: await page.screenshot(),
		contentType: 'image/png'
	});
}

test.describe('rendered-structure paint containment', () => {
	test.use({ colorScheme: 'light' });

	test('contains a tall table note and keeps the visible block in place', async ({
		page
	}, info) => {
		test.setTimeout(240_000);
		const fixture = tallTables(60);
		expect(fixture.length).toBeLessThan(256 * 1024);
		await resetAppState(page, { mode: 'source' });
		await seedNote(page, fixture);
		await page.reload();
		await openVisualEditor(page);
		await page.waitForTimeout(700);

		const gate = await gateState(page);
		expect(gate.longDocument, 'the rendered tree selects containment').toBe(true);
		expect(gate.elements).toBeGreaterThanOrEqual(4000);
		expect(gate.contentVisibility).toBe('auto');
		// The measured sizes live in a generated sheet, not in inline styles: the
		// editor re-renders a block whose style attribute changes.
		expect(gate.containmentRules).toBeGreaterThan(100);
		expect(gate.tableIntrinsicSize).toMatch(/^auto [0-9.]+px$/);

		const checks: ScrollCheck[] = [];
		for (const ratio of [0.25, 0.5, 0.75, 0.95, 0.6, 0.25]) {
			checks.push(await scrollCheck(page, ratio));
		}
		for (const check of checks) {
			expect(check.requested).toBeGreaterThan(0);
			expect(
				check.anchorShift,
				`the visible block stays in place at ratio ${check.ratio} (${check.anchorText})`
			).not.toBeNull();
			expect(
				Math.abs(check.anchorShift ?? 999),
				`the visible block stays in place at ratio ${check.ratio} (${check.anchorText})`
			).toBeLessThanOrEqual(2);
		}
		const startHeight = checks[0]?.height ?? 0;
		const endHeight = checks[checks.length - 1]?.height ?? 0;
		expect(
			Math.abs(endHeight - startHeight) / Math.max(startHeight, 1),
			'the pinned sizes keep the document height stable'
		).toBeLessThan(0.02);

		await attachEvidence(info, page, 'containment-tall-tables', {
			fixture: {
				bytes: fixture.length,
				sections: 60,
				sha256: createHash('sha256').update(fixture).digest('hex')
			},
			gate,
			scrollChecks: checks
		});
	});

	test('keeps a 200 KB prose note out of containment', async ({ page }, info) => {
		test.setTimeout(240_000);
		const fixture = longProse(200 * 1024);
		await resetAppState(page, { mode: 'source' });
		await seedNote(page, fixture);
		await page.reload();
		await openVisualEditor(page);
		await page.waitForTimeout(700);

		const gate = await gateState(page);
		expect(gate.longDocument, 'a 200 KB prose note keeps the short policy').toBe(false);
		expect(gate.contentVisibility).toBe('visible');
		expect(gate.containmentRules).toBe(0);

		await attachEvidence(info, page, 'containment-prose-200kb', {
			fixture: { bytes: fixture.length },
			gate
		});
	});

	test('selects containment from the top-level block count', async ({ page }, info) => {
		test.setTimeout(180_000);
		const fixture = manyParagraphs(900);
		expect(fixture.length).toBeLessThan(256 * 1024);
		await resetAppState(page, { mode: 'source' });
		await seedNote(page, fixture);
		await page.reload();
		await openVisualEditor(page);
		await page.waitForTimeout(700);

		const gate = await gateState(page);
		expect(gate.elements, 'the element budget stays below its threshold').toBeLessThan(4000);
		expect(gate.topLevelBlocks).toBeGreaterThanOrEqual(800);
		expect(gate.longDocument, 'the block count selects containment').toBe(true);
		expect(gate.contentVisibility).toBe('auto');

		await attachEvidence(info, page, 'containment-block-count', {
			fixture: { bytes: fixture.length, paragraphs: 900 },
			gate
		});
	});
});
