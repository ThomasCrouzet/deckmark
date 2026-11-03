import { describe, it, expect } from 'vitest';
import { BUILTIN_TEMPLATES, applyTemplateVars, isoDate, templateFileName } from './templates';

const FIXED = new Date('2026-06-16T10:30:00.000Z');

describe('isoDate', () => {
	it('uses the local calendar date near midnight', () => {
		expect(isoDate(new Date(2026, 8, 22, 0, 15))).toBe('2026-09-22');
	});
});

describe('applyTemplateVars', () => {
	it('replaces all occurrences', () => {
		expect(applyTemplateVars('{{date}} / {{date}}', FIXED)).toBe('2026-06-16 / 2026-06-16');
	});

	it('leaves unknown placeholders untouched', () => {
		expect(applyTemplateVars('{{date}} {{title}}', FIXED)).toBe('2026-06-16 {{title}}');
	});
});

describe('built-in templates', () => {
	it('keeps stable, unique identifiers and cases', () => {
		const ids = BUILTIN_TEMPLATES.map((template) => template.id);
		expect(ids).toEqual([
			'builtin:meeting',
			'builtin:journal',
			'builtin:todo',
			'builtin:readme',
			'builtin:specification',
			'builtin:incident',
			'builtin:personal-notes'
		]);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('builds readable file names with the template date', () => {
		const byId = (id: string) => BUILTIN_TEMPLATES.find((template) => template.id === id)!;
		expect(templateFileName(byId('builtin:readme'), FIXED)).toBe('README.md');
		expect(templateFileName(byId('builtin:incident'), FIXED)).toBe('Incident 2026-06-16.md');
		expect(templateFileName(byId('builtin:personal-notes'), FIXED)).toBe('Notes 2026-06-16.md');
		expect(templateFileName(byId('builtin:journal'), FIXED)).toBe('2026-06-16.md');
	});

	it('produces Markdown for each starter', () => {
		for (const template of BUILTIN_TEMPLATES) {
			expect(template.content).toContain('# ');
			expect(template.content.length).toBeGreaterThan(20);
		}
	});
});
