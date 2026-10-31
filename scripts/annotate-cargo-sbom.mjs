import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const patchSha256 = '982b07f58864aad3d0aa0421cdd8ddc7438bb862b93e7b6b34da96b4147f8add';
const patchRepositoryPath = 'patches/glib/variant-str-iter.patch';
const upstreamCommit =
	'https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34';
const advisoryId = 'GHSA-wrw7-89jp-8q8g';
const advisoryUrl = `https://github.com/advisories/${advisoryId}`;
const rustsecUrl = 'https://rustsec.org/advisories/RUSTSEC-2024-0429.html';

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Expected a CycloneDX object.');
	}
	return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @returns {Record<string, unknown>[]} */
function objects(value) {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error('Expected a CycloneDX list.');
	return value.map(object);
}

/**
 * Official schema: https://cyclonedx.org/schema/bom-1.5.schema.json
 * diff accepts text/url. Put its hash in externalReferences.hashes.
 * @param {unknown} input
 * @param {Uint8Array} patch
 * @param {string} sourceSha
 */
export function annotateCargoSbom(input, patch, sourceSha) {
	if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('SOURCE_SHA must be a full Git SHA.');
	if (createHash('sha256').update(patch).digest('hex') !== patchSha256) {
		throw new Error('Incorrect glib patch SHA256.');
	}
	const bom = object(structuredClone(input));
	if (bom.bomFormat !== 'CycloneDX' || bom.specVersion !== '1.5') {
		throw new Error('A CycloneDX 1.5 SBOM is required.');
	}
	if (bom.signature !== undefined) throw new Error('Cannot modify a signed SBOM.');
	/** @type {Record<string, unknown>[]} */
	const components = [];
	/** @param {Record<string, unknown>} component */
	function visit(component) {
		components.push(component);
		for (const child of objects(component.components)) visit(child);
	}
	for (const component of objects(bom.components)) visit(component);
	if (bom.metadata !== undefined) {
		const metadata = object(bom.metadata);
		if (metadata.component !== undefined) visit(object(metadata.component));
	}
	const targets = components.filter((item) => item.name === 'glib' && item.version === '0.18.5');
	if (targets.length !== 1) throw new Error('Exactly one glib 0.18.5 component is required.');
	const target = /** @type {Record<string, unknown>} */ (targets[0]);
	const purl = typeof target.purl === 'string' ? target.purl : '';
	const [packageId, qualifiers] = purl.split('?');
	const params = new URLSearchParams(qualifiers);
	if (
		target.type !== 'library' ||
		target.group !== undefined ||
		packageId !== 'pkg:cargo/glib@0.18.5' ||
		purl.split('?').length !== 2 ||
		params.size !== 1 ||
		params.get('download_url') !== 'file://vendor/glib' ||
		typeof target['bom-ref'] !== 'string' ||
		!/^path\+file:\/\/\/.+\/src-tauri\/vendor\/glib#0\.18\.5$/.test(target['bom-ref']) ||
		components.filter((item) => item['bom-ref'] === target['bom-ref']).length !== 1
	) {
		throw new Error('The local glib component identity is inconsistent.');
	}
	const patchUrl = `https://raw.githubusercontent.com/ThomasCrouzet/deckmark/${sourceSha}/${patchRepositoryPath}`;
	const expectedPatch = {
		type: 'backport',
		diff: {
			url: patchUrl,
			text: {
				contentType: 'text/x-diff',
				encoding: 'base64',
				content: Buffer.from(patch).toString('base64')
			}
		},
		resolves: [
			{
				type: 'security',
				id: advisoryId,
				source: { name: 'GitHub Advisory Database', url: advisoryUrl },
				references: [rustsecUrl, upstreamCommit, patchUrl]
			}
		]
	};
	const pedigree = target.pedigree === undefined ? {} : object(target.pedigree);
	const patches = objects(pedigree.patches);
	const existing = patches.filter(
		(item) =>
			objects(item.resolves).some((issue) => issue.id === advisoryId) ||
			(item.diff !== undefined && object(item.diff).url === patchUrl)
	);
	if (
		existing.length > 1 ||
		(existing.length === 1 && !isDeepStrictEqual(existing[0], expectedPatch))
	) {
		throw new Error('Conflicting glib patch provenance.');
	}
	if (!existing.length) patches.push(expectedPatch);
	target.pedigree = { ...pedigree, patches };
	const references = objects(target.externalReferences);
	const expectedReference = {
		type: 'other',
		url: patchUrl,
		comment: 'Security patch for glib 0.18.5 backported from the upstream commit in pedigree.',
		hashes: [{ alg: 'SHA-256', content: patchSha256 }]
	};
	const patchReferences = references.filter((item) => item.url === patchUrl);
	if (
		patchReferences.length > 1 ||
		(patchReferences.length === 1 && !isDeepStrictEqual(patchReferences[0], expectedReference))
	) {
		throw new Error('The glib patch hash or reference conflicts with the expected value.');
	}
	if (!patchReferences.length) references.push(expectedReference);
	target.externalReferences = references;
	const properties = objects(target.properties);
	for (const [name, value] of Object.entries({
		'mdsh:glib-backport:source-sha': sourceSha,
		'mdsh:glib-backport:patch-sha256': patchSha256
	})) {
		const matches = properties.filter((item) => item.name === name);
		if (matches.length > 1 || (matches.length === 1 && matches[0]?.value !== value)) {
			throw new Error(`Conflicting provenance property: ${name}`);
		}
		if (!matches.length) properties.push({ name, value });
	}
	target.properties = properties;
	return bom;
}

async function main() {
	const [sbomPath, patchPath, extra] = process.argv.slice(2);
	if (!sbomPath || !patchPath || extra !== undefined) {
		throw new Error(
			'Usage: SOURCE_SHA=<sha> node scripts/annotate-cargo-sbom.mjs <sbom.json> <patch-file.patch>'
		);
	}
	const sourceSha = process.env.SOURCE_SHA ?? '';
	if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('SOURCE_SHA must be a full Git SHA.');
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
	if (sourceSha !== head) throw new Error('SOURCE_SHA does not match the checked HEAD.');
	const patch = await readFile(patchPath);
	const trackedPatch = execFileSync('git', ['show', `${sourceSha}:${patchRepositoryPath}`], {
		cwd: root
	});
	if (!patch.equals(trackedPatch))
		throw new Error('The local patch differs from the patch tracked in SOURCE_SHA.');
	const annotated = annotateCargoSbom(
		JSON.parse(await readFile(sbomPath, 'utf8')),
		patch,
		sourceSha
	);
	const temporaryPath = `${sbomPath}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(annotated, null, 2)}\n`, { flag: 'wx' });
	try {
		await rename(temporaryPath, sbomPath);
	} finally {
		await unlink(temporaryPath).catch((error) => {
			if (error.code !== 'ENOENT') throw error;
		});
	}
}

if (
	process.argv[1] &&
	existsSync(process.argv[1]) &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await main();
}
