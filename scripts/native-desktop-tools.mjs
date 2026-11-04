// Native checks for the desktop backup snapshots and the signed update gate.
// Called from native-smoke.mjs after the main window is ready.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {{
 *   executeAsync: (script: string, args?: unknown[]) => Promise<any>,
 *   passed: (label: string) => void,
 *   output: string
 * }} context
 */
export async function checkDesktopTools({ executeAsync, passed, output }) {
	const directory = join(output, 'desktop-tools');
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });

	// The WebDriver bridge rejects the script when a Tauri command returns an
	// error, so rethrow it as a result object for the negative checks.
	const attempt = async (script, args) => {
		try {
			return await executeAsync(script, args);
		} catch (error) {
			return { error: String(error) };
		}
	};

	const status = await executeAsync(
		`const done = arguments[arguments.length - 1];
		window.__TAURI__.core.invoke('update_status').then(done, error => done({ error: String(error) }));`
	);
	assert.equal(status.error, undefined, 'update_status must resolve');
	assert.equal(status.configured, false, 'unsigned builds must keep updates disabled');
	assert.equal(status.blockedReason, 'signing-required');
	passed('native updates stay blocked without a signing key');

	const install = await attempt(
		`const done = arguments[arguments.length - 1];
		(async () => {
			try {
				await window.__TAURI__.core.invoke('update_install');
				done({ ok: true });
			} catch (error) {
				done({ error: String(error) });
			}
		})();`
	);
	assert.match(String(install.error), /manual-install-required/);
	passed('native updates never install automatically');

	const manifest = JSON.stringify({
		schemaVersion: 1,
		version: '9.9.9',
		channel: 'beta',
		platform: 'linux-x86_64',
		url: 'https://example.test/deckmark.AppImage',
		sha256: 'a'.repeat(64),
		notes: ''
	});
	const rejected = await attempt(
		`const done = arguments[arguments.length - 1];
		window.__TAURI__.core.invoke('update_verify_manifest', { manifest: arguments[0], signature: 'AAAA' })
			.then(done, error => done({ error: String(error) }));`,
		[manifest]
	);
	// Without a configured key the boundary fails closed before signature checks.
	assert.match(String(rejected.error), /signing-required/);
	passed('native update manifest fails closed without a signing key');

	// Backup snapshots: write two, keep the newest, preserve unrelated files.
	writeFileSync(join(directory, 'notes.txt'), 'keep me');
	const write = (payload, keep) =>
		executeAsync(
			`const done = arguments[arguments.length - 1];
			window.__TAURI__.core.invoke('desktop_backup_write', {
				root: arguments[0], payload: arguments[1], keep: arguments[2]
			}).then(done, error => done({ error: String(error) }));`,
			[directory, payload, keep]
		);
	const first = await write('{"format":"mdsh-backup","schemaVersion":2,"marker":"first"}', 1);
	assert.equal(first.error, undefined, 'first backup write must succeed');
	assert.ok(first.path && existsSync(first.path), 'first snapshot must exist');
	const second = await write('{"format":"mdsh-backup","schemaVersion":2,"marker":"second"}', 1);
	assert.equal(second.error, undefined, 'second backup write must succeed');
	assert.notEqual(second.path, first.path, 'snapshots must not overwrite each other');
	assert.equal(existsSync(first.path), false, 'retention must remove the older snapshot');

	const listed = await executeAsync(
		`const done = arguments[arguments.length - 1];
		window.__TAURI__.core.invoke('desktop_backup_list', { root: arguments[0] })
			.then(done, error => done({ error: String(error) }));`,
		[directory]
	);
	assert.equal(listed.error, undefined);
	assert.equal(listed.length, 1, 'retention keeps exactly one snapshot');
	assert.ok(
		readdirSync(directory).includes('notes.txt'),
		'retention must preserve unrelated files'
	);
	assert.equal(readFileSync(join(directory, 'notes.txt'), 'utf8'), 'keep me');

	const read = await executeAsync(
		`const done = arguments[arguments.length - 1];
		window.__TAURI__.core.invoke('desktop_backup_read', { path: arguments[0] })
			.then(done, error => done({ error: String(error) }));`,
		[second.path]
	);
	assert.match(String(read), /"marker":"second"/);
	passed('native backup snapshots write atomically, keep the newest and preserve user files');

	const escaped = await attempt(
		`const done = arguments[arguments.length - 1];
		window.__TAURI__.core.invoke('desktop_backup_read', { path: arguments[0] })
			.then(done, error => done({ error: String(error) }));`,
		[join(directory, '..', 'outside.json')]
	);
	assert.ok(escaped.error, 'reads outside a registered root must fail');
	passed('native backup reads stay confined to the approved folder');

	return {
		update: { configured: status.configured, blockedReason: status.blockedReason },
		backup: { path: second.path, retained: listed.length }
	};
}
