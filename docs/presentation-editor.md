# Presentation editor

The presentation editor keeps text, slide layout, and shapes in one Markdown file.
It uses the local document library and its existing save queue.

## Create a presentation

1. Select **Slides** in the main toolbar.
2. Add text, an image, or a shape from the insertion toolbar.
3. Select an object and drag it to a new position.
4. Use its corner handles to change its size. Use its rotation handle to turn it.
5. Double-click text to edit its Markdown. Select **Done** to finish.
6. Use **Properties** for exact dimensions, colors, alignment, groups, and connectors.
7. Add slides with **Add slide**. Drag their thumbnails to change their order.
8. Add presenter notes below the slide.
9. Select **Present** to start the slide show.
10. Select **PDF / Print** to print or save a PDF.

The existing presentation command opens the slide show directly.
The **Slides** toolbar button opens the visual editor.
Select **Markdown source** to edit text and metadata in the same file.
Keep object identifiers when you edit the source.
Invalid metadata stays in the file until you correct it.

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

## Required behavior

- Open Slides from the main toolbar.
- Add, duplicate, remove, and reorder slides.
- Add text, images, rectangles, rounded rectangles, ellipses, lines, and arrows.
- Move, resize, rotate, align, group, and reorder objects.
- Attach connectors to objects.
- Edit text as Markdown and keep its position.
- Undo and redo changes. Copy and paste selected objects.
- Change the slide background, aspect ratio, and presenter notes.
- Use the same operations with a pointer, keyboard, or touchscreen.
- Present slides with navigation and an optional fullscreen view.
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
Opening an ordinary document must not change its source.
Changes from another tab must not cause silent overwrites.

A modal can leave the underlying editor active.
Confine shortcuts and focus to the presentation editor.
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
