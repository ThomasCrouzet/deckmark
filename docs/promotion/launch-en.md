# Launch post, English

Status: prepared, not published.

## DeckMark 2.1.0 adds an offline slide editor

DeckMark is a local Markdown workspace. Version 2.1.0 adds a fourth view: Slides.

Write a document, then select **Slides** to arrange text, images, shapes, and
connectors on a canvas. Add presenter notes, reorder slides, and present in full
screen. Use the keyboard or a touch screen. The same deck exports to Markdown,
portable HTML, PDF, and print. PDF and print put one slide on each page and leave
the presenter notes out.

A presentation remains one Markdown file. Optional front matter, Markdown content,
and a terminal `mdsh-presentation` block share the file. Text and images stay
readable in another editor. If a file uses an unknown format version, the editor
shows an error and keeps the file unchanged. An ordinary document that you open and
close without a layout change keeps its exact bytes.

The rest of the product keeps its local-first behaviour. Drafts stay in IndexedDB
with the same 400 ms save delay. The library, search, trash, history, disk links,
backups, and exports treat a presentation as a normal document. The PWA still works
offline on first use, and the presentation editor loads only when a document needs
it.

Version 2.1.0 is available on the web app and as a Desktop Beta prerelease. The
desktop installers remain unsigned and can show an operating-system warning. Check
the published checksums before installation.

Limits: visual editing can normalize Markdown. Use Source mode when exact
formatting matters. Cloud sync, collaboration, and plugins remain outside the
project scope.

Links: https://thomascrouzet.github.io/deckmark/ and
https://github.com/ThomasCrouzet/deckmark/releases
