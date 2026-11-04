//! Native AI request boundary for the Desktop Complete edition.
//!
//! The native layer reads the provider key from the vault, sends the request,
//! and returns only the reply text. Error values are stable codes. They never
//! contain the key or the request body.

use crate::vault::{valid_provider_name, SecretStore, VaultState};
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Once;
use std::time::Duration;
use url::{Host, Url};

pub const ERROR_AUTH: &str = "auth";
pub const ERROR_RATE_LIMIT: &str = "rate-limit";
pub const ERROR_SERVER: &str = "server";
pub const ERROR_NETWORK: &str = "network";
pub const ERROR_INVALID_ENDPOINT: &str = "invalid-endpoint";
pub const ERROR_MISSING_KEY: &str = "missing-key";
pub const ERROR_DISABLED: &str = "disabled";

const REQUEST_TIMEOUT_SECONDS: u64 = 60;
const MAX_TOKENS_LIMIT: u32 = 32_768;

/// Configuration for one native chat request. The key is not a field.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiNativeConfig {
    pub enabled: bool,
    pub base_url: String,
    pub model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub provider: String,
}

impl fmt::Debug for AiNativeConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The base URL can contain credentials or a token in the query. Show
        // only the scheme, host, port, and path.
        formatter
            .debug_struct("AiNativeConfig")
            .field("enabled", &self.enabled)
            .field("base_url", &redacted_endpoint(&self.base_url))
            .field("model", &self.model)
            .field("temperature", &self.temperature)
            .field("max_tokens", &self.max_tokens)
            .field("provider", &self.provider)
            .finish()
    }
}

/// One chat message. The role and content pass through unchanged.
#[derive(Clone, Deserialize, Serialize)]
pub struct AiMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
struct ChatBody<'a> {
    model: &'a str,
    messages: &'a [AiMessage],
    temperature: f64,
    max_tokens: u32,
    stream: bool,
}

#[derive(Deserialize)]
struct ChatCompletion {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Deserialize)]
struct ChatMessage {
    content: Option<String>,
}

/// A validated request. The key stays inside this structure and in the client.
pub struct PreparedRequest {
    url: Url,
    body: Value,
    secret: String,
}

impl fmt::Debug for PreparedRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedRequest")
            .field("url", &self.url.as_str())
            .field("body", &"<redacted>")
            .field("secret", &"<redacted>")
            .finish()
    }
}

fn redacted_endpoint(value: &str) -> String {
    match Url::parse(value.trim()) {
        Ok(url) => {
            let mut shown = format!("{}://{}", url.scheme(), url.host_str().unwrap_or("<none>"));
            if let Some(port) = url.port() {
                shown.push_str(&format!(":{port}"));
            }
            shown.push_str(url.path());
            shown
        }
        Err(_) => "<redacted>".to_string(),
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address == Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(address)) => address == Ipv6Addr::LOCALHOST,
        None => false,
    }
}

/// Validates a provider base URL and returns the chat completions endpoint.
///
/// `https` is allowed for any host. `http` is allowed only for `127.0.0.1`,
/// `localhost`, and `[::1]`. User information, fragments, and other schemes
/// are rejected. A non-standard port is allowed.
pub fn endpoint_for(base_url: &str) -> Result<Url, String> {
    let mut url = Url::parse(base_url.trim()).map_err(|_| ERROR_INVALID_ENDPOINT.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ERROR_INVALID_ENDPOINT.to_string());
    }
    if url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host().is_none()
    {
        return Err(ERROR_INVALID_ENDPOINT.to_string());
    }
    if url.scheme() == "http" && !is_loopback(&url) {
        return Err(ERROR_INVALID_ENDPOINT.to_string());
    }
    let path = url.path().trim_end_matches('/');
    url.set_path(&format!("{path}/chat/completions"));
    Ok(url)
}

fn request_body(config: &AiNativeConfig, messages: &[AiMessage]) -> Value {
    serde_json::to_value(ChatBody {
        model: &config.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        stream: false,
    })
    .unwrap_or(Value::Null)
}

fn validate_config(config: &AiNativeConfig) -> Result<(), String> {
    if !config.enabled {
        return Err(ERROR_DISABLED.to_string());
    }
    if config.model.trim().is_empty()
        || !(0.0..=2.0).contains(&config.temperature)
        || !(1..=MAX_TOKENS_LIMIT).contains(&config.max_tokens)
    {
        return Err(ERROR_INVALID_ENDPOINT.to_string());
    }
    Ok(())
}

/// Reads the key from the vault and builds the request. An invalid provider or
/// a missing key fails closed with `missing-key`.
pub fn prepare_request(
    store: &dyn SecretStore,
    config: &AiNativeConfig,
    messages: &[AiMessage],
) -> Result<PreparedRequest, String> {
    validate_config(config)?;
    let url = endpoint_for(&config.base_url)?;
    if !valid_provider_name(&config.provider) {
        return Err(ERROR_MISSING_KEY.to_string());
    }
    let secret = match store.get_secret(&config.provider) {
        Ok(Some(secret)) if !secret.is_empty() => secret,
        _ => return Err(ERROR_MISSING_KEY.to_string()),
    };
    Ok(PreparedRequest {
        url,
        body: request_body(config, messages),
        secret,
    })
}

/// Maps an HTTP status to a stable code. No response text is included.
pub fn status_error(status: u16) -> &'static str {
    match status {
        401 | 403 => ERROR_AUTH,
        429 => ERROR_RATE_LIMIT,
        _ => ERROR_SERVER,
    }
}

static INSTALL_PROVIDER: Once = Once::new();

fn ensure_crypto_provider() {
    INSTALL_PROVIDER.call_once(|| {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
    });
}

/// Builds the blocking client. Redirects stay disabled.
pub fn build_client() -> Result<Client, String> {
    ensure_crypto_provider();
    Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .redirect(Policy::none())
        .build()
        .map_err(|_| ERROR_NETWORK.to_string())
}

/// Sends a prepared request and returns only the reply text.
pub fn execute(client: &Client, prepared: PreparedRequest) -> Result<String, String> {
    let response = client
        .post(prepared.url.clone())
        .bearer_auth(&prepared.secret)
        .json(&prepared.body)
        .send()
        .map_err(|_| ERROR_NETWORK.to_string())?;
    if !response.status().is_success() {
        return Err(status_error(response.status().as_u16()).to_string());
    }
    let completion: ChatCompletion = response.json().map_err(|_| ERROR_SERVER.to_string())?;
    completion
        .choices
        .first()
        .and_then(|choice| choice.message.content.clone())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| ERROR_SERVER.to_string())
}

#[tauri::command]
pub fn ai_chat(
    state: tauri::State<'_, VaultState>,
    config: AiNativeConfig,
    messages: Vec<AiMessage>,
) -> Result<String, String> {
    let prepared = prepare_request(state.store(), &config, &messages)?;
    let client = build_client()?;
    execute(&client, prepared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::MemoryStore;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    fn config(base_url: &str) -> AiNativeConfig {
        AiNativeConfig {
            enabled: true,
            base_url: base_url.to_string(),
            model: "test-model".to_string(),
            temperature: 0.2,
            max_tokens: 128,
            provider: "openai".to_string(),
        }
    }

    fn messages() -> Vec<AiMessage> {
        vec![AiMessage {
            role: "user".to_string(),
            content: "Hello".to_string(),
        }]
    }

    fn store_with_secret(secret: &str) -> MemoryStore {
        let store = MemoryStore::default();
        store.set_secret("openai", secret).unwrap();
        store
    }

    #[test]
    fn endpoint_validation_matrix() {
        for allowed in [
            "https://api.openai.com/v1",
            "https://api.example.com:8443/v1",
            "https://api.example.com/v1?api-version=2024-01-01",
            "http://127.0.0.1:11434/v1",
            "http://localhost:8080/v1",
            "http://[::1]:8080/v1",
        ] {
            assert!(endpoint_for(allowed).is_ok(), "{allowed} must be allowed");
        }
        for rejected in [
            "",
            "api.example.com/v1",
            "ftp://api.example.com/v1",
            "file:///etc/passwd",
            "https://user:secret@api.example.com/v1",
            "https://user@api.example.com/v1",
            "https://api.example.com/v1#fragment",
            "http://api.example.com/v1",
            "http://192.168.0.1/v1",
            "http://10.0.0.1/v1",
            "http://127.0.0.2/v1",
            "http://[::2]/v1",
        ] {
            assert_eq!(
                endpoint_for(rejected).unwrap_err(),
                ERROR_INVALID_ENDPOINT,
                "{rejected} must be rejected"
            );
        }
    }

    #[test]
    fn endpoint_appends_the_completions_path() {
        assert_eq!(
            endpoint_for("https://api.example.com/v1/")
                .unwrap()
                .as_str(),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint_for("http://127.0.0.1:11434").unwrap().as_str(),
            "http://127.0.0.1:11434/chat/completions"
        );
        assert_eq!(
            endpoint_for("https://api.example.com/v1?api-version=1")
                .unwrap()
                .as_str(),
            "https://api.example.com/v1/chat/completions?api-version=1"
        );
    }

    #[test]
    fn request_body_uses_the_openai_compatible_shape() {
        let store = store_with_secret("sk-test");
        let mut settings = config("https://api.example.com/v1");
        settings.temperature = 0.7;
        settings.max_tokens = 256;
        let prepared = prepare_request(&store, &settings, &messages()).unwrap();
        assert_eq!(
            prepared.body,
            json!({
                "model": "test-model",
                "messages": [{ "role": "user", "content": "Hello" }],
                "temperature": 0.7,
                "max_tokens": 256,
                "stream": false
            })
        );
        assert_eq!(
            prepared.url.as_str(),
            "https://api.example.com/v1/chat/completions"
        );
    }

    #[test]
    fn missing_key_fails_closed() {
        let empty = MemoryStore::default();
        assert_eq!(
            prepare_request(&empty, &config("https://api.example.com/v1"), &messages())
                .unwrap_err(),
            ERROR_MISSING_KEY
        );

        let store = store_with_secret("");
        assert_eq!(
            prepare_request(&store, &config("https://api.example.com/v1"), &messages())
                .unwrap_err(),
            ERROR_MISSING_KEY
        );

        let mut invalid_provider = config("https://api.example.com/v1");
        invalid_provider.provider = "Bad Provider".to_string();
        assert_eq!(
            prepare_request(&store, &invalid_provider, &messages()).unwrap_err(),
            ERROR_MISSING_KEY
        );
    }

    #[test]
    fn disabled_configuration_sends_nothing() {
        let store = store_with_secret("sk-test");
        let mut settings = config("https://api.example.com/v1");
        settings.enabled = false;
        assert_eq!(
            prepare_request(&store, &settings, &messages()).unwrap_err(),
            ERROR_DISABLED
        );
    }

    #[test]
    fn status_codes_map_to_stable_codes() {
        assert_eq!(status_error(401), ERROR_AUTH);
        assert_eq!(status_error(403), ERROR_AUTH);
        assert_eq!(status_error(429), ERROR_RATE_LIMIT);
        assert_eq!(status_error(400), ERROR_SERVER);
        assert_eq!(status_error(500), ERROR_SERVER);
        assert_eq!(status_error(503), ERROR_SERVER);
    }

    fn response_server(status: u16, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut received = Vec::new();
                let mut buffer = [0_u8; 1024];
                while !received.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => received.extend_from_slice(&buffer[..read]),
                    }
                }
                let response = format!(
                    "HTTP/1.1 {status} Test\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        format!("http://{address}/v1")
    }

    #[test]
    fn a_failed_response_does_not_include_the_secret_or_the_body() {
        let secret = "sk-redaction-test-secret";
        let store = store_with_secret(secret);
        let base_url = response_server(500, "{\"error\":\"upstream detail\"}");
        let prepared = prepare_request(&store, &config(&base_url), &messages()).unwrap();
        assert!(!format!("{prepared:?}").contains(secret));
        assert!(!format!("{prepared:?}").contains("Hello"));
        let error = execute(&build_client().unwrap(), prepared).unwrap_err();
        assert_eq!(error, ERROR_SERVER);
        assert!(!error.contains(secret));
        assert!(!error.contains("upstream detail"));
    }

    #[test]
    fn a_successful_response_returns_only_the_reply_text() {
        let store = store_with_secret("sk-test-secret");
        let base_url = response_server(
            200,
            "{\"choices\":[{\"message\":{\"content\":\"native reply\"}}]}",
        );
        let prepared = prepare_request(&store, &config(&base_url), &messages()).unwrap();
        let reply = execute(&build_client().unwrap(), prepared).unwrap();
        assert_eq!(reply, "native reply");
    }

    #[test]
    fn auth_failure_returns_the_auth_code_without_the_secret() {
        let store = store_with_secret("sk-auth-secret");
        let base_url = response_server(401, "{\"error\":\"invalid key sk-auth-secret\"}");
        let prepared = prepare_request(&store, &config(&base_url), &messages()).unwrap();
        let error = execute(&build_client().unwrap(), prepared).unwrap_err();
        assert_eq!(error, ERROR_AUTH);
        assert!(!error.contains("sk-auth-secret"));
    }

    #[test]
    fn config_debug_output_redacts_credentials_in_the_url() {
        let mut settings = config("https://user:sk-url-secret@api.example.com/v1?token=sk-query");
        settings.provider = "openai".to_string();
        let debug = format!("{settings:?}");
        assert!(!debug.contains("sk-url-secret"));
        assert!(!debug.contains("sk-query"));
        assert!(debug.contains("api.example.com"));
    }

    #[test]
    fn vault_state_is_shared_with_the_ai_boundary() {
        let vault = VaultState::with_store(Arc::new(store_with_secret("sk-shared")));
        let prepared = prepare_request(
            vault.store(),
            &config("https://api.example.com/v1"),
            &messages(),
        );
        assert!(prepared.is_ok());
    }
}
