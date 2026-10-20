import { resolve } from 'node:path';

const desktopPatterns = [
	/^(?:src|src-tauri|static|patches)\//,
	/^scripts\//,
	/^\.github\/workflows\/desktop\.yml$/,
	/^(?:\.node-version|\.npmrc|package(?:-lock)?\.json|rust-toolchain\.toml|svelte\.config\.js|tsconfig\.json|vite\.config\.ts)$/
];

const desktopIgnoredPatterns = [/^src\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/, /^src\/.*\/__tests__\//];

export function needsDesktopValidation(paths) {
	return paths.some(
		(path) =>
			!desktopIgnoredPatterns.some((pattern) => pattern.test(path)) &&
			desktopPatterns.some((pattern) => pattern.test(path))
	);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const paths = Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean);
	process.stdout.write(`required=${needsDesktopValidation(paths)}\n`);
}
