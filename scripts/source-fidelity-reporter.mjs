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
		this.tests.push({
			title: test.titlePath().join(' / '),
			status: result.status,
			retry: result.retry,
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
		const unexpectedLines = this.comparisons.reduce(
			(total, item) => total + item.unexpectedLines.added + item.unexpectedLines.removed,
			0
		);
		await writeFile(
			'test-results/source-fidelity.json',
			JSON.stringify(
				{
					schema: 1,
					...this.metadata,
					status: result.status,
					totals: { comparisons: this.comparisons.length, exact, unexpectedLines },
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
			`Source fidelity: ${exact}/${this.comparisons.length} exact comparisons; ${unexpectedLines} unexpected changed lines. See test-results/source-fidelity.json.`
		);
	}
}
