import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collectDesktopAssets } from '../../scripts/collect-desktop-assets.mjs';

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true });
});
function setup() {
	const root = mkdtempSync(join(tmpdir(), 'mdsh-assets-'));
	folders.push(root);
	const input = join(root, 'input');
	const output = join(root, 'output');
	mkdirSync(input);
	for (const name of [
		'mdsh_aarch64.dmg',
		'mdsh_x64.dmg',
		'mdsh.AppImage',
		'mdsh.deb',
		'mdsh.rpm',
		'mdsh.msi',
		'mdsh-setup.exe',
		'sbom-npm.cdx.json',
		'sbom-cargo.cdx.json',
		'desktop-source.json'
	])
		writeFileSync(join(input, name), name);
	return { input, output };
}
describe('release asset collection', () => {
	it('flattens only installers and produces independently verifiable checksums', () => {
		const { input, output } = setup();
		mkdirSync(join(input, 'mdsh.app'));
		writeFileSync(join(input, 'mdsh.app', 'internal.exe'), 'internal');
		writeFileSync(join(input, 'build.log'), 'log');
		const files = collectDesktopAssets(input, output);
		expect(files).toHaveLength(7);
		expect(files).not.toContain('internal.exe');
		expect(files).not.toContain('sbom-npm.cdx.json');
		expect(files).not.toContain('sbom-cargo.cdx.json');
		expect(files).not.toContain('desktop-source.json');
		expect(files).toContain('mdsh_macOS_Apple-Silicon.dmg');
		expect(files).toContain('mdsh_macOS_Intel.dmg');
		for (const line of readFileSync(join(output, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
			const [hash, name] = line.split('  ');
			expect(hash).toBe(
				createHash('sha256')
					.update(readFileSync(join(output, name!)))
					.digest('hex')
			);
		}
	});
	it('rejects filename collisions before copying', () => {
		const { input, output } = setup();
		mkdirSync(join(input, 'another'));
		writeFileSync(join(input, 'another', 'mdsh_x64.dmg'), 'other architecture');
		expect(() => collectDesktopAssets(input, output)).toThrow('Duplicate artifact names');
	});
	it('rejects an incomplete installer matrix', () => {
		const { input, output } = setup();
		rmSync(join(input, 'mdsh.msi'));
		expect(() => collectDesktopAssets(input, output)).toThrow('Required artifact is missing');
	});
});
