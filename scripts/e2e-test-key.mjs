// Build the identity of one listed E2E test for the shard plan and the
// manifest gate. Playwright can share one spec id across the project tests of
// a spec and derive it from the first project, so a filtered --test-list run
// can give the same test a different id. Bind the plan and the digest to the
// stable location fields, the describe path and the project name instead.
export function e2eTestKey(spec, test, suitePath = []) {
	const file = spec.file ?? suitePath[0] ?? '';
	return JSON.stringify([
		file,
		spec.line ?? 0,
		...suitePath,
		spec.title ?? '',
		test.projectName ?? ''
	]);
}
