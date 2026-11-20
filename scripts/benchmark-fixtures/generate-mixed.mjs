#!/usr/bin/env node
// Write the committed mixed benchmark fixtures. The source of truth is
// mixed.mjs, so a regeneration is deterministic. After a regeneration, copy the
// printed descriptors into manifest.json and run `npm run test:ci`.
// Usage: node scripts/benchmark-fixtures/generate-mixed.mjs [--check]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIXED_FIXTURE_SPECS, mixedNote, mixedStats } from './mixed.mjs';

const root = import.meta.dirname;
const check = process.argv.includes('--check');
let changed = false;
const descriptors = {};
for (const spec of MIXED_FIXTURE_SPECS) {
	const markdown = mixedNote({
		label: spec.label,
		targetBytes: spec.targetBytes,
		imageLineChars: spec.imageLineChars
	});
	const path = join(root, `${spec.id}.md`);
	const stats = mixedStats(markdown);
	descriptors[spec.id] = {
		bytes: stats.bytes,
		sha256: createHash('sha256').update(markdown).digest('hex'),
		maxLineChars: stats.maxLineChars,
		inlineImageCount: stats.inlineImageCount,
		tableRowCount: stats.tableRowCount,
		listItemCount: stats.listItemCount
	};
	let current = null;
	try {
		current = readFileSync(path, 'utf8');
	} catch {
		// The fixture is new.
	}
	if (current === markdown) continue;
	if (check) {
		changed = true;
		console.error(`${spec.id}.md is not the deterministic output.`);
		continue;
	}
	writeFileSync(path, markdown);
	console.log(`wrote ${spec.id}.md`);
}
console.log(JSON.stringify(descriptors, null, '\t'));
if (changed) process.exitCode = 1;
