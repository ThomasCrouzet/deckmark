import { createHash } from 'node:crypto';
import { stressFixture, stressLibrary, stressMatrix } from './benchmark-fixtures/stress.mjs';

export const stressMethod = {
	version: 'codemirror-insert/1',
	clock: 'performance.now',
	start: 'target-beforeinput-capture',
	inputToFrameMs: 'second-animation-frame',
	inputDispatchMs: 'queued-microtask',
	saveObservedMs: 'after-exact-indexeddb-observation',
	insertion: 'x',
	positions: [
		{ id: 'start', ratio: 0.02 },
		{ id: 'middle', ratio: 0.5 },
		{ id: 'end', ratio: 0.98 }
	],
	offset: 'Math.round(currentUtf16Length*ratio)',
	warmups: 0,
	framesBeforeInput: 2,
	idleAfterSampleMs: 550,
	statistic: 'nearest-rank',
	percentiles: [0.5, 0.95],
	decimals: 3
};

export const provenanceInputs = [
	'package.json',
	'package-lock.json',
	'vite.config.ts',
	'tsconfig.json',
	'scripts/build-edition.mjs',
	'scripts/generate-service-worker.mjs',
	'scripts/patch-milkdown-images.mjs',
	'.github/workflows/deploy.yml',
	'.github/workflows/desktop.yml'
];
export const requiredCapabilities = [
	'longTasks',
	'heap',
	'transactionCpu',
	'preview',
	'validation',
	'postIdleCpu',
	'rss'
];
export const resourceKeys = ['domNodes', 'canvasPixels', 'heapBytes', 'rssBytes'];
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const canonical = (value) =>
	JSON.stringify(value, (_key, item) =>
		item && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
			: item
	);
export const same = (left, right) => canonical(left) === canonical(right);
export const isDigest = (value, length = 64) =>
	typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
export const finiteNonnegative = (value) =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const safeCount = (value) => Number.isSafeInteger(value) && value >= 0;

const fixtures = new Map();
const libraries = new Map();
const cases = new Map(stressMatrix().cases.map((entry) => [entry.id, entry]));

export function catalogCase(id) {
	return cases.get(id);
}

export function catalogFixture(id) {
	if (!fixtures.has(id)) fixtures.set(id, stressFixture(id));
	return fixtures.get(id);
}

export function libraryIdentity(count) {
	if (!libraries.has(count)) {
		const rows = stressLibrary(count).map((row, index) => ({
			...row,
			order: index + 2,
			open: false,
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000
		}));
		rows.sort((a, b) => a.id.localeCompare(b.id));
		libraries.set(count, {
			count,
			totalRows: count + 2,
			idsSha256: sha256(JSON.stringify(rows.map((row) => row.id))),
			rowsSha256: sha256(canonical(rows))
		});
	}
	return libraries.get(count);
}

export function sentinelText(mode) {
	return mode === 'json' ? '{"payload":"sentinel"}' : 'Stable sentinel content.\n';
}

export function sourceIdentity(snapshot) {
	return {
		revision: snapshot.source,
		tree: snapshot.sourceTree,
		diffSha256: snapshot.workingDiffSha256,
		untrackedSha256: Object.fromEntries(
			snapshot.untracked.map((entry) => [entry.path, entry.sha256])
		)
	};
}
