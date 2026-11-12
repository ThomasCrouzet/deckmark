import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce', serviceWorkers: 'block' });

const FOCUSABLE =
	'a[href], button:not([disabled]), summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface FocusSnapshot {
	tag: string | null;
	ariaLabel: string | null;
	text: string | null;
	testId: string | null;
	dialogTestId: string | null;
	inInert: boolean;
}

async function focusSnapshot(page: Page): Promise<FocusSnapshot> {
	return page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		const dialog = el?.closest('[role="dialog"]') as HTMLElement | null;
		return {
			tag: el?.tagName ?? null,
			ariaLabel: el?.getAttribute('aria-label') ?? null,
			text: (el?.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) || null,
			testId: el?.getAttribute('data-testid') ?? null,
			dialogTestId: dialog?.getAttribute('data-testid') ?? null,
			inInert: Boolean(el?.closest('[inert]'))
		};
	});
}

async function openPanel(page: Page, option: RegExp, testId: string): Promise<void> {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: option })
		.click();
	await expect(page.getByTestId(testId)).toBeVisible();
}

function closeButton(page: Page, testId: string) {
	return page.getByTestId(testId).locator('header button').first();
}

const panels = [
	{ name: 'Collections', option: /vues tableau/i, testId: 'collection-panel' },
	{ name: 'Export Profiles', option: /profils d’export/i, testId: 'export-profiles' },
	{ name: 'Frontmatter', option: /propriétés du document/i, testId: 'frontmatter-panel' },
	{ name: 'Linked Blocks', option: /blocs de contenu liés/i, testId: 'linked-blocks-panel' },
	{ name: 'AI', option: /assistant IA/i, testId: 'ai-panel' }
];

for (const panel of panels) {
	test(`${panel.name} moves initial focus into its foreground dialog on open`, async ({
		page
	}, info: TestInfo) => {
		if (panel.testId === 'ai-panel') {
			await page.addInitScript(() => {
				localStorage.setItem(
					'mdsh:ai',
					JSON.stringify({
						enabled: true,
						privacyMode: 'direct',
						allowBrowserKey: true,
						baseUrl: 'https://mock.local/v1',
						model: 'mock-model',
						temperature: 0.2,
						maxTokens: 24000
					})
				);
			});
		}
		await resetAppState(page);
		await createFirstFile(page);
		await writeSourceContent(page, '---\ntitle: Focus\nstatus: draft\n---\n\n# Focus\n');
		const before = await focusSnapshot(page);

		await openPanel(page, panel.option, panel.testId);
		await expect(closeButton(page, panel.testId)).toBeFocused();
		const after = await focusSnapshot(page);

		expect(after.dialogTestId).toBe(panel.testId);
		expect(after.inInert).toBe(false);
		expect(after.ariaLabel).toBe('Fermer');
		await expect(page.locator('.mdsh-shell')).toHaveAttribute('inert');

		await info.attach('initial-focus.json', {
			body: JSON.stringify({ panel: panel.name, before, after }, null, 2),
			contentType: 'application/json'
		});
	});
}

test('Collections wraps Tab and Shift+Tab from the shared trap', async ({ page }) => {
	await resetAppState(page);
	await createFirstFile(page);
	await openPanel(page, /vues tableau/i, 'collection-panel');
	const close = closeButton(page, 'collection-panel');
	await expect(close).toBeFocused();

	const last = await page.evaluate((selector) => {
		const panel = document.querySelector('[data-testid="collection-panel"]');
		if (!panel) return null;
		const elements = Array.from(panel.querySelectorAll<HTMLElement>(selector)).filter((el) => {
			const style = getComputedStyle(el);
			return (
				el.tabIndex >= 0 &&
				el.getAttribute('aria-hidden') !== 'true' &&
				style.display !== 'none' &&
				style.visibility !== 'hidden' &&
				el.getClientRects().length > 0 &&
				!el.closest('[inert]')
			);
		});
		const target = elements.at(-1);
		if (!target) return null;
		target.setAttribute('data-focus-probe-last', 'true');
		target.focus();
		return { count: elements.length, tag: target.tagName, text: target.textContent?.trim() };
	}, FOCUSABLE);
	expect(last).not.toBeNull();
	expect(last?.count ?? 0).toBeGreaterThan(1);
	expect(await focusSnapshot(page)).toMatchObject({ dialogTestId: 'collection-panel' });

	await page.keyboard.press('Tab');
	await expect(close).toBeFocused();

	await page.keyboard.press('Shift+Tab');
	await expect(page.locator('[data-focus-probe-last="true"]')).toBeFocused();
});

test('closing a dialog opened from a visible control restores that control', async ({ page }) => {
	await resetAppState(page);
	const trigger = page.getByTestId('projects-open');
	await trigger.click();
	const dialog = page.getByRole('dialog', { name: 'Projets Markdown' });
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('header button').first()).toBeFocused();

	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
});

test('rapid close and reopen leaves no stale focus or page error', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await resetAppState(page);
	await createFirstFile(page);

	await openPanel(page, /vues tableau/i, 'collection-panel');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('collection-panel')).toHaveCount(0);

	await openPanel(page, /profils d’export/i, 'export-profiles');
	await expect(closeButton(page, 'export-profiles')).toBeFocused();

	await page.keyboard.press('Escape');
	await expect(page.getByTestId('export-profiles')).toHaveCount(0);

	await openPanel(page, /vues tableau/i, 'collection-panel');
	await expect(closeButton(page, 'collection-panel')).toBeFocused();
	expect(errors).toEqual([]);
});

test('a nested prompt keeps the lower dialog open and restores its control', async ({ page }) => {
	await resetAppState(page);
	await page.getByTestId('projects-open').click();
	const projects = page.getByRole('dialog', { name: 'Projets Markdown' });
	await expect(projects).toBeVisible();

	const newProject = projects.getByRole('button', { name: 'Nouveau projet' });
	await newProject.click();
	const prompt = page.getByRole('dialog', { name: 'Nom du projet' });
	await expect(prompt).toBeVisible();
	await expect(prompt.locator('input')).toBeFocused();

	await page.keyboard.press('Escape');
	await expect(prompt).toHaveCount(0);
	await expect(projects).toBeVisible();
	await expect(newProject).toBeFocused();
});

test('a delayed lazy panel receives initial focus after its chunk resolves', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);

	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	let paused = false;
	await page.route('**/_app/immutable/**/*.js', async (route) => {
		const response = await route.fetch();
		if (!paused && (await response.text()).includes('linked-blocks-panel')) {
			paused = true;
			await gate;
		}
		await route.fulfill({ response });
	});

	try {
		await openPalette(page);
		await page
			.getByRole('dialog', { name: 'Palette de commandes' })
			.getByRole('option', { name: /blocs de contenu liés/i })
			.click();
		await expect.poll(() => paused, { timeout: 10_000 }).toBe(true);
		await expect(page.getByTestId('linked-blocks-panel')).toHaveCount(0);
		release();
		await expect(page.getByTestId('linked-blocks-panel')).toBeVisible();
		await expect(closeButton(page, 'linked-blocks-panel')).toBeFocused();
		const snapshot = await focusSnapshot(page);
		expect(snapshot).toMatchObject({
			dialogTestId: 'linked-blocks-panel',
			ariaLabel: 'Fermer',
			inInert: false
		});
		await info.attach('delayed-lazy-focus.json', {
			body: JSON.stringify({ paused, snapshot }, null, 2),
			contentType: 'application/json'
		});
	} finally {
		release();
	}
});
