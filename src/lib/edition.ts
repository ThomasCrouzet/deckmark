// Compile-time edition selected by the build command. The Web edition aliases
// native Tauri packages to a stub, so native modules cannot be reached even by
// a mistaken runtime call.

export type Edition = 'web' | 'desktop';

export const EDITION: Edition = import.meta.env.VITE_EDITION === 'desktop' ? 'desktop' : 'web';
export const IS_WEB_EDITION = EDITION === 'web';
export const IS_DESKTOP_EDITION = EDITION === 'desktop';

export interface EditionManifest {
	edition: Edition;
	features: readonly string[];
	excluded: readonly string[];
}

export const WEB_EXCLUDED_FEATURES = [
	'native-disk',
	'native-projects',
	'native-vault',
	'native-ai',
	'git',
	'cli',
	'mcp',
	'global-capture'
] as const;

export function editionManifest(): EditionManifest {
	return IS_DESKTOP_EDITION
		? {
				edition: 'desktop',
				features: [
					'notes',
					'presentations',
					'code',
					'images',
					'projects',
					'pwa-offline',
					'native-disk',
					'native-projects',
					'native-vault',
					'native-ai'
				],
				excluded: []
			}
		: {
				edition: 'web',
				features: ['notes', 'presentations', 'code', 'images', 'projects', 'pwa-offline'],
				excluded: [...WEB_EXCLUDED_FEATURES]
			};
}
