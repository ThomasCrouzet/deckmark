# User guide

## Editions

DeckMark has two editions: **Web Light** and **Desktop Complete (Beta)**.
Web Light is the complete browser edition. It is free and it is not a trial.
Desktop Complete uses the same editor and adds native file access, local Git
tools, scheduled backups, global quick capture, and a native API key vault.
The [edition matrix](EDITIONS.md) lists shared capabilities, Desktop-only
capabilities, system requirements, and support boundaries.

Open the [web app](https://www.deckmark.dev/) to use Web Light. If the custom
domain is not available, open the
[GitHub Pages fallback](https://thomascrouzet.github.io/deckmark/).
Desktop installers are separate `desktop-v<version>` prereleases on
[GitHub Releases](https://github.com/ThomasCrouzet/deckmark/releases).

## Start writing

Select **New file**. In the
**Create a document** dialog, choose **Note** or **Presentation**. A note opens in
its last Edit, Source, or Read mode. A presentation opens in the inline slide
editor. The app does not convert notes to presentations.

`Cmd+N` (`Ctrl+N` on Windows and Linux) opens the same dialog. The command palette
also has **Create a note** and **Create a presentation** commands. Escape or
**Cancel** closes the dialog without creating a file.

Drafts stay in the current browser profile. The app does not create an account or
remote copy. The header, library, and search results identify each document type.

Closing a tab keeps the document in the library. The delete command moves it to the trash for 30 days. Open the library and trash from the sidebar.

The **Actions** button gives direct access to documents, search, export, and settings. The keyboard icon opens all commands and their shortcuts. Labels use Command on macOS and Control on Windows and Linux. File navigation uses Control on every platform.

Open **Document library** to filter open and closed documents by filename, title, or tag. The list shows recent changes first. It also lists unresolved or ambiguous wiki links. Open the referring document to correct a target.

Use the library checkboxes to select documents, then select **Delete selected**.
**Select all results** follows the current filter. **Delete all** includes the full
library, including closed documents. Confirm the count before you continue.
Documents move to trash. In the trash, select individual documents or use
**Empty trash** to remove them permanently. This removes their version history
and unused disk permissions, but does not delete files from disk.

For notes, **Document outline** in Actions works in all three modes and on small screens. Source mode includes headings outside code and front matter. Reading and Edit modes use the visible headings. Find in document keeps the current mode. In source mode, the search panel also supports replacement.

On wide screens, the table of contents stays beside the note in all three modes.
It includes heading levels H1 through H6 and changes as you edit.
Select a heading to move to that section. In Source and Edit modes, this also moves the caret.
The column stays hidden in focus mode and when the document has no headings.

Source mode keeps a separate undo history for each recently used draft. A change of draft cannot undo content from another draft.
The current browser session keeps editor positions for up to 32 recently used drafts. Reloading clears undo history, but keeps these positions.

<a id="install-the-pwa"></a>

## Install the PWA

Use the browser install action from the web app. Wait for **Ready offline** before you disconnect the network. The cache contains the note and presentation editors, Markdown rendering, formulas, diagrams, fonts, and export modules. You can then create, edit, search, and export documents offline.

The service worker caches the application for the current address and base path.
The scope is `/` on a custom domain and `/deckmark/` on the GitHub Pages fallback.
A deep-link refresh opens the cached application shell.
A PWA installed on one origin stays on that origin after a domain change.

A new version waits for IndexedDB writes before it reloads the app. If a local save fails, the document stays visible. The update does not force a reload.

## Import documents

A selection or folder can contain up to 300 files and 64 MiB. Each file can contain up to 16 MiB. Supported text files must be UTF-8 without prohibited control characters. Images and PDFs use separate binary import paths. The app shows a result for each rejection. If you cancel an import, the app keeps imported documents and reports how many it added.

A note with at least 262,144 characters opens first in source mode. You must confirm before you change to visual rendering because parsing can take more time.

Imported presentations open directly in the slide editor. The presentation data
in the file determines its type. A malformed presentation stays in that editor
with a source error so you can repair it.

On supported systems, opening a file with the installed PWA uses the same import limits.

## Code, images, and PDFs

Select **New file > Code** to create a local code or text file. Choose a language
and a file name. The dialog suggests an extension for the selected language and
refuses a mismatched extension. Select **JSON** to create a valid empty object.
The new file opens in the code editor with a ready caret. A created file stays a
local draft until you link or export it; creation does not grant disk access.

Import a supported code or text file to open the code editor. Use its controls
for indentation, line endings, word wrap, and visible whitespace. JSON files
have syntax checks, duplicate-key reports, **Format**, and **Minify** actions.
JSON with comments (`.jsonc`) keeps comments and does not run the strict JSON
checks or transformations. C# (`.cs`) and PowerShell (`.ps1`) use their own
grammars. A code extension without a registered grammar opens as plain text and
shows the extension, for example **Plain text (rb)**. The editor does not
execute imported code.

Import an image to open the annotation canvas. Use the pen, highlighter, eraser,
zoom, and undo controls. Export a flattened PNG to keep the annotations.
Strokes are temporary and do not change the original image. The **Annotate**
control in a note's Read mode also creates temporary ink, not saved document content.

Import a PDF to keep it in the library. **Open PDF** opens it in a separate
browser viewer. **Export** downloads the PDF. Inline viewing depends on browser
support and the security policy. The production Web policy permits local blob frames.
Use the open or download action if the document area is blank. DeckMark has
no PDF text extraction, OCR, annotation, or editing tools.

## Portable projects

Select **Projects** in the sidebar. Create a project, import a ZIP, or import a folder.
Documents keep their paths, so `README.md` and `notes/README.md` remain separate documents.
Relative Markdown links and images resolve inside the project. Wiki paths also stay within the source project.

Use **New project document** to add a path such as `notes/guide.md`.
Rename an open document through the toolbar. DeckMark updates incoming document links and keeps history checkpoints.
Select **Check links** to list missing resources, ambiguous wiki links, paths outside the project, and remote images.

Select **Export project** to download the documents and resources together.
The ZIP contains `.mdsh/project.json` and `.mdsh/link-report.json` for project metadata and link diagnostics.
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

## Check and export documentation

Open **Check documentation** from Commands. Select a project, then **Run check**.
The checker reports link, anchor, heading, front matter, code fence, image, and
presentation metadata problems. Select a result to open its source line.
Use **Export JSON** to keep the report. Checks run locally and do not fetch
remote resources. The report lists checks that were skipped.

Open **Export documentation site** from Commands. Select a project and choose
whether to include the local search index. **Export site** creates a ZIP with
HTML pages, navigation, local assets, and a resource report. Extract the ZIP to
read the site or publish its files on a static host. DeckMark does not upload it.
The export does not change source documents or download remote images. Resolve
reported resource errors before you retry a blocked export.

## Source and preview

For a note in Source mode, select **Show preview**. The preview follows the source after a short delay.
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

Search includes presentation slide text. Tags, backlinks, and the link graph
apply to notes. Presentation text does not enter those note indices.

Global replacement first shows a comparison for each affected document.
Confirmation refuses an outdated preview. Create a new preview after another tab changes an input document.
History and disk conflicts also show line comparisons. Large comparisons identify omitted lines and approximate counts.

Wiki links reopen closed targets without making a copy. A rename updates incoming name-based links, including links in closed documents. Code examples and displayed aliases stay intact. A backup merge updates identifier-based links to the imported IDs. If several documents have the same target name, select the correct document in the library.

In Web Light, linked disk files need the File System Access API. Chromium
provides this API. Firefox and Safari use a download fallback. A browser link
covers only the file that you select and does not give the app unrestricted
filesystem access.

Before saving a linked file, the app compares its content with the last saved reference. If the check fails, it stops the save.
An older link without a reference requires an explicit decision before the first write. Use a new target if you cannot verify the file.

For a conflict, choose the local revision, the disk revision, or cancellation after reviewing the comparison.
The app keeps a checkpoint before replacement and checks the reviewed revision again.
Browser file APIs cannot make this final check and write atomic. Avoid simultaneous writes from another application.

In Desktop, change the name in the toolbar and press Enter or leave the field to rename the linked file on disk. Escape cancels the edit. A rename keeps the file in the same folder and refuses a name that another file uses. In a browser, renaming disconnects the old disk link. Save the renamed draft to a new file; the original disk file stays unchanged.

Importing an exact copy of one linked document, with the same name and content, opens its existing tab. A different content version remains a separate draft.

## Local search index

Open **Local search index** from Commands and enable it. Select the library or
current project, choose a model, then select **Build or refresh index**. Search
results show the source path and line. Refresh the index after document changes.

The feature-hash model matches word and character features. The local
co-occurrence model uses terms that occur together in the selected documents.
Both run on this device without a model download or provider request. The index
contains note and code text in IndexedDB. **Clear index** removes the stored index.
Disabling search alone does not delete it.

## Snippets and content blocks

Use **Save selection as snippet...** or **Save file as snippet...** from Commands.
Open **Code snippets** to edit, copy, or export snippets. Search uses titles,
tags, folders, and language names. It does not search the code body.
Favorites and project filters limit the results.

Copy can resolve `${PROJECT_NAME}`, `${FILE_NAME}`, `${DOCUMENT_TITLE}`,
`${DATE}`, and `${TIME}`. Check the resolved preview before you copy.
Use `\${NAME}` to keep a placeholder as text. A snippet JSON export keeps the
stored code and metadata. Full library backups also include snippets.

To define a reusable content block, add these markers in a note's Source mode:

```markdown
<!-- mdsh-block id="support" -->
Contact the support team before you change the configuration.
<!-- /mdsh-block -->
```

Open the destination note, then **Linked content blocks** from Commands. Select
the source block and insert it. The destination keeps a readable Markdown
snapshot. **Update** copies a changed source block. **Freeze** keeps the current
snapshot, and **Detach** removes its link while retaining the text. Source
changes do not update destination notes automatically.

## Local and remote images

The app embeds images that you add with the picker, clipboard, or drag and drop. Embedded images remain available after a reload and appear in PDF and standalone HTML exports. Older versions created temporary links that cannot be recovered after expiration. Import the image again from its original file.

Source mode hides long image payloads behind **Image data**. Activate the control to show the original data.
Copy and Markdown export retain all bytes. Visual images keep their proportions when you change the editor width.

The app blocks remote images by default. Reading mode can load and embed them in the current document. This action contacts the image host and reveals your IP address. The request sends no cookies or referrer and rejects redirects. Each remote image can contain up to 2 MiB. One operation can fetch up to 8 MiB in total. The app sanitizes SVG files before it embeds them.

To resolve a relative image path, select the applicable file or folder. The app then embeds the image to keep the document portable.

Mermaid diagrams reject images and network styles. Put images directly in the Markdown.
Diagrams use the Dagre layout online and offline. Document settings cannot select
the ELK layout. The app keeps these settings in the Markdown source without applying them.

## AI and network access

AI is optional and disabled by default in both editions. In Settings, configure
an OpenAI-compatible API base URL, a model identifier, and a provider key.
Enable AI features to use the assistant. A connection test contacts the provider
with a test prompt, without document content.

Web Light requires consent to use a browser-resident key. It keeps the key in
memory and tab session storage. That storage is accessible to page scripts and
is not a secure vault. **Forget key** removes it. Provider CORS rules and the
app's connection policy can prevent browser requests.

Desktop stores the key in the operating-system credential store. The key passes
from the entry field to the vault. Stored keys are not returned to the WebView.
Rust reads the key for provider requests. **Delete key** removes it from the vault.
Each key belongs to a full endpoint, including its port and path. If you used an
older host-only key entry, enter the key again for the configured endpoint.

Open **AI assistant** from Commands. Choose a selection, document, file list, or
project as context. Review the included paths and text before you send a prompt.
That action sends the prompt and context to the configured provider. Review
proposed changes before applying them. A reply does not run commands or apply
edits automatically.

No local inference engine is bundled. A separately installed compatible provider
can use a local endpoint where the edition's network policy permits it.
The app requires no backend or cloud storage and sends no telemetry or crash
reports. Remote images still require a separate fetch action.

<a id="backups-and-storage-health"></a>

## Backups and storage health

Settings shows whether the browser granted persistent storage. It also shows the estimated quota and the date of the latest successful external backup. Export a backup regularly. Always make one before you clear browser data or change profiles. Clearing site data, using private browsing, or evicting site storage can remove all local drafts, history, and assets.

Web Light and Desktop Complete use the same backup format. New metadata can
require a newer release. Check a backup before you restore it in another version.

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

A backup contains open and closed documents, projects, assets, workspaces, custom templates, snippets, and comments.
It excludes trash, version history, the search index, API keys, browser file handles, and Desktop path permissions.
Version 2 backups use schema 2. The app also accepts schema 1 backups from version 1.9.
The format accepts up to 3,000 documents, 300 workspaces, 16 MiB per document, and 64 MiB in total.
The app checks these limits before it reports a successful download. You cannot recover an encrypted backup without its passphrase.

Replace mode keeps old documents in the trash and preserves variants that share an identifier. Merge mode assigns new identifiers to added drafts and updates workspace references.

Replace mode also disconnects disk links. Imported content cannot reuse an old file permission. Merge mode keeps links for existing local drafts.

On Desktop, open **Automatic local backups** in Settings. Choose a folder, set
the interval and retention count, then enable scheduled backups. The schedule
runs while the app is open. It is not an operating-system background service.
An overdue schedule runs at startup. A schedule without a previous snapshot
starts its first backup when enabled. Older path-only settings require you to
select the folder again.
**Back up now** creates a snapshot immediately. **Preview** shows the snapshot
counts before restore. Older DeckMark snapshots are removed according to the
retention count. Scheduled snapshots are unencrypted JSON. Use manual encrypted
export when you need a passphrase-protected backup.

## Export

PDF export renders content, embedded images, formulas, code blocks, and diagrams before it opens the print dialog. The app reports success only after preparation finishes. Select a PDF printer in the browser or system dialog. You can disable browser headers and footers in that dialog.

On macOS Desktop, use the native print panel's **PDF** menu to save the document.
The editor returns after the print operation finishes or you cancel it.
Tall images fit within the A4 printable height without cropping.

During HTML or PDF preparation, select **Cancel export** in the progress message
to stop waiting for media or styles. In a native save or print panel, use its
**Cancel** button. Cancellation keeps the draft and its unexported-change marker.
You can edit the document and start another export.

For notes, select **PDF (A4)** under **Editor width** in Settings or through Commands. This
preset uses the 178 mm text width of an A4 page with 16 mm side margins. It is a
width guide. Fonts, page breaks, and print settings can differ from the editor.

The standalone HTML file embeds its styles, images, and required KaTeX fonts. You can read the local file without a network. Markdown, ZIP, and HTML exports do not include direct disk-access permissions.

**Export all files (ZIP)** includes open and closed documents in the library. **Export open tabs as ZIP** limits the archive to the current session. Selection export includes only selected tabs.

Library ZIP exports keep each project in a separate nested ZIP with its assets.
Open-tab and selection exports include the selected project documents. Their link reports identify references to documents outside that selection.

## Presentations

Select **New file**, then **Presentation**. The slide editor opens directly in the
document area with one empty slide. Open an existing presentation from a tab or
the library to edit its stored layout. Notes remain notes; there is no conversion
action or global Slides button.

Presentations have their own controls. Note modes, split preview, outline, tags,
backlinks, and the link graph do not apply to them. Disk links, version history,
trash, and backups work for both document types.

The slide strip lists slides. Add, duplicate, move, or delete a slide there. The
canvas holds text, images, rectangles, ellipses, lines, and arrows. Drag an object
to move it, or use the arrow keys for one-pixel steps and Shift with an arrow for
ten-pixel steps. Drag a corner to resize, or use the properties panel for exact
position and size. Shift-click selects more than one object. The properties panel
also controls stacking, grouping, alignment, colors, text size, and connectors.

The **Presenter notes** panel is visible below the slide by default. Write your
speech there. Use the header control to hide or show the panel.

Select **Present**, or press `Cmd+Shift+L` (`Ctrl+Shift+L` on Windows and Linux),
to use the full-screen overlay. Use the arrow keys, Page Up, Page Down, Space,
Home, and End to move. Use **Show notes** to display your speech. Press Escape to
return to the inline editor. Select another tab or library file to change documents.

**Advanced > Markdown source** opens a draft of the complete file. Keep the slide
and element markers and the terminal presentation data. Select **Apply** to save
the source, or **Cancel** to discard the draft. Apply rejects a missing
presentation marker and keeps both your draft and the previous file content.
A marker inside code or front matter does not satisfy this check. Malformed
metadata keeps the presentation type and shows a parse error. Correct it to
resume visual editing.

Use **Export** to select **Markdown**, **HTML**, or **PDF / Print**. HTML works
offline. PDF and print produce one slide per page at the stored canvas size.
HTML and PDF omit presenter notes. Markdown keeps them in the presentation data.
Notes keep their A4 print settings.

A presentation is one Markdown file with optional front matter, slide content, and
one terminal `mdsh-presentation` metadata block. The format remains version 1;
existing files need no migration. The metadata block controls
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

In a table cell, press Enter or Shift+Enter to add a line break. Press Shift+Tab
to move to the previous cell. Press Ctrl+Enter, or Cmd+Enter on macOS, to leave
the table. Markdown exports use `<br>` for line breaks inside cells.
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

<a id="desktop-beta-app"></a>
<a id="desktop-complete-app"></a>

## Desktop Complete app (Beta)

Desktop Complete is the Desktop edition. It uses the same editor, storage model,
and document formats as Web Light. It adds native in-place file editing, native
folder access, file associations, native menus, and the macOS print panel.
See the [edition matrix](EDITIONS.md) for the full comparison.

Desktop installers are unsigned beta artifacts. macOS can show a Gatekeeper warning, and Windows can show a SmartScreen warning. Download files only from the `desktop-v<version>` prerelease for the applicable version. Compare their checksums with `SHA256SUMS`. The workflow also creates a GitHub build provenance attestation.

| Platform | Artifact | Requirement |
| --- | --- | --- |
| macOS | `deckmark_<version>_macOS_Apple-Silicon.dmg` | macOS 14 or later on an Apple Silicon Mac. |
| Windows x64 | `deckmark_<version>_x64-setup.exe` or `.msi` | WebView2. The installer can add WebView2 if it is absent. |
| Linux x64 | `.AppImage`, `.deb`, or `.rpm` | WebKitGTK 4.1 and the packaged native libraries. |

Earlier releases use the previous `mdsh_` filename prefix.
Desktop update delivery is on standby. The app does not check for or install
updates. Download and install a new release manually, and keep your JSON backups
and exported files. See [Desktop updates](UPDATES.md).

Native selections and file associations authorize each Markdown path. The app restores that access after restart, so `Cmd+Shift+S` or `Ctrl+Shift+S` saves the restored draft directly. Removing a disk link revokes access. Files first selected in an older version need one new native selection to enter the access registry.

The native boundary does not provide unrestricted filesystem access. JavaScript
cannot add a path to the native access registry. Background disk scanning and a
general file browser are not available.

## Desktop tools

For Git, open a disk folder that contains an existing repository. Save draft
changes to disk before you open **Git changes**. The panel reads disk state,
shows diffs and recent commits, and lets you stage, unstage, and commit changes.
Stage and commit are disabled when the project is inside a parent repository.
The panel does not provide clone, fetch, push, or pull actions.

Enable global quick capture in Settings to register its shortcut. The default
is `Cmd+Shift+Space` on macOS and `Ctrl+Shift+Space` on Windows and Linux.
The capture window saves a note or snippet without opening the main editor.
The shortcut is disabled by default and can be changed in Settings.

The [CLI](CLI.md) and [local MCP server](MCP.md) run as separate Node processes
from a source checkout. The MCP server accepts explicit roots and provides
read, search, check, and patch-proposal tools. It starts no network listener and
does not write files. The MCP client controls any later use of returned content.
