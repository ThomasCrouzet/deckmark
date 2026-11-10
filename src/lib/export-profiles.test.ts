import { beforeEach, describe, expect, it } from 'vitest';
import {
	ACTIVE_PROFILE_KEY,
	applyExportProfile,
	createProfile,
	DEFAULT_PROFILES,
	ExportProfileError,
	MAX_PROFILE_DOCUMENT_BYTES,
	MAX_PROFILES,
	parseProfiles,
	persistProfileSelection,
	readProfiles,
	saveProfiles,
	serializeProfiles,
	type ExportProfile,
	type ExportProfileErrorCode
} from './export-profiles';

function expectCode(run: () => unknown, code: ExportProfileErrorCode): void {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ExportProfileError);
		expect((error as ExportProfileError).code).toBe(code);
		return;
	}
	throw new Error(`Expected the profile operation to fail with ${code}`);
}

const STORAGE_KEY = 'mdsh:export-profiles';

function document(profiles: unknown[]): string {
	return JSON.stringify({ format: 'mdsh-export-profiles', schemaVersion: 1, profiles });
}

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

describe('export profile import invariants', () => {
	beforeEach(() => localStorage.clear());

	it('rejects an empty profile collection', () => {
		expectCode(() => parseProfiles(document([])), 'empty');
	});

	it('rejects duplicate profile identifiers', () => {
		expectCode(
			() =>
				parseProfiles(
					document([
						{ ...profile, id: 'same', name: 'First' },
						{ ...profile, id: 'same', name: 'Second' }
					])
				),
			'duplicate'
		);
	});

	it('rejects an identifier with surrounding whitespace', () => {
		expectCode(() => parseProfiles(document([{ ...profile, id: ' padded ' }])), 'invalid');
	});

	it('rejects an oversized collection, document or text field', () => {
		const many = Array.from({ length: MAX_PROFILES + 1 }, (_, index) => ({
			...profile,
			id: `profile-${index}`
		}));
		expectCode(() => parseProfiles(document(many)), 'excess');
		expectCode(
			() =>
				parseProfiles(
					JSON.stringify({
						...JSON.parse(document([profile])),
						padding: 'x'.repeat(MAX_PROFILE_DOCUMENT_BYTES)
					})
				),
			'oversized'
		);
		expectCode(
			() => parseProfiles(document([{ ...profile, header: 'h'.repeat(10_000) }])),
			'invalid'
		);
	});

	it('keeps one stored profile per identifier and repairs a damaged collection', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify([
				{ ...profile, id: 'same', name: 'First' },
				{ ...profile, id: 'same', name: 'Second' },
				{ ...profile, id: '', name: 'Empty id' }
			])
		);
		const profiles = readProfiles();
		expect(profiles.map((entry) => entry.id)).toEqual(['same']);
		expect(profiles[0]!.name).toBe('First');
	});

	it('refuses to persist an empty or duplicate collection', () => {
		expectCode(() => saveProfiles([]), 'empty');
		expectCode(
			() =>
				saveProfiles([
					{ ...profile, id: 'same' },
					{ ...profile, id: 'same' }
				]),
			'duplicate'
		);
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('persists the collection and the active identity together', () => {
		persistProfileSelection([profile], profile.id);
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toHaveLength(1);
		expect(localStorage.getItem(ACTIVE_PROFILE_KEY)).toBe(profile.id);
	});
});
