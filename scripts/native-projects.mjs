import assert from 'node:assert/strict';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	realpathSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { basename, join, toNamespacedPath } from 'node:path';

const invokeScript = `const done = arguments[arguments.length - 1];
window.__TAURI__.core.invoke(arguments[0], arguments[1]).then(
  value => done({ value }),
  error => done({ rejection: String(error) })
);`;

/**
 * Exercise project commands against a temporary native directory.
 * The caller starts a native-smoke binary with MDSH_NATIVE_PROJECT_ROOT set.
 */
export async function nativeProjects({
	execute,
	executeAsync,
	until,
	fixtureRoot,
	projectRegistry,
	gate,
	output,
	restart
}) {
	const invoke = (command, args = {}) => executeAsync(invokeScript, [command, args]);
	const evidence = [];
	const record = (scenario, result) => {
		evidence.push({ scenario, result });
		return result;
	};
	const clickVisibleText = (selector, label) =>
		until(
			() =>
				execute(
					`const element = [...document.querySelectorAll(arguments[0])].find(node => node.textContent.trim() === arguments[1]);
					if (!element || element.disabled || element.closest('[inert]') || !element.getClientRects().length) return false;
					element.click(); return true;`,
					[selector, label]
				),
			`click ${label}`,
			45_000
		);
	const readProjectDatabase = () =>
		executeAsync(`const done = arguments[arguments.length - 1];
			const request = indexedDB.open('mdsh');
			request.onerror = () => done({ error: String(request.error) });
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction(['projects', 'drafts', 'projectAssets']);
				const projects = transaction.objectStore('projects').getAll();
				const documents = transaction.objectStore('drafts').getAll();
				const assets = transaction.objectStore('projectAssets').getAll();
				transaction.oncomplete = () => {
					database.close();
					done({
						projects: projects.result.map(({ id, name, nativeRootId }) => ({ id, name, nativeRootId })),
						documents: documents.result.map(({ id, projectId, relativePath, content }) => ({ id, projectId, relativePath, content })),
						assets: assets.result.map(({ id, projectId, path, data }) => ({ id, projectId, path, bytes: [...new Uint8Array(data)] }))
					});
				};
				transaction.onerror = () => done({ error: String(transaction.error) });
			};`);
	const writeProjectAsset = (projectId, path, bytes) =>
		executeAsync(
			`const [projectId, path, bytes] = arguments; const done = arguments[arguments.length - 1];
			const request = indexedDB.open('mdsh');
			request.onerror = () => done({ error: String(request.error) });
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('projectAssets', 'readwrite');
				const store = transaction.objectStore('projectAssets');
				const all = store.getAll();
				all.onsuccess = () => {
					const asset = all.result.find(row => row.projectId === projectId && row.path === path);
					if (!asset) { transaction.abort(); return; }
					store.put({ ...asset, data: new Uint8Array(bytes) });
				};
				transaction.oncomplete = () => { database.close(); done(true); };
				transaction.onabort = () => { database.close(); done({ error: String(transaction.error ?? 'asset is missing') }); };
			};`,
			[projectId, path, bytes]
		);
	const openProjectsPanel = async () => {
		const open = await execute('return !!document.getElementById("projects-title")');
		if (!open) {
			await until(
				() =>
					execute(
						`const button = document.querySelector('[data-testid="projects-open"]');
						if (!button || button.disabled || !button.getClientRects().length) return false;
						button.click(); return true;`
					),
				'open Projects panel',
				45_000
			);
		}
		await until(
			() => execute('return !!document.getElementById("projects-title")'),
			'Projects panel'
		);
	};
	const waitForProjectsIdle = async () => {
		const state = await until(
			() =>
				execute(`const panel = document.querySelector('[role="dialog"][aria-labelledby="projects-title"]');
					const close = panel?.querySelector('header button');
					if (!panel || panel.closest('[inert]') || panel.querySelector('[data-testid="projects-busy"]') ||
						!close || close.disabled || !close.getClientRects().length) return false;
					return { failure: panel.querySelector('[role="alert"]')?.textContent?.trim() ?? null };`),
			'Projects panel is available',
			45_000
		);
		assert.equal(state.failure, null, `Project operation failed: ${state.failure}`);
	};
	const waitForProjectDocument = async (relativePath) => {
		await until(
			() =>
				execute(
					`return [...document.querySelectorAll('[role="dialog"] [data-project-document]')].some(node => node.getAttribute('data-project-document') === arguments[0]);`,
					[relativePath]
				),
			`project document ${relativePath}`,
			45_000
		);
		await waitForProjectsIdle();
	};
	const openProjectDocument = async (relativePath) => {
		await until(
			() =>
				execute(
					`const row = [...document.querySelectorAll('[role="dialog"] [data-project-document]')].find(node => node.getAttribute('data-project-document') === arguments[0]);
					const button = row?.querySelector('button');
					if (!button || button.disabled || !button.getClientRects().length) return false;
					button.click(); return true;`,
					[relativePath]
				),
			`open project document ${relativePath}`,
			45_000
		);
	};
	const notePath = join(fixtureRoot, 'notes', 'start.md');
	const assetPath = join(fixtureRoot, 'images', 'pixel.png');
	mkdirSync(join(fixtureRoot, 'notes'), { recursive: true });
	mkdirSync(join(fixtureRoot, 'images'), { recursive: true });
	writeFileSync(notePath, '# Start\n');
	writeFileSync(assetPath, Buffer.from([137, 80, 78, 71]));
	writeFileSync(join(fixtureRoot, 'notes', 'readme.txt'), 'Plain text\n');

	const picked = record(
		'native picker grants the configured smoke root',
		await invoke('project_pick_root')
	);
	assert.equal(picked.rejection, undefined, picked.rejection);
	assert.equal(picked.value.entries.length, 3);
	assert.deepEqual(picked.value.entries.map((entry) => entry.relativePath).sort(), [
		'images/pixel.png',
		'notes/readme.txt',
		'notes/start.md'
	]);
	assert.ok(picked.value.rootId);
	assert.ok(picked.value.token);
	assert.equal(
		picked.value.entries.every((entry) => !entry.relativePath.startsWith('/')),
		true
	);

	const { rootId } = picked.value;
	let { token } = picked.value;
	const initial = picked.value.entries.find((entry) => entry.relativePath === 'notes/start.md');
	const manifestBefore = record(
		'manifest lists metadata without file contents',
		await invoke('project_manifest', { token })
	);
	assert.equal(manifestBefore.rejection, undefined, manifestBefore.rejection);
	assert.equal(manifestBefore.value.entries.length, picked.value.entries.length);
	assert.equal(
		manifestBefore.value.entries.every(
			(entry) => !('content' in entry) && !('bytes' in entry) && entry.first && entry.second
		),
		true
	);
	record('metadata manifest is smaller than the full snapshot', {
		snapshotBytes: JSON.stringify(picked.value).length,
		manifestBytes: JSON.stringify(manifestBefore.value).length
	});
	for (const relativePath of [
		'../outside.md',
		'/tmp/outside.md',
		'notes/../outside.md',
		'notes//empty.md',
		'notes/./dot.md',
		'notes/start.md:stream.md',
		'notes/trailing.md.',
		'notes/trailing.md ',
		'CON.md',
		'notes/AUX.txt',
		'notes/bad<name.md',
		'notes/bad|name.md',
		'notes/control\u0001.md'
	]) {
		const result = record(
			`path confinement rejects ${relativePath}`,
			await invoke('project_read', { token, relativePath })
		);
		assert.equal(typeof result.rejection, 'string');
	}

	rmSync(gate, { recursive: true, force: true });
	mkdirSync(gate, { recursive: true });
	writeFileSync(
		join(gate, 'armed.json'),
		JSON.stringify({ path: toNamespacedPath(realpathSync(notePath)), stage: 'project-read' })
	);
	await execute(
		`window.__projectReadRace = null;
		window.__TAURI__.core.invoke('project_read', arguments[0]).then(
		  value => window.__projectReadRace = { value },
		  error => window.__projectReadRace = { rejection: String(error) }
		);`,
		[{ token, relativePath: 'notes/start.md' }]
	);
	await until(() => existsSync(join(gate, 'reached')), 'native project read recheck');
	writeFileSync(notePath, '# Changed during read\n');
	writeFileSync(join(gate, 'release'), 'release');
	const readRace = record(
		'in-place change during a read rejects the snapshot',
		await until(() => execute('return window.__projectReadRace'), 'native project read result')
	);
	assert.equal(typeof readRace.rejection, 'string');
	writeFileSync(notePath, '# Start\n');
	rmSync(gate, { recursive: true, force: true });

	const staleContent = '# External\n';
	writeFileSync(notePath, staleContent);
	const manifestAfter = record(
		'manifest reports the changed entry without other contents',
		await invoke('project_manifest', { token })
	);
	const manifestEntry = manifestAfter.value.entries.find(
		(entry) => entry.relativePath === 'notes/start.md'
	);
	const beforeEntry = manifestBefore.value.entries.find(
		(entry) => entry.relativePath === 'notes/start.md'
	);
	assert.notDeepEqual(
		{ size: manifestEntry.size, mtimeMs: manifestEntry.mtimeMs },
		{ size: beforeEntry.size, mtimeMs: beforeEntry.mtimeMs }
	);
	const deltaRead = record(
		'changed entry read returns exact external bytes',
		await invoke('project_read', { token, relativePath: 'notes/start.md' })
	);
	assert.equal(deltaRead.value.content, staleContent);
	const stale = record(
		'stale revision rejects overwrite',
		await invoke('project_write_text', {
			token,
			relativePath: 'notes/start.md',
			content: '# Local\n',
			expectedRevision: initial.revision
		})
	);
	assert.equal(typeof stale.rejection, 'string');
	assert.equal(readFileSync(notePath, 'utf8'), staleContent);

	const refreshed = record(
		'explicit refresh observes external edits',
		await invoke('project_refresh', { token })
	);
	const external = refreshed.value.entries.find((entry) => entry.relativePath === 'notes/start.md');
	assert.equal(external.content, staleContent);
	chmodSync(notePath, 0o640);
	const written = record(
		'atomic overwrite preserves permissions',
		await invoke('project_write_text', {
			token,
			relativePath: 'notes/start.md',
			content: '# Saved\n',
			expectedRevision: external.revision
		})
	);
	assert.equal(written.rejection, undefined, written.rejection);
	if (process.platform !== 'win32') assert.equal(statSync(notePath).mode & 0o777, 0o640);
	if (process.platform !== 'win32') {
		rmSync(gate, { recursive: true, force: true });
		mkdirSync(gate, { recursive: true });
		writeFileSync(
			join(gate, 'armed.json'),
			JSON.stringify({ path: toNamespacedPath(realpathSync(notePath)), stage: 'project-staged' })
		);
		await execute(
			`window.__projectRace = null;
			window.__TAURI__.core.invoke('project_write_text', arguments[0]).then(
			  value => window.__projectRace = { value },
			  error => window.__projectRace = { rejection: String(error) }
			);`,
			[
				{
					token,
					relativePath: 'notes/start.md',
					content: '# Raced\n',
					expectedRevision: written.value.revision
				}
			]
		);
		await until(() => existsSync(join(gate, 'reached')), 'native project staged write');
		const outside = join(fixtureRoot, '..', `${basename(fixtureRoot)}-write-target.md`);
		writeFileSync(outside, '# Outside write target\n');
		rmSync(notePath);
		symlinkSync(outside, notePath);
		writeFileSync(join(gate, 'release'), 'release');
		const race = record(
			'symbolic-link replacement rejects the staged write',
			await until(() => execute('return window.__projectRace'), 'native project write result')
		);
		assert.equal(typeof race.rejection, 'string');
		assert.equal(readFileSync(outside, 'utf8'), '# Outside write target\n');
		rmSync(notePath);
		writeFileSync(notePath, '# Saved\n');
		rmSync(outside);
		rmSync(gate, { recursive: true, force: true });
	}

	rmSync(gate, { recursive: true, force: true });
	mkdirSync(gate, { recursive: true });
	writeFileSync(
		join(gate, 'armed.json'),
		JSON.stringify({ path: toNamespacedPath(realpathSync(notePath)), stage: 'project-staged' })
	);
	await execute(
		`window.__projectSameBytesRace = null;
		window.__TAURI__.core.invoke('project_write_text', arguments[0]).then(
		  value => window.__projectSameBytesRace = { value },
		  error => window.__projectSameBytesRace = { rejection: String(error) }
		);`,
		[
			{
				token,
				relativePath: 'notes/start.md',
				content: '# Same byte race\n',
				expectedRevision: written.value.revision
			}
		]
	);
	await until(() => existsSync(join(gate, 'reached')), 'same-byte replacement stage');
	rmSync(notePath);
	writeFileSync(notePath, '# Saved\n');
	writeFileSync(join(gate, 'release'), 'release');
	const sameBytesRace = record(
		'same-content file replacement rejects the staged write',
		await until(
			() => execute('return window.__projectSameBytesRace'),
			'same-byte replacement result'
		)
	);
	assert.equal(typeof sameBytesRace.rejection, 'string');
	assert.equal(readFileSync(notePath, 'utf8'), '# Saved\n');
	rmSync(gate, { recursive: true, force: true });

	if (process.platform !== 'win32') {
		mkdirSync(gate, { recursive: true });
		writeFileSync(
			join(gate, 'armed.json'),
			JSON.stringify({ path: toNamespacedPath(realpathSync(notePath)), stage: 'project-staged' })
		);
		await execute(
			`window.__projectParentRace = null;
			window.__TAURI__.core.invoke('project_write_text', arguments[0]).then(
			  value => window.__projectParentRace = { value },
			  error => window.__projectParentRace = { rejection: String(error) }
			);`,
			[
				{
					token,
					relativePath: 'notes/start.md',
					content: '# Parent race\n',
					expectedRevision: written.value.revision
				}
			]
		);
		await until(() => existsSync(join(gate, 'reached')), 'parent replacement stage');
		const notesPath = join(fixtureRoot, 'notes');
		const approvedNotes = join(fixtureRoot, 'notes-approved');
		const outsideNotes = join(fixtureRoot, '..', `${basename(fixtureRoot)}-outside-directory`);
		renameSync(notesPath, approvedNotes);
		mkdirSync(outsideNotes);
		writeFileSync(join(outsideNotes, 'start.md'), '# Outside parent\n');
		symlinkSync(outsideNotes, notesPath);
		writeFileSync(join(gate, 'release'), 'release');
		const parentRace = record(
			'parent symbolic-link replacement rejects the staged write',
			await until(() => execute('return window.__projectParentRace'), 'parent replacement result')
		);
		assert.equal(typeof parentRace.rejection, 'string');
		assert.equal(readFileSync(join(outsideNotes, 'start.md'), 'utf8'), '# Outside parent\n');
		rmSync(notesPath);
		renameSync(approvedNotes, notesPath);
		assert.equal(
			readdirSync(notesPath).some((name) => name.endsWith('.tmp')),
			false
		);
		rmSync(outsideNotes, { recursive: true });
		rmSync(gate, { recursive: true, force: true });
	}

	const fixedTime = new Date(Math.floor(Date.now() / 1000) * 1000);
	utimesSync(notePath, fixedTime, fixedTime);
	const plainBefore = record(
		'plain manifest still omits content revisions',
		await invoke('project_manifest', { token })
	);
	const plainEntry = plainBefore.value.entries.find(
		(entry) => entry.relativePath === 'notes/start.md'
	);
	assert.equal('revision' in plainEntry, false);
	const verifiedBefore = record(
		'verified manifest hashes each entry',
		await invoke('project_manifest', { token, verified: true })
	);
	const verifiedEntry = verifiedBefore.value.entries.find(
		(entry) => entry.relativePath === 'notes/start.md'
	);
	assert.equal(typeof verifiedEntry.revision, 'string');
	const noteStats = statSync(notePath);
	const sameSizeContent = '# Other\n';
	assert.equal(Buffer.byteLength(sameSizeContent), noteStats.size);
	writeFileSync(notePath, sameSizeContent);
	utimesSync(notePath, fixedTime, fixedTime);
	const restoredStats = statSync(notePath);
	assert.equal(restoredStats.size, noteStats.size);
	assert.equal(restoredStats.mtimeMs, noteStats.mtimeMs);
	const verifiedAfter = record(
		'verified manifest detects same-size same-mtime content',
		await invoke('project_manifest', { token, verified: true })
	);
	const changedEntry = verifiedAfter.value.entries.find(
		(entry) => entry.relativePath === 'notes/start.md'
	);
	assert.notEqual(changedEntry.revision, verifiedEntry.revision);
	const sameSizeRefresh = record(
		'explicit refresh reads same-size same-mtime content',
		await invoke('project_refresh', { token })
	);
	const sameSizeEntry = sameSizeRefresh.value.entries.find(
		(entry) => entry.relativePath === 'notes/start.md'
	);
	assert.equal(sameSizeEntry.content, sameSizeContent);

	const assetRevision = picked.value.entries.find(
		(entry) => entry.relativePath === 'images/pixel.png'
	).revision;
	const assetWrite = record(
		'asset write replaces the approved image',
		await invoke('project_write_asset', {
			token,
			relativePath: 'images/pixel.png',
			contents: [137, 80, 78, 71, 1],
			expectedRevision: assetRevision
		})
	);
	assert.equal(assetWrite.rejection, undefined, assetWrite.rejection);
	assert.deepEqual([...readFileSync(assetPath)], [137, 80, 78, 71, 1]);

	const created = record(
		'null revision creates a new file',
		await invoke('project_write_text', {
			token,
			relativePath: 'new.md',
			content: '# New\n',
			expectedRevision: null
		})
	);
	assert.equal(created.rejection, undefined, created.rejection);
	const createAgain = record(
		'null revision cannot replace an existing file',
		await invoke('project_write_text', {
			token,
			relativePath: 'new.md',
			content: '# Replaced\n',
			expectedRevision: null
		})
	);
	assert.equal(typeof createAgain.rejection, 'string');
	assert.equal(readFileSync(join(fixtureRoot, 'new.md'), 'utf8'), '# New\n');
	const nestedCreated = record(
		'create makes confined missing parent directories',
		await invoke('project_write_text', {
			token,
			relativePath: 'created/nested.md',
			content: '# Nested\n',
			expectedRevision: null
		})
	);
	assert.equal(nestedCreated.rejection, undefined, nestedCreated.rejection);
	assert.equal(readFileSync(join(fixtureRoot, 'created', 'nested.md'), 'utf8'), '# Nested\n');

	const occupiedPath = join(fixtureRoot, 'occupied.md');
	writeFileSync(occupiedPath, '# Occupied\n');
	const occupiedRename = record(
		'rename cannot replace an existing destination',
		await invoke('project_rename', {
			token,
			fromPath: 'new.md',
			toPath: 'occupied.md',
			expectedRevision: created.value.revision
		})
	);
	assert.equal(typeof occupiedRename.rejection, 'string');
	const renamed = record(
		'rename moves the approved child',
		await invoke('project_rename', {
			token,
			fromPath: 'new.md',
			toPath: 'renamed.md',
			expectedRevision: created.value.revision
		})
	);
	assert.equal(renamed.rejection, undefined, renamed.rejection);
	assert.equal(existsSync(join(fixtureRoot, 'new.md')), false);
	assert.equal(readFileSync(join(fixtureRoot, 'renamed.md'), 'utf8'), '# New\n');

	if (process.platform !== 'win32') {
		const outside = join(fixtureRoot, '..', `${basename(fixtureRoot)}-outside.md`);
		writeFileSync(outside, '# Outside\n');
		symlinkSync(outside, join(fixtureRoot, 'linked.md'));
		const linked = record(
			'symbolic-link child is rejected',
			await invoke('project_read', { token, relativePath: 'linked.md' })
		);
		assert.equal(typeof linked.rejection, 'string');
		assert.equal(readFileSync(outside, 'utf8'), '# Outside\n');
		rmSync(join(fixtureRoot, 'linked.md'));
		rmSync(outside);
	}

	await restart();
	const reopened = record(
		'a trusted root identifier renews a token after restart',
		await invoke('project_open_root', { rootId })
	);
	assert.equal(reopened.rejection, undefined, reopened.rejection);
	assert.notEqual(reopened.value.token, token);
	token = reopened.value.token;
	const unknown = record(
		'an unknown root identifier cannot grant access',
		await invoke('project_open_root', { rootId: `${rootId}-unknown` })
	);
	assert.equal(typeof unknown.rejection, 'string');

	const movedRoot = `${fixtureRoot}.approved`;
	renameSync(fixtureRoot, movedRoot);
	mkdirSync(fixtureRoot);
	writeFileSync(join(fixtureRoot, 'start.md'), '# Replacement root\n');
	const replaced = record(
		'root replacement invalidates the session',
		await invoke('project_refresh', { token })
	);
	assert.equal(typeof replaced.rejection, 'string');
	rmSync(fixtureRoot, { recursive: true });
	renameSync(movedRoot, fixtureRoot);

	const reopenedAgain = await invoke('project_open_root', { rootId });
	assert.equal(reopenedAgain.rejection, undefined, reopenedAgain.rejection);
	token = reopenedAgain.value.token;
	const revoked = record(
		'active token revokes the persistent root',
		await invoke('project_revoke', { token })
	);
	assert.equal(revoked.rejection, undefined, revoked.rejection);
	const afterRevoke = record(
		'revoked root cannot renew a token',
		await invoke('project_open_root', { rootId })
	);
	assert.equal(typeof afterRevoke.rejection, 'string');

	await openProjectsPanel();
	await clickVisibleText('button', 'Ouvrir un dossier du disque');
	await waitForProjectDocument('notes/start.md');
	let database = await readProjectDatabase();
	assert.equal(database.error, undefined, database.error);
	let nativeRows = database.projects.filter((project) => project.nativeRootId);
	assert.equal(nativeRows.length, 1);
	const uiProject = nativeRows[0];
	assert.ok(uiProject.nativeRootId);
	assert.ok(
		database.assets.some(
			(asset) =>
				asset.projectId === uiProject.id &&
				asset.path === 'images/pixel.png' &&
				asset.bytes.join(',') === '137,80,78,71,1'
		)
	);
	await clickVisibleText('button', 'Ouvrir un dossier du disque');
	await waitForProjectDocument('notes/start.md');
	database = await readProjectDatabase();
	nativeRows = database.projects.filter((project) => project.nativeRootId);
	assert.equal(nativeRows.length, 1);
	record('Projects panel reuses an existing imported root', {
		projectId: uiProject.id,
		rootId: uiProject.nativeRootId,
		documents: database.documents
			.filter((document) => document.projectId === uiProject.id)
			.map((document) => document.relativePath)
			.sort()
	});

	const upperCasePath = join(fixtureRoot, 'Case.md');
	const lowerCasePath = join(fixtureRoot, 'case.md');
	writeFileSync(upperCasePath, '# Upper case path\n');
	writeFileSync(lowerCasePath, '# Lower case path\n');
	const hasDistinctCasePaths =
		readFileSync(upperCasePath, 'utf8') === '# Upper case path\n' &&
		readFileSync(lowerCasePath, 'utf8') === '# Lower case path\n';
	if (hasDistinctCasePaths) {
		await clickVisibleText('button', 'Actualiser depuis le disque');
		await until(
			() => execute(`return !!document.querySelector('[role="alert"]');`),
			'case-folded duplicate path rejection',
			45_000
		);
		record('Projects panel rejects case-folded duplicate disk paths', {
			paths: ['Case.md', 'case.md']
		});
		rmSync(upperCasePath);
		rmSync(lowerCasePath);
		await clickVisibleText('button', 'Actualiser depuis le disque');
		await waitForProjectsIdle();
	} else {
		rmSync(upperCasePath);
	}

	const reviewedAssetBytes = [137, 80, 78, 71, 2];
	const changedDuringReviewBytes = [137, 80, 78, 71, 4];
	const externalAssetBytes = [137, 80, 78, 71, 3];
	assert.equal(await writeProjectAsset(uiProject.id, 'images/pixel.png', reviewedAssetBytes), true);
	writeFileSync(assetPath, Buffer.from(externalAssetBytes));
	await clickVisibleText('button', 'Actualiser depuis le disque');
	await until(
		() =>
			execute(
				`return document.getElementById('disk-conflict-title')?.textContent.includes('images/pixel.png');`
			),
		'asset conflict review',
		45_000
	);
	assert.equal(
		await writeProjectAsset(uiProject.id, 'images/pixel.png', changedDuringReviewBytes),
		true
	);
	await clickVisibleText('button', 'Écraser le disque');
	await until(
		() =>
			execute(
				`return document.querySelector('[data-native-project-failures]')?.textContent.includes('Local asset changed during conflict review');`
			),
		'changed asset conflict failure',
		45_000
	);
	assert.deepEqual([...readFileSync(assetPath)], externalAssetBytes);
	record('Asset change during conflict review cannot write stale bytes', {
		path: 'images/pixel.png',
		diskBytes: externalAssetBytes
	});
	await clickVisibleText('button', 'Actualiser depuis le disque');
	await until(
		() =>
			execute(
				`return document.getElementById('disk-conflict-title')?.textContent.includes('images/pixel.png');`
			),
		'asset conflict retry',
		45_000
	);
	await clickVisibleText('button', 'Utiliser la révision du disque');
	await until(
		async () => {
			const state = await readProjectDatabase();
			return state.assets.some(
				(asset) =>
					asset.projectId === uiProject.id &&
					asset.path === 'images/pixel.png' &&
					asset.bytes.join(',') === externalAssetBytes.join(',')
			);
		},
		'reload reviewed asset bytes',
		45_000
	);

	await openProjectDocument('notes/start.md');
	await until(
		() =>
			execute(
				`const button = document.querySelector('button[data-mode="source"]');
				if (!button || !button.getClientRects().length) return false;
				button.click(); return true;`
			),
		'open native project source editor',
		45_000
	);
	const localMarker = 'LOCAL_PROJECT_PANEL_REVISION';
	await until(
		() =>
			execute(
				`const editor = document.querySelector('.cm-content');
				if (!editor || !editor.getClientRects().length) return false;
				editor.focus();
				const range = document.createRange(); range.selectNodeContents(editor);
				const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
				return document.execCommand('insertText', false, arguments[0]);`,
				[`# ${localMarker}\n\nSaved through ProjectsPanel.\n`]
			),
		'edit native project document',
		45_000
	);
	const durableLocal = await until(
		async () => {
			const state = await readProjectDatabase();
			return state.documents.find(
				(document) =>
					document.projectId === uiProject.id &&
					document.relativePath === 'notes/start.md' &&
					document.content.includes(localMarker)
			)?.content;
		},
		'durable native project edit',
		45_000
	);
	const externalContent = '# EXTERNAL_PROJECT_PANEL_REVISION\n';
	writeFileSync(notePath, externalContent);
	await openProjectsPanel();
	await clickVisibleText('button', 'Actualiser depuis le disque');
	const conflictText = await until(
		() =>
			execute(
				`const dialog = document.getElementById('disk-conflict-title')?.closest('[role="dialog"]');
				if (!dialog) return false;
				const text = dialog.textContent;
				return text.includes(arguments[0]) && text.includes(arguments[1]) ? text : false;`,
				[localMarker, 'EXTERNAL_PROJECT_PANEL_REVISION']
			),
		'native project conflict snapshots',
		45_000
	);
	record('Projects panel displays exact local and disk conflict revisions', {
		localMarker: conflictText.includes(localMarker),
		diskMarker: conflictText.includes('EXTERNAL_PROJECT_PANEL_REVISION')
	});
	await clickVisibleText('button', 'Écraser le disque');
	await until(
		async () => readFileSync(notePath, 'utf8') === durableLocal,
		'write reviewed project revision',
		45_000
	);

	await openProjectDocument('notes/start.md');
	await execute(
		`const original = IDBObjectStore.prototype.put;
		window.__restoreRenameJournalPut = () => { IDBObjectStore.prototype.put = original; };
		IDBObjectStore.prototype.put = function (value, key) {
			const row = Array.isArray(value) ? value[0] : value;
			if (row && typeof row === 'object' && typeof row.key === 'string' &&
				row.key.startsWith('project-rename-journal:'))
				throw new DOMException('Injected journal write failure', 'QuotaExceededError');
			return key === undefined ? original.call(this, value) : original.call(this, value, key);
		};
		return true;`
	);
	await until(
		() =>
			execute(
				`const input = document.querySelector('#app-toolbar input[type="text"]');
				if (!input || input.disabled || !input.getClientRects().length) return false;
				input.focus(); input.value = arguments[0]; input.blur(); return true;`,
				['ui-blocked']
			),
		'rename attempt without a recovery journal',
		45_000
	);
	await new Promise((resolve) => setTimeout(resolve, 750));
	assert.equal(existsSync(join(fixtureRoot, 'notes', 'ui-blocked.md')), false);
	assert.equal(readFileSync(notePath, 'utf8'), durableLocal);
	const blockedRename = record('rename aborts when the recovery journal cannot be persisted', {
		blockedPath: 'notes/ui-blocked.md',
		blockedPathExists: existsSync(join(fixtureRoot, 'notes', 'ui-blocked.md')),
		originalPathExists: existsSync(notePath)
	});
	assert.equal(blockedRename.blockedPathExists, false);
	assert.equal(blockedRename.originalPathExists, true);
	await execute('window.__restoreRenameJournalPut?.(); return true;');

	await until(
		() =>
			execute(
				`const input = document.querySelector('#app-toolbar input[type="text"]');
				if (!input || input.disabled || !input.getClientRects().length) return false;
				input.focus(); input.value = arguments[0]; input.blur(); return true;`,
				['ui-renamed']
			),
		'rename native project document',
		45_000
	);
	const renamedPath = join(fixtureRoot, 'notes', 'ui-renamed.md');
	await until(
		async () => existsSync(renamedPath) && !existsSync(notePath),
		'native project rename receipt',
		45_000
	);
	assert.equal(readFileSync(renamedPath, 'utf8'), durableLocal);
	record('Project rename commits the native path and reviewed bytes', {
		path: 'notes/ui-renamed.md',
		content: durableLocal
	});

	const refreshedAssetBytes = [137, 80, 78, 71, 9, 8, 7];
	writeFileSync(assetPath, Buffer.from(refreshedAssetBytes));
	await restart();
	await openProjectsPanel();
	await waitForProjectDocument('notes/ui-renamed.md');
	await clickVisibleText('button', 'Actualiser depuis le disque');
	await until(
		async () => {
			const state = await readProjectDatabase();
			return state.assets.some(
				(asset) =>
					asset.projectId === uiProject.id &&
					asset.path === 'images/pixel.png' &&
					asset.bytes.join(',') === refreshedAssetBytes.join(',')
			);
		},
		'refresh native asset bytes after restart',
		45_000
	);
	record('Registry renewal and explicit refresh load disk bytes after restart', {
		path: 'images/pixel.png',
		bytes: refreshedAssetBytes
	});

	// Issue #351: a no-change refresh must not hydrate document bodies, must not
	// call project_read, and must not rewrite the full baseline once per entry.
	// The native smoke build counts project_manifest and project_read calls; the
	// IndexedDB wrapper counts revision baseline writes.
	await execute(
		`const originalPut = IDBObjectStore.prototype.put;
		window.__restoreProjectPerfPut = () => { IDBObjectStore.prototype.put = originalPut; };
		window.__baselineWrites = [];
		IDBObjectStore.prototype.put = function (value, key) {
		  const row = Array.isArray(value) ? value[0] : value;
		  if (row && typeof row === 'object' && typeof row.key === 'string' &&
		      row.key.startsWith('project-native-revisions:'))
		    window.__baselineWrites.push(row.key);
		  return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
		};
		return true;`
	);
	const readSmokeCalls = () =>
		executeAsync(
			`const done = arguments[arguments.length - 1];
			window.__TAURI__.core.invoke('project_smoke_calls').then(
			  value => done(value),
			  error => done({ error: String(error) })
			);`
		);
	const resetBaselineWrites = () => execute('window.__baselineWrites = []; return true;');
	const refreshWithPerf = async (label) => {
		await resetBaselineWrites();
		const before = await readSmokeCalls();
		assert.equal(before.error, undefined, before.error);
		const startedAt = performance.now();
		await clickVisibleText('button', 'Actualiser depuis le disque');
		const deadline = Date.now() + 120_000;
		let after = null;
		let state = null;
		while (Date.now() < deadline) {
			after = await readSmokeCalls();
			state = await execute(
				`return {
				  busy: !!document.querySelector('[data-testid="projects-busy"]'),
				  alert: document.querySelector('[role="alert"]')?.textContent?.trim() ?? null
				};`
			);
			if (after.manifest > before.manifest && !state.busy) break;
			if (state.alert) throw new Error(`${label} failed: ${state.alert}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (!after || after.manifest <= before.manifest || state?.busy)
			throw new Error(
				`${label}: calls=${JSON.stringify({ before, after })} state=${JSON.stringify(state)}`
			);
		const elapsed = Number((performance.now() - startedAt).toFixed(1));
		const baselineWrites = await execute('return (window.__baselineWrites ?? []).length;');
		return {
			manifestCalls: after.manifest - before.manifest,
			reads: after.read - before.read,
			baselineWrites,
			elapsed
		};
	};
	const quietRefreshSamples = [];
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const perf = await refreshWithPerf(`quiet refresh ${attempt + 1}`);
		assert.equal(perf.reads, 0, 'a no-change refresh must not call project_read');
		assert.ok(perf.manifestCalls >= 1);
		assert.equal(perf.baselineWrites, 0, 'a no-change refresh must not rewrite the baseline');
		quietRefreshSamples.push(perf);
	}
	record('No-change refresh skips content reads and baseline rewrites', {
		samples: quietRefreshSamples,
		p50Ms: quietRefreshSamples.map((sample) => sample.elapsed).sort((a, b) => a - b)[1]
	});

	const perfNotePath = join(fixtureRoot, 'notes', 'ui-renamed.md');
	const perfNoteContent = '# PERF_REFRESH_ONE_FILE\n';
	writeFileSync(perfNotePath, perfNoteContent);
	const oneFileRefresh = await refreshWithPerf('single-file refresh');
	await until(
		async () => {
			const state = await readProjectDatabase();
			return state.documents.some(
				(document) =>
					document.projectId === uiProject.id &&
					document.relativePath === 'notes/ui-renamed.md' &&
					document.content === perfNoteContent
			);
		},
		'single-file refresh bytes',
		45_000
	);
	assert.ok(
		oneFileRefresh.reads >= 1 && oneFileRefresh.reads <= 2,
		`a single changed file reads only that entry, got ${oneFileRefresh.reads}`
	);
	assert.ok(oneFileRefresh.baselineWrites <= 1, 'the baseline write is batched');
	record('Single-file refresh reads one entry and batches the baseline', {
		reads: oneFileRefresh.reads,
		baselineWrites: oneFileRefresh.baselineWrites
	});

	mkdirSync(join(fixtureRoot, 'perf'), { recursive: true });
	for (let index = 0; index < 5; index += 1)
		writeFileSync(join(fixtureRoot, 'perf', `note-${index}.md`), `# Batch ${index}\n`);
	const batchRefresh = await refreshWithPerf('new-file batch refresh');
	await until(
		async () => {
			const state = await readProjectDatabase();
			return state.documents.filter((document) => document.projectId === uiProject.id).length >= 6;
		},
		'new-file batch import',
		45_000
	);
	assert.equal(batchRefresh.reads, 5, 'a new-file refresh reads only the new entries');
	assert.ok(batchRefresh.baselineWrites <= 1, 'new entries flush one baseline batch');
	record('New-file refresh reads only the new entries', {
		reads: batchRefresh.reads,
		baselineWrites: batchRefresh.baselineWrites
	});

	mkdirSync(join(fixtureRoot, 'perf', 'bulk'), { recursive: true });
	for (let index = 0; index < 600; index += 1)
		writeFileSync(
			join(fixtureRoot, 'perf', 'bulk', `note-${String(index).padStart(4, '0')}.md`),
			`# Bulk ${index}\n\nRepresentative project content. `.repeat(4)
		);
	await refreshWithPerf('600-document import');
	await until(
		async () => {
			const state = await readProjectDatabase();
			return (
				state.documents.filter((document) => document.projectId === uiProject.id).length >= 600
			);
		},
		'600-document import',
		120_000
	);
	const payloadProbe = await executeAsync(
		`const [rootId] = arguments; const done = arguments[arguments.length - 1];
		window.__TAURI__.core.invoke('project_open_root', { rootId }).then(
		  async (snapshot) => {
		    const manifest = await window.__TAURI__.core.invoke('project_manifest', {
		      token: snapshot.token,
		      verified: true
		    });
		    const full = await window.__TAURI__.core.invoke('project_refresh', {
		      token: snapshot.token
		    });
		    done({
		      entries: manifest.entries.length,
		      manifestBytes: JSON.stringify(manifest).length,
		      snapshotBytes: JSON.stringify(full).length
		    });
		  },
		  error => done({ error: String(error) })
		);`,
		[uiProject.nativeRootId]
	);
	assert.equal(payloadProbe.error, undefined, payloadProbe.error);
	assert.ok(payloadProbe.entries >= 600);
	assert.ok(payloadProbe.manifestBytes < payloadProbe.snapshotBytes);
	const bulkSamples = [];
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const perf = await refreshWithPerf(`600-document quiet refresh ${attempt + 1}`);
		assert.equal(perf.reads, 0, 'a 600-document no-change refresh must not call project_read');
		assert.equal(perf.baselineWrites, 0);
		bulkSamples.push(perf);
	}
	const bulkDurations = bulkSamples.map((sample) => sample.elapsed).sort((a, b) => a - b);
	record('600-document no-change refresh stays metadata-only', {
		documents: payloadProbe.entries,
		reads: 0,
		baselineWrites: 0,
		p50Ms: bulkDurations[2],
		p95Ms: bulkDurations[4],
		manifestBytes: payloadProbe.manifestBytes,
		snapshotBytes: payloadProbe.snapshotBytes
	});
	await execute('window.__restoreProjectPerfPut?.(); return true;');

	const registryBackup = `${projectRegistry}.backup`;
	renameSync(projectRegistry, registryBackup);
	mkdirSync(projectRegistry);
	await clickVisibleText('button', 'Dissocier le dossier du disque');
	await until(
		async () => {
			const state = await readProjectDatabase();
			return (
				state.projects.find((candidate) => candidate.id === uiProject.id)?.nativeRootId ===
				uiProject.nativeRootId
			);
		},
		'failed revoke keeps native project connection',
		45_000
	);
	record('Registry failure keeps the project linked for a later revoke', {
		projectId: uiProject.id,
		rootId: uiProject.nativeRootId
	});
	rmSync(projectRegistry, { recursive: true });
	renameSync(registryBackup, projectRegistry);
	await clickVisibleText('button', 'Dissocier le dossier du disque');
	database = await until(
		async () => {
			const state = await readProjectDatabase();
			const project = state.projects.find((candidate) => candidate.id === uiProject.id);
			return project && !project.nativeRootId ? state : false;
		},
		'disconnect native project',
		45_000
	);
	assert.ok(database.documents.some((document) => document.projectId === uiProject.id));
	assert.ok(database.assets.some((asset) => asset.projectId === uiProject.id));
	const disconnectedGrant = await invoke('project_open_root', { rootId: uiProject.nativeRootId });
	assert.equal(typeof disconnectedGrant.rejection, 'string');
	record('Disconnect keeps local data and revokes the registry identifier', {
		documents: database.documents.filter((document) => document.projectId === uiProject.id).length,
		assets: database.assets.filter((asset) => asset.projectId === uiProject.id).length,
		reopenRejected: true
	});
	await execute(
		`const dialog = document.getElementById('projects-title')?.closest('[role="dialog"]');
		if (dialog) dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`
	);
	await until(
		() => execute('return !document.getElementById("projects-title")'),
		'close Projects panel'
	);

	writeFileSync(
		join(output, 'native-projects.json'),
		JSON.stringify(
			{
				fixtureRoot,
				commands: [
					'project_pick_root',
					'project_open_root',
					'project_refresh',
					'project_read',
					'project_write_text',
					'project_write_asset',
					'project_rename',
					'project_revoke'
				],
				evidence
			},
			null,
			2
		)
	);
	return evidence;
}
