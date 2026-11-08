//! The four ports of the channel runtime that had only test fakes: the `channels` settings
//! section, the relay's public base, the agent runtime and the webhook listener.
//!
//! Node: `session-runtime/services/channel-admin.mjs` (`normalizeChannelsConfig`,
//! `setWebhookConfigAsync`), `runtime/channels/lib/webhook/relay-tunnel.mjs` (`readHookPublicBase`),
//! `runtime/channels/lib/tool-dispatch.mjs` (`reload_config`),
//! `owned-runtime/automation-services.mjs` (the webhook server's start and stop).
//! The recorded Node run of the settings writer is `fixtures/channel-settings/golden.json`
//! (`record-channel-settings.mjs`).

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_ai::registry::ProviderRegistry;
use mixdog_core_config::config::{Config, ConfigError};
use mixdog_rt::{CancellationToken, DurabilityIo};
use mixdog_services::channels::ports::{WebhookPatch, WebhookSettings};
use mixdog_services::channels::{AgentRuntime, ChannelSettings, PublicBase};
use mixdog_services::webhooks::handler::{WebhookConfig, WebhookService};
use mixdog_services::webhooks::lifecycle::{TunnelStarter, WebhookServer};
use mixdog_services::webhooks::relay::{hook_public_base, resolve_relay_url};
use serde_json::{Map, Value};

const DEFAULT_PORT: u16 = 3333;
const IDENTITY_FILE: &str = "relay-hook-device.json";

/// `CHANNELS_DEFAULTS.webhook` filled under what the file stores, in Node's key order.
fn effective_webhook(channels: &Map<String, Value>) -> Map<String, Value> {
    let mut webhook = Map::new();
    webhook.insert("enabled".into(), Value::Bool(true));
    webhook.insert("port".into(), Value::from(DEFAULT_PORT));
    if let Some(stored) = channels.get("webhook").and_then(Value::as_object) {
        for (key, value) in stored {
            webhook.insert(key.clone(), value.clone());
        }
    }
    webhook
}

/// JavaScript truthiness of a stored value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `net.listen(port)`: a number must be an integer below 65536 (Node's `ERR_SOCKET_BAD_PORT`
/// text), a numeric string is that port.
fn listen_port(port: &Value) -> Result<u16, String> {
    match port {
        Value::Number(n) => n
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .ok_or_else(|| format!("listen error: options.port should be >= 0 and < 65536. Received type number ({n})")),
        Value::String(s) => s.trim().parse::<u16>().map_err(|_| format!("listen error: invalid port {s}")),
        other => Err(format!("listen error: invalid port {other}")),
    }
}

/// What the receiver reads of its settings: it runs when `enabled === true`, on `port || 3333`.
fn settings_of(webhook: &Map<String, Value>) -> WebhookSettings {
    let port = match webhook.get("port") {
        Some(port) if truthy(port) => port.clone(),
        _ => Value::from(DEFAULT_PORT),
    };
    let domain = webhook.get("domain").and_then(Value::as_str).filter(|d| !d.is_empty()).map(str::to_owned);
    WebhookSettings { enabled: webhook.get("enabled") == Some(&Value::Bool(true)), port, domain }
}

/// The `channels` section of the live config (`readSection('channels')`).
pub struct ConfigChannelSettings {
    config: Config,
}

impl ConfigChannelSettings {
    pub fn new(config: Config) -> Self {
        Self { config }
    }

    fn channels(&self) -> Map<String, Value> {
        self.config.get("channels").and_then(|v| v.as_object().cloned()).unwrap_or_default()
    }
}

#[async_trait]
impl ChannelSettings for ConfigChannelSettings {
    async fn webhook(&self) -> Result<WebhookSettings, String> {
        Ok(settings_of(&effective_webhook(&self.channels())))
    }

    /// `setWebhookConfigAsync(patch)`: one read-modify-write of the section. The file keeps only
    /// what differs from the defaults (`stripChannelsDefaults`), `webhook` first; the section is
    /// written even when nothing is left (`updateSectionAsync` stores `{}`).
    async fn update_webhook(&self, patch: &WebhookPatch) -> Result<WebhookSettings, String> {
        let patch = patch.clone();
        let applied: Arc<Mutex<Option<WebhookSettings>>> = Arc::default();
        let slot = applied.clone();
        self.config
            .update(move |doc: &mut Map<String, Value>| {
                let mut stored = doc.get("channels").and_then(Value::as_object).cloned().unwrap_or_default();
                // canonicalizeStoredChannelsConfig
                stored.shift_remove("promptInjection");
                stored.shift_remove("schedules");
                let mut webhook = effective_webhook(&stored);
                if let Some(enabled) = patch.enabled {
                    webhook.insert("enabled".into(), Value::Bool(enabled));
                }
                if let Some(port) = patch.port {
                    webhook.insert("port".into(), port.clone());
                }
                if let Some(domain) = &patch.domain {
                    webhook.insert("domain".into(), Value::String(domain.clone()));
                }
                *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(settings_of(&webhook));
                // withoutDefaults
                if webhook.get("enabled") == Some(&Value::Bool(true)) {
                    webhook.shift_remove("enabled");
                }
                if webhook.get("port") == Some(&Value::from(DEFAULT_PORT)) {
                    webhook.shift_remove("port");
                }
                stored.shift_remove("webhook");
                let mut persisted = Map::new();
                if !webhook.is_empty() {
                    persisted.insert("webhook".into(), Value::Object(webhook));
                }
                persisted.extend(stored);
                doc.insert("channels".into(), Value::Object(persisted));
                Ok::<(), ConfigError>(())
            })
            .await
            .map_err(|error| error.to_string())?;
        let settings = applied.lock().unwrap_or_else(PoisonError::into_inner).take();
        settings.ok_or_else(|| "the channels settings update did not run".to_owned())
    }

    /// `config.secret`, `config.allowUnsignedWebhooks` and `config.endpoints` of the section.
    async fn webhook_config(&self) -> Result<WebhookConfig, String> {
        serde_json::from_value(Value::Object(self.channels())).map_err(|error| error.to_string())
    }
}

/// `readHookPublicBase()`: the relay's `/hook/<deviceId>` base once a tunnel has persisted an
/// identity; nothing is created here.
pub struct HookIdentityBase {
    lane: DurabilityIo,
    data_dir: PathBuf,
    /// `MIXDOG_RELAY_URL`, read by the composition root (the tunnel starter's own value).
    relay_url_env: Option<String>,
}

impl HookIdentityBase {
    pub fn new(lane: DurabilityIo, data_dir: PathBuf, relay_url_env: Option<String>) -> Self {
        Self { lane, data_dir, relay_url_env }
    }
}

#[async_trait]
impl PublicBase for HookIdentityBase {
    async fn hook_public_base(&self) -> Result<Option<String>, String> {
        let Some(relay_url) = resolve_relay_url(self.relay_url_env.as_deref())? else { return Ok(None) };
        let path = self.data_dir.join(IDENTITY_FILE);
        let read = mixdog_core_base::support::on_lane(self.lane, &CancellationToken::new(), move |_| mixdog_statefile::read_content(&path))
            .await
            .map_err(|error| error.to_string())?;
        // Node's `catch`: an unreadable or unparsable identity is "the tunnel has not started yet".
        let Some(bytes) = read.ok().flatten() else { return Ok(None) };
        let identity: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        match identity.get("deviceId").and_then(Value::as_str).filter(|id| !id.is_empty()) {
            Some(id) => hook_public_base(&relay_url, id).map(Some),
            None => Ok(None),
        }
    }
}

/// The channel runtime's view of the agent runtime: the start registers the providers of the live
/// config (`initProviders(agentConfig.providers || {})`). `reload_config` leaves them alone, as
/// the worker's `MIXDOG_STANDALONE=1` does (`tool-dispatch.mjs:66`).
pub struct RegistryAgentRuntime {
    config: Config,
    registry: Arc<ProviderRegistry>,
}

impl RegistryAgentRuntime {
    pub fn new(config: Config, registry: Arc<ProviderRegistry>) -> Self {
        Self { config, registry }
    }
}

#[async_trait]
impl AgentRuntime for RegistryAgentRuntime {
    async fn init_providers(&self) -> Result<(), String> {
        let providers = self.config.agent().get("providers").and_then(Value::as_object).cloned().unwrap_or_default();
        self.registry.init_providers(&providers).await.map_err(|error| error.to_string())
    }
}

/// The webhook receiver's listener and relay tunnel, started on the configured port.
pub struct ServerListener {
    service: Arc<WebhookService>,
    tunnels: Arc<dyn TunnelStarter>,
    server: Mutex<Option<WebhookServer>>,
}

impl ServerListener {
    pub fn new(service: Arc<WebhookService>, tunnels: Arc<dyn TunnelStarter>) -> Self {
        Self { service, tunnels, server: Mutex::new(None) }
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<WebhookServer>> {
        self.server.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[async_trait]
impl mixdog_services::channels::WebhookListener for ServerListener {
    async fn prepare(&self, cancel: &CancellationToken) -> Result<(), String> {
        self.tunnels.prepare(cancel).await
    }

    async fn start(&self, settings: &WebhookSettings, cancel: &CancellationToken) -> Result<(), String> {
        let mut server = WebhookServer::new(self.service.clone(), self.tunnels.clone(), listen_port(&settings.port)?);
        server.start(cancel).await?;
        // `WebhookAutomation` stops a running listener before it starts another; a server left in
        // the slot would keep its port, so it is stopped here too.
        let replaced = self.slot().replace(server);
        if let Some(mut old) = replaced {
            old.stop().await;
        }
        Ok(())
    }

    async fn stop(&self) -> Result<(), String> {
        let server = self.slot().take();
        if let Some(mut server) = server {
            server.stop().await;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "channel_stack_tests.rs"]
mod tests;
