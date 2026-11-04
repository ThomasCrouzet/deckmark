# Desktop update delivery

Update delivery is on standby. DeckMark publishes unsigned Desktop installers,
and the application does not check for updates. This document records the
policy, the manifest contract, and the steps that must happen before a future
release can reactivate the feature.

## Current state

- Settings does not show an update section.
- The application performs no update request and contacts no update server.
- Automatic installation does not exist: the `update_install` command always
  returns `manual-install-required`.
- The native commands and their tests stay in the binary, so the boundary does
  not regress. `update_status` reports `signing-required` because no public key
  is configured.
- Users update Desktop Complete by downloading and installing a new release.

This matches `docs/decisions/desktop-signing.md` and
`docs/decisions/desktop-updates-standby.md`.

## Reactivation prerequisites

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

These variables are used only after the standby decision is lifted. When the
public key is missing, the native boundary stays closed. When it is present, a
future release can show the key fingerprint and a manual check button again.

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

## Standby checks

```sh
cargo test --manifest-path src-tauri/Cargo.toml update::
```

The tests cover signature validation, tampering, cross-platform manifests,
version ordering, endpoint validation, and the manual-install gate. The native
smoke also asserts that the settings dialog has no update panel and that
`update_install` is rejected. `e2e/update-gate.spec.ts` asserts that Web Light
has no update panel and sends no external request.
