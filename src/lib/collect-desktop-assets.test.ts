import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collectDesktopAssets } from '../../scripts/collect-desktop-assets.mjs';

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true });
});
const identity = { sha: 'a'.repeat(40), tag: 'v1.5.0', version: '1.5.0' };
function setup() {
	const root = mkdtempSync(join(tmpdir(), 'mdsh-assets-'));
	folders.push(root);
	const input = join(root, 'input');
	const output = join(root, 'output');
	mkdirSync(input);
	const artifacts = {
		'desktop-installers-macos-arm': ['mdsh_aarch64.dmg'],
		'desktop-installers-macos-intel': ['mdsh_x64.dmg'],
		'desktop-installers-linux': ['mdsh.AppImage', 'mdsh.deb', 'mdsh.rpm'],
		'desktop-installers-windows': ['mdsh.msi', 'mdsh-setup.exe']
	};
	for (const [artifact, names] of Object.entries(artifacts)) {
		const artifactPath = join(input, artifact);
		mkdirSync(artifactPath);
		for (const name of names) writeFileSync(join(artifactPath, name), name);
		writeFileSync(join(artifactPath, 'desktop-source.json'), JSON.stringify(identity));
	}
	writeFileSync(join(input, 'desktop-installers-linux', 'sbom-npm.cdx.json'), 'npm sbom');
	writeFileSync(join(input, 'desktop-installers-linux', 'sbom-cargo.cdx.json'), 'cargo sbom');
	return { input, output };
}
describe('release asset collection', () => {
	it('flattens only installers and produces independently verifiable checksums', () => {
		const { input, output } = setup();
		mkdirSync(join(input, 'desktop-installers-macos-arm', 'mdsh.app'));
		writeFileSync(
			join(input, 'desktop-installers-macos-arm', 'mdsh.app', 'internal.exe'),
			'internal'
		);
		writeFileSync(join(input, 'desktop-installers-linux', 'build.log'), 'log');
		const files = collectDesktopAssets(input, output, identity);
		expect(files).toHaveLength(7);
		expect(files).not.toContain('internal.exe');
		expect(files).not.toContain('sbom-npm.cdx.json');
		expect(files).not.toContain('sbom-cargo.cdx.json');
		expect(files).not.toContain('desktop-source.json');
		expect(files).toContain('mdsh_macOS_Apple-Silicon.dmg');
		expect(files).toContain('mdsh_macOS_Intel.dmg');
		expect(readdirSync(output).sort()).toEqual([...files, 'SHA256SUMS'].sort());
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
		writeFileSync(join(input, 'desktop-installers-windows', 'mdsh_x64.dmg'), 'other architecture');
		expect(() => collectDesktopAssets(input, output, identity)).toThrow('Duplicate artifact names');
	});
	it('rejects invalid expected and supplied source identities', () => {
		const { input, output } = setup();
		expect(() => collectDesktopAssets(input, output, { ...identity, sha: 'short' })).toThrow(
			'Invalid source identity'
		);
		expect(() => collectDesktopAssets(input, output, { ...identity, tag: 'v1.5.1' })).toThrow(
			'Invalid source identity'
		);
		const manifest = join(input, 'desktop-installers-linux', 'desktop-source.json');
		writeFileSync(manifest, JSON.stringify({ ...identity, sha: 'b'.repeat(40) }));
		expect(() => collectDesktopAssets(input, output, identity)).toThrow('specified source');
		writeFileSync(manifest, JSON.stringify({ ...identity, tag: 'v1.5.1' }));
		expect(() => collectDesktopAssets(input, output, identity)).toThrow('specified source');
		writeFileSync(manifest, JSON.stringify({ ...identity, version: '1.4.9' }));
		expect(() => collectDesktopAssets(input, output, identity)).toThrow('specified source');
	});
	it('rejects a missing or malformed platform manifest', () => {
		const { input, output } = setup();
		const manifest = join(input, 'desktop-installers-windows', 'desktop-source.json');
		rmSync(manifest);
		expect(() => collectDesktopAssets(input, output, identity)).toThrow('source manifest');
		writeFileSync(manifest, '{');
		expect(() => collectDesktopAssets(input, output, identity)).toThrow('Invalid source manifest');
	});
	it('rejects an incomplete installer matrix', () => {
		const { input, output } = setup();
		rmSync(join(input, 'desktop-installers-windows', 'mdsh.msi'));
		expect(() => collectDesktopAssets(input, output, identity)).toThrow(
			'Required artifact is missing'
		);
	});
});
