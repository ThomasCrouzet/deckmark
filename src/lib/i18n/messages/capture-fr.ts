import type { captureEn } from './capture-en';

export const captureFr: Record<keyof typeof captureEn, string> = {
	'capture.title': 'Capture rapide',
	'capture.hint': "Enregistrez une note sans ouvrir l'éditeur.",
	'capture.titleLabel': 'Titre',
	'capture.titlePlaceholder': 'Titre de la note (facultatif)',
	'capture.project': 'Enregistrer dans',
	'capture.library': 'Bibliothèque',
	'capture.content': 'Note',
	'capture.contentPlaceholder': 'Saisissez ou collez votre note.',
	'capture.paste': 'Coller depuis le presse-papiers',
	'capture.keyboardHint': 'Ctrl ou Cmd avec Entrée enregistre.',
	'capture.save': 'Enregistrer la note',
	'capture.cancel': 'Annuler',
	'capture.saved': 'Note enregistrée.',
	'capture.contentRequired': "Saisissez le texte de la note avant d'enregistrer.",
	'capture.clipboardFailed': 'Impossible de lire le presse-papiers. Collez avec le clavier.',
	'capture.saveFailed': "Impossible d'enregistrer la note : {message}",
	'capture.loadFailed': "La fenêtre de capture rapide n'a pas pu se charger.",
	'settings.capture': 'Capture rapide (facultatif)',
	'settings.captureHelp':
		'Ouvrez une petite fenêtre de capture depuis toute application avec un raccourci global. Le raccourci est désactivé par défaut.',
	'settings.captureEnable': 'Activer le raccourci global',
	'settings.captureShortcut': 'Raccourci',
	'settings.captureShortcutHelp':
		"Utilisez la forme d'accélérateur Tauri, par exemple CommandOrControl+Shift+Space.",
	'settings.captureRegistered': 'Le raccourci est enregistré : {shortcut}.',
	'settings.captureNotRegistered': "Le raccourci n'est pas enregistré.",
	'settings.captureOpen': 'Ouvrir la fenêtre de capture maintenant'
};
