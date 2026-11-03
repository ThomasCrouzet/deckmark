// §2.7 - Pure document-template logic (no rune, testable).
//
// The "builtin" templates live in code (never persisted in the database): they
// are therefore always present, do not pollute backups (§1.1 only exports the
// user templates from `db.templates`), and cannot be corrupted.
// User templates, by contrast, are persisted in `db.templates`.

import type { DocumentKind } from './document-kind';
import type { MessageKey } from './i18n/messages/en';

export interface TemplateDef {
	id: string;
	name: string;
	description: string;
	/** Markdown body, with `{{date}}` variables substituted at instantiation. */
	content: string;
	kind?: DocumentKind;
	nameKey?: MessageKey;
	descriptionKey?: MessageKey;
}

/** Provided templates. Stable id `builtin:<slug>` (not persisted, cf. header). */
export const BUILTIN_TEMPLATES: TemplateDef[] = [
	{
		id: 'builtin:meeting',
		name: 'Meeting note',
		description: 'Agenda, decisions, actions',
		nameKey: 'templates.meeting',
		descriptionKey: 'templates.meetingDescription',
		content: `---
title: Meeting {{date}}
tags: [meeting]
---

# Meeting - {{date}}

**Attendees:**

## Agenda

-

## Decisions

-

## Actions

- [ ]
`
	},
	{
		id: 'builtin:journal',
		name: 'Daily journal',
		description: 'Dated entry for the day',
		nameKey: 'templates.journal',
		descriptionKey: 'templates.journalDescription',
		content: `---
title: {{date}}
tags: [journal]
---

# {{date}}

## Notes

`
	},
	{
		id: 'builtin:todo',
		name: 'To-do list',
		description: 'Simple checklist',
		nameKey: 'templates.todo',
		descriptionKey: 'templates.todoDescription',
		content: `# To do

- [ ]
- [ ]
- [ ]
`
	},
	{
		id: 'builtin:readme',
		name: 'README',
		description: 'Project overview and quick start',
		nameKey: 'templates.readme',
		descriptionKey: 'templates.readmeDescription',
		content: `# Project name

One paragraph that explains what this project does.

## Requirements

- Requirement one

## Install

\`\`\`sh
command
\`\`\`

## Usage

\`\`\`sh
command --help
\`\`\`

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| option | value | Description |

## License

License name.
`
	},
	{
		id: 'builtin:specification',
		name: 'Technical specification',
		description: 'Goals, design, and acceptance criteria',
		nameKey: 'templates.specification',
		descriptionKey: 'templates.specificationDescription',
		content: `# Technical specification - Feature

## Context

Describe the current behaviour and the problem.

## Goals

- Goal one

## Non-goals

- Non-goal one

## Design

Describe the data model, interfaces, and flow.

## Acceptance criteria

- [ ] Criterion one

## Risks

- Risk one and its mitigation.
`
	},
	{
		id: 'builtin:incident',
		name: 'Incident report',
		description: 'Timeline, impact, and follow-up',
		nameKey: 'templates.incident',
		descriptionKey: 'templates.incidentDescription',
		content: `# Incident - {{date}}

## Summary

Describe the incident in two sentences.

## Impact

- Affected users or systems:
- Start and end times:

## Timeline

| Time | Event |
| --- | --- |
| 00:00 | Detection |

## Root cause

Describe the confirmed cause.

## Resolution

Describe the action that restored service.

## Follow-up

- [ ] Owner and action
`
	},
	{
		id: 'builtin:personal-notes',
		name: 'Personal notes',
		description: 'Quick notes and reminders',
		nameKey: 'templates.personalNotes',
		descriptionKey: 'templates.personalNotesDescription',
		content: `# Notes - {{date}}

## Ideas

-

## Reminders

- [ ]

## References

-
`
	}
];

/** Today's date in short ISO format (YYYY-MM-DD), sortable and neutral. */
export function isoDate(now: Date = new Date()): string {
	return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Substitutes the template variables. Today: `{{date}}` → today's date.
 * Designed to be extended (time, title…) without breaking existing templates.
 */
export function applyTemplateVars(content: string, now: Date = new Date()): string {
	return content.split('{{date}}').join(isoDate(now));
}

/**
 * Suggested filename for a new document created from a template.
 * Dated templates (meeting, journal) include the date; the others take their
 * template name.
 */
export function templateFileName(
	def: { id: string; name: string },
	now: Date = new Date()
): string {
	const date = isoDate(now);
	if (def.id === 'builtin:journal') return `${date}.md`;
	if (def.id === 'builtin:meeting') return `Meeting ${date}.md`;
	if (def.id === 'builtin:incident') return `Incident ${date}.md`;
	if (def.id === 'builtin:personal-notes') return `Notes ${date}.md`;
	return `${def.name}.md`;
}
