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
	it(
		'renders 50,000 characters of mixed Markdown in less than 2 seconds',
		{ retry: 1, timeout: 30_000 },
		async () => {
			const md = buildLargeMarkdown();
			expect(md.length).toBeGreaterThanOrEqual(50_000);

			// Exclude module loading from the measured runs.
			await renderMarkdown(md);

			// Use the minimum of five runs to reduce noise from garbage collection
			// and shared-runner scheduling. One retry absorbs a transient stall;
			// a systematic slowdown still fails every attempt.
			const times: number[] = [];
			for (let i = 0; i < 5; i++) {
				const t0 = performance.now();
				await renderMarkdown(md);
				times.push(performance.now() - t0);
			}
			const min = Math.min(...times);
			console.log(
				`[bench] renderMarkdown 50k mixed: min=${min.toFixed(0)}ms (runs: ${times.map((t) => t.toFixed(0)).join('/')}ms)`
			);

			// Browser tests check the SVG output. This limit checks mixed-content rendering time.
			expect(min).toBeLessThan(2_000);
		}
	);
});
