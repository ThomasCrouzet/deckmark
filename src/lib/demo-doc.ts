// §P1.9 - Opt-in guided tour, offered as an explicit button on the Welcome
// screen (never created automatically: the corpus stays empty until the user
// asks for either a new file or this tour).
//
// Three files linked by wiki-links `[[Target]]`, matched by filename (see
// `MetaIndex.resolveWikiLink`) - opening them together shows off backlinks
// and the link graph, not just a single empty editor.

export interface DemoDoc {
	name: string;
	content: string;
}

export const DEMO_DOCS: DemoDoc[] = [
	{
		name: 'Welcome to the DeckMark demo.md',
		content: `# Welcome to the DeckMark demo

A short, offline tour of what DeckMark can do. Nothing here is pinned: multi-select
these three files in the sidebar and trash them whenever you are done.

## Try it

- Switch modes: WYSIWYG (\`⌘E\`), source (\`⌘/\`), reading (\`⌘R\`).
- Open the command palette (\`⌘⇧P\`) and run "Show link graph" - these three
  files show up as connected nodes.
- Click a link below to jump to another demo file. Once there, look at the
  sidebar: it shows this file as a backlink.

## Explore

- [[Math and diagrams]] - KaTeX math and a live Mermaid diagram.
- [[Task list]] - a markdown checklist you can toggle in WYSIWYG mode.
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
  A[Write markdown] --> B[WYSIWYG or source]
  B --> C[Auto-saved locally]
  C --> D[Export md / PDF / HTML / ZIP]
\`\`\`

Switch to WYSIWYG mode (\`⌘E\`) - the diagram above renders live as you edit
it, not only in reading mode.
`
	},
	{
		name: 'Task list.md',
		content: `# Task list

Back to [[Welcome to the DeckMark demo]].

A plain markdown checklist - click a box in WYSIWYG mode to toggle it.

- [x] Open this demo
- [ ] Switch to source mode (\`⌘/\`) and look at the raw markdown
- [ ] Open the command palette (\`⌘⇧P\`)
- [ ] Open the link graph and see these three files connected
- [ ] Delete the demo files when you are done

## Also try (palette & settings)

These stay offline and optional - open them from the command palette (\`⌘⇧P\`)
or Settings (\`⌘,\`):

- **Presentation mode** - split a note on a line that is only \`---\` into
  fullscreen slides.
- **Version history** - local snapshots with a lightweight diff and restore.
- **Templates** - dated builtins and your own document starters.
- **Encrypted backup** - portable JSON export of drafts, workspaces, and custom templates with an optional AES-GCM passphrase.
`
	}
];
