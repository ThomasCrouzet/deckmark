// Local export profiles. Web Light supports HTML and PDF presets only. The
// profile is applied to generated HTML so print and download stay repeatable.

export type ExportProfileFormat = 'html' | 'pdf';
export type PageSize = 'A4' | 'Letter' | 'Legal';
export type ProfileFont = 'serif' | 'sans' | 'mono';

export interface ExportProfile {
	id: string;
	name: string;
	format: ExportProfileFormat;
	pageSize: PageSize;
	marginMm: number;
	fontFamily: ProfileFont;
	fontSizePt: number;
	includeCover: boolean;
	header: string;
	footer: string;
	createdAt: number;
	updatedAt: number;
}

export interface ExportProfileDocument {
	format: 'mdsh-export-profiles';
	schemaVersion: 1;
	profiles: ExportProfile[];
}

const STORAGE_KEY = 'mdsh:export-profiles';
export const ACTIVE_PROFILE_KEY = 'mdsh:export-profile-active';

/** A profile file must stay small enough for one local import step. */
export const MAX_PROFILE_DOCUMENT_BYTES = 512 * 1024;
export const MAX_PROFILES = 100;
const MAX_PROFILE_ID = 128;
const MAX_PROFILE_NAME = 200;
const MAX_PROFILE_TEXT = 500;

export type ExportProfileErrorCode =
	'unsupported' | 'missing' | 'empty' | 'invalid' | 'duplicate' | 'excess' | 'oversized';

/**
 * A rejected import with a stable code. The lazy panel owns the translated
 * text, so this boot module keeps no user-facing message strings.
 */
export class ExportProfileError extends Error {
	readonly code: ExportProfileErrorCode;

	constructor(code: ExportProfileErrorCode) {
		super(code);
		this.name = 'ExportProfileError';
		this.code = code;
	}
}

export const DEFAULT_PROFILES: readonly ExportProfile[] = [
	{
		id: 'builtin:a4-document',
		name: 'A4 document',
		format: 'pdf',
		pageSize: 'A4',
		marginMm: 18,
		fontFamily: 'serif',
		fontSizePt: 11,
		includeCover: false,
		header: '',
		footer: '',
		createdAt: 0,
		updatedAt: 0
	},
	{
		id: 'builtin:letter-report',
		name: 'Letter report',
		format: 'html',
		pageSize: 'Letter',
		marginMm: 20,
		fontFamily: 'sans',
		fontSizePt: 12,
		includeCover: true,
		header: '',
		footer: '',
		createdAt: 0,
		updatedAt: 0
	}
];

function validProfile(value: unknown): value is ExportProfile {
	if (!value || typeof value !== 'object') return false;
	const profile = value as Partial<ExportProfile>;
	return (
		typeof profile.id === 'string' &&
		profile.id.length > 0 &&
		profile.id.length <= MAX_PROFILE_ID &&
		profile.id === profile.id.trim() &&
		typeof profile.name === 'string' &&
		profile.name.trim().length > 0 &&
		profile.name.length <= MAX_PROFILE_NAME &&
		(profile.format === 'html' || profile.format === 'pdf') &&
		(profile.pageSize === 'A4' || profile.pageSize === 'Letter' || profile.pageSize === 'Legal') &&
		(profile.fontFamily === 'serif' ||
			profile.fontFamily === 'sans' ||
			profile.fontFamily === 'mono') &&
		typeof profile.marginMm === 'number' &&
		profile.marginMm >= 5 &&
		profile.marginMm <= 60 &&
		typeof profile.fontSizePt === 'number' &&
		profile.fontSizePt >= 7 &&
		profile.fontSizePt <= 24 &&
		typeof profile.includeCover === 'boolean' &&
		typeof profile.header === 'string' &&
		profile.header.length <= MAX_PROFILE_TEXT &&
		typeof profile.footer === 'string' &&
		profile.footer.length <= MAX_PROFILE_TEXT &&
		Number.isFinite(profile.createdAt) &&
		Number.isFinite(profile.updatedAt)
	);
}

/**
 * Keeps the first valid entry for each identifier. A collection written by an
 * older client can contain duplicate keys, which a keyed list cannot render.
 */
function sanitizeStoredProfiles(values: readonly unknown[]): ExportProfile[] {
	const seen = new Set<string>();
	const profiles: ExportProfile[] = [];
	for (const value of values) {
		if (profiles.length >= MAX_PROFILES) break;
		if (!validProfile(value) || seen.has(value.id)) continue;
		seen.add(value.id);
		profiles.push(value);
	}
	return profiles;
}

export function readProfiles(): ExportProfile[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [...DEFAULT_PROFILES];
		const parsed = JSON.parse(raw) as unknown;
		const values = Array.isArray(parsed)
			? parsed
			: (parsed as Partial<ExportProfileDocument>)?.profiles;
		if (!Array.isArray(values)) return [...DEFAULT_PROFILES];
		const profiles = sanitizeStoredProfiles(values);
		return profiles.length > 0 ? profiles : [...DEFAULT_PROFILES];
	} catch {
		return [...DEFAULT_PROFILES];
	}
}

/** Writes only a complete, renderable collection. A refusal changes nothing. */
export function saveProfiles(profiles: readonly ExportProfile[]): void {
	if (profiles.length === 0) throw new ExportProfileError('empty');
	if (profiles.length > MAX_PROFILES) throw new ExportProfileError('excess');
	const valid = profiles.filter(validProfile);
	if (valid.length !== profiles.length) throw new ExportProfileError('invalid');
	if (new Set(valid.map((profile) => profile.id)).size !== valid.length)
		throw new ExportProfileError('duplicate');
	localStorage.setItem(STORAGE_KEY, JSON.stringify(valid));
}

/**
 * Persists the collection and the active identity in one step. A failed write
 * restores both stored values, so the panel keeps the previous collection.
 */
export function persistProfileSelection(
	profiles: readonly ExportProfile[],
	activeId: string | null
): void {
	if (activeId !== null && !profiles.some((profile) => profile.id === activeId))
		throw new ExportProfileError('invalid');
	const previousCollection = localStorage.getItem(STORAGE_KEY);
	const previousActive = localStorage.getItem(ACTIVE_PROFILE_KEY);
	try {
		saveProfiles(profiles);
		if (activeId === null) localStorage.removeItem(ACTIVE_PROFILE_KEY);
		else localStorage.setItem(ACTIVE_PROFILE_KEY, activeId);
	} catch (failure) {
		restoreStoredValue(STORAGE_KEY, previousCollection);
		restoreStoredValue(ACTIVE_PROFILE_KEY, previousActive);
		throw failure;
	}
}

/** Rollback is best effort and must not hide the original write failure. */
function restoreStoredValue(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// Keep the failure that stopped the write.
	}
}

/**
 * Returns the profile the user selected, or null. Exports keep their built-in
 * layout until a profile is chosen, so existing PDF and print output does not
 * change by default.
 */
export function activeProfile(profiles = readProfiles()): ExportProfile | null {
	const id = localStorage.getItem(ACTIVE_PROFILE_KEY);
	if (!id) return null;
	return profiles.find((profile) => profile.id === id) ?? null;
}

export function setActiveProfile(id: string): void {
	localStorage.setItem(ACTIVE_PROFILE_KEY, id);
}

export function createProfile(name: string, now = Date.now()): ExportProfile {
	return {
		id: crypto.randomUUID(),
		name: name.trim() || 'Export profile',
		format: 'pdf',
		pageSize: 'A4',
		marginMm: 18,
		fontFamily: 'serif',
		fontSizePt: 11,
		includeCover: false,
		header: '',
		footer: '',
		createdAt: now,
		updatedAt: now
	};
}

export function serializeProfiles(profiles: ExportProfile[]): string {
	return JSON.stringify(
		{ format: 'mdsh-export-profiles', schemaVersion: 1, profiles } satisfies ExportProfileDocument,
		null,
		2
	);
}

export function parseProfiles(json: string): ExportProfile[] {
	if (new TextEncoder().encode(json).byteLength > MAX_PROFILE_DOCUMENT_BYTES)
		throw new ExportProfileError('oversized');
	let value: Partial<ExportProfileDocument> | null;
	try {
		value = JSON.parse(json) as Partial<ExportProfileDocument> | null;
	} catch {
		throw new ExportProfileError('invalid');
	}
	if (!value || value.format !== 'mdsh-export-profiles' || value.schemaVersion !== 1)
		throw new ExportProfileError('unsupported');
	if (!Array.isArray(value.profiles)) throw new ExportProfileError('missing');
	if (value.profiles.length === 0) throw new ExportProfileError('empty');
	if (value.profiles.length > MAX_PROFILES) throw new ExportProfileError('excess');
	const profiles = value.profiles.filter(validProfile);
	if (profiles.length !== value.profiles.length) throw new ExportProfileError('invalid');
	if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
		throw new ExportProfileError('duplicate');
	return profiles;
}

const FONT_STACKS: Record<ProfileFont, string> = {
	serif: 'Georgia, "Times New Roman", serif',
	sans: 'system-ui, sans-serif',
	mono: '"SFMono-Regular", Consolas, monospace'
};

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/** Injects deterministic page and typography CSS into generated HTML. */
export function applyExportProfile(html: string, profile: ExportProfile, title: string): string {
	const css = `
@page { size: ${profile.pageSize}; margin: ${profile.marginMm}mm; }
html { font-size: ${profile.fontSizePt}pt; }
body, .print-body { font-family: ${FONT_STACKS[profile.fontFamily]}; }
.export-profile-header, .export-profile-footer {
  position: fixed; left: ${profile.marginMm}mm; right: ${profile.marginMm}mm;
  font-size: 8pt; color: #555; border-top: 1px solid #ccc; padding-top: 2mm;
}
.export-profile-header { top: 4mm; }
.export-profile-footer { bottom: 4mm; }
.export-profile-cover { page-break-after: always; padding-top: 35%; text-align: center; }
.export-profile-cover h1 { font-size: 24pt; }
@media screen { .export-profile-header, .export-profile-footer { position: static; margin: 8px 0; } }
`;
	const decoration = [
		profile.includeCover
			? `<section class="export-profile-cover"><h1>${escapeHtml(title)}</h1></section>`
			: '',
		profile.header ? `<div class="export-profile-header">${escapeHtml(profile.header)}</div>` : '',
		profile.footer ? `<div class="export-profile-footer">${escapeHtml(profile.footer)}</div>` : ''
	]
		.filter(Boolean)
		.join('\n');
	const style = `<style data-export-profile="${escapeHtml(profile.id)}">${css}</style>`;
	const withStyle = html.includes('</head>')
		? html.replace('</head>', `${style}</head>`)
		: `${style}${html}`;
	if (!decoration) return withStyle;
	if (withStyle.includes('<body>')) {
		const cover = profile.includeCover
			? `<section class="export-profile-cover"><h1>${escapeHtml(title)}</h1></section>`
			: '';
		const header = profile.header
			? `<div class="export-profile-header">${escapeHtml(profile.header)}</div>`
			: '';
		const footer = profile.footer
			? `<div class="export-profile-footer">${escapeHtml(profile.footer)}</div>`
			: '';
		return withStyle.replace('<body>', `<body>${header}${cover}${footer}`);
	}
	return `${withStyle}${decoration}`;
}

/** Formats that only a future Desktop converter can provide. */
export function advancedFormatState(format: string): 'unsupported' | 'available' {
	return format === 'docx' || format === 'epub' ? 'unsupported' : 'available';
}
