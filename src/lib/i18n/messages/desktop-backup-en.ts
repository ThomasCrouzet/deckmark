export const desktopBackupEn = {
	'settings.desktopBackupTitle': 'Automatic local backups',
	'settings.desktopBackupScope':
		'Desktop Complete can write snapshots to a folder that you choose. Snapshots use the same portable format as a manual backup. No cloud service is used.',
	'settings.desktopBackupLoading': 'Loading desktop backup settings...',
	'settings.desktopBackupEnable': 'Enable scheduled backups',
	'settings.desktopBackupDisable': 'Disable scheduled backups',
	'settings.desktopBackupFolder': 'Backup folder',
	'settings.desktopBackupNoFolder': 'No folder selected.',
	'settings.desktopBackupChooseFolder': 'Choose folder',
	'settings.desktopBackupChooseTitle': 'Choose a backup folder',
	'settings.desktopBackupFolderHint':
		'DeckMark writes only files that start with deckmark-backup- and keeps the newest snapshots.',
	'settings.desktopBackupInterval': 'Interval (hours)',
	'settings.desktopBackupRetention': 'Snapshots to keep',
	'settings.desktopBackupKeepHint':
		'Use a value from 1 to 50. Older DeckMark snapshots are removed. Other files are not touched.',
	'settings.desktopBackupLast': 'Last backup',
	'settings.desktopBackupNever': 'No backup yet.',
	'settings.desktopBackupNext': 'Next backup',
	'settings.desktopBackupOff': 'The schedule is off.',
	'settings.desktopBackupNow': 'Back up now',
	'settings.desktopBackupList': 'Snapshots',
	'settings.desktopBackupRefresh': 'Refresh list',
	'settings.desktopBackupEmpty': 'No snapshot in this folder.',
	'settings.desktopBackupPreview': 'Preview',
	'settings.desktopBackupRestore': 'Restore',
	'settings.desktopBackupPreviewSummary':
		'Snapshot from {date}: {drafts} file(s), {workspaces} workspace(s), {templates} template(s), {snippets} snippet(s), {projects} project(s), and {assets} asset(s).',
	'settings.desktopBackupPreviewHint':
		'Check the counts before you restore. The restore asks for merge or replace.',
	'settings.desktopBackupSaved': 'Local backup written.',
	'settings.desktopBackupRetentionWarning':
		'Backup saved to {path} ({size}) at {date}. Cleanup of {failed} old snapshot(s) failed: {error}',
	'settings.desktopBackupRetryCleanup': 'Retry cleanup',
	'settings.desktopBackupCleanupDone': 'Old snapshots were removed.',
	'settings.desktopBackupFailed': 'Backup failed.',
	'settings.desktopBackupReadFailed': 'Cannot read the snapshot.',
	'settings.desktopBackupFolderRequired': 'Choose a backup folder first.',
	'settings.desktopBackupRestoreFailed': 'Restore failed.'
} as const;
