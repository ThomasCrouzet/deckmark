import { mkdir, writeFile } from 'node:fs/promises';

/** Keep one complete source comparison artifact for each browser run. */
export default class SourceFidelityReporter {
	metadata = {};
	tests = [];
	comparisons = [];

	onBegin(config) {
		this.metadata = config.metadata;
	}

	onTestEnd(test, result) {
		if (!test.location.file.endsWith('/source-fidelity.spec.ts')) return;
		const paths = result.attachments.find(
			(item) => item.name === 'source-fidelity-path-counts.json'
		)?.body;
		this.tests.push({
			title: test.titlePath().join(' / '),
			status: result.status,
			retry: result.retry,
			...(paths ? JSON.parse(paths.toString()) : {}),
			errors: result.errors.map((error) => error.message)
		});
		for (const attachment of result.attachments) {
			if (!attachment.name.endsWith('-metrics.json') || !attachment.body) continue;
			const metrics = JSON.parse(attachment.body.toString());
			const content = (suffix) =>
				result.attachments
					.find((item) => item.name === `${metrics.fixture}-${suffix}`)
					?.body?.toString();
			this.comparisons.push({
				...metrics,
				status: result.status,
				retry: result.retry,
				sourceText: content('source.md'),
				expectedText: content('expected.md'),
				actualText: content('actual.md'),
				gitDiff: content('git.diff'),
				unexpectedDiff: content('unexpected.diff')
			});
		}
	}

	async onEnd(result) {
		if (!this.tests.length) return;
		await mkdir('test-results', { recursive: true });
		const exact = this.comparisons.filter((item) => item.exact).length;
		const pathCounts = { fastPath: 0, blockFallback: 0, fullSerializer: 0 };
		for (const test of this.tests) {
			for (const path of Object.keys(pathCounts)) pathCounts[path] += test.pathCounts?.[path] ?? 0;
		}
		const unexpectedLines = this.comparisons.reduce(
			(total, item) => total + item.unexpectedLines.added + item.unexpectedLines.removed,
			0
		);
		await writeFile(
			'test-results/source-fidelity.json',
			JSON.stringify(
				{
					schema: 2,
					...this.metadata,
					status: result.status,
					totals: { comparisons: this.comparisons.length, exact, unexpectedLines, pathCounts },
					tests: this.tests,
					comparisons: this.comparisons.toSorted(
						(a, b) =>
							b.unexpectedLines.added +
							b.unexpectedLines.removed -
							(a.unexpectedLines.added + a.unexpectedLines.removed)
					)
				},
				null,
				2
			) + '\n'
		);
		console.log(
			`Source fidelity: ${exact}/${this.comparisons.length} exact comparisons; ${unexpectedLines} unexpected changed lines; paths: ${pathCounts.fastPath} fast, ${pathCounts.blockFallback} block fallback, ${pathCounts.fullSerializer} full serializer. See test-results/source-fidelity.json.`
		);
	}
}
