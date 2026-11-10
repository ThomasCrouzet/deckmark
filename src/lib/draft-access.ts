// One lazy boundary for the library body, metadata and draft helpers. The
// store and the metadata index share this module so the offline precache
// keeps one resource instead of three small chunks.
export { applyDraftContent, buildSearchCorpus } from './draft-content';
export { loadDraftLibrary } from './draft-load';
export { MetadataRunner } from './metadata-runner';
// Rare or deferred actions share this lazy boundary so they do not add a
// precache entry for each small helper.
export { findProjectDocument } from './project-link-target';
export { deleteDiscardedWrite } from './save-reverse-delete';
export { runExportMarkdown } from './export-markdown-op';
