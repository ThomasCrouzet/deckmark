import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBackupWithReport } from './backup';

const fixture = (name: string) =>
	readFileSync(join(import.meta.dirname, '../../../e2e/fixtures/compat', name), 'utf8');

describe('released backup compatibility corpus', () => {
	it('reads a schema 1 backup with empty collections', () => {
		const parsed = parseBackupWithReport(fixture('backup-v1-empty.json'));
		expect(parsed.backup.schemaVersion).toBe(1);
		expect(parsed.backup.drafts).toEqual([]);
		expect(parsed.backup.projects).toEqual([]);
	});

	it('reads a schema 2 backup with project collections', () => {
		const parsed = parseBackupWithReport(fixture('backup-v2-empty.json'));
		expect(parsed.backup.schemaVersion).toBe(2);
		expect(parsed.backup.projects).toEqual([]);
		expect(parsed.backup.projectAssets).toEqual([]);
	});
});
