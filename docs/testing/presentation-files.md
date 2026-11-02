# Presentation file review

## Design before implementation

```text
New (sidebar, Welcome, palette, shortcut)
  -> Create a document [Note] [Presentation] [Cancel]
     -> Note: title [Note], Edit / Source / Read, note tools
     -> Presentation: title [Presentation], inline slide editor
        -> Present: full-screen overlay -> Escape: inline editor
        -> Export: Markdown / HTML / PDF
        -> Advanced: source draft -> Apply / Cancel
        -> Presenter notes: speech for the selected slide
```

The global header owns the title, type, disk save, and global controls. The slide
header owns Present, export, advanced source, and presenter notes. Tabs and the
library select files. There is no conversion action.

## State inventory and failure risks

| Area | States and recovery |
| --- | --- |
| Creation | Note has initial focus. Both cards have equal weight. Cancel and Escape create nothing. Cards stack on narrow screens. Creation disables repeated activation. |
| Note | Empty, edited, pending save, saved, and failed save use the existing editor and retry control. |
| Presentation | Empty, one slide, many slides, selected objects, and no selection retain the slide strip, canvas, and properties. |
| Source | Current, modified, rejected, invalid JSON, and applied. Rejection keeps the draft and stored bytes. Cancel restores the stored source. |
| Present | Current slide, next slide, notes, navigation, and exit. Escape restores editor focus. |
| Library | Note, presentation, active, selected, dirty, broken disk link, and empty. Keep existing status signals and add a named type icon. |
| Search | Empty query, no result, note result, presentation result, and failure. Keep searchable slide text; omit slides from note indices. |
| Export | Idle, working, complete, and failure. Keep content on failure and allow retry. Notes stay out of rendered exports. |
| Offline | Preparing, ready, and unavailable use the existing offline status. The lazy editor remains cached. |
| Errors | Parse, save, image, overflow, and disk permission errors retain content and show the existing recovery action. |

Additional risks: a file switch can retain the previous deck; a note shortcut can
write presentation source; a source draft can overwrite an external change;
opening or exporting a file can rewrite its bytes; modal state can block global
shortcuts; small document panes can clip the canvas or properties.

The review also found these failure modes:

- A final note editor flush can arrive after the file moves to the closed library.
- An unapplied source draft can disappear when the file view is remounted.
- An external repair can replace a correction in the malformed-source editor.
- An export can target a different file after it waits for a pending save.

Flushes use the full library. Unapplied source drafts remain in session memory.
Source Apply checks the original revision. Presentation exports use the captured
file ID. A reload still requires Apply to keep a source draft.

## Proof

Use `e2e/presentation-files.spec.ts` for creation, type signals, source guards,
file switching, keyboard focus, palette actions, and responsive checks. Keep the
existing editor, format, export, offline, and performance scenarios. Record the
command, source revision and diff, platform, browser, fixtures, results, and HTML
report path in `test-results/presentation-files-<revision>.json`.

Review English and French at widths 320, 360, 390, 768, 1024, 1280, and 1440 in
portrait and landscape. Keep screenshots and accessibility results. Check the
five-task flow: create a note, create a presentation, add a slide, add speech,
and present. Record human screen reader checks separately from browser
accessibility-tree assertions.

The new workflows run on Chromium, Firefox, and WebKit. The separate mobile spec
uses Chromium and WebKit touch input. To repeat the focused checks:

```bash
E2E_PORT=4291 xvfb-run -a env CI=1 npm run test:e2e -- presentation-files.spec.ts presentation-mobile.spec.ts --workers=2
```

To repeat the full browser gate:

```bash
E2E_PORT=4291 xvfb-run -a env CI=1 npm run test:e2e -- --ignore-snapshots --grep-invert "Snapshots visuels" --workers=2
```

The zoom test records CSS zoom separately from browser zoom. It is not a claim
that native browser zoom or a physical phone keyboard was tested.
