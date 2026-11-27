// §P1.9 - Opt-in guided tour, offered as an explicit button on the Welcome
// screen (never created automatically: the corpus stays empty until the user
// asks for either a new file or this tour).
//
// Three files linked by wiki-links `[[Target]]`, matched by filename (see
// `MetaIndex.resolveWikiLink`) - opening them together shows off backlinks
// and the link graph, not just a single empty editor.
//
// The text follows the interface language. Shortcut labels come from the same
// helpers as the rest of the interface, so each platform reads its own keys.

import type { Locale } from '#lib/i18n/index.js';
import { formatKbd, modKey } from '#lib/platform.js';

export interface DemoDoc {
	name: string;
	content: string;
}

/** Wraps a shortcut, written in Mac notation, as inline code for this platform. */
function key(macShortcut: string): string {
	return `\`${formatKbd(macShortcut)}\``;
}

function englishDemo(): DemoDoc[] {
	const followLink = `\`${modKey()}+click\``;
	const followKey = `\`${formatKbd('⌥')}Enter\``;
	return [
		{
			name: 'Welcome to the DeckMark demo.md',
			content: `# Welcome to the DeckMark demo

A short, offline tour of what DeckMark can do. Nothing here is pinned: multi-select
these three files in the sidebar and trash them whenever you are done.

## Try it

- Switch modes: Edit (${key('⌘E')}), Source (${key('⌘/')}), Read (${key('⌘R')}).
- Open the command palette (${key('⌘⇧P')}) and run "Links graph" - these three
  files show up as connected nodes.
- Follow a link below: ${followLink} it in Edit mode, or put the caret in it and
  press ${followKey}. In Read mode, a plain click is enough. Once there, look at
  the sidebar: it shows this file as a backlink.

## Explore

- [[Math and diagrams]] - KaTeX math and a live Mermaid diagram.
- [[Task list]] - a markdown checklist you can toggle in Edit mode.
`
		},
		{
			name: 'Math and diagrams.md',
			content: `# Math and diagrams

Back to [[Welcome to the DeckMark demo]].

## Math (KaTeX)

Inline: $E = mc^2$.

Block:

$$
\\frac{d}{dx}\\left( \\int_{0}^{x} f(u)\\,du \\right) = f(x)
$$

## Diagram (Mermaid)

\`\`\`mermaid
graph LR
  A[Write markdown] --> B[Edit or source]
  B --> C[Auto-saved locally]
  C --> D[Export md / PDF / HTML / ZIP]
\`\`\`

Switch to Edit mode (${key('⌘E')}) - the diagram above renders live as you edit
it, not only in Read mode.
`
		},
		{
			name: 'Task list.md',
			content: `# Task list

Back to [[Welcome to the DeckMark demo]].

A plain markdown checklist - click a box in Edit mode to toggle it.

- [x] Open this demo
- [ ] Switch to Source mode (${key('⌘/')}) and look at the raw markdown
- [ ] Open the command palette (${key('⌘⇧P')})
- [ ] Open the link graph and see these three files connected
- [ ] Delete the demo files when you are done

## Also try (palette & settings)

These stay offline and optional - open them from the command palette (${key('⌘⇧P')})
or Settings (${key('⌘,')}):

- **Presentation mode** - split a note on a line that is only \`---\` into
  fullscreen slides.
- **Version history** - local snapshots with a lightweight diff and restore.
- **Templates** - dated builtins and your own document starters.
- **Encrypted backup** - portable JSON export of drafts, workspaces, and custom templates with an optional AES-GCM passphrase.
`
		}
	];
}

function frenchDemo(): DemoDoc[] {
	const followLink = `\`${modKey()}+clic\``;
	const followKey = `\`${formatKbd('⌥')}Entrée\``;
	return [
		{
			name: 'Bienvenue dans la démo DeckMark.md',
			content: `# Bienvenue dans la démo DeckMark

Une courte visite hors ligne de ce que DeckMark sait faire. Rien n'est épinglé :
sélectionnez ces trois fichiers dans la barre latérale et mettez-les à la corbeille
quand vous avez terminé.

## À essayer

- Changez de mode : Éditer (${key('⌘E')}), Source (${key('⌘/')}), Lire (${key('⌘R')}).
- Ouvrez la palette de commandes (${key('⌘⇧P')}) et lancez « Graphe des liens » :
  ces trois fichiers apparaissent comme des nœuds reliés.
- Suivez un lien ci-dessous : ${followLink} dessus en mode édition, ou placez le
  curseur dedans et appuyez sur ${followKey}. En mode lecture, un simple clic
  suffit. Une fois sur place, regardez la barre latérale : elle affiche ce fichier
  comme rétrolien.

## À explorer

- [[Maths et diagrammes]] - des formules KaTeX et un diagramme Mermaid en direct.
- [[Liste de tâches]] - une liste de tâches Markdown que vous pouvez cocher en mode édition.
`
		},
		{
			name: 'Maths et diagrammes.md',
			content: `# Maths et diagrammes

Retour à [[Bienvenue dans la démo DeckMark]].

## Maths (KaTeX)

En ligne : $E = mc^2$.

Bloc :

$$
\\frac{d}{dx}\\left( \\int_{0}^{x} f(u)\\,du \\right) = f(x)
$$

## Diagramme (Mermaid)

\`\`\`mermaid
graph LR
  A[Écrire en Markdown] --> B[Édition ou source]
  B --> C[Enregistrement local automatique]
  C --> D[Export md / PDF / HTML / ZIP]
\`\`\`

Passez en mode édition (${key('⌘E')}) : le diagramme ci-dessus s'affiche en direct
pendant que vous le modifiez, pas seulement en mode lecture.
`
		},
		{
			name: 'Liste de tâches.md',
			content: `# Liste de tâches

Retour à [[Bienvenue dans la démo DeckMark]].

Une simple liste de tâches Markdown : cliquez sur une case en mode édition pour la cocher.

- [x] Ouvrir cette démo
- [ ] Passer en mode Source (${key('⌘/')}) et regarder le Markdown brut
- [ ] Ouvrir la palette de commandes (${key('⌘⇧P')})
- [ ] Ouvrir le graphe des liens et voir ces trois fichiers reliés
- [ ] Supprimer les fichiers de démo quand vous avez terminé

## À essayer aussi (palette et réglages)

Ces fonctions restent hors ligne et facultatives : ouvrez-les depuis la palette de
commandes (${key('⌘⇧P')}) ou les Réglages (${key('⌘,')}) :

- **Mode présentation** - découpez une note en diapositives plein écran avec une
  ligne qui contient seulement \`---\`.
- **Historique des versions** - instantanés locaux avec comparaison légère et restauration.
- **Modèles** - modèles intégrés datés et vos propres modèles de document.
- **Sauvegarde chiffrée** - export JSON portable des brouillons, des espaces de travail et des modèles personnalisés, avec une phrase secrète AES-GCM facultative.
`
		}
	];
}

/** Builds the three linked demo files in the interface language. */
export function demoDocs(locale: Locale): DemoDoc[] {
	return locale === 'fr' ? frenchDemo() : englishDemo();
}
