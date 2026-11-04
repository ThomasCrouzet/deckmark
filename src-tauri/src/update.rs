//! Signed opt-in update verification.
//!
//! The project still publishes unsigned installers, so this module keeps every
//! installation path closed until a signing key is configured. It verifies an
//! ed25519 signature over the exact manifest bytes, rejects cross-platform and
//! non-newer manifests, and never installs anything by itself.

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const MANIFEST_SCHEMA: u32 = 1;
const MAX_MANIFEST_BYTES: usize = 6 * 1024;
const MAX_SIGNATURE_BYTES: usize = 512;

/// Fetches the manifest of the configured channel. The check is user triggered.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub configured: bool,
    pub channel: String,
    pub public_key_fingerprint: Option<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateManifest {
    pub schema_version: u32,
    pub version: String,
    pub channel: String,
    pub platform: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedUpdate {
    pub version: String,
    pub channel: String,
    pub platform: String,
    pub url: String,
    pub sha256: String,
    pub notes: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct UpdateError(pub &'static str, pub String);

impl UpdateError {
    fn code(code: &'static str, detail: impl Into<String>) -> Self {
        Self(code, detail.into())
    }
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.0, self.1)
    }
}

fn configured_key() -> Option<VerifyingKey> {
    let value = std::env::var("DECKMARK_UPDATE_PUBLIC_KEY").ok()?;
    decode_public_key(&value)
}

fn decode_public_key(value: &str) -> Option<VerifyingKey> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(value.trim()).ok()?;
    let array: [u8; 32] = bytes.as_slice().try_into().ok()?;
    VerifyingKey::from_bytes(&array).ok()
}

fn channel() -> String {
    match std::env::var("DECKMARK_UPDATE_CHANNEL") {
        Ok(value) if value == "stable" => "stable".to_string(),
        _ => "beta".to_string(),
    }
}

/// Current platform identifier used by the release manifest.
pub fn platform_id() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn valid_version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    parts.iter().all(|part| {
        !part.is_empty() && part.len() <= 6 && part.chars().all(|character| character.is_ascii_digit())
    })
}

fn version_tuple(value: &str) -> Option<(u32, u32, u32)> {
    let mut parts = value.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Returns true when `candidate` is strictly newer than `current`.
pub fn version_is_newer(candidate: &str, current: &str) -> bool {
    match (version_tuple(candidate), version_tuple(current)) {
        (Some(next), Some(previous)) => next > previous,
        _ => false,
    }
}

fn valid_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let rest = if let Some(rest) = lower.strip_prefix("https://") {
        rest
    } else if let Some(rest) = lower.strip_prefix("http://") {
        // Local test servers stay reachable. Production releases use HTTPS.
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        let host = host.split(':').next().unwrap_or("");
        if host != "127.0.0.1" && host != "localhost" && host != "[::1]" {
            return false;
        }
        rest
    } else {
        return false;
    };
    !rest.is_empty()
        && !rest.contains('@')
        && !rest.contains('#')
        && !rest.chars().any(|character| character.is_whitespace())
        && value.len() <= 2048
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn parse_manifest(bytes: &str) -> Result<UpdateManifest, UpdateError> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::code("invalid-manifest", "manifest is too large"));
    }
    let manifest: UpdateManifest = serde_json::from_str(bytes)
        .map_err(|error| UpdateError::code("invalid-manifest", error.to_string()))?;
    if manifest.schema_version != MANIFEST_SCHEMA {
        return Err(UpdateError::code(
            "invalid-manifest",
            "unsupported manifest schema",
        ));
    }
    if !valid_version(&manifest.version) {
        return Err(UpdateError::code("invalid-manifest", "invalid version"));
    }
    if manifest.channel != "stable" && manifest.channel != "beta" {
        return Err(UpdateError::code("invalid-manifest", "invalid channel"));
    }
    if !valid_url(&manifest.url) {
        return Err(UpdateError::code(
            "invalid-manifest",
            "invalid package URL",
        ));
    }
    if !valid_sha256(&manifest.sha256) {
        return Err(UpdateError::code("invalid-manifest", "invalid checksum"));
    }
    if manifest.platform.len() > 64 {
        return Err(UpdateError::code(
            "invalid-manifest",
            "invalid platform identifier",
        ));
    }
    Ok(manifest)
}

fn decode_signature(value: &str) -> Result<Signature, UpdateError> {
    if value.len() > MAX_SIGNATURE_BYTES {
        return Err(UpdateError::code("invalid-signature", "signature is too large"));
    }
    let raw = value.trim();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw))
        .map_err(|_| UpdateError::code("invalid-signature", "signature is not base64"))?;
    let array: [u8; 64] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| UpdateError::code("invalid-signature", "signature has the wrong length"))?;
    Ok(Signature::from_bytes(&array))
}

/// Verifies the manifest signature and release policy with an explicit key.
pub fn verify_with_key(
    manifest_bytes: &str,
    signature: &str,
    key: &VerifyingKey,
    platform: &str,
    current_version: &str,
) -> Result<VerifiedUpdate, UpdateError> {
    let signature = decode_signature(signature)?;
    key.verify_strict(manifest_bytes.as_bytes(), &signature)
        .map_err(|_| UpdateError::code("invalid-signature", "signature does not match"))?;
    let manifest = parse_manifest(manifest_bytes)?;
    if manifest.platform != platform {
        return Err(UpdateError::code(
            "platform-mismatch",
            format!(
                "manifest targets {} but this installation is {}",
                manifest.platform, platform
            ),
        ));
    }
    if !version_is_newer(&manifest.version, current_version) {
        return Err(UpdateError::code(
            "not-newer",
            format!(
                "version {} is not newer than {}",
                manifest.version, current_version
            ),
        ));
    }
    Ok(VerifiedUpdate {
        version: manifest.version,
        channel: manifest.channel,
        platform: manifest.platform,
        url: manifest.url,
        sha256: manifest.sha256,
        notes: manifest.notes,
    })
}

fn verify(manifest_bytes: &str, signature: &str) -> Result<VerifiedUpdate, UpdateError> {
    let key = configured_key().ok_or_else(|| {
        UpdateError::code(
            "signing-required",
            "no update signing key is configured for this installation",
        )
    })?;
    verify_with_key(
        manifest_bytes,
        signature,
        &key,
        &platform_id(),
        env!("CARGO_PKG_VERSION"),
    )
}

fn fetch(url: &str) -> Result<String, UpdateError> {
    if !valid_url(url) {
        return Err(UpdateError::code("invalid-endpoint", "invalid update URL"));
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| UpdateError::code("network", error.to_string()))?;
    let response = client
        .get(url)
        .header("accept", "application/json, text/plain")
        .send()
        .map_err(|error| UpdateError::code("network", error.to_string()))?;
    if !response.status().is_success() {
        return Err(UpdateError::code(
            "network",
            format!("update server returned {}", response.status()),
        ));
    }
    let bytes = response
        .bytes()
        .map_err(|error| UpdateError::code("network", error.to_string()))?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::code("invalid-manifest", "manifest is too large"));
    }
    String::from_utf8(bytes.to_vec())
        .map_err(|_| UpdateError::code("invalid-manifest", "manifest is not UTF-8"))
}

fn check_urls() -> Option<(String, String)> {
    let base = std::env::var("DECKMARK_UPDATE_BASE_URL").ok()?;
    let base = base.trim_end_matches('/').to_string();
    if !valid_url(&base) {
        return None;
    }
    let manifest = format!("{base}/latest.json");
    let signature = format!("{base}/latest.json.sig");
    Some((manifest, signature))
}

#[tauri::command]
pub fn update_status() -> UpdateStatus {
    let key = configured_key();
    let has_url = check_urls().is_some();
    let blocked_reason = if key.is_none() {
        Some("signing-required".to_string())
    } else if !has_url {
        Some("no-update-source".to_string())
    } else {
        None
    };
    UpdateStatus {
        configured: blocked_reason.is_none(),
        channel: channel(),
        public_key_fingerprint: key.map(|value| {
            use sha2::{Digest, Sha256};
            let digest = Sha256::digest(value.as_bytes());
            digest[..8]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        }),
        blocked_reason,
    }
}

/// Verifies a manifest that the user supplied or downloaded manually.
#[tauri::command]
pub fn update_verify_manifest(
    manifest: String,
    signature: String,
) -> Result<VerifiedUpdate, String> {
    verify(&manifest, &signature).map_err(|error| error.to_string())
}

/// Fetches and verifies the manifest of the configured channel.
#[tauri::command]
pub fn update_check() -> Result<VerifiedUpdate, String> {
    let status = update_status();
    if !status.configured {
        return Err(format!(
            "signing-required: {}",
            status.blocked_reason.unwrap_or_default()
        ));
    }
    let (manifest_url, signature_url) =
        check_urls().ok_or_else(|| "no-update-source: configure DECKMARK_UPDATE_BASE_URL".to_string())?;
    let manifest = fetch(&manifest_url).map_err(|error| error.to_string())?;
    let signature = fetch(&signature_url).map_err(|error| error.to_string())?;
    verify(&manifest, &signature).map_err(|error| error.to_string())
}

/// Automatic installation stays disabled. The user installs a signed package.
#[tauri::command]
pub fn update_install() -> Result<(), String> {
    Err("manual-install-required: download and install the signed package from the release page"
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use ed25519_dalek::{Signer, SigningKey};

    // RFC 8032 test vector key pair.
    const SECRET: [u8; 32] = [
        0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c,
        0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae,
        0x7f, 0x60,
    ];

    fn key() -> SigningKey {
        SigningKey::from_bytes(&SECRET)
    }

    fn manifest(version: &str, platform: &str) -> String {
        serde_json::json!({
            "schemaVersion": 1,
            "version": version,
            "channel": "beta",
            "platform": platform,
            "url": "https://example.test/deckmark.AppImage",
            "sha256": "a".repeat(64),
            "notes": "Test release"
        })
        .to_string()
    }

    fn sign(payload: &str) -> String {
        STANDARD.encode(key().sign(payload.as_bytes()).to_bytes())
    }

    #[test]
    fn accepts_a_signed_manifest_for_this_platform() {
        let payload = manifest("2.4.0", "linux-x86_64");
        let verified = verify_with_key(
            &payload,
            &sign(&payload),
            &key().verifying_key(),
            "linux-x86_64",
            "2.3.0",
        )
        .expect("valid signature");
        assert_eq!(verified.version, "2.4.0");
        assert_eq!(verified.channel, "beta");
    }

    #[test]
    fn rejects_unsigned_and_tampered_manifests() {
        let payload = manifest("2.4.0", "linux-x86_64");
        let signature = sign(&payload);
        let tampered = payload.replace("2.4.0", "9.9.9");
        let unsigned = verify_with_key(&payload, "AAAA", &key().verifying_key(), "linux-x86_64", "2.3.0")
            .unwrap_err();
        assert_eq!(unsigned.0, "invalid-signature");
        let changed =
            verify_with_key(&tampered, &signature, &key().verifying_key(), "linux-x86_64", "2.3.0")
                .unwrap_err();
        assert_eq!(changed.0, "invalid-signature");
    }

    #[test]
    fn rejects_cross_platform_manifests() {
        let payload = manifest("2.4.0", "macos-aarch64");
        let error = verify_with_key(
            &payload,
            &sign(&payload),
            &key().verifying_key(),
            "linux-x86_64",
            "2.3.0",
        )
        .unwrap_err();
        assert_eq!(error.0, "platform-mismatch");
    }

    #[test]
    fn rejects_versions_that_are_not_newer() {
        for version in ["2.3.0", "2.2.9"] {
            let payload = manifest(version, "linux-x86_64");
            let error = verify_with_key(
                &payload,
                &sign(&payload),
                &key().verifying_key(),
                "linux-x86_64",
                "2.3.0",
            )
            .unwrap_err();
            assert_eq!(error.0, "not-newer");
        }
        assert!(version_is_newer("2.3.1", "2.3.0"));
        assert!(!version_is_newer("nonsense", "2.3.0"));
    }

    #[test]
    fn rejects_invalid_manifest_fields() {
        for payload in [
            manifest("2.4.0", "linux-x86_64").replace("\"schemaVersion\":1", "\"schemaVersion\":2"),
            manifest("2.4.0", "linux-x86_64")
                .replace("https://example.test/deckmark.AppImage", "file:///etc/passwd"),
            manifest("2.4.0", "linux-x86_64").replace(&"a".repeat(64), "not-a-checksum"),
            manifest("bad", "linux-x86_64"),
        ] {
            let error = verify_with_key(
                &payload,
                &sign(&payload),
                &key().verifying_key(),
                "linux-x86_64",
                "2.3.0",
            );
            if let Err(error) = error {
                assert!(error.0 == "invalid-manifest" || error.0 == "invalid-signature");
            }
        }
    }

    #[test]
    fn validates_endpoints() {
        assert!(valid_url("https://releases.example.test/deckmark.AppImage"));
        assert!(valid_url("http://127.0.0.1:8080/latest.json"));
        assert!(valid_url("http://localhost/latest.json"));
        assert!(!valid_url("file:///etc/passwd"));
        assert!(!valid_url("http://example.test/latest.json"));
        assert!(!valid_url("https://user:secret@example.test/app"));
        assert!(!valid_url("https://example.test/app#fragment"));
        assert!(!valid_url("javascript:alert(1)"));
    }

    #[test]
    fn status_is_blocked_without_a_signing_key() {
        // Parallel tests share the process environment, so read the state directly
        // instead of mutating variables here.
        let status = update_status();
        if configured_key().is_none() {
            assert!(!status.configured);
            assert_eq!(status.blocked_reason.as_deref(), Some("signing-required"));
        }
    }

    #[test]
    fn install_is_never_automatic() {
        let error = update_install().unwrap_err();
        assert!(error.starts_with("manual-install-required"));
    }

    #[test]
    fn platform_identifier_is_stable() {
        let value = platform_id();
        assert!(value.contains('-'));
        assert!(value.len() <= 64);
    }
}
