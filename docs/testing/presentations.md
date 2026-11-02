# Presentation editor test plan

## Scope

These workflows verify separate note and presentation files, the inline slide editor, Markdown persistence,
presentation playback, and exported artifacts. The editor must remain local and
usable without a network connection.

The core browser tests use the English locale. They select controls through
stable `data-testid` values and accessible names. The responsive review must also
check French labels.

## Primary workflow

1. Open New and select Note. Confirm the note editor and unchanged note content.
2. Open New and select Presentation. Confirm the inline editor and initial metadata.
3. Add slides and reorder their thumbnails.
4. Add text, an image, shapes, a line, and an arrow.
5. Move, resize, and rotate objects with pointer input.
6. Select several objects, align them, group them, and change their order.
7. Attach a connector and move its connected shape.
8. Edit Markdown text inside a text object.
9. Use copy, paste, duplicate, delete, undo, and redo.
10. Set slide notes, background, and aspect ratio.
11. Switch files, then reopen the presentation. Reload and verify its type and layout.
12. Start the slide show and navigate with visible controls and the keyboard.
13. Use Export to download Markdown, offline HTML, and PDF artifacts.
14. Open Advanced > Markdown source. Apply a valid edit, reject a missing marker,
    and cancel a draft. Confirm stored content and retained input after rejection.

The format remains version 1. No step converts a note or requires a database migration.

## Failure risks

- Opening the editor can replace or lose existing Markdown content.
- A late lazy import can show an empty document area or the previous file's deck.
- A failed lazy import can leave the page inert or hide the error.
- A presentation chunk can be absent from the PWA precache on its first offline use.
- A horizontal rule or fenced code separator can become an unintended slide.
- Reordering thumbnails can reorder the visible slides but not the saved source.
- A thumbnail can show stale content after an object edit.
- Pointer coordinates can change when the canvas scales to the viewport.
- Dragging can select text, scroll the page, or move more than one object.
- Resizing can invert an object or move the opposite edge unexpectedly.
- Rotation can change the object center or lose its angle after reload.
- Keyboard movement can use screen pixels instead of slide coordinates.
- Touch movement can pan the viewport instead of moving the selected object.
- A small touch target can make resize and rotation controls unusable.
- Pinch zoom can change stored object coordinates.
- Multi-selection can omit an object or retain a hidden object.
- Grouping can change the visual positions of its children.
- Ungrouping can lose transforms or object order.
- Front and back commands can save an order that differs from the canvas.
- Alignment can change the wrong axis or move the reference object.
- Copy and paste can reuse identifiers or connector references.
- Duplicate can overlap without a visible offset or omit object properties.
- Delete, undo, and redo can leave disconnected history or selection state.
- Redo can replay stale text after it commits an active text edit.
- Text editing can insert plain text and lose Markdown marks or line breaks.
- A source edit can discard visual metadata or corrupt the document body.
- Source input can write before Apply or overwrite an external source change.
- Cancel can create a document or save a source draft.
- A missing metadata marker can convert a presentation to a note.
- Invalid metadata can hide the repair view by opening the note editor.
- Note-only commands can write to a presentation or add metadata to a note.
- An unsupported metadata version can remove readable Markdown content.
- Image insertion can save a temporary blob URL or request a private path.
- Large image data can block pointer interaction or exceed local storage.
- A connector can detach, point to stale identifiers, or stop following a shape.
- Moving a selected connector can keep stale attachment identifiers.
- A line or arrow can expose resize controls that change the wrong endpoint.
- Presenter notes can disappear from the default editing panel or from saved Markdown.
- Presenter notes can appear on audience slides or in HTML and PDF exports.
- Background and aspect settings can apply to the wrong slide.
- A non-default aspect ratio can stretch objects or export at the wrong size.
- Overflowing content can be clipped silently or create an extra PDF page.
- Slide playback can show editor controls or stale slide content.
- Escape can close the document when it must return from Present to inline editing.
- Fullscreen rejection can prevent the in-page slide show from working.
- Export can use an edit state that differs from the saved Markdown state.
- HTML export can depend on application assets or make a network request.
- HTML export can lose object geometry, images, navigation, or aspect ratio.
- Shape Markdown can render in the editor but disappear from HTML or PDF output.
- PDF export can add blank pages or split one slide across several pages.
- PDF export can omit backgrounds, shapes, arrows, images, or slide text.
- Print CSS can use the printer paper ratio instead of the slide ratio.
- Repeated export can reuse a stale artifact or duplicate temporary content.
- Export cancellation or failure can leave the editor inert.
- A quota failure can look saved or omit the retry action inside the editor.
- Reload can lose slides during the 400 ms delayed save.
- Concurrent tabs can replace newer slide metadata with an older revision.
- A malformed presentation block can make the source unreadable in DeckMark.
- A marker inside a YAML literal can misclassify ordinary Markdown.
- Alignment can invert or move a negative line endpoint outside the slide.
- A reserved slide marker in element text can start a new slide after reload.
- A reserved element marker in element text can create a different object.
- A metadata marker and terminator in element text can truncate the document.
- An alternative HTML comment close can bypass metadata framing or become noncanonical.
- Text that resembles the framing escape marker can change after a round trip.
- A Markdown horizontal rule inside an element can become a slide separator.
- Closed backtick or tilde fences can expose internal markers to the parser.
- An unclosed fence can consume the next element or presentation metadata.
- An ordinary fenced marker can incorrectly classify a document as a presentation.
- Accessibility names can disappear from icon-only controls.
- Selection, focus, and status changes can be unavailable to assistive software.
- New or Present can fail to confine focus or restore it on exit.
- The inline editor can incorrectly confine focus and block file navigation.
- New cards and labeled Export or Advanced controls can overflow narrow screens.
- The editor can contain serious or critical axe violations.
- A representative deck can miss the interaction frame budget during drag.
- Long tasks during drag can make desktop or mobile input visibly stall.
- Firefox or WebKit can interpret pointer capture differently from Chromium.
- WebKit can retain inspector input focus after object selection and ignore clipboard commands.
- WebKit GTK can omit clipboard events for Ctrl+C, Ctrl+X, and Ctrl+V.
- Native clipboard events and keyboard fallbacks can apply cut or paste twice.
- A later paste shortcut can cancel an earlier clipboard read before it applies.
- A delayed cut fallback can remove objects selected after the shortcut.
- A failed rich clipboard read can hide text that remains available through `readText`.

## Browser scenarios

Use `e2e/presentation-files.spec.ts` for the document-type workflow. Check New
dialog focus and cancellation, both creation choices, type labels, persistence,
file switching, the source guard, and return from Present. Verify that notes
have no Slides conversion action. Include palette commands and narrow-screen
checks in the review. This section defines required evidence, not a passing result.

The desktop workflow uses Chromium, Firefox, and WebKit. It verifies slide
management, every object type, direct manipulation, selection commands, text
editing, presentation settings, persistence, and slide playback.

`e2e/fixtures/presentation-complete.md` keeps front matter, a blank slide, all
object types, a group, connector references, a negative line direction, an
embedded image, notes, and a fenced separator. The workflow compares its exact
Markdown bytes after open and reload.

The framing workflow creates element text with reserved slide, element, and
metadata markers. It also covers horizontal rules, escape-like text, closed
backtick and tilde fences, and an unclosed fence. It verifies deterministic
Markdown after reload, source editing, parsing, and export. A separate ordinary
Markdown fixture keeps the same marker lines inside a fence and must stay an
ordinary document.

The mobile workflow uses Chromium and WebKit device profiles. It verifies one
touch drag, one touch resize, touch multi-selection, grouping, alignment,
toolbar access, slide navigation, text editing, and application overflow.

The accessibility workflow checks keyboard operation, focus restoration, live
selection state, and axe results. Serious and critical violations fail the test.

The performance workflow uses a representative deck with 20 slides and 200
objects. It records pointer event timing, animation frame intervals, long tasks,
and the final saved geometry. It checks a real drag instead of static values.

The PWA workflow first installs the service worker without opening the editor.
It deletes the runtime cache, disables the network, and opens the lazy editor.
It edits, saves, reloads, and restores a two-slide deck while offline. Chromium
and Firefox run this workflow. Playwright 1.62 WebKit rejects service worker
responses during offline emulation. The portable-project outage workflow stops
a real origin and verifies the WebKit service worker separately.

Presentation saves use the shared draft save queue. The storage-pressure
workflow applies a real Chromium quota limit and verifies the visible failure
and retry states. Presentation tests verify the same queue's saved state and
restored Markdown without an IndexedDB mock.

## Export scenarios

The HTML workflow downloads the exported file and opens it in a new offline
browser context. It checks all slides, object geometry, embedded images,
keyboard navigation, and an empty network request log.

The PDF workflow captures the product print document and produces a real PDF
through Chromium. It requires exactly one PDF page for each slide. It also
checks page dimensions, backgrounds, first and last slide text, and object
content. The report retains the Markdown, print HTML, PDF, and measured results.

Browser PDF generation cannot verify every native print dialog or printer
driver. Desktop smoke tests must keep native print cancellation and final PDF
checks for supported desktop platforms.

## Stable UI contract

The creation dialog and inline presentation editor use these test identifiers:

- `create-note`, `create-presentation`, and `document-kind`
- `presentation-editor`, `slide-canvas`, `slide-thumbnail`, and `slide-object`
- `slide-add`, `slide-duplicate-slide`, `slide-delete-slide`,
  `slide-move-prev`, and `slide-move-next`
- `slide-add-text`, `slide-add-image`, `slide-add-rectangle`,
  `slide-add-rounded-rectangle`, `slide-add-ellipse`, `slide-add-line`, and
  `slide-add-arrow`
- `slide-prop-x`, `slide-prop-y`, `slide-prop-width`, `slide-prop-height`, and
  `slide-prop-rotation`
- `slide-undo`, `slide-redo`, `slide-copy`, `slide-paste`, `slide-duplicate`,
	`slide-delete`, `slide-group`, `slide-ungroup`, and `slide-multiselect`
- `slide-front`, `slide-back`, `slide-align-left`, `slide-align-center`,
  `slide-align-right`, `slide-align-top`, `slide-align-middle`, and
  `slide-align-bottom`
- `slide-connect`, `slide-prop-startId`, and `slide-prop-endId`
- `slide-notes`, `slide-notes-toggle`, `slide-background`, `slide-aspect`,
  `slide-advanced`, `slide-source`, `slide-source-editor`, `slide-source-apply`,
  `slide-source-cancel`, `slide-present`, `slide-present-exit`,
  `slide-present-prev`, `slide-present-next`, `slide-present-notes`,
  `slide-presenter-notes`, `slide-export`, `slide-export-html`, and `slide-export-pdf`
- `slide-text-editor`, `slide-edit-text`, `slide-text-done`, `slide-rotate`,
  `slide-resize-nw`, `slide-resize-ne`, `slide-resize-sw`, and
  `slide-resize-se`
- `slide-image-input`

Object nodes expose a stable object identifier and object type through data
attributes. Thumbnails expose the stable slide identifier. Resize and rotation
handles expose their operation through a data attribute.
Select the New dialog by its accessible name, **Create a document**.

## Commands and evidence

Run the focused desktop workflows with:

```sh
npm run test:e2e -- presentation-files.spec.ts presentation-editor.spec.ts presentation-export.spec.ts --project=chromium --workers=1
```

Run the mobile workflows with:

```sh
npm run test:e2e -- presentation-mobile.spec.ts --project=mobile-chromium --project=mobile-webkit --workers=1
```

Run the cross-browser workflow with:

```sh
npm run test:e2e -- presentation-editor.spec.ts --project=firefox --project=webkit --workers=1
```

Run the first-use offline workflow with:

```sh
npm run test:e2e -- presentation-offline.spec.ts --project=chromium --project=firefox --workers=1
```

The Playwright HTML and JSON reports record the command, source revision,
working diff identity, environment, fixtures, assertions, timings, and results.
Each presentation scenario also attaches its Markdown fixture and workflow
evidence. Export scenarios attach the downloaded artifact and inspection data.

After each presentation-file run, retain
`test-results/presentation-files-<revision>.json` with the exact command, source
revision and working diff identity, platform, Node and browser versions, fixtures,
pass/fail/skipped results, and HTML report path. Link the retained screenshots,
source files, and exports. See [test policy and evidence](../TESTING.md#presentation-workflows).

Review English and French at widths 320, 360, 390, 768, 1024, 1280, and 1440 in
portrait and landscape. Include 200 percent zoom and reduced motion. Record
keyboard-only, first-use, and human screen reader results separately from
automated checks. Mark checks without evidence as **not run**. The full application
gate remains required before release.
