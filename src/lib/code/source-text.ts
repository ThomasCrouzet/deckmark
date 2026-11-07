import { Text, type ChangeSet } from '@codemirror/state';

const endings: Record<string, string> = { l: '\n', c: '\r\n', r: '\r' };

/** Immutable raw-byte snapshot. Import this module with the lazy editor. */
export class SourceText {
	readonly doc: Text;
	/** This counter is local to the buffer. It is not a store revision. */
	readonly revision: number;
	readonly #separators: Text;
	readonly #uniform: string | null;
	#text: string | undefined;

	private constructor(
		doc: Text,
		separators: Text,
		uniform: string | null,
		revision: number,
		text?: string
	) {
		this.doc = doc;
		this.#separators = separators;
		this.#uniform = uniform;
		this.revision = revision;
		this.#text = text;
	}

	static create(source: string, doc: Text): SourceText {
		const codes: string[] = [];
		let uniform: string | null | undefined;
		for (const match of source.matchAll(/\r\n?|\n/g)) {
			const ending = match[0];
			codes.push(ending === '\r\n' ? 'c' : ending === '\r' ? 'r' : 'l');
			if (uniform === undefined) uniform = ending;
			else if (uniform !== ending) uniform = null;
		}
		codes.push('');
		if (codes.length !== doc.lines) throw new Error('Source line map does not match native text');
		return new SourceText(
			doc,
			Text.of(codes),
			uniform ?? (codes.length === 1 ? '\n' : null),
			0,
			source
		);
	}

	apply(changes: ChangeSet, doc: Text): SourceText {
		if (changes.length !== this.doc.length || changes.newLength !== doc.length) {
			throw new Error('Source change does not match native text');
		}
		if (changes.empty) return this;
		let separators = this.#separators;
		let shift = 0;
		changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
			// Most keys change no separator and need no raw offset lookup.
			if (from === to && inserted.lines === 1) return;
			const first = this.doc.lineAt(from).number;
			const last = this.doc.lineAt(to).number;
			if (first === last && inserted.lines === 1) return;
			const code = this.#separators.line(first).text || this.#separators.line(1).text || 'l';
			const added = inserted.lines - 1;
			// Each separator occupies one code and one Text line break. The final
			// empty line makes line-index edits persistent and logarithmic.
			separators = separators.replace(
				(first - 1 + shift) * 2,
				(last - 1 + shift) * 2,
				Text.of([...Array<string>(added).fill(code), ''])
			);
			shift += added - (last - first);
		});
		if (separators.lines !== doc.lines) throw new Error('Source separator update is inconsistent');
		return new SourceText(doc, separators, this.#uniform, this.revision + 1);
	}

	getText(): string {
		if (this.#text !== undefined) return this.#text;
		if (this.#uniform !== null) {
			this.#text = this.doc.sliceString(0, this.doc.length, this.#uniform);
		} else {
			const parts: string[] = [];
			const separators = this.#separators.iterLines();
			for (const part of this.doc.iter()) {
				parts.push(part === '\n' ? endings[separators.next().value]! : part);
			}
			this.#text = parts.join('');
		}
		return this.#text;
	}
}
