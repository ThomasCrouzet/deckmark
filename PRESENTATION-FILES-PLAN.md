# Presentation files plan

Status: implemented. Release checks are in progress.

The implementation uses content-derived types and presentation format v1.
See `docs/testing/presentation-files.md` for the review and test commands.

This plan changes the document model. A file is either a Markdown note or a
presentation. A file cannot be both. The plan keeps the current presentation
format and removes the implicit note to presentation conversion.

## 1. Decisions

The following decisions are final for this plan:

1. A presentation opens directly in the document area.
2. The new document action shows a dialog with two cards: Note and Presentation.
3. The application does not convert a note to a presentation.
4. The Markdown source stays in an advanced panel of the slide editor.
5. Presenter notes carry the speech. A presentation file has no separate note
   field.

## 2. Baseline before implementation

The code before this change had these properties:

- `FileItem` has no document type.
- A presentation is a Markdown file with a terminal metadata block.
- `isPresentation()` detects the metadata block. It ignores markers inside code
  fences and front matter.
- The toolbar has a small Slides icon. The icon opens a full-screen modal.
- `handlePresentation()` creates `Présentation.md` when no file is active.
- `EditorPane` shows a read-only presentation preview when a file contains
  presentation metadata.
- `SlideEditor` writes directly to the active file with
  `filesStore.updateContent()`.
- The slide editor has a source text area. It writes each change immediately.
- Presenter notes are stored in `slide.notes` and do not enter exports.

The main problem is not storage. The main problem is the interface. A note looks
like a note until the user opens the Slides modal. The modal then treats the note
body as slide content.

## 3. Target model

### 3.1 Document types

| Type | Definition | Main view |
| --- | --- | --- |
| Note | A Markdown file without presentation metadata | Current note editor |
| Presentation | A Markdown file with valid or malformed presentation metadata | Slide editor |

The content is the source of truth. The application does not store a separate
type field. This rule has these effects:

- No database migration.
- No change to existing notes.
- No change to existing presentations.
- Import and export keep the type through the file content.
- Backup, ZIP export, trash, disk links, and version history need no change.

`isPresentation()` already provides the detection. Add one small helper module
for the UI, for example `documentKind(content): 'note' | 'presentation'`. Keep
the detection logic in one place.

A malformed presentation stays a presentation. The slide editor shows the parse
error. The application must not fall back to the note editor, because that would
hide the error and could start a conversion.

### 3.2 What the application must not do

- It must not create a presentation from a note body.
- It must not add presentation metadata to a note.
- It must not remove presentation metadata from a presentation.
- It must not show note-only tools for a presentation.
- It must not show the global Slides icon.

Remove the current conversion path. Do not keep a hidden action that calls
`serializePresentation()` on a note.

## 4. File format

Reuse presentation format version 1. Do not add a format version 2.

A new presentation file must contain the metadata block at creation time. This
rule makes the file self-describing after a reload, an export, or an import.
Create the first content with the model helpers:

1. Create an empty deck with `createDeck()`.
2. Serialize it with `serializePresentation()`.
3. Use the result as the initial file content.

The first slide is empty. The slide editor shows its normal empty state. The file
is valid before the first user change.

The presentation serializer stays the only writer of presentation content. The
note editor must not write a presentation file. The slide editor must not write a
note file.

### 4.1 Advanced source panel

The source panel stays available, but it is an advanced action in the slide
editor menu.

Change the source panel from "write on each input" to a small draft workflow:

1. Open the panel. The panel shows the current file source.
2. The user edits the text.
3. The user selects Apply.
4. The application checks that the text still contains valid presentation
   metadata.
5. If the check passes, write the source.
6. If the check fails, keep the previous file content and show an error.

The check uses `isPresentation()`. A text without the metadata marker is a note,
not a presentation. The application rejects that text. The error message must
say that a presentation file must keep its presentation data. The user can
cancel and keep the previous content.

This rule enforces decision 3 without a conversion action.

### 4.2 Metadata and source errors

These cases are different:

- The metadata marker is missing. The source is a note. Reject the apply.
- The metadata marker is present but the JSON is invalid. Keep the presentation
  type. Show the parse error and let the user correct the source.
- The metadata marker is inside a code fence or front matter. Treat the source
  as a note. Reject the apply.

The existing parser and serializer already apply these rules. The new work is
only the apply guard and the user message.

## 5. Creation flow

### 5.1 New document dialog

Create `NewDocumentDialog.svelte`. Show two large cards.

```text
+--------------------------------------------------+
|  Create a document                               |
|                                                  |
|  +---------------------+  +---------------------+ |
|  |  Note               |  |  Presentation       | |
|  |  Write and read     |  |  Arrange slides and | |
|  |  Markdown.          |  |  present.           | |
|  |  [Create note]      |  |  [Create deck]      | |
|  +---------------------+  +---------------------+ |
|                                                  |
|  Cancel                                          |
+--------------------------------------------------+
```

Rules:

- The Note card is the default focus.
- Each card is a button. The full card is the target.
- Enter activates the focused card. Escape cancels.
- Trap focus inside the dialog. Restore focus to the New button on close.
- Stack the cards on narrow screens.
- Use existing modal and focus-trap patterns.
- Show a short description for each type. Do not use jargon.

The dialog opens from:

- the sidebar New button,
- the Welcome screen New action,
- the command palette New document command,
- the `Cmd+N` shortcut.

The command palette also gets two direct commands: New note and New presentation.
This gives users a fast path without the dialog.

### 5.2 File creation

Add a files store method, for example `createDocument(kind)`.

- For a note, call the current `createNew()` path with empty content.
- For a presentation, call `createNew(name, presentationContent)`.
- Use the unique name helper.
- Set the new file active.
- Keep the 400 ms draft save delay.
- Report save failures with the current error path.

Default names:

- Note: current `files.untitledFilename`.
- Presentation: new `slides.newPresentationName`, for example
  `Présentation.md` in French and `Presentation.md` in English.

### 5.3 First open

After creation, close the dialog and open the correct view immediately.

- A new note opens in the last note mode.
- A new presentation opens in the slide editor.
- Announce the creation to screen readers.
- On mobile, close the sidebar after creation.

## 6. Document area integration

### 6.1 EditorPane

`EditorPane` selects the main view from the document type.

- Note: current Edit, Source, and Read views.
- Presentation: inline `SlideEditor`.
- Split view: notes only. Hide it for presentations.
- Document navigator and outline: notes only. Hide them for presentations.

Keep the dynamic import so the presentation editor stays out of the initial
bundle. Change the lazy entry to load the inline slide editor instead of the
read-only preview.

Remove `PresentationDocument.svelte` if no other caller needs it. Remove the
read-only preview path from `EditorPane`.

### 6.2 Slide editor as a document view

`SlideEditor` becomes the main view of a presentation file. It is not a modal.

Required changes:

- Remove the required `onClose` prop. Closing the file is a tab action.
- Remove the brand block and the close button from the editor header.
- Keep the editor actions: Present, Export, Advanced source, Notes.
- Keep the slide strip, canvas, inspector, and footer.
- Keep the full-screen Present mode as an overlay.
- Keep the `mdsh:presentation-action` event while the file is active. Desktop
  menu actions must still reach the inline editor.
- Use the active file id as the component key. A file switch must remount the
  editor with the correct content.
- Keep focus inside the document area after view changes.
- On mobile, keep the current responsive behavior. The inspector and source
  panel open as sheets or full panels.

`PresentationView.svelte` is no longer needed. Remove it after the inline path
works. Keep `entry.ts` for lazy loading and export helpers.

### 6.3 Application state

Remove the `presentationOpen` modal state from `modals.svelte.ts`. Keep a small
state for the full-screen Present overlay. Rename it if needed, for example
`presenting`.

Update these callers:

- `Modals.svelte`
- `EditorPane.svelte`
- `Toolbar.svelte`
- `+page.svelte`
- `modals.anyOpen` checks
- desktop menu action routing

The `anyOpen` contract must not block note shortcuts when the inline editor is
open. The inline editor is a document view, not a modal.

## 7. Toolbar and header

### 7.1 Remove the Slides icon

Remove these items:

- the Slides button from `Toolbar.svelte`,
- the `onOpenPresentation` prop,
- the `Presentation` icon import if unused,
- `handlePresentation()` from `+page.svelte`,
- the automatic `filesStore.createNew(t('slides.newName'))` call.

### 7.2 Type-aware toolbar

The toolbar shows controls for the active document type.

For a note:

- Edit, Source, Read.
- Note export and PDF.
- Note-only tools.

For a presentation:

- No Edit, Source, or Read mode group.
- Present.
- Export Markdown, HTML, and PDF.
- Advanced source.
- Notes.
- Save to disk and the rest of the global controls.

Do not duplicate actions between the global toolbar and the slide editor header.
Choose one location for each action. The plan recommends the slide editor header
for presentation actions.

### 7.3 Rename and title

Renaming works for both types. The type badge stays visible next to the title.

The title area shows:

```text
Presentation.md   [Presentation]
```

Use one badge style. Do not use a small unlabeled icon as the only signal.

## 8. Library, search, and palette

### 8.1 Sidebar

Add a type icon to each file row.

- Note: document icon.
- Presentation: presentation icon.

Add an accessible label, for example `Note` or `Presentation`. Do not rely on
color alone. Keep the current dirty dot, broken-link badge, and path display.

If a type filter is added, use three values: All, Notes, Presentations. The
filter is optional for the first release.

### 8.2 Search

Search continues to work on file content. Presentation slide text is searchable.

Show the document type in each result group. If the current search indexes tags
or backlinks, skip presentation files for those note-specific indices.

### 8.3 Command palette

Replace the current slides command with these commands:

- New note.
- New presentation.
- Present active file. Disabled for notes.
- Open advanced source. Available for presentations.

Remove the command that opens the old slides modal.

### 8.4 Welcome screen

Replace the single New file action with New note and New presentation actions.
Keep Import and Demo.

If the Welcome screen is too small for four actions, open the New document dialog
from one New action. The dialog then shows the two cards.

## 9. Note-only and presentation-only features

Guard these features by document type:

| Feature | Note | Presentation |
| --- | --- | --- |
| Edit, Source, Read modes | Yes | No. The slide editor has its own source panel. |
| Outline and document navigator | Yes | No |
| Tags and tag filter | Yes | No |
| Backlinks and link graph | Yes | No |
| Note word count | Yes | Replace with slide count and current slide |
| Wiki links | Yes | Not indexed. Links in slide text stay as text. |
| Version history | Yes | Yes. History is per file. |
| Disk link and save | Yes | Yes |
| Trash | Yes | Yes |
| Export Markdown | Yes | Yes |
| Export HTML and PDF | Note export | Slide export |

These guards must be central. Do not repeat `isPresentation()` in many
components. Use one derived document kind in the page or document shell and pass
it down.

## 10. UI and UX quality bar

This section is a release gate. The feature must not ship if it fails this
section. The target is a first use without frustration. A new user must
understand the application at first glance. The user must never feel lost, and
must never have to find an important action by accident.

### 10.1 Core principles

1. **Show the model at first glance.** The user sees two document types at
   creation, in the library, and in the document header. The type is never a
   surprise.
2. **One primary action per view.** Each view has one clear next step. Secondary
   actions stay quieter.
3. **No hidden critical action.** A critical action has a text label. An icon
   alone is not sufficient. A keyboard shortcut is never the only path.
4. **Every option has a reason.** Remove controls that do not help the current
   task. If a control is disabled, the interface explains why.
5. **Progressive disclosure.** Common actions stay visible. Advanced actions,
   such as the Markdown source, stay in an Advanced menu.
6. **Consistency.** Use the same words, button styles, spacing, icons, and focus
   behavior everywhere.
7. **Safe by default.** The application does not convert files, does not
   overwrite silently, and does not lose input on error.
8. **Visible feedback.** Every action shows a state: working, success, failure,
   or nothing to do.
9. **Recovery is always possible.** Cancel, undo, retry, and clear error text
   must exist for risky actions.
10. **No random discovery.** Do not hide a feature behind an unlabeled icon, a
    secret gesture, or a shortcut. The interface teaches the feature in place.
11. **Calm interface.** Use motion and color with purpose. Do not compete with
    the content.
12. **Accessibility is part of UX.** Keyboard, screen reader, zoom, contrast,
    and reduced motion are normal acceptance criteria.
13. **Short interface text.** Labels are short. Help text appears only where a
    decision needs it. Do not explain obvious actions.

### 10.2 First-glance test

A first-time user must answer these questions in about ten seconds, without
help:

- What type is this file?
- How do I create a note?
- How do I create a presentation?
- How do I present this file?
- How do I return to my files?
- Where are the presenter notes?
- How do I export?

If a question needs a manual, the design fails the gate.

### 10.3 Navigation and hierarchy

- The document header shows the file name and a text type badge.
- The sidebar shows the active file with a clear selected state.
- The slide editor is the document view. Only Present uses a full-screen
  overlay.
- Escape leaves Present mode and returns to the slide editor. It does not leave
  the application.
- The advanced source panel has Apply and Cancel. It is not a second editor with
  hidden save behavior.
- Do not open a modal from a modal. Use one layer at a time.
- A file switch keeps the correct document type and view. Do not show stale
  content from the previous file.

### 10.4 Creation dialog quality

- Two cards have equal visual weight. The Note card has the default focus, but
  the interface does not push the user to one type.
- Each card has an icon, a text title, and a short description.
- The full card is the click and touch target.
- Cancel is always visible.
- Escape cancels. Enter activates the focused card.
- Closing the dialog does not create a file.
- On mobile, the cards stack in one column with no horizontal scroll.
- The dialog fits a 320 px wide screen and a 200 percent zoom level.

### 10.5 State inventory

The design must cover these states before implementation starts:

| Area | States |
| --- | --- |
| Creation dialog | Default, keyboard focus, disabled, narrow screen |
| Note view | Default, empty, dirty, saving, saved, error |
| Presentation view | Empty deck, one slide, many slides, selected object, no selection |
| Source panel | Default, modified, invalid, apply rejected, apply success |
| Present mode | Default, presenter notes, next slide, exit |
| Library | Note, presentation, active, selected, dirty, broken disk link, empty |
| Search | No result, result in note, result in presentation, error |
| Export | Idle, working, success, failure |
| Offline | Ready, preparing, unavailable |
| Errors | Parse error, save error, image error, overflow, disk permission error |

Each state must have a visible message and a next action. A blank screen or a
silent failure is not acceptable.

### 10.6 Responsive rules

Test these widths in portrait and landscape:

- 320 px
- 360 px
- 390 px
- 768 px
- 1024 px
- 1280 px
- 1440 px

Required rules:

- No horizontal page scroll at any width.
- No horizontal scroll at 200 percent browser zoom.
- Touch targets are at least 44 by 44 CSS pixels.
- Critical labels do not truncate. Use wrapping or a labeled overflow menu.
- Header actions collapse into a labeled menu. They do not disappear without a
  replacement path.
- The slide strip scrolls horizontally and keeps the active slide visible.
- The inspector becomes a sheet or a full panel on small screens.
- The canvas fits the available area and keeps its aspect ratio.
- The virtual keyboard does not cover the active field.
- Dialogs have a maximum height and scroll inside the dialog body.
- Safe areas are respected on phones.

### 10.7 Visual system

- Keep the current Relay identity. Do not introduce a new visual language for
  this feature.
- Use the existing design tokens. Do not add one-off colors, font sizes, or
  radii.
- Use one button hierarchy: primary, secondary, ghost, and danger.
- Use the same control for the same job in both document types.
- Use a visible focus ring on every interactive element.
- Meet WCAG 2.2 AA contrast for text and controls.
- Use motion only to explain a change. Keep it short and support
  `prefers-reduced-motion`.
- Do not use an emoji as an interface icon.
- Keep icon and label alignment consistent with the current toolbar.

### 10.8 Language and labels

- Use the same terms everywhere: Note, Presentation, Slide, Presenter notes.
- Use action labels that start with a verb, for example Create a note and Create
  a presentation.
- Do not use internal terms such as metadata in normal interface text. Use them
  only in the advanced source warning.
- A tooltip is not the only label. Every icon has an accessible name.
- Error text says what happened and what to do next.
- Test the English and French text at the narrowest width. The French text is
  often longer.

### 10.9 Concise interface text

The interface must not read like documentation. The agentic workflow can produce
long explanatory text by default. This plan rejects that style.

Rules:

- Use short labels. Prefer two or three words.
- Use one short sentence for a card description, not a paragraph.
- An empty state has one title, one short line, and one action. Do not add a
  second paragraph.
- Do not explain an action that the label already explains. For example, do not
  add a sentence under a button that says Create a note.
- Do not repeat the same information in the title, the subtitle, the tooltip,
  and the help text. Keep one source for each message.
- Do not describe the whole application on a screen. Show help only at the point
  where the user must make a decision.
- Put long help in one help location, not on every screen.
- Use concrete verbs and nouns. Do not use marketing text, filler, or phrases
  such as This is where you can.
- Keep an error message to one sentence plus the next action.
- Keep a tooltip to one short sentence.
- A disabled control gets a short reason, not a paragraph.
- Do not add a subtitle to a screen that already has a clear title.
- Use progressive disclosure. Advanced source, format details, and keyboard
  help stay in their own panels.
- Test each sentence with this question: if the sentence is removed, does the
  user lose a needed decision or a needed next step? If no, remove it.
- Review the text in English and French. Remove text that only repeats the
  layout or the obvious result.

The goal is not minimalism for its own sake. The goal is a calm screen where each
word helps the user act.

### 10.10 Feedback and error recovery

- Show the save state near the document title.
- Keep user input after a failed save, a failed export, or a rejected source
  apply.
- Move focus to an error message when it appears.
- Use `role="alert"` for errors that need immediate attention.
- Confirm destructive actions. Offer undo or trash recovery.
- A disabled action shows a reason on focus and on hover.
- No action fails without a visible message.

### 10.11 Accessibility smoke test

The UX gate includes these manual checks:

- Complete the full create, edit, present, and export flow with the keyboard
  only.
- Use a screen reader to identify the document type and the primary actions.
- Check the focus order in the dialog, the slide editor, and Present mode.
- Check 200 percent zoom at 320 px width.
- Check `prefers-reduced-motion`.
- Check that no status message is visual only.

### 10.12 Perceived performance

- Keep the slide editor in a lazy chunk.
- Show a stable loading state. Do not shift the header or the canvas after load.
- Keep the first interaction fast on a mid-range phone.
- Keep a 20-slide deck responsive during a drag, as the current performance test
  requires.
- Do not block the note editor while the slide editor loads.

### 10.13 Design review process

Before implementation:

- Draw the creation flow, the document shell, and the presentation shell.
- List every state from section 10.5.
- List every action and its location. Remove duplicate actions.
- Review the text in English and French.

During implementation:

- Reuse existing components and tokens.
- Capture screenshots at the widths in section 10.6.
- Run the keyboard and screen reader checks as each view lands.

Before release:

- Review every touched screen: sidebar, toolbar, creation dialog, document
  header, slide editor, source panel, library, search, Welcome, and Present
  mode.
- Run a first-time user walkthrough with five tasks: create a note, create a
  presentation, add a slide, add presenter notes, and present.
- Run the heuristic review: visibility of status, match with the real world,
  user control, consistency, error prevention, recognition over recall, clear
  feedback, and simple language.
- Classify issues by severity. A blocker prevents a task, causes data loss, or
  hides a conversion path. A high issue causes confusion or blocks keyboard and
  screen reader use. Fix all blocker and high issues.
- Record the review result in the E2E artifact.

### 10.14 UX release gate

The feature does not ship if any answer is no:

- Can a new user create both document types without help?
- Is the type visible before the user opens the file?
- Is every critical action visible with a text label?
- Is there exactly one clear primary action per view?
- Does every error keep the user input and give a next step?
- Does the full flow work with the keyboard only?
- Does the layout work at 320 px and at 200 percent zoom?
- Is the interface free of hidden conversion paths?
- Does the user always know how to return to the previous view?
- Is every visible sentence needed for a decision or a task?

## 11. Presenter notes

Presenter notes stay in `slide.notes`.

- They are the speech for the slide.
- They do not enter exported slides, HTML, or PDF pages.
- The presenter view shows the current slide, the next slide, and the notes.
- The edit view keeps a Notes action. The notes panel must be easy to find.
- Do not add a separate note field to a presentation file.

The existing `slides.notes` and `slides.notesPlaceholder` messages stay. Update
the help text to say that these notes carry the speech.

## 12. Internationalization

Add or update English and French messages for:

- new document dialog title,
- Note card title and description,
- Presentation card title and description,
- Create note and Create presentation actions,
- document type labels,
- presentation default name,
- presentation type badge,
- empty presentation help,
- advanced source warning,
- source apply error for a missing metadata block,
- present active file command,
- slide count in the status bar.

Rules:

- English is the default.
- French is an option.
- Keep existing keys.
- Do not use U+2014 or U+2013 in interface text.
- Keep the same key naming style as the current catalogs.

## 13. Accessibility

- The new document dialog has `role="dialog"` and `aria-modal="true"`.
- Focus moves to the Note card when the dialog opens.
- Focus stays inside the dialog.
- Escape cancels the dialog.
- Each card has a clear name and description.
- The type badge and type icon have text alternatives.
- The inline slide editor keeps a logical focus order.
- The Present overlay traps focus until the user exits.
- Creation and type changes are announced to screen readers.
- The source apply error uses `role="alert"`.
- Do not use color as the only type signal.

## 14. Compatibility and failure control

| Risk | Control |
| --- | --- |
| Existing note changes | Never write metadata to a note |
| Existing presentation changes | Open it in the inline editor. Do not rewrite it on open. |
| Presentation loses its type | Reject advanced source without a metadata block |
| Note keeps an old Slides icon | Remove the button, the prop, and the handler |
| Malformed presentation becomes a note | `isPresentation()` returns true for malformed metadata. Show the parse error. |
| Presentation metadata in a code fence | Detection already ignores it. Treat the file as a note. |
| Database change | No migration. Type comes from content. |
| Import from disk | Content detection classifies each file |
| Backup and ZIP restore | Content stays unchanged |
| Desktop menu actions | Keep the `mdsh:presentation-action` channel for the inline editor |
| Shortcut conflict | Remove the old slides modal action. Add explicit present and new actions. |
| Mobile layout | Test the dialog and inline editor at a narrow viewport |
| Version history noise | History stays per file. This is expected. |

## 15. Testing plan

Follow the project testing policy. Use E2E tests for observable behavior. Keep
the existing model tests. Do not add unit tests for type contracts or call
sequences.

### 15.1 E2E scenarios

Create a new spec, for example `e2e/presentation-files.spec.ts`.

1. New note flow.
   - Open the New dialog.
   - Select Note.
   - Confirm the note editor opens.
   - Confirm the file has no presentation metadata.
2. New presentation flow.
   - Open the New dialog.
   - Select Presentation.
   - Confirm the inline slide editor opens.
   - Confirm the file contains presentation metadata.
   - Add a slide and text.
   - Reload the page.
   - Confirm the file is still a presentation and the content remains.
3. Document type in the sidebar.
   - Confirm each type shows its icon and accessible label.
4. Existing files.
   - Open an existing note. Confirm the note editor.
   - Open an existing presentation. Confirm the inline slide editor.
   - Confirm no file content changed on open.
5. No hidden entry point.
   - Confirm the toolbar has no Slides button.
   - Confirm the command palette has no old slides command.
6. Advanced source panel.
   - Edit valid slide text. Apply. Confirm the canvas updates.
   - Remove the metadata block. Apply. Confirm the alert and unchanged file.
7. Presenter notes.
   - Add notes to a slide.
   - Start Present.
   - Confirm the notes are visible in the presenter view.
   - Export HTML and PDF.
   - Confirm the notes are absent from the exported pages.
8. Present mode.
   - Start Present from the inline editor.
   - Confirm full screen behavior.
   - Press Escape. Confirm the document area returns.
9. Command palette.
   - Create a note.
   - Create a presentation.
   - Confirm Present is disabled for a note.
10. Mobile.
    - Open the New dialog at a narrow viewport.
    - Confirm the cards stack.
    - Confirm the inline slide editor does not overlap the header.

### 15.2 Artifact

Produce a repeatable artifact at the end of the E2E run. The artifact must
include:

- command,
- source revision,
- browser and platform,
- fixtures,
- pass and fail results,
- path to the Playwright HTML report.

Write it under `test-results/` with a stable name and the revision in the file
name. Do not add automated attribution.

### 15.3 Checks

Run these commands for the change:

```bash
npm run check
npm run lint
npm run test
npm run build
npm run test:e2e
```

Use the full E2E suite because the change affects shared navigation, storage,
export, and PWA paths. Regenerate visual snapshots only if the UI change is
accepted.

## 16. Implementation phases

### Phase 0: Baseline

- Record the current E2E result and the current presentation fixture behavior.
- Confirm that opening a presentation does not rewrite it.
- List the current note-only tools that must be hidden.

### Phase 1: Document type and creation

- Add the document kind helper.
- Add `createDocument(kind)` to the files store.
- Add presentation content creation with metadata from the first write.
- Keep `createNew()` for imports and internal callers.
- Add E2E tests for the content and the reload.

### Phase 2: New document dialog

- Create `NewDocumentDialog.svelte`.
- Add the two cards, focus trap, Escape, and mobile layout.
- Connect the sidebar, Welcome, command palette, and `Cmd+N`.
- Add English and French messages.
- Add E2E tests for both creation paths.

### Phase 3: Inline slide editor

- Render `SlideEditor` in `EditorPane` for presentation files.
- Remove the read-only preview path.
- Remove the required `onClose` prop.
- Adapt the header and actions.
- Keep the full-screen Present overlay.
- Remove `PresentationView.svelte` and the old modal state.
- Add E2E tests for existing and new presentations.

### Phase 4: Toolbar and note-only guards

- Remove the Slides icon, prop, and handler.
- Make the toolbar type-aware.
- Hide note modes and note-only tools for presentations.
- Replace the word count with slide count for presentations.
- Add E2E tests for the toolbar and the guards.

### Phase 5: Advanced source panel

- Move the source panel to an advanced menu action.
- Add the draft, Apply, and Cancel flow.
- Add the metadata guard.
- Add the error message and `role="alert"`.
- Add E2E tests for a valid apply and a rejected apply.

### Phase 6: Library, search, and palette

- Add type icons and accessible labels.
- Update search result groups.
- Replace the slides command with new note, new presentation, and present.
- Update the Welcome screen.
- Add E2E tests for the sidebar and palette.

### Phase 7: Presenter notes and export

- Confirm notes editing and the presenter view.
- Confirm notes stay out of HTML and PDF exports.
- Update the notes help text.
- Add E2E coverage for presenter notes and export.

### Phase 8: Documentation

- Update `README.md`.
- Update `docs/presentation-editor.md`.
- Update `docs/presentation-format.md` with the type rule and no format change.
- Update `docs/USER_GUIDE.md` if it describes the Slides modal.
- Update `ARCHITECTURE.md`.
- Update `docs/TESTING.md` with the new E2E artifact and failure risks.

### Phase 9: UX review and release gate

- Draw the final flow and compare it with section 10.
- Complete the state inventory from section 10.5.
- Run the first-glance test from section 10.2.
- Run the first-time user walkthrough from section 10.13.
- Run the responsive matrix from section 10.6.
- Run the keyboard-only flow.
- Run the screen reader smoke test.
- Run the accessibility scan in E2E.
- Run the verbosity review from section 10.9. Remove filler, duplicate help,
  and descriptions that do not help a decision.
- Review the screenshots and visual snapshots.
- Fix all blocker and high-severity UX issues.
- Run all checks.
- Publish the E2E artifact with the UX review result.

Do not start the release step until every answer in section 10.14 is yes.

## 17. Acceptance criteria

The change is complete when all these statements are true:

1. A new note opens in the note editor and has no presentation metadata.
2. A new presentation opens in the document area in the slide editor.
3. A new presentation contains presentation metadata before the first edit.
4. A reload keeps the document type and the content.
5. Existing notes and presentations keep their content and open in the correct
   view.
6. The application has no action that converts a note to a presentation.
7. The advanced source panel rejects a source without presentation metadata.
8. The global Slides icon and the old slides modal are removed.
9. The sidebar and the command palette show the document type.
10. Presenter notes are editable, visible in the presenter view, and absent from
    exported slides.
11. Note-only tools do not appear for presentation files.
12. No database migration is required.
13. `npm run check`, `npm run lint`, `npm run test`, and `npm run build` pass.
14. The E2E run passes and produces the required artifact.
15. A first-time user can create both document types without help.
16. The document type is visible in the header and in the sidebar before the
    file opens.
17. Every critical action has a visible text label. No critical action depends
    on an icon or a shortcut alone.
18. Every screen has the states from section 10.5, and every error keeps the
    user input and gives a next step.
19. The full flow works with the keyboard only and at 200 percent zoom.
20. The layout has no horizontal scroll at 320 px width and on a phone in
    landscape.
21. All answers in the UX release gate in section 10.14 are yes.
22. The primary screens have no explanatory paragraph. Each empty state has one
    short line, and no message repeats a label, a tooltip, or another message.

## 18. Out of scope

- A note with an attached presentation in the same file.
- Conversion between notes and presentations.
- Presentation templates.
- A separate speech field in a presentation file.
- A link between a note and a presentation.
- Cloud storage, telemetry, or a required backend.
- A new presentation format version.

## 19. Main implementation risk

The main risk is the inline slide editor. The current editor assumes a full-screen
modal. It has its own header, focus behavior, and viewport sizing. The plan keeps
the editor logic and changes its container. Test the following points early:

- canvas size and zoom at different viewport widths,
- focus and keyboard shortcuts,
- full-screen Present mode,
- mobile layout,
- desktop menu actions,
- file switch without stale state.

If the inline integration causes too much layout risk, stop and review the
container approach before the other phases. Do not fall back to a modal, because
the modal is the source of the current confusion.
