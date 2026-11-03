import { describe, expect, it } from 'vitest';
import {
	applyExportProfile,
	createProfile,
	DEFAULT_PROFILES,
	parseProfiles,
	serializeProfiles,
	type ExportProfile
} from './export-profiles';

const profile: ExportProfile = {
	...DEFAULT_PROFILES[0]!,
	id: 'test',
	name: 'Letter report',
	pageSize: 'Letter',
	marginMm: 22,
	fontFamily: 'sans',
	fontSizePt: 12,
	includeCover: true,
	header: 'Header',
	footer: 'Footer'
};

describe('export profiles', () => {
	it('round-trips a validated profile document', () => {
		const parsed = parseProfiles(serializeProfiles([profile]));
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({
			name: 'Letter report',
			pageSize: 'Letter',
			marginMm: 22,
			header: 'Header'
		});
	});

	it('rejects malformed or unsafe profiles', () => {
		expect(() => parseProfiles('{}')).toThrow();
		expect(() =>
			parseProfiles(
				JSON.stringify({
					format: 'mdsh-export-profiles',
					schemaVersion: 1,
					profiles: [{ ...profile, marginMm: 999 }]
				})
			)
		).toThrow();
	});

	it('injects deterministic page CSS and decorations', () => {
		const html = applyExportProfile(
			'<html><head></head><body><main>Body</main></body></html>',
			profile,
			'Doc'
		);
		expect(html).toContain('data-export-profile="test"');
		expect(html).toContain('size: Letter');
		expect(html).toContain('margin: 22mm');
		expect(html).toContain('system-ui');
		expect(html).toContain('export-profile-cover');
		expect(html).toContain('Header');
		expect(html).toContain('Footer');
		expect(applyExportProfile('<body></body>', profile, 'Doc')).toContain('Doc');
	});

	it('creates editable profiles', () => {
		const created = createProfile('New', 100);
		expect(created).toMatchObject({ name: 'New', format: 'pdf', pageSize: 'A4' });
	});
});
