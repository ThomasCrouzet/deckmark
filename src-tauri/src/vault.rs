//! Native credential vault for the Desktop Complete edition.
//!
//! The operating system credential store holds provider secrets. A command can
//! write, test, or delete a secret. No command returns a secret value.

use keyring::Entry;
use std::sync::Arc;

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Mutex;

/// Service name used in the operating system credential store.
const SERVICE: &str = "io.github.thomascrouzet.deckmark.ai";
/// Maximum secret length in bytes.
pub const MAX_SECRET_BYTES: usize = 8_192;
/// Maximum provider name length in characters.
const MAX_PROVIDER_BYTES: usize = 64;

pub const ERROR_INVALID_PROVIDER: &str = "invalid-provider";
pub const ERROR_INVALID_SECRET: &str = "invalid-secret";
pub const ERROR_VAULT: &str = "vault";

/// Returns true when the provider name matches `^[a-z0-9._-]{1,64}$`.
pub(crate) fn valid_provider_name(provider: &str) -> bool {
    let length = provider.len();
    (1..=MAX_PROVIDER_BYTES).contains(&length)
        && provider.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn valid_secret(secret: &str) -> bool {
    !secret.is_empty() && secret.len() <= MAX_SECRET_BYTES
}

/// Secret storage used by the vault commands.
pub trait SecretStore: Send + Sync {
    fn set_secret(&self, provider: &str, secret: &str) -> Result<(), String>;
    fn get_secret(&self, provider: &str) -> Result<Option<String>, String>;
    fn delete_secret(&self, provider: &str) -> Result<(), String>;
}

/// Operating system credential store implementation.
pub struct KeyringStore;

impl SecretStore for KeyringStore {
    fn set_secret(&self, provider: &str, secret: &str) -> Result<(), String> {
        let entry = Entry::new(SERVICE, provider).map_err(|_| ERROR_VAULT.to_string())?;
        entry
            .set_password(secret)
            .map_err(|_| ERROR_VAULT.to_string())
    }

    fn get_secret(&self, provider: &str) -> Result<Option<String>, String> {
        let entry = Entry::new(SERVICE, provider).map_err(|_| ERROR_VAULT.to_string())?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(ERROR_VAULT.to_string()),
        }
    }

    fn delete_secret(&self, provider: &str) -> Result<(), String> {
        let entry = Entry::new(SERVICE, provider).map_err(|_| ERROR_VAULT.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(ERROR_VAULT.to_string()),
        }
    }
}

/// In-memory store for tests on machines without a credential service.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    secrets: Mutex<HashMap<String, String>>,
}

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn set_secret(&self, provider: &str, secret: &str) -> Result<(), String> {
        self.secrets
            .lock()
            .map_err(|_| ERROR_VAULT.to_string())?
            .insert(provider.to_string(), secret.to_string());
        Ok(())
    }

    fn get_secret(&self, provider: &str) -> Result<Option<String>, String> {
        Ok(self
            .secrets
            .lock()
            .map_err(|_| ERROR_VAULT.to_string())?
            .get(provider)
            .cloned())
    }

    fn delete_secret(&self, provider: &str) -> Result<(), String> {
        self.secrets
            .lock()
            .map_err(|_| ERROR_VAULT.to_string())?
            .remove(provider);
        Ok(())
    }
}

/// Application state for the vault commands.
pub struct VaultState {
    store: Arc<dyn SecretStore>,
}

impl Default for VaultState {
    fn default() -> Self {
        Self {
            store: Arc::new(KeyringStore),
        }
    }
}

impl VaultState {
    #[cfg(test)]
    pub fn with_store(store: Arc<dyn SecretStore>) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &dyn SecretStore {
        self.store.as_ref()
    }

    /// Writes or replaces a secret. The secret value is not returned.
    pub fn set(&self, provider: &str, secret: &str) -> Result<(), String> {
        if !valid_provider_name(provider) {
            return Err(ERROR_INVALID_PROVIDER.to_string());
        }
        if !valid_secret(secret) {
            return Err(ERROR_INVALID_SECRET.to_string());
        }
        self.store.set_secret(provider, secret)
    }

    /// Reports whether a secret exists. The secret value is not returned.
    pub fn status(&self, provider: &str) -> Result<bool, String> {
        if !valid_provider_name(provider) {
            return Err(ERROR_INVALID_PROVIDER.to_string());
        }
        Ok(self
            .store
            .get_secret(provider)?
            .is_some_and(|secret| !secret.is_empty()))
    }

    /// Deletes a secret. Deleting a missing secret succeeds.
    pub fn clear(&self, provider: &str) -> Result<(), String> {
        if !valid_provider_name(provider) {
            return Err(ERROR_INVALID_PROVIDER.to_string());
        }
        self.store.delete_secret(provider)
    }
}

#[tauri::command]
pub fn vault_set(
    state: tauri::State<'_, VaultState>,
    provider: String,
    secret: String,
) -> Result<(), String> {
    state.set(&provider, &secret)
}

#[tauri::command]
pub fn vault_status(state: tauri::State<'_, VaultState>, provider: String) -> Result<bool, String> {
    state.status(&provider)
}

#[tauri::command]
pub fn vault_delete(state: tauri::State<'_, VaultState>, provider: String) -> Result<(), String> {
    state.clear(&provider)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_state() -> VaultState {
        VaultState::with_store(Arc::new(MemoryStore::default()))
    }

    #[test]
    fn secret_lifecycle_uses_the_store_without_returning_the_value() {
        let vault = memory_state();
        let provider = "openai";
        let secret = "sk-test-secret-value";

        assert!(!vault.status(provider).unwrap());
        vault.set(provider, secret).unwrap();
        assert!(vault.status(provider).unwrap());
        assert_eq!(
            vault.store().get_secret(provider).unwrap().as_deref(),
            Some(secret)
        );

        vault.set(provider, "sk-replaced").unwrap();
        assert!(vault.status(provider).unwrap());
        assert_eq!(
            vault.store().get_secret(provider).unwrap().as_deref(),
            Some("sk-replaced")
        );

        vault.clear(provider).unwrap();
        assert!(!vault.status(provider).unwrap());
        vault.clear(provider).unwrap();
        assert!(!vault.status(provider).unwrap());
    }

    #[test]
    fn provider_names_are_validated() {
        for valid in [
            "a",
            "openai",
            "api.openai.com",
            "local_1",
            "x-y",
            &"a".repeat(64),
        ] {
            assert!(valid_provider_name(valid), "{valid} must be valid");
        }
        for invalid in [
            "",
            "OpenAI",
            "a b",
            "api/openai",
            "api:openai",
            "é",
            &"a".repeat(65),
        ] {
            assert!(!valid_provider_name(invalid), "{invalid} must be rejected");
        }

        let vault = memory_state();
        assert_eq!(
            vault.set("Bad Name", "secret").unwrap_err(),
            ERROR_INVALID_PROVIDER
        );
        assert_eq!(
            vault.status("Bad Name").unwrap_err(),
            ERROR_INVALID_PROVIDER
        );
        assert_eq!(vault.clear("Bad Name").unwrap_err(), ERROR_INVALID_PROVIDER);
    }

    #[test]
    fn secret_length_is_limited_and_errors_do_not_echo_the_secret() {
        let vault = memory_state();
        let long = "s".repeat(MAX_SECRET_BYTES + 1);
        let error = vault.set("openai", &long).unwrap_err();
        assert_eq!(error, ERROR_INVALID_SECRET);
        assert!(!error.contains(&long));

        let maximum = "s".repeat(MAX_SECRET_BYTES);
        vault.set("openai", &maximum).unwrap();
        assert!(vault.status("openai").unwrap());
        assert_eq!(vault.set("openai", "").unwrap_err(), ERROR_INVALID_SECRET);
    }

    #[test]
    fn status_reports_presence_only() {
        let vault = memory_state();
        vault.set("openai", "sk-test-secret-value").unwrap();
        let status: bool = vault.status("openai").unwrap();
        assert!(status);
        assert!(!format!("{status}").contains("sk-test-secret-value"));
    }

    #[test]
    fn command_signatures_never_return_a_secret() {
        // These assignments fail to compile if a command returns the secret.
        let _set: for<'a> fn(tauri::State<'a, VaultState>, String, String) -> Result<(), String> =
            vault_set;
        let _status: for<'a> fn(tauri::State<'a, VaultState>, String) -> Result<bool, String> =
            vault_status;
        let _delete: for<'a> fn(tauri::State<'a, VaultState>, String) -> Result<(), String> =
            vault_delete;
    }
}
