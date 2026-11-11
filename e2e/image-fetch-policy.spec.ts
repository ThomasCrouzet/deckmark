import { expect, test, type Page } from '@playwright/test';
import { resetAppState } from './helpers';

// Image fetch policy ordering for issue 578.
test.use({ locale: 'en-US', reducedMotion: 'reduce', trace: 'off' });

type PolicyProbe = {
	images: { hasCrossOrigin: boolean; hasReferrerPolicy: boolean; src: string }[];
	mutations: { attribute: string | null; src: string | null }[];
	loads: number;
	maxLoads: number;
};

async function installProbe(page: Page) {
	await page.addInitScript(() => {
		const probe = {
			images: [] as { hasCrossOrigin: boolean; hasReferrerPolicy: boolean; src: string }[],
			mutations: [] as { attribute: string | null; src: string | null }[],
			loads: 0,
			maxLoads: 0,
			callbacks: 0,
			errors: [] as string[]
		};
		const perImage = new WeakMap<HTMLImageElement, number>();
		const record = (node: Node) => {
			if (!(node instanceof Element)) return;
			const images = node.matches('img') ? [node as HTMLImageElement] : [];
			images.push(...node.querySelectorAll<HTMLImageElement>('img'));
			for (const image of images) {
				if (!image.closest('.milkdown-image-block, .milkdown-image-inline')) continue;
				probe.images.push({
					hasCrossOrigin: image.hasAttribute('crossorigin'),
					hasReferrerPolicy: image.hasAttribute('referrerpolicy'),
					src: image.getAttribute('src') ?? ''
				});
			}
		};
		(window as unknown as { __policyProbe: PolicyProbe }).__policyProbe = probe;
		const observer = new MutationObserver((records) => {
			probe.callbacks += records.length;
			try {
				for (const mutation of records) {
					if (mutation.type === 'attributes' && mutation.target instanceof HTMLImageElement) {
						probe.mutations.push({
							attribute: mutation.attributeName,
							src: mutation.target.getAttribute('src')
						});
					} else if (mutation.type === 'childList') {
						for (const node of mutation.addedNodes) record(node);
					}
				}
			} catch (error) {
				probe.errors.push(String(error));
			}
		});
		observer.observe(document, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['crossorigin', 'referrerpolicy']
		});
		document.addEventListener(
			'load',
			(event) => {
				if (!(event.target instanceof HTMLImageElement)) return;
				probe.loads += 1;
				const count = (perImage.get(event.target) ?? 0) + 1;
				perImage.set(event.target, count);
				if (count > probe.maxLoads) probe.maxLoads = count;
			},
			true
		);
	});
}

async function readProbe(page: Page): Promise<PolicyProbe> {
	return page.evaluate(() => (window as unknown as { __policyProbe: PolicyProbe }).__policyProbe);
}

async function seedNote(page: Page) {
	await page.evaluate(async () => {
		const draw = (color: string, width = 900, height = 600): string => {
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext('2d')!;
			context.fillStyle = color;
			context.fillRect(0, 0, width, height);
			return canvas.toDataURL('image/png');
		};
		const first = draw('#a33');
		const second = draw('#3a3');
		const project = draw('#33a', 700, 500);
		const bytes = Uint8Array.from(atob(project.split(',')[1]!), (character) =>
			character.charCodeAt(0)
		);
		const content = [
			'# Fetch policy',
			'',
			`![Inline one](${first})`,
			'',
			`![Inline two](${second})`,
			'',
			'![Project one](../assets/policy.png)',
			'',
			'![Project two](../assets/policy-copy.png)',
			'',
			'Tail paragraph.',
			''
		].join('\n');
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('mdsh');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction(
					['projects', 'drafts', 'projectAssets'],
					'readwrite'
				);
				transaction.objectStore('projects').put({
					id: 'policy-project',
					name: 'Policy project',
					createdAt: 1,
					updatedAt: 1
				});
				transaction.objectStore('projectAssets').put({
					id: 'policy-asset',
					projectId: 'policy-project',
					path: 'assets/policy.png',
					mime: 'image/png',
					data: bytes
				});
				transaction.objectStore('projectAssets').put({
					id: 'policy-asset-copy',
					projectId: 'policy-project',
					path: 'assets/policy-copy.png',
					mime: 'image/png',
					data: bytes
				});
				transaction.objectStore('drafts').put({
					id: 'policy-note',
					name: 'policy-note.md',
					content,
					projectId: 'policy-project',
					relativePath: 'notes/policy-note.md',
					createdAt: 1,
					updatedAt: 1,
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
		localStorage.setItem('mdsh:activeId', 'policy-note');
		localStorage.setItem('mdsh:locale', 'en');
	});
}

async function openVisualEditor(page: Page) {
	await page.locator('[data-mode=wysiwyg]').click();
	await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true', {
		timeout: 60_000
	});
}

test('local images settle fetch policies before the first src load', async ({ page }, info) => {
	test.setTimeout(120_000);
	await installProbe(page);
	await resetAppState(page, { mode: 'source' });
	await seedNote(page);
	await page.reload();
	await openVisualEditor(page);
	const images = page.locator('.milkdown-image-block img');
	await expect(images).toHaveCount(4);
	await expect
		.poll(() =>
			images.evaluateAll((elements) =>
				elements.every((element) => {
					const image = element as HTMLImageElement;
					return image.complete && image.naturalWidth > 0;
				})
			)
		)
		.toBe(true);
	await page.waitForTimeout(500);
	const probe = await readProbe(page);
	expect(probe.images.length).toBeGreaterThanOrEqual(4);
	expect(
		probe.images.every((image) => image.hasCrossOrigin && image.hasReferrerPolicy),
		'every image must carry both fetch policies when it enters the DOM'
	).toBe(true);
	expect(
		probe.mutations,
		'a sizing or selection pass must not change the fetch policy after src'
	).toEqual([]);
	expect(probe.maxLoads, 'an image must not load again after its src').toBeLessThanOrEqual(1);
	const properties = await images.evaluateAll((elements) =>
		elements.map((element) => {
			const image = element as HTMLImageElement;
			return {
				crossOrigin: image.crossOrigin,
				referrerPolicy: image.referrerPolicy,
				hasLoad: image.complete && image.naturalWidth > 0
			};
		})
	);
	expect(properties.every((image) => image.crossOrigin === 'anonymous')).toBe(true);
	expect(properties.every((image) => image.referrerPolicy === 'no-referrer')).toBe(true);
	expect(properties.every((image) => image.hasLoad)).toBe(true);

	// Selection, typing and a viewport change must not restart the policy.
	await page.locator('.ProseMirror p').last().click();
	await page.keyboard.press('End');
	for (let index = 0; index < 10; index += 1) await page.keyboard.insertText('x');
	await page.setViewportSize({ width: 1100, height: 900 });
	await page.waitForTimeout(500);
	const after = await readProbe(page);
	expect(after.mutations).toEqual([]);
	expect(after.maxLoads, 'a layout change must not restart an image load').toBeLessThanOrEqual(1);

	await page.locator('[data-mode=source]').click();
	const saved = await page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const request = indexedDB.open('mdsh');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const database = request.result;
					const get = database.transaction('drafts').objectStore('drafts').get('policy-note');
					get.onsuccess = () => {
						database.close();
						resolve((get.result as { content?: string } | undefined)?.content ?? '');
					};
					get.onerror = () => reject(get.error);
				};
			})
	);
	expect(saved).toContain('![Inline one](data:image/png;base64,');
	expect(saved).toContain('![Project one](../assets/policy.png)');
	await info.attach('image-fetch-policy.json', {
		body: JSON.stringify(
			{
				probe,
				after,
				properties,
				browser: page.context().browser()?.version()
			},
			null,
			2
		),
		contentType: 'application/json'
	});
});
