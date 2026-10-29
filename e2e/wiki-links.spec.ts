import { test, expect } from '@playwright/test';
import { resetAppState, seedFiles } from './helpers';

test.describe('Wiki-links navigation + backlinks', () => {
	test.beforeEach(async ({ page }) => {
		await resetAppState(page);
	});

	test('keeps wiki links and literals after visual edit', async ({ page }, testInfo) => {
		const frontmatter = "---\nnote: '[[Metadata|literal YAML]]'\n---\n";
		const source = [
			frontmatter,
			'# Field notes',
			'',
			String.raw`See [[Ideas|idea list]] and [[Diagrams]]. Literal: \[[Ideas|idea list]].`,
			'',
			String.raw`Escaped: \[[Ideas|idea list]] and \[\[Diagrams\]\].`,
			'',
			'Inline code: `[[Ideas|idea list]]` and ``[[Diagrams]]``.',
			'',
			'```md',
			'[[Ideas|idea list]]',
			String.raw`\[[Diagrams]]`,
			'```',
			'',
			'    [[Ideas|indented example]]',
			'',
			'Edit this paragraph.',
			''
		].join('\n');
		await seedFiles(page, [
			{ name: 'Ideas', content: '# Ideas\n\nTarget for the alias.\n' },
			{ name: 'Diagrams', content: '# Diagrams\n\nTarget for the plain link.\n' },
			{ name: 'field-notes', content: source }
		]);

		const preview = page.locator('.mdsh-preview');
		const verifyReading = async () => {
			await expect(preview.locator('a.wiki-link')).toHaveCount(2);
			await expect(preview.locator('a[data-mdsh-wiki="Ideas"]')).toHaveText('idea list');
			await expect(preview.locator('a[data-mdsh-wiki="Diagrams"]')).toHaveText('Diagrams');
			const escaped = preview.locator('p').filter({ hasText: 'Escaped:' });
			await expect(escaped).toHaveText('Escaped: [[Ideas|idea list]] and [[Diagrams]].');
			await expect(escaped.locator('a')).toHaveCount(0);
			const inline = preview.locator('p').filter({ hasText: 'Inline code:' });
			await expect(inline.locator('code')).toHaveText(['[[Ideas|idea list]]', '[[Diagrams]]']);
			await expect(preview.locator('pre code')).toHaveText([
				'[[Ideas|idea list]]\n\\[[Diagrams]]\n',
				'[[Ideas|indented example]]\n'
			]);
			await expect(preview.locator('code a')).toHaveCount(0);
		};

		await page.locator('button[data-mode="read"]').click();
		await verifyReading();
		await page.locator('button[data-mode="wysiwyg"]').click();
		const paragraph = page.locator('.ProseMirror > p').filter({ hasText: 'Edit this paragraph.' });
		await expect(paragraph).toBeVisible();
		await paragraph.click();
		await page.keyboard.press('End');
		await page.keyboard.insertText(' Saved from the visual editor.');
		await page.locator('button[data-mode="read"]').click();
		await expect(preview).toContainText('Saved from the visual editor.');
		await verifyReading();

		// Wait for the 400 ms save delay before the reload. A reload during the
		// delay can keep the previous draft and hide a real persistence failure.
		await expect(page.locator('#app-statusbar')).toContainText('Brouillons locaux : enregistré');
		await page.reload();
		await expect(preview).toContainText('Saved from the visual editor.');
		await verifyReading();
		await testInfo.attach('wiki-links-after-reload.png', {
			body: await page.screenshot({ fullPage: true }),
			contentType: 'image/png'
		});

		const nameInput = page.locator('input[aria-label^="Nom du fichier"]');
		for (const target of ['Ideas', 'Diagrams']) {
			await preview.locator(`a[data-mdsh-wiki="${target}"]`).click();
			await expect(nameInput).toHaveValue(target);
			const backlinks = page.locator('aside [aria-label="Backlinks"]');
			await expect(backlinks).toContainText('Field notes');
			await backlinks.getByRole('button', { name: /Field notes/ }).click();
			await verifyReading();
		}

		await page.locator('button[data-mode="source"]').click();
		const editor = page.locator('.cm-content').first();
		await expect(editor).toContainText('See [[Ideas|idea list]] and [[Diagrams]].');
		const saved = await editor.innerText();
		expect(saved.startsWith(frontmatter)).toBe(true);
		await testInfo.attach('wiki-links-round-trip.md', {
			body: saved,
			contentType: 'text/markdown'
		});
	});

	test('saves wiki links typed and edited in visual mode', async ({ page }, testInfo) => {
		await seedFiles(page, [
			{ name: 'Ideas', content: '# Ideas\n' },
			{ name: 'visual-links', content: '# Visual links\n\nSee here.\n' }
		]);
		await page.locator('button[data-mode="wysiwyg"]').click();
		const paragraph = page.locator('.ProseMirror > p').filter({ hasText: 'See here.' });
		await paragraph.click();
		await page.keyboard.press('End');
		await page.keyboard.type(' [[Ideas|old alias]]');
		const wiki = paragraph.locator('[data-mdsh-wiki-link]');
		await expect(wiki).toHaveText('[[Ideas|old alias]]');
		// Mark boundaries can consume an arrow key without moving the selection.
		await wiki.evaluate((element, alias) => {
			const nodes = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
				if (!(node instanceof Text)) continue;
				const start = node.data.indexOf(alias);
				if (start < 0) continue;
				const range = document.createRange();
				range.setStart(node, start);
				range.setEnd(node, start + alias.length);
				const selection = window.getSelection();
				if (!selection) throw new Error('Text selection is unavailable');
				selection.removeAllRanges();
				selection.addRange(range);
				return;
			}
			throw new Error('The wiki alias text is missing');
		}, 'old alias');
		await expect
			.poll(() => page.evaluate(() => window.getSelection()?.toString()))
			.toBe('old alias');
		await testInfo.attach('wiki-alias-selection.json', {
			body: JSON.stringify({
				selectedText: await page.evaluate(() => window.getSelection()?.toString())
			}),
			contentType: 'application/json'
		});
		await page.keyboard.insertText('new alias');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.type('[[Ideas|second alias]]');
		await page.locator('button[data-mode="source"]').click();
		await expect(page.locator('.cm-content').first()).toContainText(
			'[[Ideas|new alias]][[Ideas|second alias]]'
		);
		await page.locator('button[data-mode="wysiwyg"]').click();
		await expect(page.locator('.ProseMirror')).toContainText('[[Ideas|new alias]]');
		await page.locator('button[data-mode="read"]').click();
		const link = page.locator('.mdsh-preview a[data-mdsh-wiki="Ideas"]');
		await expect(link).toHaveText(['new alias', 'second alias']);
		await link.first().click();
		await expect(page.locator('input[aria-label^="Nom du fichier"]')).toHaveValue('Ideas');
		await testInfo.attach('visual-wiki-navigation.png', {
			body: await page.screenshot({ fullPage: true }),
			contentType: 'image/png'
		});
	});

	test('opens the Alice file from `[[Alice]]` in read mode', async ({ page }) => {
		await seedFiles(page, [
			{ name: 'alice', content: '# Alice\n\nContenu de Alice.\n' },
			{ name: 'bob', content: '# Bob\n\nBob référence [[alice]].\n' }
		]);
		// Bob is active because it was seeded last. Select read mode to render the wiki link.
		await page.locator('button[data-mode="read"]').click();
		const wiki = page.locator('.mdsh-preview a.wiki-link[data-mdsh-wiki]').first();
		await expect(wiki).toBeVisible({ timeout: 10_000 });
		await wiki.click();
		// The active file changes to "alice", and the toolbar shows its name.
		const nameInput = page.locator('input[aria-label^="Nom du fichier"]');
		await expect(nameInput).toHaveValue('alice', { timeout: 5000 });
	});

	test('lists incoming files in the sidebar Backlinks section', async ({ page }) => {
		await seedFiles(page, [
			// Create the target first. ref-a and ref-b link to it.
			{ name: 'cible', content: '# Cible\n\nFichier référencé.\n' },
			{ name: 'ref-a', content: '# Ref A\n\nVoir [[cible]].\n' },
			{ name: 'ref-b', content: '# Ref B\n\nAussi [[cible]].\n' }
		]);
		// Activate "cible" to show its backlinks in the sidebar.
		await page.locator('aside button[aria-label^="cible"]').first().click();
		const backlinksSection = page.locator('aside [aria-label="Backlinks"]');
		await expect(backlinksSection).toBeVisible({ timeout: 5000 });
		await expect(backlinksSection.getByText('ref-a')).toBeVisible();
		await expect(backlinksSection.getByText('ref-b')).toBeVisible();
	});
});
