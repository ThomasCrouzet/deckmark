# Desktop update delivery

DeckMark still publishes unsigned Desktop installers. This document records the
update policy, the manifest contract, and the steps that must happen before the
update feature can be enabled.

## Current state

Update checks are disabled. The application reports `signing-required` and does
not contact any server. Automatic installation does not exist: the
`update_install` command always returns `manual-install-required`.

This matches `docs/decisions/desktop-signing.md`.

## Prerequisites for enabling updates

1. An Apple Developer ID certificate for macOS, an Authenticode certificate for
   Windows, and a signed package for Linux.
2. An ed25519 key pair. The private key stays in the release environment. Only
   the public key is embedded in the desktop build.
3. A release host that serves the manifest and the packages over HTTPS.
4. A release process that signs the exact manifest bytes and publishes the
   SHA-256 checksum next to every package.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DECKMARK_UPDATE_PUBLIC_KEY` | Base64 ed25519 public key compiled into the desktop build. |
| `DECKMARK_UPDATE_BASE_URL` | HTTPS base URL that serves `latest.json` and `latest.json.sig`. |
| `DECKMARK_UPDATE_CHANNEL` | `beta` by default; `stable` for a stable channel. |

When the public key is missing, the update panel shows that updates are
disabled. When it is present, the panel shows the key fingerprint and a manual
check button.

## Manifest contract

```json
{
  "schemaVersion": 1,
  "version": "2.4.0",
  "channel": "beta",
  "platform": "macos-aarch64",
  "url": "https://releases.example/deckmark_2.4.0_aarch64.dmg",
  "sha256": "hex encoded SHA-256 of the package",
  "notes": "Release notes"
}
```

The signature covers the exact UTF-8 bytes of the manifest.

## Verification rules

The native layer rejects:

- a missing or invalid signature;
- a manifest that is not schema version 1;
- a malformed version, channel, checksum or URL;
- a platform that differs from the running installation;
- a version that is not strictly newer than the installed version.

`https://` URLs are accepted. `http://` is accepted only for `127.0.0.1`,
`localhost` and `[::1]`, which the tests use. User information, fragments and
redirects are rejected.

## Installation and rollback

The application never installs an update by itself. The user copies the
verified package URL, installs the signed package with the operating system,
and keeps the previous installer until the new version starts correctly. A
failed or cancelled installation therefore leaves the previous installation
intact. The manifest and package checksums provide the recovery record.

## Web Light

Web Light contains no updater, no update check and no network request. The
settings panel renders the update section only in the desktop edition, and the
native commands exist only in the Rust binary.

## Tests

```sh
cargo test --manifest-path src-tauri/Cargo.toml update::
```

The tests cover signature validation, tampering, cross-platform manifests,
version ordering, endpoint validation, redaction of the key, and the
manual-install gate.
