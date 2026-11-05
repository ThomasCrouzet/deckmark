import { describe, expect, it } from 'vitest';
import { filterCommands } from './palette-rank';

const commands = [
	{ id: 'settings', label: 'Settings', keywords: 'preferences theme' },
	{ id: 'new', label: 'New file' },
	{ id: 'export', label: 'Export PDF', keywords: 'print document' }
];

describe('palette command filtering', () => {
	it('returns every command for an empty query', () => {
		expect(filterCommands(commands, '   ')).toEqual(commands);
	});

	it('matches labels and keywords without case or accent sensitivity', () => {
		expect(filterCommands(commands, 'SETTINGS').map((command) => command.id)).toEqual(['settings']);
		expect(filterCommands(commands, 'théme').map((command) => command.id)).toEqual(['settings']);
		expect(filterCommands(commands, 'print').map((command) => command.id)).toEqual(['export']);
	});

	it('keeps the caller order and drops non-matches', () => {
		expect(filterCommands(commands, 'e').map((command) => command.id)).toEqual([
			'settings',
			'new',
			'export'
		]);
		expect(filterCommands(commands, 'missing')).toEqual([]);
	});
});
