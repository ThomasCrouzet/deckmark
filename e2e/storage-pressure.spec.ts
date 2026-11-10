import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resetAppState } from './helpers';
import { databaseState, editWithoutWaiting, importBackup } from './storage-evidence';

function corpusText(seed: number, length: number) {
	let state = seed + 1;
	return Array.from({ length }, (_, index) => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return index % 80 === 79 ? '\n' : String.fromCharCode(97 + ((state >>> 0) % 26));
	}).join('');
}

test('Replace All covers a 300-note library with a deferred closed body', async ({
	page
}, info) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	const now = Date.now();
	const largeBody = `# Large deferred note\n\nneedle in the deferred body\n${'filler line '.repeat(30_000)}`;
	expect(largeBody.length).toBeGreaterThan(256 * 1024);
	const drafts = Array.from({ length: 300 }, (_, index) => ({
		id: `replace-${index}`,
		name: `Replace ${index}.md`,
		content:
			index === 299
				? largeBody
				: `# Note ${index}\n\nneedle in document ${index}\n${'context '.repeat(100)}`,
		createdAt: now,
		updatedAt: now,
		order: index,
		open: index === 0
	}));
	await importBackup(page, {
		format: 'mdsh-backup',
		schemaVersion: 1,
		exportedAt: now,
		drafts,
		workspaces: [],
		templates: []
	});
	await expect.poll(async () => (await databaseState(page)).drafts.length).toBe(300);
	await page.keyboard.press('Escape');
	await page.reload();
	await page.locator('.mdsh-shell[aria-busy="false"]:not([inert])').waitFor({
		state: 'visible',
		timeout: 15_000
	});
	await expect(page.getByText('Documents conservés')).toBeVisible();

	await page.keyboard.press('ControlOrMeta+Shift+f');
	await page.getByRole('combobox').fill('needle');
	await page.getByTitle('Remplacer dans tous les fichiers').click();
	await page.getByLabel('Texte de remplacement').fill('replacement');
	await page.getByRole('button', { name: 'Remplacer tout' }).click();
	await expect(page.getByText('300 fichier(s), 300 remplacement(s)')).toBeVisible({
		timeout: 120_000
	});
	await page.getByRole('button', { name: 'Confirmer le remplacement' }).click();
	await expect(page.getByRole('dialog', { name: 'Recherche cross-fichiers' })).toHaveCount(0, {
		timeout: 120_000
	});

	const state = await databaseState(page);
	const replaced = state.drafts.filter((row) => row.content.includes('replacement'));
	const remaining = state.drafts.filter((row) => row.content.includes('needle'));
	const large = state.drafts.find((row) => row.id === 'replace-299');
	expect(replaced).toHaveLength(300);
	expect(remaining).toEqual([]);
	expect(
		large?.content.startsWith('# Large deferred note\n\nreplacement in the deferred body')
	).toBe(true);
	const artifact = info.outputPath('replace-all-library.json');
	await writeFile(
		artifact,
		JSON.stringify(
			{
				documents: drafts.length,
				largeBodyBytes: Buffer.byteLength(largeBody),
				replaced: replaced.length,
				remaining: remaining.length,
				previewFiles: 300,
				previewOccurrences: 300
			},
			null,
			2
		)
	);
	await info.attach('replace-all-library.json', {
		path: artifact,
		contentType: 'application/json'
	});
});

test('large library quota failures retain drafts and roll back replacement', async ({
	page,
	context
}, info) => {
	test.setTimeout(180_000);
	await resetAppState(page);
	const now = Date.now();
	const drafts = Array.from({ length: 300 }, (_, index) => ({
		id: `pressure-${index}`,
		name: `Pressure ${index}.md`,
		content: corpusText(index, 32_768),
		createdAt: now,
		updatedAt: now,
		order: index,
		open: index === 0
	}));
	const fixture = {
		format: 'mdsh-backup',
		schemaVersion: 1,
		exportedAt: now,
		drafts,
		workspaces: [
			{
				id: 'pressure-workspace',
				name: 'Pressure',
				fileIds: [drafts[0]!.id],
				activeId: drafts[0]!.id,
				createdAt: now,
				updatedAt: now
			}
		],
		templates: []
	};
	await importBackup(page, fixture);
	await expect.poll(async () => (await databaseState(page)).drafts.length).toBe(300);
	await page.keyboard.press('Escape');
	// Retain a repeatable long-lived profile, including closed drafts and near-limit history.
	await page.evaluate(
		async ({ drafts, now }) => {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const tx = db.transaction(['versions', 'trashed'], 'readwrite');
					for (const draft of drafts) {
						for (let version = 0; version < 30; version++) {
							tx.objectStore('versions').put({
								id: `${draft.id}-${version}`,
								draftId: draft.id,
								name: draft.name,
								content: `${version}\n${draft.content.slice(0, 2048)}`,
								createdAt: now - (31 - version) * 360_000
							});
						}
						if (draft.order < 100)
							tx.objectStore('trashed').put({
								id: `trash-${draft.id}`,
								file: { ...draft, id: `trash-${draft.id}` },
								order: draft.order,
								trashedAt: now
							});
					}
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.onabort = () => {
						db.close();
						reject(tx.error);
					};
				};
			});
		},
		{ drafts, now }
	);
	await page.reload();
	await expect(page.locator('.cm-content')).toBeVisible();
	const cdp = await context.newCDPSession(page);
	const origin = new URL(page.url()).origin;
	const measurements: unknown[] = [];
	const measure = async (stage: string) => {
		const state = await databaseState(page);
		const tables = Object.fromEntries(
			Object.entries(state).map(([name, rows]) => {
				const json = JSON.stringify(rows);
				return [
					name,
					{
						rows: rows.length,
						logicalBytes: Buffer.byteLength(json),
						sha256: createHash('sha256').update(json).digest('hex')
					}
				];
			})
		);
		measurements.push({
			stage,
			tables,
			storage: await cdp.send('Storage.getUsageAndQuota', { origin })
		});
		return state;
	};
	try {
		const initial = await measure('large-fixture');
		expect(initial.drafts).toHaveLength(300);
		expect(initial.versions).toHaveLength(9000);
		expect(initial.trashed).toHaveLength(100);
		// This is the Chromium quota manager, not an IndexedDB mock.
		await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1 });
		await measure('quota-constrained');
		// Let Chromium's 30 second bucket-space cache expire without filling the disk.
		await page.waitForTimeout(32_000);
		const pending = `# Pending under quota pressure\n${corpusText(500, 65_536)}`;
		await editWithoutWaiting(page, pending);
		await expect(page.locator('#app-statusbar')).toContainText('Non enregistré localement');
		expect((await measure('failed-save')).drafts).toEqual(initial.drafts);
		await page.keyboard.press('ControlOrMeta+,');
		let downloads = 0;
		page.on('download', () => downloads++);
		await page.getByRole('button', { name: 'Exporter une sauvegarde', exact: true }).click();
		await expect(
			page.getByRole('alert').filter({ hasText: "L'export de la sauvegarde a échoué" })
		).toBeVisible();
		expect(downloads).toBe(0);
		await page.keyboard.press('Escape');
		await cdp.send('Storage.overrideQuotaForOrigin', { origin });
		await page.locator('#app-statusbar button').filter({ hasText: 'Réessayer' }).click();
		await expect
			.poll(
				async () =>
					(await databaseState(page)).drafts.find((row) => row.id === 'pressure-0')?.content
			)
			.toBe(pending);
		await expect(page.locator('#app-statusbar')).not.toContainText('Non enregistré localement');
		const recovered = await measure('retry-saved');
		expect(recovered.versions.filter((row) => row.draftId === 'pressure-0')).toHaveLength(30);
		await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1 });
		await page.waitForTimeout(32_000);
		await importBackup(page, {
			...fixture,
			drafts: [{ ...drafts[0], id: 'replacement', content: corpusText(999, 1_048_576) }],
			workspaces: []
		});
		await expect(
			page.getByRole('alert').filter({ hasText: 'La restauration a échoué' })
		).toBeVisible();
		expect(await measure('failed-replacement')).toEqual(recovered);
		await cdp.send('Storage.overrideQuotaForOrigin', { origin });
		await page.reload();
		await page.locator('.cm-content').press('ControlOrMeta+Home');
		await expect(page.locator('.cm-content')).toContainText('Pending under quota pressure');
		expect((await databaseState(page)).drafts).toEqual(recovered.drafts);
	} finally {
		await cdp.send('Storage.overrideQuotaForOrigin', { origin }).catch(() => {});
		const artifact = info.outputPath('storage-pressure.json');
		await writeFile(
			artifact,
			JSON.stringify(
				{
					fixture: {
						generator: 'xorshift32',
						now,
						documents: 300,
						draftBytes: 32_768,
						versionsPerDraft: 30,
						versionBytes: 2048,
						trash: 100
					},
					measurements
				},
				null,
				2
			)
		);
		await info.attach('storage-pressure.json', { path: artifact, contentType: 'application/json' });
	}
});
