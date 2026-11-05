import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../e2e/fixtures/compat');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
	version: number;
	fixtures: Array<{ file: string; sha256: string; bytes: number; origin: string }>;
};

describe('compatibility corpus manifest', () => {
	it('pins every fixture by size and SHA-256', () => {
		expect(manifest.version).toBe(1);
		expect(manifest.fixtures.length).toBeGreaterThan(0);
		for (const fixture of manifest.fixtures) {
			const bytes = readFileSync(join(root, fixture.file));
			expect(bytes.byteLength, fixture.file).toBe(fixture.bytes);
			expect(createHash('sha256').update(bytes).digest('hex'), fixture.file).toBe(fixture.sha256);
			expect(['released', 'synthetic'], fixture.file).toContain(fixture.origin);
		}
	});
});
