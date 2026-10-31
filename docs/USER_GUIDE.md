# User guide

## Start writing

Open the [web app](https://thomascrouzet.github.io/deckmark/) and create a document. Select WYSIWYG, source, or reading mode on the toolbar. Drafts stay in the current browser profile. The app does not create an account or remote copy.

Closing a tab keeps the document in the library. The delete command moves it to the trash for 30 days. Open the library and trash from the sidebar.

The **Actions** button gives direct access to documents, search, export, and settings. The keyboard icon opens all commands and their shortcuts. Labels use Command on macOS and Control on Windows and Linux. File navigation uses Control on every platform.

Open **Document library** to filter open and closed documents by filename, title, or tag. The list shows recent changes first. It also lists unresolved or ambiguous wiki links. Open the referring document to correct a target.

Use the library checkboxes to select documents, then select **Delete selected**.
**Select all results** follows the current filter. **Delete all** includes the full
library, including closed documents. Confirm the count before you continue.
Documents move to trash. In the trash, select individual documents or use
**Empty trash** to remove them permanently. This removes their version history
and unused disk permissions, but does not delete files from disk.

**Document outline** in Actions works in all three modes and on small screens. Source mode includes headings outside code and front matter. Reading and WYSIWYG modes use the visible headings. Find in document keeps the current mode. In source mode, the search panel also supports replacement.

On wide screens, the table of contents stays beside the document in all three modes.
It includes heading levels H1 through H6 and changes as you edit.
Select a heading to move to that section. In Source and Edit modes, this also moves the caret.
The column stays hidden in focus mode and when the document has no headings.

Source mode keeps a separate undo history for each recently used draft. A change of draft cannot undo content from another draft.
The current browser session keeps editor positions for up to 32 recently used drafts. Reloading clears undo history, but keeps these positions.

<a id="install-the-pwa"></a>

## Install the PWA

Use the browser install action from the web app. Wait for offline preparation to finish before you disconnect the network. The cache contains both editors, Markdown rendering, formulas, diagrams, fonts, and export modules. You can then create, edit, search, and export documents offline.

A new version waits for IndexedDB writes before it reloads the app. If a local save fails, the document stays visible. The update does not force a reload.

## Import documents

A selection or folder can contain up to 300 files and 64 MiB. Each file can contain up to 16 MiB. The app rejects binary files, prohibited control characters, and text that is not UTF-8. It shows a result for each rejection. If you cancel an import, the app keeps imported documents and reports how many it added.

A document with at least 262,144 characters opens first in source mode. You must confirm before you change to visual rendering because parsing can take more time.

On supported systems, opening a file with the installed PWA uses the same import limits.

## Portable projects

Select **Projects** in the sidebar. Create a project, import a ZIP, or import a folder.
Documents keep their paths, so `README.md` and `notes/README.md` remain separate documents.
Relative Markdown links and images resolve inside the project. Wiki paths also stay within the source project.

Use **New project document** to add a path such as `notes/guide.md`.
Rename an open document through the toolbar. deckmark updates incoming document links and keeps history checkpoints.
Select **Check links** to list missing resources, ambiguous wiki links, paths outside the project, and remote images.

Select **Export project** to download the documents and resources together.
The ZIP contains `.deckmark/project.json` and `.deckmark/link-report.json` for project metadata and link diagnostics.
Image data embedded in Markdown becomes a separate asset in the archive. The stored source remains unchanged.
An individual Markdown download keeps its relative references. Use the project ZIP when those references need local resources.

Projects accept up to 300 documents, 1,300 archive entries, eight directory levels, and 64 MiB of uncompressed data.
Each document can contain up to 16 MiB. Each image can contain up to 2 MiB.
Unsafe paths, duplicate paths, symbolic links, and unsupported archives are rejected before import changes storage.

On Desktop, select **Open a disk folder** to keep a native directory connection.
Use **Refresh from disk** to read external changes. Use **Save project to disk** to write local changes.
These actions report failed paths and keep local drafts when the directory becomes unavailable.
Creating or renaming disk documents requires filesystem hard link support.
If that support is unavailable, the operation fails without replacing an existing file.
Disconnecting keeps local documents and assets. Backups do not contain directory permissions.

Library ZIP exports accept at most 300 documents and 64 MiB of source and asset data.

## Source and preview

In Source mode, select **Show preview**. The preview follows the source after a short delay.
Drag the divider, or focus it and use the arrow keys. Home and End select the minimum and maximum sizes.
The panes stack vertically on narrow screens. Section synchronization follows source navigation without changing the document.

| Content | Source and preview | Visual editing |
| --- | --- | --- |
| Whitespace and Markdown delimiters | Source text stays unchanged | Serialization can normalize formatting |
| Front matter and code examples | Source text stays unchanged | Use Source for exact syntax |
| Local project image paths | Assets resolve without replacing source paths | Existing references remain paths |
| Tables, task lists, formulas, and diagrams | Preview renders supported syntax | Supported structures can be edited visually |

A visit to the visual editor preserves the source if you make no edit.
Visual edits can normalize Markdown syntax.
Use Source when a document requires exact formatting or syntax outside the visual editor's supported structures.

## Search and disk links

Whole-word search includes Unicode letters, marks, numbers, and underscores. Apostrophes and hyphens separate words. Search and replacement use the same boundaries.

Cross-file search includes closed documents by default. Select **Open tabs** to limit its scope. Replacement uses the selected scope and saves a history checkpoint. Search shows up to 200 matching lines and reports this limit.

Global replacement first shows a comparison for each affected document.
Confirmation refuses an outdated preview. Create a new preview after another tab changes an input document.
History and disk conflicts also show line comparisons. Large comparisons identify omitted lines and approximate counts.

Wiki links reopen closed targets without making a copy. A rename updates incoming name-based links, including links in closed documents. Code examples and displayed aliases stay intact. A backup merge updates identifier-based links to the imported IDs. If several documents have the same target name, select the correct document in the library.

Before saving a linked file, the app compares its content with the last saved reference. If the check fails, it stops the save.
An older link without a reference requires an explicit decision before the first write. Use a new target if you cannot verify the file.

For a conflict, choose the local revision, the disk revision, or cancellation after reviewing the comparison.
The app keeps a checkpoint before replacement and checks the reviewed revision again.
Browser file APIs cannot make this final check and write atomic. Avoid simultaneous writes from another application.

In Desktop, change the name in the toolbar and press Enter or leave the field to rename the linked file on disk. Escape cancels the edit. A rename keeps the file in the same folder and refuses a name that another file uses. In a browser, renaming disconnects the old disk link. Save the renamed draft to a new file; the original disk file stays unchanged.

Importing an exact copy of one linked document, with the same name and content, opens its existing tab. A different content version remains a separate draft.

## Local and remote images

The app embeds images that you add with the picker, clipboard, or drag and drop. Embedded images remain available after a reload and appear in PDF and standalone HTML exports. Older versions created temporary links that cannot be recovered after expiration. Import the image again from its original file.

Source mode hides long image payloads behind **Image data**. Activate the control to show the original data.
Copy and Markdown export retain all bytes. Visual images keep their proportions when you change the editor width.

The app blocks remote images by default. Reading mode can load and embed them in the current document. This action contacts the image host and reveals your IP address. The request sends no cookies or referrer and rejects redirects. Each remote image can contain up to 2 MiB. One operation can fetch up to 8 MiB in total. The app sanitizes SVG files before it embeds them.

To resolve a relative image path, select the applicable file or folder. The app then embeds the image to keep the document portable.

Mermaid diagrams reject images and network styles. Put images directly in the Markdown.

<a id="backups-and-storage-health"></a>

## Backups and storage health

Settings shows whether the browser granted persistent storage. It also shows the estimated quota and the date of the latest successful external backup. Export a backup regularly. Always make one before you clear browser data or change profiles.

The status bar identifies local draft saves. A linked disk file requires the explicit **Save to disk** action. The backup reminder opens Settings. You can dismiss the reminder for a week.

If the status says **Not saved locally**, keep the editor open. Free storage and
select **Retry save**. The latest text stays in memory until that save succeeds.
Backup export and workspace saves stop if pending drafts cannot be saved.
An abrupt browser or system exit can lose text that has not reached IndexedDB.
Version history can contain a newer recovery point, but it is not an external backup.

Each document keeps at most 30 regular history versions for 30 days. The app
usually adds a version at intervals of at least five minutes. Conflict copies
are separate closed documents, so normal history pruning does not delete them.
Trash also retains documents for 30 days. Closing tabs does not free this space.

Select **Check a backup** to validate a JSON file or decrypt and validate an encrypted backup without changing your library. A restore first shows the backup date and document counts, then asks whether to merge or replace. In a browser, wait for the download to finish before you rely on an exported file.

A backup contains open and closed documents, projects, assets, workspaces, and custom templates.
It excludes trash, version history, browser file handles, and Desktop path permissions.
Version 2 backups use schema 2. The app also accepts schema 1 backups from version 1.9.
The format accepts up to 3,000 documents, 300 workspaces, 16 MiB per document, and 64 MiB in total.
The app checks these limits before it reports a successful download. You cannot recover an encrypted backup without its passphrase.

Replace mode keeps old documents in the trash and preserves variants that share an identifier. Merge mode assigns new identifiers to added drafts and updates workspace references.

Replace mode also disconnects disk links. Imported content cannot reuse an old file permission. Merge mode keeps links for existing local drafts.

## Export

PDF export renders content, embedded images, formulas, code blocks, and diagrams before it opens the print dialog. The app reports success only after preparation finishes. Select a PDF printer in the browser or system dialog. You can disable browser headers and footers in that dialog.

On macOS Desktop, use the native print panel's **PDF** menu to save the document.
The editor returns after the print operation finishes or you cancel it.
Tall images fit within the A4 printable height without cropping.

During HTML or PDF preparation, select **Cancel export** in the progress message
to stop waiting for media or styles. In a native save or print panel, use its
**Cancel** button. Cancellation keeps the draft and its unexported-change marker.
You can edit the document and start another export.

Select **PDF (A4)** under **Editor width** in Settings or through Commands. This
preset uses the 178 mm text width of an A4 page with 16 mm side margins. It is a
width guide. Fonts, page breaks, and print settings can differ from the editor.

The standalone HTML file embeds its styles, images, and required KaTeX fonts. You can read the local file without a network. Markdown, ZIP, and HTML exports do not include direct disk-access permissions.

**Export all files (ZIP)** includes open and closed documents in the library. **Export open tabs as ZIP** limits the archive to the current session. Selection export includes only selected tabs.

Library ZIP exports keep each project in a separate nested ZIP with its assets.
Open-tab and selection exports include the selected project documents. Their link reports identify references to documents outside that selection.

## Presentations

Select **Slides** in the toolbar, or press `Cmd+Shift+L`, to open the presentation editor.
For a new document, the editor creates a slide deck. For an ordinary document, it
imports the Markdown as slides. A document with presentation metadata opens its
stored layout.

The left strip lists slides. Add, duplicate, move, or delete a slide there. The
canvas holds text, images, rectangles, ellipses, lines, and arrows. Drag an object
to move it, or use the arrow keys for one-pixel steps and Shift with an arrow for
ten-pixel steps. Drag a corner to resize, or use the properties panel for exact
position and size. Shift-click selects more than one object. The properties panel
also controls stacking, grouping, alignment, colors, text size, and connectors.

Select **Present** to use the full-screen view. Use the arrow keys, Page Up, Page
Down, Space, Home, and End to move. Press Escape to return to the editor. Presenter
notes appear in the editor and in the presenter view, not on a printed page.

The **Markdown source** view shows the complete file. Keep the slide and element
markers when you edit text or image content. The **Visual editor** view returns to
the canvas. The same file opens as a normal document in Source and Read modes.

**Markdown**, **HTML**, and **PDF / Print** export the deck. HTML works offline.
PDF and print produce one slide per page. A deck prints in landscape at its stored
canvas size. An ordinary document keeps its A4 print settings.

A presentation is one Markdown file with optional front matter, slide content, and
one terminal `deckmark-presentation` metadata block. The metadata block controls
geometry and styles. The Markdown body controls text and image content. If a file
uses an unknown format version, the editor shows an error and keeps the file
unchanged. See the [presentation format](presentation-format.md) for the complete
contract.

## Templates

Use Commands to create a document from a built-in or custom template, or save the current document as a template. Settings contains **Manage templates** for editing and deleting custom templates. The `{{date}}` variable uses the local calendar date. Built-in template labels follow the interface language.

## Keyboard shortcuts

Open **Settings**, then **Keyboard shortcuts**, to view writing shortcuts and customize application shortcuts.
The writing section identifies the modes that support each shortcut.
In Edit mode, point to a heading or put the caret inside it to show its level, H1 through H6.
The level indicator does not change the document or its exports.
Press Tab to insert indentation at the caret. In a list, Tab indents the item. In a table, Tab moves to the next cell.
In a plain text block, use Shift+Tab to move focus out of the editor.

The Commands menu shows all active shortcuts. In Settings, you can customize commands, detect conflicts, and restore defaults. The app saves web and Desktop profiles separately. Content-editing shortcuts have priority when the cursor is in the editor.

macOS Desktop keeps the standard application and Window menus, including Hide, Services, Minimize, Full Screen, and Quit.
Undo and Redo use the active editor's history. Control-only text-navigation shortcuts remain available.
`Cmd+W` closes the current document tab. `Cmd+Q` quits after pending draft writes finish.

In the sidebar, focus a draft and press Space to change its selection. Press Enter to open the draft.
Focus another draft and press Shift+Space to select the range. The buttons expose their selection state to screen readers.

Use `Ctrl+Tab` for the next workspace file and `Ctrl+Shift+Tab` for the previous file. Both shortcuts use Control on macOS too. Navigation follows the workspace order and continues from the last file to the first. Some browsers reserve these shortcuts for browser tabs. The Desktop app receives them directly.

In the visual editor, type `/h1` through `/h6`, or `/t1` through `/t6`, to select
a heading level. Press Enter to apply it. The full translated command names also
remain available.

## Desktop Beta app

Desktop installers are unsigned beta artifacts. macOS can show a Gatekeeper warning, and Windows can show a SmartScreen warning. Download files only from the Desktop prerelease for the applicable version. Compare their checksums with `SHA256SUMS`. The release also contains npm and Cargo SBOMs and a provenance attestation.

Choose `mdsh_<version>_macOS_Apple-Silicon.dmg` for a Mac with an Apple M-series chip.
Choose `mdsh_<version>_macOS_Intel.dmg` for an Intel Mac.

The macOS version requires macOS 14 or later. Windows uses the Tauri installation mode to install WebView2 if it is absent. Linux packages use WebKitGTK. Native selections and file associations authorize each Markdown path. The app restores that access after restart, so `Cmd+Shift+S` or `Ctrl+Shift+S` saves the restored draft directly. Removing a disk link revokes access. Files first selected in an older version need one new native selection to enter the access registry.
