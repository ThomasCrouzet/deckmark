import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outputPath = resolve(root, 'THIRD_PARTY_NOTICES.md');
const check = process.argv.includes('--check');

function read(path) {
	return readFileSync(resolve(root, path), 'utf8').trim();
}

function packageVersion(path) {
	return JSON.parse(read(path)).version;
}

const katexVersion = packageVersion('node_modules/katex/package.json');
const lucideVersion = packageVersion('node_modules/@lucide/svelte/package.json');
const katexFonts = readdirSync(resolve(root, 'static/katex/fonts'))
	.filter((name) => name.endsWith('.woff2'))
	.sort();

if (katexFonts.length === 0) throw new Error('No redistributed KaTeX fonts were found.');

const content = `# Third-party notices

This file records notices for third-party code and assets redistributed directly with DeckMark. The generated dependency SBOM provides the complete package inventory.

## KaTeX ${katexVersion} and bundled fonts

Source: https://github.com/KaTeX/KaTeX

The production application redistributes KaTeX CSS and ${katexFonts.length} WOFF2 font files from the KaTeX package under the following MIT license.

\`\`\`text
${read('node_modules/katex/LICENSE')}
\`\`\`

## Lucide for Svelte ${lucideVersion}

Source: https://github.com/lucide-icons/lucide

The interface redistributes Lucide SVG icon components. The upstream package notice includes the ISC license and the MIT notice for icons derived from Feather.

\`\`\`text
${read('node_modules/@lucide/svelte/LICENSE')}
\`\`\`
`;

if (check) {
	if (read(outputPath) !== content.trim()) {
		throw new Error('THIRD_PARTY_NOTICES.md is stale. Run npm run notices:generate.');
	}
} else {
	writeFileSync(outputPath, content);
}
