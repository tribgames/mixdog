//! The seams of the channel runtime that other packages own: the settings store (WP-CONFIG),
//! the relay's public URL (WP-REMOTE), the HTTP listener (WP-SERVER) and the agent runtime.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::channels::running::WorkGuard;
use crate::webhooks::{WebhookConfig, WebhookService};

/// The webhook receiver's settings (`channels.webhook`), defaults filled in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookSettings {
    pub enabled: bool,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
}

impl Default for WebhookSettings {
    fn default() -> Self {
        Self { enabled: true, port: 3333, domain: None }
    }
}

/// A `setWebhookConfig` patch after its rules were applied (channel-admin.mjs `webhookPatch`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WebhookPatch {
    pub enabled: Option<bool>,
    pub port: Option<u16>,
    pub domain: Option<String>,
}

impl WebhookPatch {
    /// `enabled` only when present (and then only `true` enables); a non-zero `port` (an
    /// unparsable one means 3333); a non-empty trimmed `domain`.
    pub fn from_params(patch: &Value) -> Self {
        let number = |v: &Value| match v {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => Some(mixdog_js::string_to_number(s)),
            Value::Bool(b) => Some(f64::from(u8::from(*b))),
            _ => None,
        };
        let port = patch.get("port").filter(|p| is_truthy(p)).map(|p| {
            number(p).filter(|n| n.is_finite() && *n >= 1.0 && *n <= f64::from(u16::MAX)).map_or(3333, |n| n as u16)
        });
        let domain = patch.get("domain").filter(|d| is_truthy(d)).map(|d| match d {
            Value::String(s) => mixdog_js::js_trim(s).to_string(),
            other => other.to_string(),
        });
        Self { enabled: patch.get("enabled").map(|e| *e == Value::Bool(true)), port, domain }
    }

    pub fn apply(&self, mut current: WebhookSettings) -> WebhookSettings {
        if let Some(enabled) = self.enabled {
            current.enabled = enabled;
        }
        if let Some(port) = self.port {
            current.port = port;
        }
        if let Some(domain) = &self.domain {
            current.domain = Some(domain.clone());
        }
        current
    }
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The `channels` section of the settings file.
#[async_trait]
pub trait ChannelSettings: Send + Sync {
    /// The receiver's settings, defaults filled in.
    async fn webhook(&self) -> Result<WebhookSettings, String>;
    /// Applies `patch` to the stored section (the file keeps only values that differ from the
    /// defaults) and returns the effective settings.
    async fn update_webhook(&self, patch: &WebhookPatch) -> Result<WebhookSettings, String>;
    /// What the receiver verifies deliveries against: the global secret, the unsigned opt-in
    /// and the config-file endpoints.
    async fn webhook_config(&self) -> Result<WebhookConfig, String>;
}

/// The relay tunnel's public base URL, once it has a hook identity (`readHookPublicBase`).
pub trait PublicBase: Send + Sync {
    fn hook_public_base(&self) -> Option<String>;
}

/// The agent runtime the channel runtime keeps in step: providers must be registered before
/// the scheduler's first fire, and `reload_config` refreshes them.
#[async_trait]
pub trait AgentRuntime: Send + Sync {
    /// Registers the configured providers; a failure is non-fatal to the start.
    async fn init_providers(&self) -> Result<(), String>;
    /// Reloads providers, presets and maintenance.
    async fn reload(&self) -> Result<(), String>;
}

/// The webhook listener the transport binds.
#[async_trait]
pub trait WebhookListener: Send + Sync {
    async fn start(&self, settings: &WebhookSettings) -> Result<(), String>;
    async fn stop(&self) -> Result<(), String>;
}

/// The webhook receiver (and its event pipeline) behind the automation runtime: this decides
/// when each one runs.
#[async_trait]
pub trait AutomationServices: Send + Sync {
    /// Starts what the settings call for and stops what they no longer do; `reload` re-listens
    /// on changed settings.
    async fn sync(&self, reload: bool) -> Result<(), String>;
    async fn stop(&self);
}

/// `AutomationServices` for the webhook receiver: while it listens it holds the service's
/// `listening()` guard, so a listening server keeps the core alive.
pub struct WebhookAutomation {
    settings: Arc<dyn ChannelSettings>,
    service: Arc<WebhookService>,
    listener: Arc<dyn WebhookListener>,
    listening: Mutex<Option<WorkGuard>>,
    #[allow(clippy::disallowed_types, reason = "a gate held across the awaited sync on purpose: syncs run one at a time")]
    gate: tokio::sync::Mutex<()>,
}

impl WebhookAutomation {
    #[allow(clippy::disallowed_types, reason = "builds the sync gate")]
    pub fn new(settings: Arc<dyn ChannelSettings>, service: Arc<WebhookService>, listener: Arc<dyn WebhookListener>) -> Self {
        Self { settings, service, listener, listening: Mutex::new(None), gate: tokio::sync::Mutex::new(()) }
    }
}

#[async_trait]
impl AutomationServices for WebhookAutomation {
    async fn sync(&self, reload: bool) -> Result<(), String> {
        let _turn = self.gate.lock().await;
        let settings = self.settings.webhook().await?;
        if !settings.enabled {
            self.listening.lock().unwrap().take();
            return self.listener.stop().await;
        }
        self.service.set_config(self.settings.webhook_config().await?);
        let up = self.listening.lock().unwrap().is_some();
        if up && !reload {
            return Ok(());
        }
        if up {
            // The old listener closes before the new one binds the same port.
            self.listener.stop().await?;
        }
        self.listener.start(&settings).await?;
        *self.listening.lock().unwrap() = Some(self.service.listening());
        Ok(())
    }

    async fn stop(&self) {
        let _turn = self.gate.lock().await;
        self.listening.lock().unwrap().take();
        if let Err(error) = self.listener.stop().await {
            tracing::warn!("mixdog channels: webhook listener stop failed: {error}");
        }
    }
}

/// One signed, test-flagged request to an endpoint's public URL.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeResponse {
    pub status: u16,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProbeError {
    TimedOut,
    Network(String),
}

#[async_trait]
pub trait WebhookProbe: Send + Sync {
    async fn post(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: String,
        timeout: Duration,
    ) -> Result<ProbeResponse, ProbeError>;
}

/// `WebhookProbe` over HTTP.
pub struct ReqwestProbe {
    client: reqwest::Client,
}

impl ReqwestProbe {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl WebhookProbe for ReqwestProbe {
    async fn post(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: String,
        timeout: Duration,
    ) -> Result<ProbeResponse, ProbeError> {
        let mut request = self.client.post(url).timeout(timeout).body(body);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let failure = |e: reqwest::Error| if e.is_timeout() { ProbeError::TimedOut } else { ProbeError::Network(e.to_string()) };
        let response = request.send().await.map_err(failure)?;
        let status = response.status().as_u16();
        // The body read stays inside the same timeout: a timeout while reading is a timeout.
        let body = response.text().await.map_err(failure)?;
        Ok(ProbeResponse { status, body })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn patch_rules_follow_the_admin_helper() {
        let patch = WebhookPatch::from_params(&json!({"enabled": "yes", "port": "8080", "domain": "  hooks.example "}));
        assert_eq!(patch, WebhookPatch { enabled: Some(false), port: Some(8080), domain: Some("hooks.example".into()) });
        let nothing = WebhookPatch::from_params(&json!({"port": 0, "domain": ""}));
        assert_eq!(nothing, WebhookPatch::default());
        assert_eq!(WebhookPatch::from_params(&json!({"port": "abc"})).port, Some(3333));
        let applied = WebhookPatch { enabled: Some(false), ..Default::default() }.apply(WebhookSettings::default());
        assert_eq!(applied, WebhookSettings { enabled: false, port: 3333, domain: None });
    }
}
