# Release note for 2.1.0

## Slides

DeckMark now has four views: Edit, Source, Read, and Slides.

The Slides view arranges text, images, rectangles, rounded rectangles, ellipses,
lines, and arrows on a canvas. Move, resize, rotate, align, group, and reorder
objects with a pointer, keyboard, or touch screen. Add presenter notes and start a
full-screen presentation.

A presentation remains one Markdown file. Optional front matter, Markdown content,
and one terminal `deckmark-presentation` block share the file. The Markdown body stays
readable in another editor.

## Documents and data

A presentation is a normal document. It appears in the library, search, trash,
version history, disk links, backups, and exports. Writes use the existing 400 ms
save queue. A failed write stays visible. Two tabs do not overwrite each other
without a conflict check.

An ordinary document that you open and close without a layout change keeps its
exact bytes. A metadata marker inside a code fence does not activate presentation
mode. A `---` inside a fence does not split slides. An unknown version or invalid
metadata shows an error and keeps the source unchanged.

## Export and print

Markdown, portable HTML, PDF, and print export the deck. HTML works offline. PDF
and print put one slide on each page and leave presenter notes out. Ordinary
documents keep their existing A4 print behaviour.

## Access and language

The Slides command appears in Settings and the command palette. `Cmd+Shift+L`
opens the editor. Selection changes are announced to assistive technology, focus
returns when the editor closes, and reduced motion is respected. The interface is
available in English and French.

## Limits

- The Desktop Beta installers remain unsigned and can show an operating-system
  warning.
- Visual editing can normalize Markdown. Use Source mode when exact formatting
  matters.
- Cloud sync, collaboration, and plugins remain outside the project scope.
- The default slide canvas is 1280 by 720 pixels. The editor supports 16:9 and
  4:3 decks.
