// Lazy language registry for code documents. The dispatch is pure; the
// CodeMirror language package loads only when a matching file opens.

import type { Extension } from '@codemirror/state';

export type CodeLanguageId =
	| 'plain'
	| 'python'
	| 'rust'
	| 'javascript'
	| 'typescript'
	| 'jsx'
	| 'tsx'
	| 'php'
	| 'html'
	| 'css'
	| 'json'
	| 'sql'
	| 'java'
	| 'cpp'
	| 'xml'
	| 'yaml'
	| 'shell';

export interface CodeLanguageDef {
	id: CodeLanguageId;
	label: string;
	extensions: readonly string[];
}

export const CODE_LANGUAGES: readonly CodeLanguageDef[] = [
	{
		id: 'plain',
		label: 'Plain text',
		extensions: ['txt', 'text', 'log', 'csv', 'env', 'ini', 'conf', 'toml', 'mk']
	},
	{ id: 'python', label: 'Python', extensions: ['py'] },
	{ id: 'rust', label: 'Rust', extensions: ['rs'] },
	{ id: 'javascript', label: 'JavaScript', extensions: ['js', 'mjs', 'cjs'] },
	{ id: 'typescript', label: 'TypeScript', extensions: ['ts', 'mts', 'cts'] },
	{ id: 'jsx', label: 'JavaScript JSX', extensions: ['jsx'] },
	{ id: 'tsx', label: 'TypeScript JSX', extensions: ['tsx'] },
	{ id: 'php', label: 'PHP', extensions: ['php'] },
	{ id: 'html', label: 'HTML', extensions: ['html', 'htm'] },
	{ id: 'css', label: 'CSS', extensions: ['css', 'scss', 'less'] },
	{ id: 'json', label: 'JSON', extensions: ['json', 'jsonc'] },
	{ id: 'sql', label: 'SQL', extensions: ['sql'] },
	{ id: 'java', label: 'Java', extensions: ['java'] },
	{ id: 'cpp', label: 'C and C++', extensions: ['c', 'h', 'cc', 'cpp', 'hpp', 'cs'] },
	{ id: 'xml', label: 'XML', extensions: ['xml', 'svg'] },
	{ id: 'yaml', label: 'YAML', extensions: ['yaml', 'yml'] },
	{ id: 'shell', label: 'Shell', extensions: ['sh', 'bash', 'zsh', 'fish', 'ps1'] }
] as const;

const BY_EXTENSION = new Map<string, CodeLanguageDef>();
for (const language of CODE_LANGUAGES) {
	for (const extension of language.extensions) BY_EXTENSION.set(extension, language);
}

export function codeLanguageForExtension(extension: string): CodeLanguageDef {
	return BY_EXTENSION.get(extension.toLowerCase()) ?? CODE_LANGUAGES[0]!;
}

export function codeLanguageForName(name: string): CodeLanguageDef {
	const match = /\.([a-z0-9]+)$/i.exec(name);
	return codeLanguageForExtension(match?.[1] ?? '');
}

/** Loads one language support. Unknown or plain text returns no extension. */
export async function loadCodeLanguage(id: CodeLanguageId): Promise<Extension> {
	switch (id) {
		case 'python': {
			const { python } = await import('@codemirror/lang-python');
			return python();
		}
		case 'rust': {
			const { rust } = await import('@codemirror/lang-rust');
			return rust();
		}
		case 'javascript': {
			const { javascript } = await import('@codemirror/lang-javascript');
			return javascript();
		}
		case 'typescript': {
			const { javascript } = await import('@codemirror/lang-javascript');
			return javascript({ typescript: true });
		}
		case 'jsx': {
			const { javascript } = await import('@codemirror/lang-javascript');
			return javascript({ jsx: true });
		}
		case 'tsx': {
			const { javascript } = await import('@codemirror/lang-javascript');
			return javascript({ jsx: true, typescript: true });
		}
		case 'php': {
			const { php } = await import('@codemirror/lang-php');
			return php();
		}
		case 'html': {
			const { html } = await import('@codemirror/lang-html');
			return html();
		}
		case 'css': {
			const { css } = await import('@codemirror/lang-css');
			return css();
		}
		case 'json': {
			const { json } = await import('@codemirror/lang-json');
			return json();
		}
		case 'sql': {
			const { sql } = await import('@codemirror/lang-sql');
			return sql();
		}
		case 'java': {
			const { java } = await import('@codemirror/lang-java');
			return java();
		}
		case 'cpp': {
			const { cpp } = await import('@codemirror/lang-cpp');
			return cpp();
		}
		case 'xml': {
			const { xml } = await import('@codemirror/lang-xml');
			return xml();
		}
		case 'yaml': {
			const { yaml } = await import('@codemirror/lang-yaml');
			return yaml();
		}
		case 'shell': {
			const [{ StreamLanguage }, { shell }] = await Promise.all([
				import('@codemirror/language'),
				import('@codemirror/legacy-modes/mode/shell')
			]);
			return StreamLanguage.define(shell);
		}
		default:
			return [];
	}
}
