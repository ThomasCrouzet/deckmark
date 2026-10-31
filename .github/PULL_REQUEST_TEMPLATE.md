<!-- Complete this template before you request a review. -->

## Summary

<!-- Describe the change in one to three lines. -->

## Why

<!-- Describe the problem or add `Closes #123`. -->

## Notable changes

<!-- List changes to behavior, shortcuts, conventions, or internal APIs. -->

- [ ] Internal API change
- [ ] New keyboard shortcut
- [ ] Markdown / PDF rendering change
- [ ] IndexedDB schema change (⚠️ migration required)
- [ ] CSP change
- [ ] New dependency added

## Test plan

<!-- Select each completed check. -->

- [ ] `npm run check` passes without error
- [ ] `npm run lint` passes without error
- [ ] `npm test` passes without error
- [ ] `npm run build` passes without error
- [ ] Tested manually in Chrome/Safari/Firefox
- [ ] Tested on mobile (DevTools device mode)
- [ ] Focus mode (`⌘⇧.`) still works
- [ ] PDF export works (if relevant)
- [ ] No a11y regression (contrast, keyboard navigation, `aria-*`)

## Screenshots / demo

<!-- If there is a visual change, paste a screenshot or a GIF. -->

## Checklist

- [ ] I followed [CONTRIBUTING.md](https://github.com/ThomasCrouzet/deckmark/blob/main/CONTRIBUTING.md)
- [ ] Comments and identifiers in English; UI strings go through the i18n layer
- [ ] Svelte 5 runes only (no `$:` or legacy reactive `let`)
- [ ] `if (browser)` or `onMount` around any `window`/`localStorage` access
- [ ] No static import of a heavy lib (marked/katex/hljs/mermaid)
- [ ] No network call added
