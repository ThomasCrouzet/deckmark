# Brand assets and demo capture

DeckMark uses the Relay symbol. Three horizontal plates share a stepped diagonal cut.
Keep the supplied paths intact. Use amber on graphite and bronze on light surfaces.
The wordmark uses outlined letters. Use system fonts for all interface text.

Use the lockup above 128 px wide. Use the symbol alone at smaller sizes. Leave
clear space equal to one half of the top plate height on all sides of the artwork.
Keep the cut free of text and avoid shadows, gradients, and fine outlines.
Use the app icon for launchers and the supplied favicon for browser tabs.

## Generate icons and the social card

```sh
npm ci --legacy-peer-deps
npx playwright install chromium
node scripts/generate-brand-assets.mjs
node scripts/generate-brand-assets.mjs --check
```

The generator writes favicons, PWA icons, Apple icons, Desktop icons, and the
Open Graph PNG. It uses the locked Playwright and Tauri tools. The maskable icon
has an opaque background and keeps the symbol inside its safe area.

## Capture the current interface

Install `ffmpeg` and `cwebp` and make sure both are on `PATH`. On macOS, use
`brew install ffmpeg webp`. Run:

```sh
npm run build
node scripts/capture-screenshots.mjs
npm run build
node scripts/capture-demo-gif.mjs
```

The second build includes the new PWA screenshots. The scripts start and stop
their own preview servers. They use a fixed viewport, English, seeded documents,
and explicit theme settings. They capture the real interface.
Desktop captures use a 1280 by 800 CSS pixel viewport. Still images use a device
pixel ratio of 2. Keep this viewport to show the compact toolbar at normal size.

The screenshot script updates all images in `docs/screenshots/` and
`static/screenshots/`, including the desktop and mobile slide editor.
The demo script writes `docs/demo.gif` at 960 by 600 pixels. It follows a launch
project through notes, wiki links, diagrams, code, project checks, exports, and slides.
Capture evidence, source
frames, build hashes, and encoding settings stay in `test-results/capture-*`.
Inspect the images and GIF before committing them. Browser and system font
versions can affect raster output.

| File in `docs/screenshots/` | Scenario |
| --- | --- |
| `mode-wysiwyg.webp` | Launch brief with linked notes, a project table, and a checklist. |
| `mode-wysiwyg-light.webp` | Visual editor in the light theme. |
| `mode-source.webp` | Source editor with syntax colors and line numbers. |
| `mode-read.webp` | Reading mode, document outline, and backlinks. |
| `palette.webp` | Command palette and shortcut labels. |
| `welcome.webp`, `welcome-light.webp` | Empty workspace in both themes. |
| `new-document.png` | Note and Presentation choices. |
| `presentation-editor.png` | Three-slide launch deck with presenter notes. |
| `presentation-present.png` | Launch deck in presentation mode. |
| `presentation-editor-mobile.png` | Slide editor at a 390-pixel viewport width. |

## Capture the README hero and gallery

The README top shows `docs/hero-dark.webp` or `docs/hero-light.webp`, an animated
demo of about 22 seconds. The "What you can do" gallery uses
`docs/screenshots/readme-*-dark.webp` and `readme-*-light.webp`. GitHub selects the
variant from the reader's color scheme.

Install the capture fonts first. The app uses the system font stack, and a Linux
host would show DejaVu. On Debian, run `sudo apt install fonts-inter
fonts-jetbrains-mono`. Then run:

```sh
npm run build
HERO_THEME=dark node scripts/capture-hero.mjs
HERO_THEME=dark node scripts/capture-hero-compose.mjs
HERO_THEME=light node scripts/capture-hero.mjs
HERO_THEME=light node scripts/capture-hero-compose.mjs
node scripts/capture-showcase.mjs
```

`capture-hero.mjs` runs the real app in an iframe inside a stage page. The stage
draws the canvas, a browser bar, the window shadow, one caption per beat, a pointer,
and the end card. Camera moves are CSS transforms, so the interface stays sharp.
The story: type a checklist in a note, edit a Mermaid diagram in Split view, select
a slide element, present the ORBIT deck, and end on the logo. Frames come from the
Chrome DevTools screencast at 1920 by 1080 pixels. `capture-hero-compose.mjs` keeps
the real frame timing and writes `hero.mp4`, `hero.webp` and `hero.gif` to
`test-results/capture-hero/<theme>/`. Copy each `hero.webp` to
`docs/hero-<theme>.webp`, the dark `hero.mp4` to `docs/hero.mp4`, and the dark
`hero.gif` to `docs/demo.gif` for places that do not show WebP. Keep the GIF under
8 MB.

`capture-showcase.mjs` captures the write, split, slide editor, present and palette
views in both themes with the same fonts. It writes to
`test-results/capture-showcase/`. Copy each output to
`docs/screenshots/readme-<name>-<theme>.webp`. Inspect every frame before you commit.

Source, reading, and palette captures also have `-light` variants. The four
desktop PWA images are 2560 by 1600 pixels. `relay-mobile.webp` is 390 by 844 pixels.
