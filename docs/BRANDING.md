# Brand assets and demo capture

The DeckMark mark uses a Markdown hash between brackets. The canonical artwork is in
`static/brand/`. Dark and light filenames refer to the background. Wordmark letters
are outlined paths, so the logo does not require an installed or remote font.

Use `logo-dark.svg` and `logo-light.svg` for the wordmark. Use the symbol files for
small marks and `app-icon.svg` as the application icon source. Keep the supplied
geometry and colors. The source ZIP is not part of the project.

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

The screenshot script updates `docs/screenshots/` and `static/screenshots/`. The
demo script writes `docs/demo.gif` at 960 by 600 pixels. Capture evidence, source
frames, build hashes, and encoding settings stay in `test-results/capture-*`.
Inspect the images and GIF before committing them. Browser and system font
versions can affect raster output.

| File in `docs/screenshots/` | Scenario |
| --- | --- |
| `mode-wysiwyg.webp` | Visual editor, heading, math, code, and checklist. |
| `mode-wysiwyg-light.webp` | Visual editor in the light theme. |
| `mode-source.webp` | Source editor with syntax colors and line numbers. |
| `mode-read.webp` | Reading mode, outline, formulas, and backlinks. |
| `palette.webp` | Command palette and shortcut labels. |
