# Desktop signing decision

- Date: 2026-10-31
- Status: accepted for version 2.1.0
- Owner: Thomas Crouzet

## Current state

The Desktop Beta installers are unsigned. macOS can show a Gatekeeper warning.
Windows can show a SmartScreen warning. Each release publishes the SHA-256 values,
the npm and Cargo SBOM files, and a build provenance attestation. The application
uses Tauri, and the build runs in the project GitHub Actions workflow.

The stable source release and the `desktop-v*` prerelease stay separate. The web
PWA remains the primary distribution path.

## Decision

Version 2.1.0 does not add code signing. The project keeps the current unsigned
Desktop Beta and the published checksum and provenance records. This decision
avoids a recurring certificate cost before the project has a measured download
base and a support process for installation warnings.

## Consequences

- Users must verify the checksum and accept the operating-system warning.
- The project cannot claim a warning-free desktop installation.
- macOS notarization and Windows Authenticode remain open work.
- The release note must repeat the unsigned installer limit.

## Revisit trigger

Revisit this decision when one of these conditions is true:

1. A signing certificate is available for Apple Developer ID or Windows
   Authenticode.
2. Desktop downloads exceed 1,000 in a 90 day period.
3. A security report shows that users cannot verify an installer.
4. The project publishes a desktop build outside GitHub Releases.
5. A distribution channel requires a signed installer.

Record the certificate owner, cost, rotation plan, and notarization steps before
the change. Add the signed build to the `desktop-v*` prerelease first.
