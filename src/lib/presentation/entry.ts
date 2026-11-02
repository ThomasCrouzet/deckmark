// One lazy entry keeps the presentation editor and exports in the offline cache.
export { default } from './SlideEditor.svelte';
export { parsePresentation } from './model';
export { renderPresentationDeck } from './render';
export { buildPresentationHtmlDocument, buildPresentationPrintDocument } from './export';
