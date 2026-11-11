// Single machine-readable policy for the Desktop release channel.
//
// Three operating-system builds produce four installers:
// macOS ARM64 DMG, Windows x64 NSIS, and Linux x64 deb plus AppImage.
// The collector, the Tauri bundle configuration and the workflow selection
// read this file. scripts/desktop-release-policy.test.mjs checks that the
// published documentation and the configuration still agree with it.

/** @typedef {'macos-15' | 'ubuntu-24.04' | 'windows-2022'} DesktopPlatform */

/**
 * Accepted bundle targets for each operating-system runner.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const DESKTOP_PLATFORM_BUNDLES = Object.freeze({
	'macos-15': Object.freeze(['dmg']),
	'ubuntu-24.04': Object.freeze(['deb', 'appimage']),
	'windows-2022': Object.freeze(['nsis'])
});

export const DESKTOP_ARTIFACT_PREFIX = 'desktop-installers-';

/** Installer-like names that the policy does not accept. */
const UNSUPPORTED_INSTALLER_PATTERN = /\.(?:msi|rpm|exe|dmg|deb|appimage)$/i;

/**
 * @typedef {{
 *   id: string,
 *   platform: string,
 *   bundle: string,
 *   label: string,
 *   pattern: RegExp,
 *   releaseName: (name: string) => string
 * }} DesktopReleaseFormat
 */

/** @type {readonly DesktopReleaseFormat[]} */
export const DESKTOP_RELEASE_FORMATS = Object.freeze([
	Object.freeze({
		id: 'macos-dmg',
		platform: 'macos-15',
		bundle: 'dmg',
		label: 'macOS Apple Silicon DMG',
		pattern: /_(?:aarch64|macOS_Apple-Silicon)\.dmg$/,
		releaseName: (name) => name.replace(/_aarch64\.dmg$/, '_macOS_Apple-Silicon.dmg')
	}),
	Object.freeze({
		id: 'linux-deb',
		platform: 'ubuntu-24.04',
		bundle: 'deb',
		label: 'Linux x64 deb',
		pattern: /\.deb$/,
		releaseName: (name) => name
	}),
	Object.freeze({
		id: 'linux-appimage',
		platform: 'ubuntu-24.04',
		bundle: 'appimage',
		label: 'Linux x64 AppImage',
		pattern: /\.AppImage$/,
		releaseName: (name) => name
	}),
	Object.freeze({
		id: 'windows-nsis',
		platform: 'windows-2022',
		bundle: 'nsis',
		label: 'Windows x64 NSIS installer',
		pattern: /-setup\.exe$/,
		releaseName: (name) => name
	})
]);

/**
 * @param {string} name
 * @returns {DesktopReleaseFormat | undefined}
 */
function supportedFormat(name) {
	return DESKTOP_RELEASE_FORMATS.find((format) => format.pattern.test(name));
}

/**
 * Return the accepted format for one file name.
 * An installer name outside the policy throws instead of passing silently.
 * @param {string} name
 * @returns {DesktopReleaseFormat | undefined}
 */
export function formatForFile(name) {
	const format = supportedFormat(name);
	if (format) return format;
	if (UNSUPPORTED_INSTALLER_PATTERN.test(name)) {
		throw new Error(`Unsupported installer format: ${name}`);
	}
	return undefined;
}

/** @param {string} name */
export function isInstallerName(name) {
	return Boolean(supportedFormat(name));
}

/** @param {string} name */
export function platformForFile(name) {
	const format = formatForFile(name);
	if (!format) throw new Error(`Not an installer file: ${name}`);
	return format.platform;
}

/**
 * Published release name for one built installer.
 * @param {string} name
 */
export function releaseNameFor(name) {
	const format = formatForFile(name);
	if (!format) throw new Error(`Not an installer file: ${name}`);
	return format.releaseName(name);
}

/**
 * Comma-separated Tauri `--bundles` value for one runner.
 * @param {string} platform
 */
export function bundleTargets(platform) {
	const bundles = DESKTOP_PLATFORM_BUNDLES[platform];
	if (!bundles) throw new Error(`Unknown desktop platform: ${platform}`);
	return bundles.join(',');
}

/**
 * Workflow artifact name for one runner.
 * @param {string} platform
 */
export function artifactName(platform) {
	if (!DESKTOP_PLATFORM_BUNDLES[platform]) throw new Error(`Unknown desktop platform: ${platform}`);
	return `${DESKTOP_ARTIFACT_PREFIX}${platform}`;
}

/**
 * Runner that owns an uploaded workflow artifact directory.
 * @param {string} name
 */
export function platformFromArtifact(name) {
	const platform = name.startsWith(DESKTOP_ARTIFACT_PREFIX)
		? name.slice(DESKTOP_ARTIFACT_PREFIX.length)
		: '';
	if (!DESKTOP_PLATFORM_BUNDLES[platform]) {
		throw new Error(`Unknown desktop artifact directory: ${name}`);
	}
	return platform;
}
