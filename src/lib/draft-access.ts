// One lazy boundary for the library body, metadata and draft helpers. The
// store and the metadata index share this module so the offline precache
// keeps one resource instead of three small chunks.
export { applyDraftContent, buildSearchCorpus } from './draft-content';
export { loadDraftLibrary } from './draft-load';
export { MetadataRunner } from './metadata-runner';
export { buildRequest } from './metadata-delta';
// Rare or deferred actions share this lazy boundary so they do not add a
// precache entry for each small helper.
export { resolveProjectLink } from './project-link-target';
export { handleDiscardedWrite } from './save-reverse-delete';
export { exportUnlinkedMarkdown, runExportMarkdown } from './export-markdown-op';
export { exportMarkdown } from './export-ops';
export { openExportSnapshot } from './open-export-snapshot';
