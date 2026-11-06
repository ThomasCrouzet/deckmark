# Portable format compatibility

DeckMark has four different version numbers. They do not move together:

| Version | Where it lives | Rule |
| --- | --- | --- |
| Application version | `package.json`, release tags | Identifies a build. It is not a file-format version. |
| Presentation format | `version` inside `<!-- mdsh-presentation` metadata | A change needs a format decision, a version bump and a corpus fixture. |
| Backup schema | `schemaVersion` in `mdsh-backup` JSON | Readers accept the supported schema range and refuse newer schemas. |
| IndexedDB schema | Dexie version in `src/lib/db.ts` | Local database migration. It is not a portable format. |

## Compatibility corpus

`e2e/fixtures/compat/` keeps released and synthetic fixtures. The manifest records
the producer tag and commit, the creation method, the SHA-256 hash and the
expected result. Released entries are serialized with the code from tag `v2.4.0`
at commit `523a946`. Synthetic entries are hand-authored and labeled. Do not
describe a synthetic fixture as historical evidence.

`e2e/format-compat.spec.ts` checks the visible behavior:

- A valid released presentation keeps its exact bytes through save and reload.
- A future presentation version shows the source error and keeps the original bytes.
- A BOM and CRLF note keeps its exact bytes.
- Literal and fenced presentation markers stay ordinary notes.
- Metadata that is not at the end is classified as a presentation and then refused
  with the original source.
- The backup corpus is parsed by the current readers.

`src/lib/presentation/detect.test.ts` checks marker placement independently of a
browser. `src/lib/format-compat.test.ts` checks that each manifest hash matches
the committed bytes.

## Version policy

1. A portable-format change that an older reader cannot understand requires a
   version bump. Add a fixture and the expected-result entry before the change.
2. A reader must refuse a newer format with an actionable message and keep the
   original source available. It must not coerce the file into another kind.
3. Opening a valid file without an edit must not normalize it. A permitted rewrite
   must be documented and asserted.
4. Unknown optional metadata is preserved. If preservation is not possible, refuse
   the file safely and offer the untouched original.
5. A backup schema bump updates `BACKUP_SCHEMA_VERSION`, the parser, the writer
   and the corpus. Older schema readers keep their fixtures.
6. Do not automatically downgrade a file. A conversion is an explicit user action
   with a preview when it can lose information.

## Limits

The corpus proves the listed cases on the tested source. It does not prove that
an older application can edit every future feature. Web and Desktop share the
client code. A cross-edition transfer still needs the tested build on each target.
