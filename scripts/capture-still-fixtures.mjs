export const documents = [
	{
		name: 'Design notes',
		content:
			'# Design notes\n\nGive every idea a clear place to start.\n\n- Keep the source readable.\n- Make the next action clear.\n- Keep the work on this device.\n\nSee [[Launch brief]] and [[System map]].\n'
	},
	{
		name: 'System map',
		content:
			'# System map\n\n```mermaid\nflowchart LR\n  A[Capture an idea] --> B[Connect the details]\n  B --> C[Present the result]\n```\n\nReturn to [[Launch brief]].\n'
	},
	{
		name: 'Launch brief',
		content: `# Launch brief

**One idea. A clear plan. A story worth sharing.**

Keep the research, code, and presentation in one local workspace.
Start with [[Design notes]] and follow the [[System map]].

## Make room for good work

| Phase | Deliverable | State |
| --- | --- | --- |
| Discover | Research and linked notes | Complete |
| Build | A small, useful prototype | Ready |
| Share | A clear presentation | Next |

## Ready for the next step

- [x] Connect the research
- [x] Keep the source portable
- [ ] Present the launch story
`
	}
];

function element(id, type, x, y, width, height, extra = {}) {
	return {
		id,
		type,
		x,
		y,
		width,
		height,
		rotation: 0,
		fill: 'transparent',
		stroke: 'none',
		strokeWidth: 0,
		color: '#f3f0e5',
		fontSize: 28,
		textAlign: 'left',
		content: '',
		...extra
	};
}

const deck = {
	version: 1,
	width: 1280,
	height: 720,
	theme: 'dark',
	slides: [
		{
			id: 'launch',
			background: '#101a21',
			notes: 'Start with the idea. Explain how notes, code, and slides support the same story.',
			elements: [
				element('eyebrow', 'text', 72, 55, 720, 55, {
					content: 'FIELD GUIDE / 01',
					color: '#d8af68',
					fontSize: 20
				}),
				element('title', 'text', 72, 175, 790, 240, {
					content: 'From idea  \nto launch.',
					fontSize: 76
				}),
				element('subtitle', 'text', 76, 470, 690, 120, {
					content: 'Write it. Connect it. Share it.\n\nKeep every step on your device.',
					color: '#b3c4c7',
					fontSize: 25
				}),
				element('rule', 'line', 76, 635, 1120, 0, { stroke: '#34505a', strokeWidth: 2 }),
				element('footer', 'text', 76, 654, 1100, 40, {
					content: 'DECKMARK  /  YOUR LOCAL WORKSPACE',
					color: '#d8af68',
					fontSize: 16
				}),
				...['NOTE', 'BUILD', 'SHARE'].flatMap((label, index) => [
					element(`card-${index}`, 'rounded-rectangle', 915, 180 + index * 130, 280, 104, {
						fill: index === 2 ? '#d8af68' : '#1b2e37',
						stroke: '#34505a',
						strokeWidth: 1
					}),
					element(`label-${index}`, 'text', 945, 209 + index * 130, 220, 55, {
						content: `0${index + 1}  ${label}`,
						color: index === 2 ? '#17232b' : '#dce9e6',
						fontSize: 25
					})
				])
			]
		},
		{
			id: 'connect',
			background: '#12242b',
			notes: 'Use one readable source from the first draft to the final export.',
			elements: [
				element('connect-label', 'text', 72, 55, 1100, 45, {
					content: 'A WORKFLOW THAT STAYS WITH YOU',
					color: '#d8af68',
					fontSize: 20
				}),
				element('connect-title', 'text', 72, 125, 1100, 100, {
					content: 'Keep the whole story together.',
					fontSize: 48
				}),
				...[
					['01  Write', 'Notes, code, and research.\n\nA source you can read.'],
					['02  Connect', 'Projects, links, and snippets.\n\nDetails you can find.'],
					['03  Share', 'Slides, HTML, and PDF.\n\nWork you can take anywhere.']
				].flatMap(([title, text], index) => [
					element(`feature-${index}`, 'rounded-rectangle', 72 + index * 389, 290, 357, 310, {
						fill: '#1d353d',
						stroke: '#34505a',
						strokeWidth: 1
					}),
					element(`feature-title-${index}`, 'text', 98 + index * 389, 320, 305, 70, {
						content: title,
						color: '#d8af68',
						fontSize: 30
					}),
					element(`feature-copy-${index}`, 'text', 98 + index * 389, 410, 305, 155, {
						content: text,
						fontSize: 23
					})
				])
			]
		},
		{
			id: 'share',
			background: '#eee8da',
			notes: 'Export the presentation and keep the Markdown source for the next revision.',
			elements: [
				element('share-label', 'text', 80, 90, 1100, 55, {
					content: 'READY FOR WHAT COMES NEXT',
					color: '#8b612b',
					fontSize: 21
				}),
				element('share-title', 'text', 80, 235, 1100, 240, {
					content: 'Your work.\n\nYour next chapter.',
					color: '#182c35',
					fontSize: 64
				}),
				element('share-rule', 'line', 80, 540, 1100, 0, { stroke: '#b28a4c', strokeWidth: 3 }),
				element('share-copy', 'text', 80, 575, 1100, 70, {
					content: 'Export the result. Keep the source.',
					color: '#3d5056',
					fontSize: 30
				})
			]
		}
	]
};

export const presentation =
	deck.slides
		.map(
			(slide) =>
				`<!-- mdsh-slide:${slide.id} -->\n\n` +
				slide.elements
					.filter((item) => item.type === 'text')
					.map((item) => `<!-- mdsh-element:${item.id} -->\n${item.content}\n`)
					.join('\n')
		)
		.join('\n---\n\n') +
	`\n<!-- mdsh-presentation\n${JSON.stringify({ ...deck, slides: deck.slides.map((slide) => ({ ...slide, elements: slide.elements.map((item) => ({ ...item, content: '' })) })) })}\n-->\n`;
