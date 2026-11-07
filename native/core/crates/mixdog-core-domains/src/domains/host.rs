//! The `host` domain: what the desktop (the host role) tells the core. `host/claim` itself is
//! taken by the server, which owns the connection registry; the rest lands here.
//!
//! * `host/state/set{key, value}` — desktop-owned state published into section `hostState`
//!   (key `browserTabs`, `browserImport`, `visualize` or `displayPreferences`), replacing the
//!   desktop's `browserRemoteTabs`, `browserRemoteImportProgress`, `visualizeRemote*` and
//!   display-preference publications.
//! * `host/remoteTarget/set{endpoint?, token?}` — the tunnel to an SSH server core that phone
//!   connections are bridged to; absent endpoint = the local core.
//! * `host/power{event}`, `host/update/report{state}` and `host/notification/clicked{threadId}`
//!   notifications.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::host::HostNotificationClickedParams;
use mixdog_app_protocol::v2::host::HostPowerParams;
use mixdog_app_protocol::v2::host::HostRemoteTargetSetParams;
use mixdog_app_protocol::v2::host::HostStateSetParams;
use mixdog_app_protocol::v2::host::HostUpdateReportParams;
use mixdog_app_protocol::v2::host::PowerEvent;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_api::state::StatePublisher;
use mixdog_protocol::SectionName;
use mixdog_remote::registry::DeviceRegistry;
use serde_json::Value;
use serde_json::json;
use url::Host;
use url::Url;

use mixdog_core_base::support::decode;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::wrong_method;
use mixdog_core_base::state::change_of;

/// `hostState` key `remoteViewing`: the sessions a paired device shows, which Node answered per
/// call as `visualizeRemoteViewing` (`viewsSessionLane`). The core owns the fact, so it publishes
/// it and the desktop reads membership instead of asking.
pub fn remote_viewing_value(registry: &DeviceRegistry) -> Value {
    json!({ "sessionIds": registry.shown_sessions() })
}

/// Publishes [`remote_viewing_value`] now and after each change of who is attached or what is
/// shown; ends when the registry is dropped.
pub async fn publish_remote_viewing(registry: std::sync::Weak<DeviceRegistry>, publisher: Arc<dyn StatePublisher>) {
    let Some(first) = registry.upgrade() else { return };
    let mut changes = first.watch();
    drop(first);
    let mut last: Option<Value> = None;
    loop {
        let Some(live) = registry.upgrade() else { return };
        let value = remote_viewing_value(&live);
        drop(live);
        if last.as_ref() != Some(&value) {
            publisher.publish(SectionName::HostState, Some("remoteViewing".to_owned()), change_of(&value));
            last = Some(value);
        }
        if changes.changed().await.is_err() {
            return;
        }
    }
}

/// The SSH server core phone connections are bridged to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteTarget {
    /// `ws://127.0.0.1:<port>/rpc` of the tunnel.
    pub endpoint: String,
    pub token: Option<String>,
}

/// The remote bridge (`remote::bridge`): opens one WebSocket per phone channel to the target
/// and copies frames byte for byte; `None` serves phones from the local core again.
pub trait RemoteBridge: Send + Sync {
    fn set_target(&self, target: Option<RemoteTarget>);
}

/// Consumers of the machine's power events: the relay leg (suspend closes it without error
/// noise, resume reconnects once), WebRTC and the watcher.
pub trait PowerSink: Send + Sync {
    fn power(&self, event: PowerEvent);
}

/// Where the click on a desktop toast is routed: opening the thread, the notification window,
/// sound and remote push (DS §8).
pub trait NotificationClicks: Send + Sync {
    fn clicked(&self, thread: &ThreadId);
}

pub struct HostService {
    publisher: Arc<dyn StatePublisher>,
    bridge: Arc<dyn RemoteBridge>,
    power: Arc<dyn PowerSink>,
    clicks: Arc<dyn NotificationClicks>,
}

impl HostService {
    pub fn new(
        publisher: Arc<dyn StatePublisher>,
        bridge: Arc<dyn RemoteBridge>,
        power: Arc<dyn PowerSink>,
        clicks: Arc<dyn NotificationClicks>,
    ) -> Arc<Self> {
        Arc::new(Self {
            publisher,
            bridge,
            power,
            clicks,
        })
    }

    fn state_set(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let (key, value) = decode::<HostStateSetParams>(req)?.into_parts();
        self.publisher.publish(
            SectionName::HostState,
            Some(key.to_owned()),
            change_of(&value),
        );
        Ok(json!({}))
    }

    fn remote_target_set(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let HostRemoteTargetSetParams { endpoint, token } = decode(req)?;
        let target = match endpoint {
            None => None,
            Some(endpoint) => {
                if !is_tunnel_endpoint(&endpoint) {
                    return Err(invalid("endpoint", "ws://127.0.0.1:<port>/rpc"));
                }
                Some(RemoteTarget { endpoint, token })
            }
        };
        self.bridge.set_target(target);
        Ok(json!({}))
    }
}

/// A `ws://` URL on the loopback interface with a port: the SSH port forward.
fn is_tunnel_endpoint(endpoint: &str) -> bool {
    let Ok(url) = Url::parse(endpoint) else {
        return false;
    };
    let loopback = match url.host() {
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    url.scheme() == "ws" && loopback && url.port().is_some()
}

#[async_trait]
impl DomainService for HostService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let value = match req.method.as_str() {
            "host/state/set" => self.state_set(&req)?,
            "host/remoteTarget/set" => self.remote_target_set(&req)?,
            other => return Err(wrong_method("host", other)),
        };
        Ok(Reply::Value(value))
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "host/state/set",
            "host/remoteTarget/set",
            "host/power",
            "host/update/report",
            "host/notification/clicked",
        ]
    }

    fn notify(&self, method: Method, params: Value, _from: ConnectionId) -> Admit {
        // No reply carries a refusal: params that do not decode are dropped.
        match method.as_str() {
            "host/power" => {
                if let Ok(HostPowerParams { event }) = serde_json::from_value(params) {
                    self.power.power(event);
                }
            }
            "host/update/report" => {
                if let Ok(HostUpdateReportParams { state }) = serde_json::from_value(params) {
                    self.publisher
                        .publish(SectionName::Update, None, change_of(&state));
                }
            }
            "host/notification/clicked" => {
                if let Ok(HostNotificationClickedParams { thread_id }) =
                    serde_json::from_value(params)
                {
                    self.clicks.clicked(&thread_id);
                }
            }
            _ => {}
        }
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests;
