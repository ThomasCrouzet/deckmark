import type { Parent, PhrasingContent } from 'mdast';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { State, Tokenizer } from 'micromark-util-types';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { $inputRule, $markSchema, $remark } from '@milkdown/kit/utils';
import { t } from '#lib/i18n/index.js';
import { modKey } from '#lib/platform.js';
import { extractWikiLinkTargets } from './wiki-links';

interface WikiLink extends Parent {
	type: 'mdshWikiLink';
	children: PhrasingContent[];
}

declare module 'mdast' {
	interface RootContentMap {
		mdshWikiLink: WikiLink;
	}

	interface PhrasingContentMap {
		mdshWikiLink: WikiLink;
	}
}

declare module 'micromark-util-types' {
	interface TokenTypeMap {
		mdshWikiLink: 'mdshWikiLink';
	}
}

const wikiLinkPattern = /\[\[([^[\]|\n]+)(\|[^[\]\n]*)?\]\]$/;

function isWikiLink(value: string): boolean {
	return wikiLinkPattern.exec(value)?.index === 0 && extractWikiLinkTargets(value).length === 1;
}

// Parse before Markdown removes escapes. Code and escaped brackets do not enter this tokenizer.
const tokenizeWikiLink: Tokenizer = function (effects, ok, nok) {
	const sliceSerialize = this.sliceSerialize.bind(this);
	const start: State = (code) => {
		effects.enter('mdshWikiLink');
		effects.consume(code);
		return secondBracket;
	};
	const secondBracket: State = (code) => {
		if (code !== 91) return nok(code);
		effects.consume(code);
		return inside;
	};
	const inside: State = (code) => {
		if (code === null || code === -5 || code === -4 || code === -3 || code === 91) {
			return nok(code);
		}
		if (code === 93) {
			effects.consume(code);
			return close;
		}
		effects.consume(code);
		return inside;
	};
	const close: State = (code) => {
		if (code !== 93) return nok(code);
		effects.consume(code);
		const token = effects.exit('mdshWikiLink');
		return isWikiLink(sliceSerialize(token)) ? ok : nok;
	};
	return start;
};

const wikiLinkRemark = $remark(
	'mdshWikiLinks',
	() =>
		function () {
			const data = this.data();
			(data.micromarkExtensions ??= []).push({
				text: { 91: { name: 'mdshWikiLink', tokenize: tokenizeWikiLink } }
			});
			(data.fromMarkdownExtensions ??= []).push({
				enter: {
					mdshWikiLink(token) {
						this.enter({ type: 'mdshWikiLink', children: [] }, token);
					}
				},
				exit: {
					mdshWikiLink(token) {
						const node = this.stack.at(-1) as WikiLink;
						node.children = [{ type: 'text', value: this.sliceSerialize(token) }];
						this.exit(token);
					}
				}
			});
			(data.toMarkdownExtensions ??= []).push({
				handlers: {
					mdshWikiLink(node: WikiLink, _parent, state, info) {
						const value = node.children
							.map((child) => (child.type === 'text' ? child.value : ''))
							.join('');
						// ProseMirror can merge the marks of adjacent links.
						const links = value.match(/\[\[([^[\]|\n]+)(\|[^[\]\n]*)?\]\]/g) ?? [];
						if (
							node.children.every((child) => child.type === 'text') &&
							links.join('') === value &&
							links.every(isWikiLink)
						)
							return value;
						// A deleted delimiter or an added code mark makes this ordinary Markdown again.
						return state.containerPhrasing(node, info);
					}
				}
			});
		}
);

// Keep the mark inclusive because the virtual cursor extension warns about
// non-inclusive marks. The input rule applies the mark to the completed link
// text only.
const wikiLinkSchema = $markSchema('mdshWikiLink', () => ({
	parseDOM: [{ tag: 'span[data-mdsh-wiki-link]' }],
	// The title tells the reader how to follow the link while editing. A plain
	// click keeps placing the caret, so the link needs a modifier key.
	toDOM: () => [
		'span',
		{ 'data-mdsh-wiki-link': '', title: t('editor.wikiLinkHint', { key: modKey() }) },
		0
	],
	parseMarkdown: {
		match: (node) => node.type === 'mdshWikiLink',
		runner: (state, node, markType) => {
			state.openMark(markType).next(node.children).closeMark(markType);
		}
	},
	toMarkdown: {
		match: (mark) => mark.type.name === 'mdshWikiLink',
		runner: (state, mark) => {
			state.withMark(mark, 'mdshWikiLink');
		}
	}
}));

const wikiLinkInputRule = $inputRule(
	(ctx) =>
		new InputRule(wikiLinkPattern, (state, match, start, end) => {
			const value = match[0];
			if (!isWikiLink(value)) return null;
			const position = state.doc.resolve(start);
			const text = position.parent.textBetween(0, position.parentOffset);
			if ((/\\+$/.exec(text)?.[0].length ?? 0) % 2) return null;
			const mark = wikiLinkSchema.type(ctx);
			return state.tr
				.insertText(value, start, end)
				.addMark(start, start + value.length, mark.create())
				.removeStoredMark(mark);
		})
);

export const wikiLinkPlugins = [...wikiLinkRemark, ...wikiLinkSchema, wikiLinkInputRule];

export interface WikiLinkHit {
	target: string;
	from: number;
	to: number;
}

const wikiLinkGlobal = /\[\[([^[\]|\n]+)(\|[^[\]\n]*)?\]\]/g;

/**
 * Finds the marked wiki link that contains or touches `pos`. A position inside
 * a link wins over a position at the edge of a neighbor, because ProseMirror
 * can merge adjacent links into one element.
 */
export function wikiLinkAt(doc: ProseNode, pos: number): WikiLinkHit | null {
	const $pos = doc.resolve(pos);
	const parent = $pos.parent;
	const markType = doc.type.schema.marks.mdshWikiLink;
	if (!parent.isTextblock || !markType) return null;
	const start = $pos.start();
	// A leaf node keeps one placeholder character, so text offsets match positions.
	const text = parent.textBetween(0, parent.content.size, undefined, '\ufffc');
	let edge: WikiLinkHit | null = null;
	for (const match of text.matchAll(wikiLinkGlobal)) {
		const from = start + match.index;
		const to = from + match[0].length;
		if (pos < from || pos > to || !isWikiLink(match[0])) continue;
		if (!doc.rangeHasMark(from, to, markType)) continue;
		const target = extractWikiLinkTargets(match[0])[0];
		if (!target) continue;
		const hit = { target, from, to };
		if (pos > from && pos < to) return hit;
		edge ??= hit;
	}
	return edge;
}
