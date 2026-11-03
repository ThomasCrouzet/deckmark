import { describe, expect, it } from 'vitest';
import {
	documentCapabilities,
	documentKind,
	documentKindForFile,
	documentKindLabelKey,
	fileNameExtension,
	imageMimeForName,
	isBinaryDocument
} from './document-kind';

const presentation = '<!-- mdsh-presentation\n{}\n-->';

describe('documentKindForFile', () => {
	it('keeps explicit kinds above extensions and content', () => {
		expect(documentKindForFile({ name: 'deck.md', kind: 'code' })).toBe('code');
		expect(documentKindForFile({ name: 'note.py', kind: 'note' })).toBe('note');
	});

	it('detects Markdown presentations without changing legacy notes', () => {
		expect(documentKindForFile({ name: 'deck.md', content: presentation })).toBe('presentation');
		expect(documentKindForFile({ name: 'note.md', content: '# Note' })).toBe('note');
		expect(documentKind(presentation)).toBe('presentation');
	});

	it('classifies code, plain text and images by extension', () => {
		for (const name of ['script.py', 'main.rs', 'app.js', 'data.json', 'notes.txt', 'run.sh'])
			expect(documentKindForFile({ name, content: '' })).toBe('code');
		for (const name of ['pixel.png', 'photo.JPEG', 'image.webp'])
			expect(documentKindForFile({ name, content: '' })).toBe('image');
	});

	it('keeps non-Markdown content as code even with a presentation marker', () => {
		expect(documentKindForFile({ name: 'fake.py', content: presentation })).toBe('code');
	});

	it('reads the final extension and image MIME type', () => {
		expect(fileNameExtension('archive.tar.gz')).toBe('gz');
		expect(imageMimeForName('photo.JPG')).toBe('image/jpeg');
		expect(isBinaryDocument({ name: 'photo.png' })).toBe(true);
		expect(isBinaryDocument({ name: 'note.md' })).toBe(false);
	});
});

describe('document capabilities', () => {
	it('limits modes to what each type can edit', () => {
		expect(documentCapabilities('note')).toMatchObject({ edit: true, source: true, read: true });
		expect(documentCapabilities('presentation')).toMatchObject({ present: true, read: false });
		expect(documentCapabilities('code')).toMatchObject({ edit: true, read: false });
		expect(documentCapabilities('image')).toMatchObject({
			edit: false,
			annotate: true,
			read: true
		});
	});

	it('maps every type to a translated label key', () => {
		expect(documentKindLabelKey('note')).toBe('documents.note');
		expect(documentKindLabelKey('presentation')).toBe('documents.presentation');
		expect(documentKindLabelKey('code')).toBe('documents.code');
		expect(documentKindLabelKey('image')).toBe('documents.image');
	});
});
