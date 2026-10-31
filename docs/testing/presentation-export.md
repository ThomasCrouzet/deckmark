# Presentation export

## Retained failure risks

Presentation export has the following observable failure risks:

- A PDF can add a blank page after a slide.
- A PDF can split one slide across two pages.
- The print dialog can use a document page size instead of the slide aspect ratio.
- Browser and Desktop exports can use different page geometry.
- Native menu actions can bypass presentation history or export commands.
- An exported HTML file can request a remote stylesheet, font, script, or image.
- A local project image can disappear after export.
- A blocked remote image can bypass the existing media consent flow.
- Markdown, Mermaid, or math content can differ between the editor and the exported file.
- Hostile Markdown or image markup can inject active content into an exported file.
- A shape, line, arrow, rotation, or stacking order can change during export.
- A slide background can stop before the physical page boundary.
- A presentation can overflow its fixed canvas and create extra printed content.
- Keyboard navigation in standalone HTML can skip slides or scroll the page.
- Export cancellation can leave print content or a progress state in the application.
- A second export can reuse stale slides from the first export.
- A mobile browser can scale the presentation outside the viewport.
- Large decks can block interaction while Markdown and diagrams render.

## Browser verification

Use the application export commands with a deck that contains text, an embedded image,
a project image, shapes, an arrow, Mermaid, and math. Verify the downloaded HTML offline.

Print the same deck from Chromium, Firefox, and WebKit. Save each result as PDF when the
browser supports automated PDF output. Inspect the page count, page dimensions, pixel
bounds, and text for every slide.

The retained artifact must contain:

- The command and source revision.
- The working diff identity.
- Browser and operating system versions.
- The Markdown fixture and exported HTML.
- The generated PDF files and rendered page images.
- The expected and actual page count and dimensions.
- All recorded network requests after the HTML file opens offline.

## Desktop verification

Build the native application with the existing smoke-test feature. The harness uses a new
temporary application profile for each run. It also assigns a random WebKit data-store
identifier. The evidence records this identifier. Export the same deck through the product
print operation. Inspect the PDF with the native PDF inspector.

The native artifact must record the requested slide geometry and the effective PDF page
geometry. It must also retain every PDF page and rendered page image.

On macOS, `scripts/native-smoke.mjs` creates the evidence in
`native-test-results/presentation-pdf/`. The directory contains the product PDF, a PNG for
each page, extracted text, and `native-presentation-pdf-inspection.json`.

The smoke test must undo and redo a shape with native menu shortcuts. It must start the
presentation PDF export with the native Print shortcut.

## Acceptance criteria

- Each slide produces exactly one logical print page.
- Each PDF page uses the slide aspect ratio.
- No slide creates a blank or overflow page.
- Each exported HTML file works without a network connection.
- The HTML file supports arrow keys, Page Up, Page Down, Home, and End.
- The print layout does not include navigation controls.
- Text, images, shapes, lines, arrows, rotation, and stacking order match the editor.
- Export uses the existing network-image consent rule.
- Cancellation removes temporary print content and permits a later export.
