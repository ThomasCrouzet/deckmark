import type { DiffMessageKey } from './diff-en';

export const diffFr = {
	'diff.added': 'Ligne {line} ajoutée',
	'diff.after': 'Après',
	'diff.approximate': 'Comparaison volumineuse. Les nombres sont approximatifs.',
	'diff.before': 'Avant',
	'diff.lineTruncated': 'La ligne {line} est raccourcie dans cette vue.',
	'diff.noChanges': 'Aucune ligne modifiée.',
	'diff.omitted': '{old} ancienne(s) ligne(s) et {next} nouvelle(s) ligne(s) masquée(s)',
	'diff.removed': 'Ligne {line} supprimée',
	'diff.summary': '{added} ligne(s) ajoutée(s) et {removed} supprimée(s).',
	'diff.unchanged': 'Ligne {line} inchangée',
	'diskConflict.cancel': 'Annuler',
	'diskConflict.description':
		'Ce fichier a changé sur le disque. Comparez les deux révisions avant de choisir le contenu à conserver.',
	'diskConflict.disk': 'Révision du disque',
	'diskConflict.local': 'Révision locale',
	'diskConflict.overwrite': 'Écraser le disque',
	'diskConflict.reload': 'Utiliser la révision du disque',
	'diskConflict.title': 'Résoudre le conflit disque pour {name}',
	'replacePreview.cancel': 'Retour à la recherche',
	'replacePreview.confirm': 'Confirmer le remplacement',
	'replacePreview.description':
		'Examine chaque fichier modifié. Aucun document ne change avant votre confirmation.',
	'replacePreview.fileCount': '{files} fichier(s), {occurrences} remplacement(s)',
	'replacePreview.next': 'Fichier suivant',
	'replacePreview.previous': 'Fichier précédent',
	'replacePreview.stale':
		'Un fichier de l’aperçu a changé. Créez un nouvel aperçu avant le remplacement.',
	'replacePreview.title': 'Aperçu du remplacement'
} as const satisfies Record<DiffMessageKey, string>;
