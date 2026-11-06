// Loaded with the lazy diagnostics panel, not with the startup catalog.
export const diagnosticsEn = {
	'settings.diagnostics': 'Diagnostics',
	'settings.diagnosticsHint': 'Build a local report. Nothing is sent automatically.',
	'settings.reportProblem': 'Report a problem',
	'settings.diagnosticsDescription': 'What happened? Your text is included exactly as written.',
	'settings.diagnosticsIncludeStats': 'Include document counts and sizes (no text or names)',
	'settings.diagnosticsPrivacy':
		'Do not paste secrets. The report excludes documents, paths, keys, prompts and model replies.',
	'settings.diagnosticsBuild': 'Preview report',
	'settings.diagnosticsDownload': 'Download report',
	'settings.diagnosticsCancel': 'Cancel',
	'settings.diagnosticsFailed': 'The report could not be built.'
};

export type DiagnosticsMessageKey = keyof typeof diagnosticsEn;
