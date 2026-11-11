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
    /// Whatever number the settings hold (`config.port || 3333`); the listener refuses one that is
    /// not a port, as Node's `listen` does.
    pub port: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
}

impl Default for WebhookSettings {
    fn default() -> Self {
        Self { enabled: true, port: Value::from(3333), domain: None }
    }
}

/// A JavaScript number as the JSON a settings file holds: an integral value is an integer, a
/// non-finite one is `null` (`JSON.stringify`).
pub fn js_port(n: f64) -> Value {
    if !n.is_finite() {
        Value::Null
    } else if n.fract() == 0.0 && n.abs() < 9.0e15 {
        Value::from(n as i64)
    } else {
        Value::from(n)
    }
}

/// A `setWebhookConfig` patch after its rules were applied (channel-admin.mjs `webhookPatch`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WebhookPatch {
    pub enabled: Option<bool>,
    pub port: Option<Value>,
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
        // `Number(patch.port) || 3333`: any number is kept, NaN and 0 give the default.
        let port = patch.get("port").filter(|p| is_truthy(p)).map(|p| match number(p) {
            Some(n) if !n.is_nan() && n != 0.0 => js_port(n),
            _ => Value::from(3333),
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
        if let Some(port) = &self.port {
            current.port = port.clone();
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
/// `Ok(None)` is Node's `null` (the relay is switched off, or no tunnel has started yet); `Err`
/// is what Node throws (an invalid `MIXDOG_RELAY_URL`, or a read that never ran).
#[async_trait]
pub trait PublicBase: Send + Sync {
    async fn hook_public_base(&self) -> Result<Option<String>, String>;
}

/// The agent runtime the channel runtime keeps in step: providers must be registered before
/// the scheduler's first fire.
#[async_trait]
pub trait AgentRuntime: Send + Sync {
    /// Registers the configured providers; a failure is non-fatal to the start.
    async fn init_providers(&self) -> Result<(), String>;
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
    /// While listening: the service's guard and the port the listener was started on.
    listening: Mutex<Option<(WorkGuard, Value)>>,
    /// Syncs run one at a time.
    gate: mixdog_rt::Gate,
    /// Ends the syncs that began before the last `stop`, so a stop never waits behind a stuck one.
    epoch: Mutex<tokio_util::sync::CancellationToken>,
}

impl WebhookAutomation {
    pub fn new(settings: Arc<dyn ChannelSettings>, service: Arc<WebhookService>, listener: Arc<dyn WebhookListener>) -> Self {
        Self { settings, service, listener, listening: Mutex::new(None), gate: mixdog_rt::Gate::new(), epoch: Mutex::default() }
    }

    fn epoch(&self) -> tokio_util::sync::CancellationToken {
        self.epoch.lock().unwrap().clone()
    }

    /// Cuts short every sync in flight and returns the token of the epoch that starts now.
    fn supersede(&self) -> tokio_util::sync::CancellationToken {
        let mut epoch = self.epoch.lock().unwrap();
        epoch.cancel();
        *epoch = tokio_util::sync::CancellationToken::new();
        epoch.clone()
    }

    async fn sync_turn(&self, reload: bool) -> Result<(), String> {
        let settings = self.settings.webhook().await?;
        if !settings.enabled {
            self.listening.lock().unwrap().take();
            return self.listener.stop().await;
        }
        self.service.set_config(self.settings.webhook_config().await?);
        let bound = self.listening.lock().unwrap().as_ref().map(|(_, port)| port.clone());
        // A listener whose port the reload keeps goes on listening: closing it to bind the same port
        // again would refuse every request arriving in between.
        if bound.as_ref().is_some_and(|port| !reload || *port == settings.port) {
            return Ok(());
        }
        if bound.is_some() {
            // The old listener closes before the new one binds.
            self.listener.stop().await?;
        }
        self.listener.start(&settings).await?;
        *self.listening.lock().unwrap() = Some((self.service.listening(), settings.port.clone()));
        Ok(())
    }

    async fn stop_turn(&self) {
        self.listening.lock().unwrap().take();
        if let Err(error) = self.listener.stop().await {
            tracing::warn!("mixdog channels: webhook listener stop failed: {error}");
        }
    }
}

#[async_trait]
impl AutomationServices for WebhookAutomation {
    async fn sync(&self, reload: bool) -> Result<(), String> {
        // A sync a stop cut short has nothing left to do: the stop closed the listener.
        self.gate.run(&self.epoch(), self.sync_turn(reload)).await.unwrap_or(Ok(()))
    }

    async fn stop(&self) {
        let epoch = self.supersede();
        // Cancelled only by a later stop, which does this teardown, so there is nothing to act on.
        let _ = self.gate.run(&epoch, self.stop_turn()).await;
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
        assert_eq!(patch, WebhookPatch { enabled: Some(false), port: Some(json!(8080)), domain: Some("hooks.example".into()) });
        let nothing = WebhookPatch::from_params(&json!({"port": 0, "domain": ""}));
        assert_eq!(nothing, WebhookPatch::default());
        assert_eq!(WebhookPatch::from_params(&json!({"port": "abc"})).port, Some(json!(3333)));
        // Node keeps any number: `Number(patch.port) || 3333`.
        for (given, kept) in [(json!(70000), json!(70000)), (json!("3.5"), json!(3.5)), (json!(-5), json!(-5)), (json!("1e3"), json!(1000)), (json!("Infinity"), Value::Null)] {
            assert_eq!(WebhookPatch::from_params(&json!({ "port": given })).port, Some(kept), "{given}");
        }
        let applied = WebhookPatch { enabled: Some(false), ..Default::default() }.apply(WebhookSettings::default());
        assert_eq!(applied, WebhookSettings { enabled: false, port: json!(3333), domain: None });
    }
}
