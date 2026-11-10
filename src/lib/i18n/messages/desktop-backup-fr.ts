export const desktopBackupFr = {
	'settings.desktopBackupTitle': 'Sauvegardes locales automatiques',
	'settings.desktopBackupScope':
		'Desktop Complete peut écrire des instantanés dans un dossier que vous choisissez. Les instantanés utilisent le même format portable qu’une sauvegarde manuelle. Aucun service cloud n’est utilisé.',
	'settings.desktopBackupLoading': 'Chargement des réglages de sauvegarde locale...',
	'settings.desktopBackupEnable': 'Activer les sauvegardes planifiées',
	'settings.desktopBackupDisable': 'Désactiver les sauvegardes planifiées',
	'settings.desktopBackupFolder': 'Dossier de sauvegarde',
	'settings.desktopBackupNoFolder': 'Aucun dossier sélectionné.',
	'settings.desktopBackupChooseFolder': 'Choisir un dossier',
	'settings.desktopBackupChooseTitle': 'Choisir un dossier de sauvegarde',
	'settings.desktopBackupFolderHint':
		'DeckMark écrit seulement les fichiers qui commencent par deckmark-backup- et conserve les instantanés les plus récents.',
	'settings.desktopBackupInterval': 'Intervalle (heures)',
	'settings.desktopBackupRetention': 'Instantanés à conserver',
	'settings.desktopBackupKeepHint':
		'Utilisez une valeur de 1 à 50. Les anciens instantanés DeckMark sont supprimés. Les autres fichiers ne sont pas touchés.',
	'settings.desktopBackupLast': 'Dernière sauvegarde',
	'settings.desktopBackupNever': 'Aucune sauvegarde pour le moment.',
	'settings.desktopBackupNext': 'Prochaine sauvegarde',
	'settings.desktopBackupOff': 'La planification est désactivée.',
	'settings.desktopBackupNow': 'Sauvegarder maintenant',
	'settings.desktopBackupList': 'Instantanés',
	'settings.desktopBackupRefresh': 'Actualiser la liste',
	'settings.desktopBackupEmpty': 'Aucun instantané dans ce dossier.',
	'settings.desktopBackupPreview': 'Aperçu',
	'settings.desktopBackupRestore': 'Restaurer',
	'settings.desktopBackupPreviewSummary':
		'Instantané du {date} : {drafts} fichier(s), {workspaces} espace(s), {templates} modèle(s), {snippets} extrait(s), {projects} projet(s) et {assets} ressource(s).',
	'settings.desktopBackupPreviewHint':
		'Vérifiez les nombres avant de restaurer. La restauration demande de fusionner ou de remplacer.',
	'settings.desktopBackupSaved': 'Sauvegarde locale écrite.',
	'settings.desktopBackupRetentionWarning':
		'Sauvegarde écrite dans {path} ({size}) le {date}. Le nettoyage de {failed} ancien(s) instantané(s) a échoué : {error}',
	'settings.desktopBackupRetryCleanup': 'Réessayer le nettoyage',
	'settings.desktopBackupCleanupDone': 'Les anciens instantanés ont été supprimés.',
	'settings.desktopBackupFailed': 'Échec de la sauvegarde.',
	'settings.desktopBackupReadFailed': 'Lecture de l’instantané impossible.',
	'settings.desktopBackupFolderRequired': 'Choisissez d’abord un dossier de sauvegarde.',
	'settings.desktopBackupRestoreFailed': 'Échec de la restauration.'
} as const;
