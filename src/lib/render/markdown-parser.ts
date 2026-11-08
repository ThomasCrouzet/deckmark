import { Marked, type Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import { escapeHTML } from '../html-escape';
import { preprocessWikiLinks, slugify } from '../wiki-links';
import { HeadingIdAllocator } from '../document-navigation';
import { RenderCache } from './render-cache';
import type { RenderStageSample } from './render-stages';

const MAX_HIGHLIGHT_CHARS = 100_000;
const cache = new RenderCache(8 * 1024 * 1024, 512);

export interface MarkdownParserInput {
	content: string;
	wikiLinks: boolean;
	headingPermalinks: boolean;
	codeLabel: string;
	codeLanguageLabel: string;
}

export interface MarkdownParserOutput {
	html: string;
	source: string;
	mermaidCodes: string[];
	stages: RenderStageSample[];
}

type MathToken = Tokens.Generic & {
	type: 'blockMath' | 'inlineMath';
	text: string;
	display?: boolean;
};

export function parseMarkdownSource(input: MarkdownParserInput): MarkdownParserOutput {
	const stages: RenderStageSample[] = [];
	let started = performance.now();
	const source = input.wikiLinks ? preprocessWikiLinks(input.content) : input.content;
	stages.push({ stage: 'wiki', durationMs: performance.now() - started, thread: 'main' });
	const mermaidCodes: string[] = [];
	const headingIds = new HeadingIdAllocator();
	let highlightMs = 0;
	let mathMs = 0;
	const hits = cache.hits;
	const misses = cache.misses;

	function math(tex: string, displayMode: boolean): string {
		const start = performance.now();
		const key = JSON.stringify(['math', tex, displayMode]);
		try {
			const existing = cache.get(key);
			if (existing !== undefined) return existing;
			let html: string;
			try {
				html = katex.renderToString(tex, {
					displayMode,
					throwOnError: false,
					strict: 'ignore',
					output: 'htmlAndMathml',
					trust: false
				});
			} catch {
				html = displayMode
					? `<div class="math-error math-error-display">${escapeHTML(tex)}</div>`
					: `<span class="math-error">${escapeHTML(tex)}</span>`;
			}
			cache.set(key, html);
			return html;
		} finally {
			mathMs += performance.now() - start;
		}
	}

	function highlight(code: string, language: string | null): string {
		const start = performance.now();
		try {
			if (code.length > MAX_HIGHLIGHT_CHARS) return escapeHTML(code);
			const key = JSON.stringify(['code', code, language]);
			const existing = cache.get(key);
			if (existing !== undefined) return existing;
			let html: string;
			try {
				html = language
					? hljs.highlight(code, { language, ignoreIllegals: true }).value
					: hljs.highlightAuto(code).value;
			} catch {
				html = escapeHTML(code);
			}
			cache.set(key, html);
			return html;
		} finally {
			highlightMs += performance.now() - start;
		}
	}

	const marked = new Marked({ gfm: true, breaks: false, pedantic: false });
	marked.use({
		renderer: {
			heading({ tokens, depth, text }) {
				const inner = this.parser.parseInline(tokens);
				const base = slugify(text).slice(0, 80) || `section-${depth}`;
				const slug = headingIds.allocate(base);
				if (depth > 3 || !input.headingPermalinks)
					return `<h${depth} id="${slug}">${inner}</h${depth}>\n`;
				return `<h${depth} id="${slug}">${inner}<a class="mdsh-anchor" href="#${slug}" tabindex="-1" aria-hidden="true"></a></h${depth}>\n`;
			},
			list(token) {
				let body = '';
				for (const item of token.items) body += this.listitem(item);
				const type = token.ordered ? 'ol' : 'ul';
				const start = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
				const cls = token.items.some((item) => item.task) ? ' class="contains-task-list"' : '';
				return `<${type}${start}${cls}>\n${body}</${type}>\n`;
			},
			listitem(item) {
				return `<li${item.task ? ' class="task-list-item"' : ''}>${this.parser.parse(item.tokens)}</li>\n`;
			},
			code({ text, lang }) {
				if (lang === 'mermaid') {
					const index = mermaidCodes.length;
					mermaidCodes.push(text);
					return `<div class="mdsh-mermaid-placeholder" data-mermaid-idx="${index}"></div>\n`;
				}
				const language = lang && hljs.getLanguage(lang) ? lang : null;
				const cls = language ? `hljs language-${language}` : 'hljs';
				const omitted = text.length > MAX_HIGHLIGHT_CHARS ? ' data-mdsh-highlight="omitted"' : '';
				const label = language
					? input.codeLanguageLabel.replace('{lang}', language)
					: input.codeLabel;
				return `<pre aria-label="${escapeHTML(label)}"><code class="${cls}"${omitted}>${highlight(text, language)}</code></pre>\n`;
			}
		},
		extensions: [
			{
				name: 'blockMath',
				level: 'block',
				start(src: string) {
					let i = src.indexOf('$$');
					while (i !== -1) {
						if (i === 0 || src[i - 1] === '\n') return i;
						i = src.indexOf('$$', i + 1);
					}
					return undefined;
				},
				tokenizer(src: string) {
					const match = /^\$\$\s*\n?([\s\S]+?)\n?\s*\$\$(?:\s*\n|\s*$)/.exec(src);
					if (!match) return;
					return { type: 'blockMath', raw: match[0], text: match[1]!.trim() };
				},
				renderer(token) {
					return `<div class="math-block">${math((token as MathToken).text, true)}</div>\n`;
				}
			},
			{
				name: 'inlineMath',
				level: 'inline',
				start(src: string) {
					const index = src.indexOf('$');
					return index < 0 ? undefined : index;
				},
				tokenizer(src: string) {
					if (src.startsWith('$$')) {
						const block = /^\$\$([^\n]+?)\$\$/.exec(src);
						if (block)
							return { type: 'inlineMath', raw: block[0], text: block[1]!.trim(), display: true };
						return;
					}
					const match = /^\$(?!\s)((?:\\\$|[^\n$])+?)(?<!\s)\$(?!\d)/.exec(src);
					if (!match) return;
					return { type: 'inlineMath', raw: match[0], text: match[1] };
				},
				renderer(token) {
					const value = token as MathToken;
					return math(value.text, value.display === true);
				}
			}
		]
	});
	started = performance.now();
	// Keep document-global references and heading deduplication in one lexer/parser.
	const tokens = marked.lexer(source);
	stages.push({ stage: 'tokenize', durationMs: performance.now() - started, thread: 'main' });
	started = performance.now();
	const html = marked.parser(tokens);
	stages.push(
		{ stage: 'parse', durationMs: performance.now() - started, thread: 'main' },
		{ stage: 'highlight', durationMs: highlightMs, thread: 'main' },
		{ stage: 'math', durationMs: mathMs, thread: 'main' },
		{
			stage: 'blocks',
			durationMs: highlightMs + mathMs,
			thread: 'main',
			cacheHits: cache.hits - hits,
			cacheMisses: cache.misses - misses,
			cache: cache.usage()
		}
	);
	return { html, source, mermaidCodes, stages };
}
