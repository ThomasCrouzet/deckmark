# Desktop update delivery standby

- Date: 2026-11-04
- Status: accepted
- Owner: Thomas Crouzet

## Context

Issue #247 delivered a signed update boundary. The native layer verifies an
ed25519 signature over the update manifest, rejects tampered, crossed-platform
and older manifests, and never installs an update by itself. The feature is
gated: without a public key and a release base URL, `update_status` reports
`signing-required` and `update_check` returns before any network call.

The project has no release signing key, no Apple Developer ID certificate, no
Windows Authenticode certificate, and no signed release host. These items need
an owner-held private key and identity-verified certificates. They cannot be
created by the application, and an unsigned release cannot be presented as an
authenticated update.

## Decision

Desktop update delivery is on standby.

- The Settings panel does not mount the update section.
- The native commands stay in the binary and keep their tests, so the boundary
  does not regress and a future release can reactivate it.
- The application performs no update request, no manifest fetch, and no
  installation.
- Users update Desktop Complete by downloading a new release and installing it.
- The project does not buy certificates or create release keys while this
  decision is active.

This extends `desktop-signing.md` without changing it. The installers stay
unsigned and the checksum and provenance records stay the verification method.

## Consequences

- No edition shows an update check.
- The update code is dormant. It is not reachable from the interface.
- The release note must not promise update checks.
- The standby state must be recorded in the feature matrix and the update
  policy.

## Reactivation

Reactivation needs all of these:

1. An ed25519 key pair. The private key stays in the release environment. The
   public key becomes `DECKMARK_UPDATE_PUBLIC_KEY` at build time.
2. An HTTPS release host that serves `latest.json` and `latest.json.sig`.
3. A release step that signs the exact manifest bytes.
4. Platform signing certificates if the release must install without an
   operating-system warning.
5. A fresh review of the tests, the manual installation policy, and the rollback
   steps.

Then mount `UpdatePanel.svelte` in the desktop branch of Settings and add a
native smoke check for the configured state.

## Revisit triggers

1. A signing certificate becomes available.
2. Desktop downloads exceed 1,000 in a 90 day period.
3. A security report shows that users cannot verify an installer.
4. A distribution channel requires signed updates.
