import { describe, expect, it } from 'vitest';
import { projectDestinations, rewriteProjectDestinations } from './project-links';

describe('project destination rewrite', () => {
	it('rewrites every occurrence in one pass and preserves untouched bytes', () => {
		const source = '# Links\r\n\r\n[One](a.md) and ![Two](img/p.png).\r\n\r\n[One again](a.md)\r\n';
		const result = rewriteProjectDestinations(source, (destination) =>
			destination.source === 'a.md' ? 'b.md' : null
		);
		expect(result).toBe(
			'# Links\r\n\r\n[One](b.md) and ![Two](img/p.png).\r\n\r\n[One again](b.md)\r\n'
		);
		expect(rewriteProjectDestinations(source, () => null)).toBe(source);
	});

	it('rewrites reference definitions even when they appear before direct links', () => {
		const source = '[ref]: old.md\n\n[Text](old.md)\n';
		const result = rewriteProjectDestinations(source, (destination) =>
			destination.source === 'old.md' ? 'new.md' : null
		);
		expect(result).toBe('[ref]: new.md\n\n[Text](new.md)\n');
	});

	it('finds destinations without allocating a full-size bracket table', () => {
		const source = `${'plain text '.repeat(200_000)}[link](a.md)\n`;
		const started = performance.now();
		const destinations = projectDestinations(source);
		expect(destinations.map((entry) => entry.source)).toEqual(['a.md']);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
