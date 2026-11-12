import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createFirstFile, openPalette, resetAppState, writeSourceContent } from './helpers';

test.use({ locale: 'en-US', reducedMotion: 'reduce' });

const STORAGE_KEY = 'mdsh:export-profiles';
const ACTIVE_KEY = 'mdsh:export-profile-active';

async function openProfiles(page: Page) {
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /profils d’export/i })
		.click();
	await expect(page.getByTestId('export-profiles')).toBeVisible();
}

function profile(id: string, name: string, patch: Record<string, unknown> = {}) {
	return {
		id,
		name,
		format: 'html',
		pageSize: 'A4',
		marginMm: 18,
		fontFamily: 'serif',
		fontSizePt: 11,
		includeCover: false,
		header: '',
		footer: '',
		createdAt: 1,
		updatedAt: 1,
		...patch
	};
}

function profileFile(profiles: unknown[]) {
	return {
		name: 'profiles.json',
		mimeType: 'application/json',
		buffer: Buffer.from(
			JSON.stringify({ format: 'mdsh-export-profiles', schemaVersion: 1, profiles })
		)
	};
}

async function importProfiles(page: Page, profiles: unknown[]) {
	await page.getByTestId('export-profiles-import').setInputFiles(profileFile(profiles));
}

async function storedState(page: Page) {
	return page.evaluate(
		([collection, active]) => ({
			collection: localStorage.getItem(collection),
			active: localStorage.getItem(active)
		}),
		[STORAGE_KEY, ACTIVE_KEY]
	);
}

function profileOptions(page: Page) {
	return page
		.getByTestId('export-profiles')
		.getByRole('listbox', { name: 'Profils d’export' })
		.getByRole('option');
}

async function profileNames(page: Page) {
	return profileOptions(page).allTextContents();
}

test('applies a reusable profile to HTML exports deterministically', async ({
	page
}, info: TestInfo) => {
	await resetAppState(page);
	await createFirstFile(page);
	await writeSourceContent(page, '# Profile test\n\nBody text.\n');
	await openProfiles(page);
	await page.getByTestId('export-profile-name').fill('Letter handoff');
	await page.getByTestId('export-profile-page-size').selectOption('Letter');
	await page.getByTestId('export-profile-header').fill('Project header');
	await page.getByTestId('export-profile-footer').fill('Page footer');
	await page.getByTestId('export-profile-cover').check();
	await page.getByTestId('export-profile-use').click();
	await expect(page.getByTestId('export-profile-use')).toContainText('Utilisé');
	await page.keyboard.press('Escape');

	const downloadPromise = page.waitForEvent('download');
	await openPalette(page);
	await page
		.getByRole('dialog', { name: 'Palette de commandes' })
		.getByRole('option', { name: /Exporter en HTML/i })
		.click();
	const download = await downloadPromise;
	const html = await readFile((await download.path())!, 'utf8');
	expect(html).toContain('data-export-profile=');
	expect(html).toContain('size: Letter');
	expect(html).toContain('Project header');
	expect(html).toContain('Page footer');
	expect(html).toContain('export-profile-cover');

	await info.attach('export-profile.html', { body: html, contentType: 'text/html' });
	await info.attach('export-profile.json', {
		body: JSON.stringify({ pageSize: 'Letter', header: true, footer: true, cover: true }),
		contentType: 'application/json'
	});
});

test('rejects empty, duplicate and oversized imports before changing stored state', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await openProfiles(page);
	await page.getByTestId('export-profile-name').fill('Survivor profile');
	const before = await storedState(page);
	const namesBefore = await profileNames(page);
	expect(before.collection).toBeTruthy();
	const cases = [
		{ label: 'empty', profiles: [], message: /aucun profil/i },
		{
			label: 'duplicate',
			profiles: [profile('same', 'First'), profile('same', 'Second')],
			message: /même identifiant/i
		},
		{
			label: 'invalid',
			profiles: [profile('too-margin', 'Too wide', { marginMm: 999 })],
			message: /valeur non valide/i
		},
		{
			label: 'oversized',
			profiles: [profile('large', 'Large')],
			message: /trop volumineux/i,
			padding: 'x'.repeat(600_000)
		}
	];
	for (const item of cases) {
		const payload = item.padding
			? {
					name: 'profiles.json',
					mimeType: 'application/json',
					buffer: Buffer.from(
						JSON.stringify({
							format: 'mdsh-export-profiles',
							schemaVersion: 1,
							profiles: item.profiles,
							padding: item.padding
						})
					)
				}
			: profileFile(item.profiles);
		await page.getByTestId('export-profiles-import').setInputFiles(payload);
		const error = page.getByTestId('export-profiles-error');
		await expect(error).toBeVisible();
		await expect(error).toHaveText(item.message);
		expect(await storedState(page)).toEqual(before);
		expect(await profileNames(page)).toEqual(namesBefore);
		await expect(page.getByTestId('export-profile-name')).toHaveValue('Survivor profile');
	}

	await info.attach('export-profile-rejections.json', {
		body: JSON.stringify({ cases: cases.map((item) => item.label), stored: before }, null, 2),
		contentType: 'application/json'
	});
});

test('imports unique identifiers and keeps one editable profile per row', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await openProfiles(page);
	await importProfiles(page, [
		profile('builtin:a4-document', 'Imported A4'),
		profile('report-b', 'Imported Report')
	]);
	await expect(page.getByTestId('export-profiles-error')).toHaveCount(0);
	await expect(profileOptions(page)).toHaveCount(2);
	expect(await profileNames(page)).toEqual([
		expect.stringContaining('Imported A4'),
		expect.stringContaining('Imported Report')
	]);
	const state = await storedState(page);
	expect(state.active).toBe('builtin:a4-document');
	await expect(page.getByTestId('export-profile-use')).toContainText('Utilisé');

	await page
		.getByTestId('export-profiles')
		.getByRole('option', { name: /Imported A4/ })
		.click();
	await page.getByTestId('export-profile-name').fill('Only A4 changed');
	await expect(profileOptions(page).filter({ hasText: 'Only A4 changed' })).toHaveCount(1);
	await expect(profileOptions(page).filter({ hasText: 'Imported Report' })).toHaveCount(1);
	const stored = JSON.parse((await storedState(page)).collection!) as Array<{
		id: string;
		name: string;
	}>;
	expect(stored.map((entry) => entry.id)).toEqual(['builtin:a4-document', 'report-b']);
	expect(stored.map((entry) => entry.name)).toEqual(['Only A4 changed', 'Imported Report']);

	await importProfiles(page, [
		profile('report-b', 'Kept Report'),
		profile('report-c', 'Third Report')
	]);
	await expect(page.getByTestId('export-profiles-error')).toHaveCount(0);
	await expect(profileOptions(page)).toHaveCount(2);
	await expect(profileOptions(page).filter({ hasText: 'Kept Report' })).toHaveCount(1);
	// The previous active profile is absent from the new file, so the first
	// imported profile becomes the active and selected fallback.
	expect((await storedState(page)).active).toBe('report-b');
	await expect(page.getByTestId('export-profile-use')).toContainText('Utilisé');

	await info.attach('export-profile-import.json', {
		body: JSON.stringify({ ids: stored.map((entry) => entry.id), active: 'report-b' }, null, 2),
		contentType: 'application/json'
	});
});

test('keeps the previous collection when the active selection cannot be saved', async ({
	page
}) => {
	await resetAppState(page);
	await createFirstFile(page);
	await page.addInitScript(() => {
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (
				key === 'mdsh:export-profile-active' &&
				(window as unknown as { __MDSH_FAIL_PROFILE_ACTIVE__?: boolean })
					.__MDSH_FAIL_PROFILE_ACTIVE__
			)
				throw new DOMException('quota', 'QuotaExceededError');
			return original.call(this, key, value);
		};
	});
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	await openProfiles(page);
	await page.getByTestId('export-profile-name').fill('Survivor profile');
	await page.getByTestId('export-profile-use').click();
	const before = await storedState(page);

	await page.evaluate(() => {
		(window as unknown as { __MDSH_FAIL_PROFILE_ACTIVE__?: boolean }).__MDSH_FAIL_PROFILE_ACTIVE__ =
			true;
	});
	await importProfiles(page, [profile('new-a', 'New A'), profile('new-b', 'New B')]);
	await expect(page.getByTestId('export-profiles-error')).toBeVisible();
	expect(await storedState(page)).toEqual(before);
	await expect(profileOptions(page)).toHaveCount(2);
	await expect(profileOptions(page).filter({ hasText: 'Survivor profile' })).toHaveCount(1);
	await expect(page.getByTestId('export-profile-name')).toHaveValue('Survivor profile');

	await page.evaluate(() => {
		(window as unknown as { __MDSH_FAIL_PROFILE_ACTIVE__?: boolean }).__MDSH_FAIL_PROFILE_ACTIVE__ =
			false;
	});
	await importProfiles(page, [profile('new-a', 'New A'), profile('new-b', 'New B')]);
	await expect(page.getByTestId('export-profiles-error')).toHaveCount(0);
	await expect(profileOptions(page)).toHaveCount(2);
	expect((await storedState(page)).active).toBe('new-a');
});

test('moves the profile selection with arrows and keeps one Tab stop', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await openProfiles(page);
	const dialog = page.getByTestId('export-profiles');
	const listbox = page.getByRole('listbox', { name: 'Profils d’export' });
	const close = dialog.getByRole('button', { name: 'Fermer' });
	const name = page.getByTestId('export-profile-name');
	const entries = Array.from({ length: 100 }, (_, index) =>
		profile(`p${index}`, `Profile ${index + 1}`)
	);
	await importProfiles(page, entries.slice(0, 30));
	await expect(profileOptions(page)).toHaveCount(30);

	await close.focus();
	await page.keyboard.press('Tab');
	await expect(listbox).toBeFocused();
	expect(await listbox.getAttribute('tabindex')).toBe('0');
	expect(
		await profileOptions(page).evaluateAll((nodes) => nodes.map((node) => node.tabIndex))
	).toEqual(Array.from({ length: 30 }, () => -1));
	await expect(profileOptions(page).nth(0)).toHaveAttribute('aria-selected', 'true');

	await page.keyboard.press('ArrowDown');
	await expect(profileOptions(page).nth(1)).toHaveAttribute('aria-selected', 'true');
	await expect(profileOptions(page).nth(0)).toHaveAttribute('aria-selected', 'false');
	await expect(name).toHaveValue('Profile 2');
	expect(await page.evaluate(() => localStorage.getItem('mdsh:export-profile-active'))).toBe('p0');

	await page.keyboard.press('End');
	await expect(profileOptions(page).nth(29)).toHaveAttribute('aria-selected', 'true');
	await expect(name).toHaveValue('Profile 30');
	await page.keyboard.press('Home');
	await expect(profileOptions(page).nth(0)).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('ArrowUp');
	await expect(profileOptions(page).nth(0)).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('ArrowDown');
	await expect(profileOptions(page).nth(1)).toHaveAttribute('aria-selected', 'true');

	const activeDescendant = await listbox.getAttribute('aria-activedescendant');
	expect(activeDescendant).toBeTruthy();
	expect(await page.locator(`#${activeDescendant}`).getAttribute('aria-selected')).toBe('true');

	await page.keyboard.press('Tab');
	await expect(name).toBeFocused();

	const traversal: Array<{ count: number; tabsToForm: number }> = [];
	for (const count of [1, 2, 100]) {
		await importProfiles(page, entries.slice(0, count));
		await expect(profileOptions(page)).toHaveCount(count);
		await close.focus();
		await page.keyboard.press('Tab');
		await expect(listbox).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Tab');
		await expect(name).toBeFocused();
		traversal.push({ count, tabsToForm: 1 });
		expect(
			await profileOptions(page).evaluateAll((nodes) => nodes.map((node) => node.tabIndex))
		).toEqual(Array.from({ length: count }, () => -1));
	}

	await info.attach('export-profile-listbox-navigation.json', {
		body: JSON.stringify(
			{
				optionCount: 30,
				activeBeforeKeyboard: 'p0',
				activeDescendant,
				traversal
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('keeps selection and focus coherent after profile changes', async ({ page }, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await openProfiles(page);
	const dialog = page.getByTestId('export-profiles');
	const listbox = page.getByRole('listbox', { name: 'Profils d’export' });
	const name = page.getByTestId('export-profile-name');
	await importProfiles(
		page,
		Array.from({ length: 5 }, (_, index) => profile(`p${index}`, `Profile ${index + 1}`))
	);
	await expect(profileOptions(page)).toHaveCount(5);

	await profileOptions(page).nth(3).click();
	await expect(profileOptions(page).nth(3)).toHaveAttribute('aria-selected', 'true');
	await expect(name).toHaveValue('Profile 4');
	await expect(listbox).toBeFocused();
	expect(await page.evaluate(() => localStorage.getItem('mdsh:export-profile-active'))).toBe('p0');

	await name.fill('Renamed profile');
	await expect(name).toBeFocused();
	await expect(profileOptions(page).nth(3)).toContainText('Renamed profile');
	const format = page.getByTestId('export-profile-format');
	await format.focus();
	await format.selectOption('pdf');
	await expect(format).toBeFocused();
	await expect(profileOptions(page).nth(3)).toContainText('PDF');

	await importProfiles(page, [
		profile('a', 'Imported A'),
		profile('b', 'Imported B'),
		profile('c', 'Imported C')
	]);
	await expect(profileOptions(page)).toHaveCount(3);
	await listbox.focus();
	await page.getByTestId('export-profile-name').fill('Temporary name');
	await listbox.focus();
	await importProfiles(page, [
		profile('a', 'Imported A'),
		profile('b', 'Imported B'),
		profile('c', 'Imported C')
	]);
	await expect(profileOptions(page)).toHaveCount(3);
	await expect(listbox).toBeFocused();

	await page.getByRole('button', { name: 'Supprimer le profil' }).focus();
	await page.keyboard.press('Enter');
	await expect(profileOptions(page)).toHaveCount(2);
	expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);

	await page.getByTestId('export-profile-use').focus();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('export-profile-use')).toContainText('Utilisé');
	await expect(page.getByTestId('export-profile-use')).toBeFocused();
	await expect(
		page.getByRole('listbox', { name: 'Profils d’export' }).getByRole('option', { selected: true })
	).toHaveCount(1);

	await info.attach('export-profile-focus-retention.json', {
		body: JSON.stringify(
			{ stored: await storedState(page), options: await profileNames(page) },
			null,
			2
		),
		contentType: 'application/json'
	});
});

test('keeps the listbox keyboard model at 375px and simulated 200 percent zoom', async ({
	page
}, info) => {
	await resetAppState(page);
	await createFirstFile(page);
	await page.setViewportSize({ width: 375, height: 740 });
	await openProfiles(page);
	const dialog = page.getByTestId('export-profiles');
	const listbox = page.getByRole('listbox', { name: 'Profils d’export' });
	const close = dialog.getByRole('button', { name: 'Fermer' });
	const name = page.getByTestId('export-profile-name');
	await importProfiles(
		page,
		Array.from({ length: 30 }, (_, index) => profile(`p${index}`, `Profile ${index + 1}`))
	);
	await expect(profileOptions(page)).toHaveCount(30);

	async function checkTraversal() {
		await close.focus();
		await page.keyboard.press('Tab');
		await expect(listbox).toBeFocused();
		await page.keyboard.press('Home');
		await page.keyboard.press('ArrowDown');
		await expect(profileOptions(page).nth(1)).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('Tab');
		await expect(name).toBeFocused();
		const box = await name.boundingBox();
		expect(box?.width ?? 0).toBeGreaterThan(0);
		return box;
	}

	const narrow = await checkTraversal();
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.evaluate(() => {
		document.documentElement.style.zoom = '2';
	});
	const zoomed = await checkTraversal();
	expect(zoomed?.width ?? 0).toBeGreaterThan(0);
	await page.evaluate(() => {
		document.documentElement.style.zoom = '';
	});

	await info.attach('export-profile-viewport.json', {
		body: JSON.stringify({ method: 'CSS zoom', narrow, zoomed }, null, 2),
		contentType: 'application/json'
	});
});

test('persists the active profile across reloads', async ({ page }) => {
	await resetAppState(page);
	await createFirstFile(page);
	await openProfiles(page);
	await page.getByTestId('export-profile-page-size').selectOption('Legal');
	await page.getByTestId('export-profile-use').click();
	await page.keyboard.press('Escape');
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor();
	expect(
		await page.evaluate(() => localStorage.getItem('mdsh:export-profile-active'))
	).toBeTruthy();
});
