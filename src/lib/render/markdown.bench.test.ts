// @vitest-environment jsdom
//
// Performance regression benchmark for mixed Markdown rendering.
// jsdom has no SVG geometry support. This test does not measure Mermaid layout.
// The two-second limit detects large changes in steady-state rendering time.

import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

function buildLargeMarkdown(): string {
	// Include headings, paragraphs, lists, tables, code, math, and Mermaid source.
	const sections: string[] = [];
	const para =
		'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
		'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(3);

	for (let i = 0; i < 50; i++) {
		sections.push(`## Section ${i + 1}\n\n${para}\n`);
		if (i % 5 === 0) {
			sections.push(
				'```mermaid\nflowchart LR\n  A[Start] --> B{Decision}\n  B -->|Yes| C[OK]\n  B -->|No| D[KO]\n```\n\n'
			);
		}
		if (i % 3 === 0) {
			sections.push('```js\nconst x = 42;\nfunction f(y) { return y * 2; }\n```\n\n');
		}
		if (i % 4 === 0) {
			sections.push('| Col A | Col B |\n|---|---|\n| 1 | $a^2 + b^2 = c^2$ |\n| 2 | foo |\n\n');
		}
		sections.push('- item 1\n- item 2 with `inline` code\n- item 3\n\n');
	}

	// Add text until the document reaches at least 50,000 characters.
	const target = 50_000;
	const filler = '\n\nFiller sentence to reach target length. '.repeat(20);
	let current = sections.join('').length;
	while (current < target) {
		sections.push(filler);
		current += filler.length;
	}
	return sections.join('');
}

describe('renderMarkdown - performance benchmark', () => {
	it('renders 50,000 characters of mixed Markdown with less than 2 seconds of CPU time', async () => {
		const md = buildLargeMarkdown();
		expect(md.length).toBeGreaterThanOrEqual(50_000);

		// Exclude module loading from the measured runs.
		await renderMarkdown(md);

		// Use the minimum of three runs to reduce noise from garbage collection.
		// CPU time ignores scheduler stalls on a shared CI runner while still
		// detecting a large increase in render work.
		const cpuTimes: number[] = [];
		const wallTimes: number[] = [];
		for (let i = 0; i < 3; i++) {
			const cpuStart = process.cpuUsage();
			const t0 = performance.now();
			await renderMarkdown(md);
			wallTimes.push(performance.now() - t0);
			const used = process.cpuUsage(cpuStart);
			cpuTimes.push((used.user + used.system) / 1000);
		}
		const min = Math.min(...cpuTimes);
		console.log(
			`[bench] renderMarkdown 50k mixed: minCpu=${min.toFixed(0)}ms ` +
				`(cpu: ${cpuTimes.map((t) => t.toFixed(0)).join('/')}ms, ` +
				`wall: ${wallTimes.map((t) => t.toFixed(0)).join('/')}ms)`
		);

		// Browser tests check the SVG output. This limit checks mixed-content rendering work.
		expect(min).toBeLessThan(2_000);
	}, 30_000);
});
