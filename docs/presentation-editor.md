# Presentation editor

The presentation editor keeps text, slide layout, and shapes in one Markdown file.
It opens directly in the document area. Notes and presentations are separate
document types. The app does not convert a note to a presentation.
Both types use the local library and the 400 ms draft save delay.

## Create a presentation

1. Select **New file**, then **Presentation** in the **Create a document** dialog.
   The inline editor opens with one empty slide.
2. Add text, an image, or a shape from the insertion toolbar.
3. Select an object and drag it to a new position.
4. Use its corner handles to change its size. Use its rotation handle to turn it.
5. Double-click text to edit its Markdown. Select **Done** to finish.
6. Use **Properties** for exact dimensions, colors, alignment, groups, and connectors.
7. Add slides with **Add slide**. Drag their thumbnails to change their order.
8. Write your speech in **Presenter notes** below the slide. This panel is visible
   by default. Use **Presenter notes** in the header to hide or show it.
9. Select **Present** to start the slide show.
10. Select **Export > PDF / Print** to print or save a PDF.

The New dialog also opens from Welcome, the command palette, and `Cmd+N`
(`Ctrl+N` on Windows and Linux). The palette has direct **Create a note** and
**Create a presentation** commands. **Present active file** requires a presentation.
Select another tab or library file to return to your documents.

Only **Present** opens a full-screen overlay. Press Escape to return to the
inline editor. Use **Show notes** during playback to read your speech.

## Edit the source

1. Select **Advanced > Markdown source**.
2. Edit the source draft. Keep the slide and object identifiers and the terminal
   presentation data block.
3. Select **Apply** to save the source, or **Cancel** to discard the draft.

An unapplied draft stays available when you switch files in the same session.
Apply it before you reload or close the application.

Apply rejects source without presentation data. It keeps your draft and the
previous file content so you can correct the draft or cancel. A marker inside
code or front matter does not count as presentation data.
Malformed presentation data keeps the file in the slide editor and shows a parse
error. Correct the source to resume visual editing. If another view changed the
file, copy your draft, cancel, and reopen the source before you apply changes.

## Edit slides

On a touchscreen, select **Edit text** to edit the selected object.
Select **Multiple selection** to select several objects without a keyboard.
Use **Properties** to group, align, and reorder the selection.
Pinch the canvas to zoom. Drag its background to move the view.
The slide movement buttons provide an alternative to thumbnail dragging.

Use Shift-click to select multiple objects. Select **Group** to move them together.
Select two shapes, then select **Connect with an arrow**.
The arrow follows the shapes. Moving the arrow directly removes its attachments.
The connector properties can attach either endpoint to another shape.

Ctrl/Cmd+Z undoes a change. Ctrl/Cmd+Shift+Z or Ctrl+Y restores it.
Ctrl/Cmd+D duplicates the selection. Delete removes it.
Arrow keys move selected objects by one slide pixel. Shift increases the step to ten pixels.
Enter or Space selects a focused object. F2 starts text editing.

PDF pages use the slide dimensions. Printing uses one slide per logical page.
Printer settings still control paper, margins, and pages per sheet.
Presenter notes stay outside PDF pages and HTML exports.
Use the labeled **Export** menu for **Markdown**, **HTML**, or **PDF / Print**.
Markdown keeps presenter notes in the presentation data.

## Required behavior

- Create a Presentation from the New dialog, or open an existing presentation.
- Keep notes in the note editor and presentations in the inline slide editor.
- Add, duplicate, remove, and reorder slides.
- Add text, images, rectangles, rounded rectangles, ellipses, lines, and arrows.
- Move, resize, rotate, align, group, and reorder objects.
- Attach connectors to objects.
- Edit text as Markdown and keep its position.
- Undo and redo changes. Copy and paste selected objects.
- Change the slide background, aspect ratio, and presenter notes.
- Use the same operations with a pointer, keyboard, or touchscreen.
- Present slides in the full-screen overlay with navigation and optional notes.
- Export a portable Markdown file and a self-contained HTML presentation.
- Produce exactly one PDF page for each slide.
- Print each slide on one logical page.

## Failure risks

Pointer movement can serialize large images repeatedly and interrupt a drag.
Keep temporary geometry separate from the saved document until the gesture ends.
Pointer cancellation must restore or finish a coherent operation.
Undo must treat each drag and text edit as one operation.

Source edits can leave layout metadata stale or invalid.
Show invalid input without replacing the source or discarding objects.
Opening a note or presentation must not change its source or document type.
Reject source Apply when the presentation marker is absent. Keep the draft on error.
Changes from another tab must not cause silent overwrites.

Note shortcuts can write to the wrong document type.
Route editing commands to the active document. Confine focus during Present and
restore it to the inline editor on exit.
Keep save failures visible inside the editor.
Keep image insertion failures visible and preserve the existing slide.

Small screens can hide commands or confuse object movement with view movement.
Provide touch controls, zoom, and explicit text editing.
Keep every operation available without hover or drag alone.

Export can use different fonts, image dimensions, or page breaks from the editor.
Use the same slide geometry and rendered content for preview and export.
Wait for media and fonts before print.
Verify actual PDF page counts and dimensions on browser and native paths.

## Validation

The browser scenarios and evidence requirements are in [presentations](testing/presentations.md).
The export scenarios are in [presentation export](testing/presentation-export.md).
