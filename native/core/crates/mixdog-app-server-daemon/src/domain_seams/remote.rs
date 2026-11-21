use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::state::StatePublisher;
use mixdog_core_domains::domains::host::publish_remote_viewing;
use mixdog_core_domains::domains::pc_access::PcAccessEvents;
use mixdog_js::js_trim;
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::Origin;
use mixdog_protocol::SectionName;
use mixdog_remote::access::AccessSettings;
use mixdog_remote::access::LegLink;
use mixdog_remote::access::PairWiring;
use mixdog_remote::access::RemoteEvents;
use mixdog_remote::access::RemoteRuntime;
use mixdog_remote::access::RuntimeConfig;
use mixdog_remote::bridge::DialError;
use mixdog_remote::bridge::Dialer;
use mixdog_remote::bridge::Upstream;
use mixdog_remote::bridge::local::Accept;
use mixdog_remote::bridge::local::LocalDialer;
use mixdog_remote::leg::validated_relay_url;
use mixdog_remote::registry::DeviceRegistry;
use mixdog_remote::registry::LocalKind;
use mixdog_remote::section::RemoteSection;
use mixdog_remote::section::RemoteSectionValue;
use mixdog_rt::DurabilityIo;
use mixdog_rt::TaskClass;
use serde_json::Value;

use crate::pair_code::ComposedPairCodeEffects;

type LatePublishState = (Option<Arc<dyn StatePublisher>>, Vec<(SectionName, Option<String>, SectionChange)>);

/// The `StatePublisher` of `compose_domains` (`ComposedDomains::state.publisher`), which exists
/// only after the runtime did: publications made before [`bind`](Self::bind) are kept and
/// delivered in order when it is bound.
#[derive(Default)]
pub struct LatePublisher {
    state: Mutex<LatePublishState>,
}

impl LatePublisher {
    pub fn bind(&self, publisher: Arc<dyn StatePublisher>) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        for (section, key, change) in state.1.drain(..) {
            publisher.publish(section, key, change);
        }
        state.0 = Some(publisher);
    }
}

impl StatePublisher for LatePublisher {
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        match state.0.clone() {
            Some(publisher) => publisher.publish(section, key, change),
            None => state.1.push((section, key, change)),
        }
    }
}

/// The dialer for a phone served by this core: the in-process [`LocalDialer`] over the server's
/// connection hub, bound once the server exists. A phone dialing before that is refused.
#[derive(Default)]
pub struct LateDialer(OnceLock<LocalDialer>);

impl mixdog_core::run_host::late::Bound for LateDialer {
    fn cell(&self) -> &'static str {
        "local dialer"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

impl LateDialer {
    /// `accept` hands an accepted connection to the server's drive loop (`spawn_drive`).
    pub fn bind(&self, hub: ConnectionHub, accept: Accept, devices: Arc<DeviceRegistry>) -> Result<(), &'static str> {
        self.0.set(LocalDialer::new(hub, accept, devices)).map_err(|_| "the local dialer is already bound")
    }
}

#[async_trait]
impl Dialer for LateDialer {
    async fn dial(&self, peer_id: &str) -> Result<Box<dyn Upstream>, DialError> {
        self.0.get().ok_or(DialError)?.dial(peer_id).await
    }

    async fn dial_open(&self, peer_id: &str, generation: u64) -> Result<Box<dyn Upstream>, DialError> {
        self.0.get().ok_or(DialError)?.dial_open(peer_id, generation).await
    }
}

/// Visualize changes to the phones that view the session: one `visualize/changed` notification per payload on each connection's control
/// queue, the connections chosen once for the whole change so a phone has all of an event's parts or none.
pub struct VisualizeNotifications {
    pub notifier: Arc<dyn mixdog_core_api::ConnectionNotifier>,
    pub registry: Arc<DeviceRegistry>,
}

impl mixdog_exthost::VisualizePush for VisualizeNotifications {
    fn push(&self, _session_id: &str, everyone: bool, payloads: Vec<serde_json::Value>) {
        for connection in self.registry.visualize_connections(everyone) {
            for payload in &payloads {
                if self.notifier.notify(ConnectionId(connection), mixdog_core_api::ids::Method("visualize/changed"), payload.clone()).is_err() {
                    break;
                }
            }
        }
    }

    fn set_lane(&self, connection: ConnectionId, on: bool) {
        self.registry.set_visualize_lane(connection.0, on);
    }
}

/// One line into the daemon log.
pub type LogLine = Arc<dyn Fn(&str) + Send + Sync>;

pub struct SectionEvents {
    cleanup: OnceLock<Arc<dyn DeviceCleanup>>,
    pc_access: OnceLock<Arc<dyn PcAccessEvents>>,
    app_feed: OnceLock<mixdog_core_config::config::Announcer>,
    log: OnceLock<LogLine>,
}

/// What the services holding a device's state drop when it is unpaired. Bound once they exist (they are built after the runtime).
pub trait DeviceCleanup: Send + Sync {
    /// Before the relay is asked: the device's file grants and transfers end.
    fn unpaired(&self, credential_id: &str);
    /// The relay handle closed: every phone download ends (`remote-relay.ts` `close`, `fileDownloads.revokeAll`).
    fn relay_closed(&self);
    /// After the relay confirmed: the device's notification preferences go.
    fn forgotten<'a>(&'a self, credential_id: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>>;
}

impl SectionEvents {
    pub fn new() -> Self {
        Self { cleanup: OnceLock::new(), pc_access: OnceLock::new(), app_feed: OnceLock::new(), log: OnceLock::new() }
    }

    /// The daemon log: each phone socket's close is written there with the code and reason the relay read.
    pub fn bind_log(&self, log: LogLine) -> Result<(), &'static str> {
        self.log.set(log).map_err(|_| "the daemon log is already bound")
    }

    pub fn bind(&self, cleanup: Arc<dyn DeviceCleanup>) -> Result<(), &'static str> {
        self.cleanup.set(cleanup).map_err(|_| "the device cleanup is already bound")
    }

    /// PC access, built after the runtime: a delivered key is enrolled, an owed revocation is revoked.
    pub fn bind_pc_access(&self, pc_access: Arc<dyn PcAccessEvents>) -> Result<(), &'static str> {
        self.pc_access.set(pc_access).map_err(|_| "PC access is already bound")
    }

    /// The app feed, built after the runtime: a frame the relay refused is announced on it (`ui/relayPayloadRefused`).
    pub fn bind_app_feed(&self, app_feed: mixdog_core_config::config::Announcer) -> Result<(), &'static str> {
        self.app_feed.set(app_feed).map_err(|_| "the app feed is already bound")
    }
}

impl Default for SectionEvents {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteEvents for SectionEvents {
    fn controller_key_delivered(&self, public_key: &str) {
        if let Some(pc_access) = self.pc_access.get() {
            pc_access.key_delivered(public_key);
        }
    }

    fn owed_access_changed(&self) {
        if let Some(pc_access) = self.pc_access.get() {
            pc_access.owed_changed();
        }
    }

    fn device_unpaired(&self, credential_id: &str) {
        if let Some(cleanup) = self.cleanup.get() {
            cleanup.unpaired(credential_id);
        }
    }

    fn relay_closed(&self) {
        if let Some(cleanup) = self.cleanup.get() {
            cleanup.relay_closed();
        }
    }

    fn device_forgotten<'a>(&'a self, credential_id: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        match self.cleanup.get() {
            Some(cleanup) => cleanup.forgotten(credential_id),
            None => Box::pin(async {}),
        }
    }

    fn relay_payload_refused(&self, bytes: Option<u64>, limit: Option<u64>) {
        tracing::warn!(?bytes, ?limit, "the relay refused an oversize frame");
        if let Some(app_feed) = self.app_feed.get() {
            app_feed("ui/relayPayloadRefused", serde_json::json!({ "bytes": bytes, "limit": limit }));
        }
    }

    fn status(&self, value: Value) {
        tracing::warn!(%value, "remote access relay status");
    }

    fn phone_left(&self, client_id: &str, code: Option<u16>, reason: &str) {
        let Some(log) = self.log.get() else { return };
        let client: String = client_id.chars().take(8).collect();
        let code = code.map_or_else(|| "none".to_owned(), |code| code.to_string());
        let reason: String = reason.chars().take(60).collect();
        log(&format!("phone leg closed client={client} code={code} reason={reason:?}"));
    }
}

/// `os.hostname()`.
#[cfg(unix)]
fn host_name() -> String {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is 256 bytes and gethostname writes at most that many.
    let status = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    if status != 0 {
        return String::new();
    }
    let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}

/// Packaged default of the desktop pairing relay (`DEFAULT_RELAY_URL`, `remote-relay-device.ts`).
const DEFAULT_RELAY_URL: &str = "wss://192-255-139-161.sslip.io";

/// `resolveRelayUrl(env)` of `remote-relay-device.ts` over `MIXDOG_RELAY_URL`: `Ok(None)` when
/// switched off (`0`, `false`, `off`), the validated URL otherwise; the error is the desktop's
/// sentence (not the webhook tunnel's, which words them differently).
pub fn resolve_relay_url(raw: Option<&str>) -> Result<Option<String>, String> {
    let raw = js_trim(raw.unwrap_or_default());
    if matches!(raw.to_lowercase().as_str(), "0" | "false" | "off") {
        return Ok(None);
    }
    let raw = if raw.is_empty() { DEFAULT_RELAY_URL } else { raw };
    validated_relay_url(raw).map(|url| Some(url.to_string())).map_err(|error| error.to_string())
}
pub struct RemoteInputs {
    /// The remote-access files directory (`<data>/remote`, where the migration puts 1.4.5's).
    pub dir: PathBuf,
    /// A 1.4.5 activation stamp moved into `remote.activatedAt` by profile migration.
    pub migrated_activation: bool,
    /// `MIXDOG_RELAY_URL` as read from the environment.
    pub relay_env: Option<String>,
    /// `(version, build)` of this install.
    pub app_version: (String, Option<String>),
    pub durability: DurabilityIo,
    pub dialer: Arc<LateDialer>,
    pub publisher: Arc<LatePublisher>,
}

/// The runtime and the pieces other services share with it.
pub struct BuiltRemote {
    pub runtime: Arc<RemoteRuntime>,
    /// The one device registry: `RemoteAccessService`, `RegistryDevices`, `ScreenSessions` and the
    /// server's connection table take this same `Arc`.
    pub registry: Arc<DeviceRegistry>,
    /// Where the services that hold a device's state bind their cleanup for an unpair.
    pub events: Arc<SectionEvents>,
}

/// Records a local client under what it stated. Returns the device name `connection`'s actions are stamped with: a paired relay
/// peer's is the name it was paired under, whatever its client stated.
pub fn register_local(registry: &DeviceRegistry, connection: ConnectionId, origin: Origin, device: &str, kind: ConnectionKind) -> String {
    let local = match kind {
        _ if origin == Origin::Relay => None,
        ConnectionKind::Desktop => Some(LocalKind::Desktop),
        ConnectionKind::Tui => Some(LocalKind::Tui),
        ConnectionKind::Cli => Some(LocalKind::Cli),
        ConnectionKind::ChannelBridge => Some(LocalKind::ChannelBridge),
        ConnectionKind::Phone | ConnectionKind::RemoteDesktop => None,
    };
    if let Some(kind) = local {
        registry.connect_local(connection.0, device, kind);
    }
    registry.describe(connection.0).map_or_else(|| device.to_owned(), |described| described.device)
}

/// The paired credential a connection acts as, for the phone file grants (SPEC.md R44, DS 4.7): that of a relay peer attached after
/// its handshake. A local client, whatever device name or kind it states, and a peer whose pairing ended have none.
pub fn phone_credential(registry: Arc<DeviceRegistry>) -> Arc<dyn Fn(ConnectionId) -> Option<String> + Send + Sync> {
    Arc::new(move |connection| registry.describe(connection.0).map(|described| described.credential).filter(|credential| !credential.is_empty()))
}

/// Whether a connection is revoked for the screen for its lifetime: a relay peer that was live at an unpair of its device, or admitted
/// while one was in force. It keeps its credential and everything but the screen (`screen-access-publisher.ts` `revoked`).
pub fn screen_revoked(registry: Arc<DeviceRegistry>) -> Arc<dyn Fn(ConnectionId) -> bool + Send + Sync> {
    Arc::new(move |connection| registry.screen_revoked(connection.0))
}

/// Whether a connection is a relay peer still attached: Node's client registry still holds it (`sendEncryptedFrame` sends it frames).
pub fn peer_attached(registry: Arc<DeviceRegistry>) -> Arc<dyn Fn(ConnectionId) -> bool + Send + Sync> {
    Arc::new(move |connection| registry.peer_attached(connection.0))
}

pub async fn start_remote(remote: &BuiltRemote, publisher: Arc<dyn StatePublisher>) {
    mixdog_rt::spawn("remote-viewing", TaskClass::Work, publish_remote_viewing(Arc::downgrade(&remote.registry), publisher));
    if let Err(error) = remote.runtime.prepare().await {
        tracing::warn!(%error, "remote access roster did not load");
    }
    if let Err(error) = remote.runtime.start(false).await {
        tracing::warn!(%error, "remote access did not start");
    }
}

/// `os.hostname()`.
#[cfg(windows)]
fn host_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}
/// §F steps 1 and 2. `Err` is the relay URL's sentence (`MIXDOG_RELAY_URL is invalid`, …).
pub fn build_remote(inputs: RemoteInputs) -> Result<BuiltRemote, String> {
    let relay_url = resolve_relay_url(inputs.relay_env.as_deref())?;
    let registry = Arc::new(DeviceRegistry::default());
    let events = Arc::new(SectionEvents::new());
    let section = Arc::new(RemoteSection::new(inputs.publisher, RemoteSectionValue::default()));
    let settings = Arc::new(AccessSettings::new(inputs.dir.clone(), Arc::new(host_name)).with_migrated_activation(inputs.migrated_activation));
    let runtime = RemoteRuntime::new(
        RuntimeConfig {
            dir: inputs.dir,
            relay_url,
            app_version: Some(inputs.app_version),
            durability: inputs.durability,
            dialer: inputs.dialer,
            registry: registry.clone(),
            section,
            settings,
            link: LegLink::default(),
            events: events.clone(),
        },
        Box::new(|wiring: PairWiring| Box::new(ComposedPairCodeEffects::new(wiring.publish, mixdog_rt::ticker().clone(), wiring.on_tick, wiring.leg))),
    );
    Ok(BuiltRemote { runtime: Arc::new(runtime), registry, events })
}
/// The services that hold a paired device's state, as `remote-relay.ts` `revokeClient` reaches them: the one-file grants, the
/// transfers of the device's connections and its notification preferences.
/// The live view once it is composed; empty until then.
pub type LiveViewCell = Arc<std::sync::OnceLock<std::sync::Weak<crate::live_view::LiveViewService>>>;

pub struct PairedDeviceCleanup {
    pub grants: Arc<mixdog_workspace::grants::GrantStore>,
    pub registry: Arc<DeviceRegistry>,
    /// Ends the transfers a connection (named by its id) owns.
    pub end_transfers: Arc<dyn Fn(&str) + Send + Sync>,
    /// Ends every phone download (the relay closed).
    pub end_downloads: Arc<dyn Fn() + Send + Sync>,
    pub config: mixdog_core_config::config::Config,
    /// The live view, once built (it is composed after this cleanup is bound): an unpair ends the device's browser streams, the
    /// relay's close every phone's.
    pub live_view: LiveViewCell,
}
impl PairedDeviceCleanup {
    fn live_view(&self) -> Option<Arc<crate::live_view::LiveViewService>> {
        self.live_view.get().and_then(std::sync::Weak::upgrade)
    }
}
impl DeviceCleanup for PairedDeviceCleanup {
    fn unpaired(&self, credential_id: &str) {
        self.grants.revoke_device(credential_id);
        let live_view = self.live_view();
        for connection in self.registry.connections_of(credential_id) {
            (self.end_transfers)(&connection.to_string());
            if let Some(live_view) = &live_view {
                live_view.unpaired(ConnectionId(connection));
            }
        }
    }

    fn relay_closed(&self) {
        (self.end_downloads)();
        self.grants.relay_closed();
        if let Some(live_view) = self.live_view() {
            live_view.relay_closed();
        }
    }

    fn forgotten<'a>(&'a self, credential_id: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            // `removeDevice`: this PC's own entry stays, and a device with none stored has nothing to drop.
            let Some(Value::Object(mut devices)) = self.config.get("notifications.devices") else { return };
            if credential_id == "pc" || devices.shift_remove(credential_id).is_none() {
                return;
            }
            let _ = self.config.write("notifications.devices", Value::Object(devices), mixdog_protocol::ConfigWriteMode::Replace).await;
        })
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test lays out its fixture files with blocking calls on the test thread")]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Default)]
    struct Seen(Mutex<Vec<(SectionName, Option<String>)>>);

    impl StatePublisher for Seen {
        fn publish(&self, section: SectionName, key: Option<String>, _change: SectionChange) {
            self.0.lock().unwrap().push((section, key));
        }
    }

    #[test]
    fn publications_before_the_bind_are_delivered_in_order_at_the_bind() {
        let late = LatePublisher::default();
        late.publish(SectionName::HostState, Some("a".into()), SectionChange::Removed);
        late.publish(SectionName::HostState, Some("b".into()), SectionChange::Removed);
        let seen = Arc::new(Seen::default());
        late.bind(seen.clone());
        late.publish(SectionName::HostState, Some("c".into()), SectionChange::Removed);
        let keys: Vec<_> = seen.0.lock().unwrap().iter().map(|(_, key)| key.clone().unwrap()).collect();
        assert_eq!(keys, ["a", "b", "c"]);
    }

    #[test]
    fn a_refused_relay_frame_is_announced_on_the_app_feed_with_its_sizes() {
        let events = SectionEvents::new();
        // Before the bind there is nowhere to announce: nothing happens.
        events.relay_payload_refused(Some(1), Some(2));
        let seen: Arc<Mutex<Vec<(&'static str, Value)>>> = Arc::default();
        let sink = seen.clone();
        events.bind_app_feed(Arc::new(move |method, params| sink.lock().unwrap().push((method, params)))).unwrap();
        assert!(events.bind_app_feed(Arc::new(|_, _| {})).is_err());
        events.relay_payload_refused(Some(70_000_000), None);
        assert_eq!(*seen.lock().unwrap(), [("ui/relayPayloadRefused", serde_json::json!({ "bytes": 70_000_000, "limit": null }))]);
    }

    #[test]
    fn a_phone_leaving_writes_the_relays_close_code_and_reason_to_the_daemon_log() {
        let events = SectionEvents::new();
        let lines: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = lines.clone();
        events.bind_log(Arc::new(move |line| sink.lock().unwrap().push(line.to_owned()))).unwrap();
        events.phone_left("0123456789abcdef", Some(4000), "keepalive unanswered");
        events.phone_left("fedcba98", None, "");
        assert_eq!(
            *lines.lock().unwrap(),
            ["phone leg closed client=01234567 code=4000 reason=\"keepalive unanswered\"", "phone leg closed client=fedcba98 code=none reason=\"\"",]
        );
    }

    #[tokio::test]
    async fn a_phone_dialing_before_the_server_exists_is_refused() {
        assert!(LateDialer::default().dial("peer").await.is_err());
    }

    #[test]
    fn the_relay_url_resolves_to_the_default_off_a_normalized_url_or_the_refusal() {
        const DEFAULT: &str = "wss://192-255-139-161.sslip.io/";
        const SCHEME: &str = "MIXDOG_RELAY_URL must use wss://; ws:// is allowed only for loopback development.";
        const CREDENTIALS: &str = "MIXDOG_RELAY_URL must not contain credentials.";
        // What a relay URL setting resolves to: the URL, none, or the refusal's words.
        type RelayUrlOutcome<'a> = Result<Option<&'a str>, &'a str>;
        let cases: [(Option<&str>, RelayUrlOutcome); 17] = [
            (None, Ok(Some(DEFAULT))),
            (Some(""), Ok(Some(DEFAULT))),
            (Some("   "), Ok(Some(DEFAULT))),
            (Some("0"), Ok(None)),
            (Some("false"), Ok(None)),
            (Some("OFF"), Ok(None)),
            (Some(" Off "), Ok(None)),
            (Some("wss://relay.example"), Ok(Some("wss://relay.example/"))),
            (Some(" wss://relay.example/path?x=1 "), Ok(Some("wss://relay.example/path?x=1"))),
            (Some("ws://127.0.0.1:9800"), Ok(Some("ws://127.0.0.1:9800/"))),
            (Some("ws://localhost"), Ok(Some("ws://localhost/"))),
            (Some("ws://[::1]:9"), Ok(Some("ws://[::1]:9/"))),
            (Some("ws://relay.example"), Err(SCHEME)),
            (Some("https://relay.example"), Err(SCHEME)),
            (Some("not a url"), Err("MIXDOG_RELAY_URL is invalid.")),
            (Some("wss://user:pw@relay.example"), Err(CREDENTIALS)),
            (Some("wss://u@relay.example"), Err(CREDENTIALS)),
        ];
        for (env, expected) in cases {
            assert_eq!(resolve_relay_url(env), expected.map(|url| url.map(str::to_owned)).map_err(str::to_owned), "{env:?}");
        }
    }

    fn settings_view(view: &mixdog_remote::access::SettingsView) -> Value {
        serde_json::json!({ "enabled": view.enabled, "name": view.name, "defaultName": view.default_name })
    }

    fn fixed_name_settings(dir: &std::path::Path) -> AccessSettings {
        AccessSettings::new(dir, Arc::new(|| "HOST-FIXED".to_owned()))
    }

    /// The recording names Node's files; in `<data>/remote` two of them have the migration's names.
    const RENAMED: [(&str, &str); 2] = [("remote-access-settings.json", "settings.json"), ("relay-device.json", "device.json")];

    fn in_remote_folder(node: &str) -> &str {
        RENAMED.iter().find(|(from, _)| *from == node).map_or(node, |(_, to)| to)
    }

    fn as_node_named(ours: &str) -> String {
        RENAMED.iter().find(|(_, to)| *to == ours).map_or(ours, |(from, _)| from).to_owned()
    }

    /// The settings store over 1.4.5 folders: the switch follows the activation files,
    /// the name falls back to the default, and what is not the right type is ignored.
    #[test]
    fn the_access_settings_read_the_switch_from_the_activation_files_and_ignore_what_is_not_the_right_type() {
        let view = |enabled: bool, name: &str| json!({ "enabled": enabled, "name": name, "defaultName": "HOST-FIXED" });
        let long_name = "n".repeat(100);
        let reads = [
            json!({"name": "fresh", "files": {}, "view": view(false, "HOST-FIXED"), "disabled": false, "after": []}),
            json!({"name": "activated", "files": {"remote-activated.json": r#"{"activatedAt":1}"#}, "view": view(true, "HOST-FIXED"), "disabled": false,
                   "after": ["remote-activated.json"]}),
            json!({"name": "migrated", "migrated": true, "files": {}, "view": view(true, "HOST-FIXED"), "disabled": false, "after": []}),
            json!({"name": "migrated-switched-off", "migrated": true, "files": {"remote-access-settings.json": r#"{"enabled":false}"#},
                   "view": view(false, "HOST-FIXED"), "disabled": true, "after": ["remote-access-settings.json"]}),
            json!({"name": "legacy-evidence", "files": {"relay-device.json": "{}"}, "view": view(true, "HOST-FIXED"), "disabled": false,
                   "after": ["relay-device.json", "remote-activated.json"]}),
            json!({"name": "trust-evidence", "files": {"remote-client-trust.json": "{}"}, "view": view(true, "HOST-FIXED"), "disabled": false,
                   "after": ["remote-activated.json", "remote-client-trust.json"]}),
            json!({"name": "switched-off", "files": {"remote-activated.json": "{}", "remote-access-settings.json": r#"{"enabled":false}"#},
                   "view": view(false, "HOST-FIXED"), "disabled": true, "after": ["remote-access-settings.json", "remote-activated.json"]}),
            json!({"name": "named", "files": {"remote-access-settings.json": r#"{"name":"My PC","enabled":true}"#}, "view": view(true, "My PC"), "disabled": false,
                   "after": ["remote-access-settings.json"]}),
            json!({"name": "empty-name", "files": {"remote-access-settings.json": r#"{"name":""}"#}, "view": view(false, "HOST-FIXED"), "disabled": false,
                   "after": ["remote-access-settings.json"]}),
            json!({"name": "long-name-kept", "files": {"remote-access-settings.json": format!(r#"{{"name":"{long_name}"}}"#)}, "view": view(false, &long_name),
                   "disabled": false, "after": ["remote-access-settings.json"]}),
            json!({"name": "damaged", "files": {"remote-access-settings.json": "{broken"}, "view": view(false, "HOST-FIXED"), "disabled": false,
                   "after": ["remote-access-settings.json"]}),
            json!({"name": "wrong-types", "files": {"remote-access-settings.json": r#"{"enabled":"yes","name":5}"#}, "view": view(false, "HOST-FIXED"), "disabled": false,
                   "after": ["remote-access-settings.json"]}),
        ];
        for case in &reads {
            let dir = tempfile::tempdir().unwrap();
            for (rel, text) in case["files"].as_object().unwrap() {
                std::fs::write(dir.path().join(in_remote_folder(rel)), text.as_str().unwrap()).unwrap();
            }
            let settings = fixed_name_settings(dir.path()).with_migrated_activation(case["migrated"] == true);
            let name = &case["name"];
            assert_eq!(settings_view(&settings.read()), case["view"], "{name}");
            assert_eq!(settings.disabled(), case["disabled"].as_bool().unwrap(), "{name}");
            assert_eq!(serde_json::to_value(settings.device_aliases()).unwrap(), json!({}), "{name}");
            let mut listed: Vec<String> =
                std::fs::read_dir(dir.path()).unwrap().map(|entry| as_node_named(&entry.unwrap().file_name().to_string_lossy())).collect();
            listed.sort();
            assert_eq!(serde_json::to_value(listed).unwrap(), case["after"], "{name}");
        }
    }

    #[test]
    fn the_access_settings_change_trims_and_caps_what_is_set_and_drops_what_is_emptied() {
        let view = |enabled: bool, name: &str| json!({ "enabled": enabled, "name": name, "defaultName": "HOST-FIXED" });
        let (long_name, capped_name) = ("x".repeat(70), "x".repeat(64));
        let (long_alias, capped_alias) = ("a".repeat(90), "a".repeat(80));
        let mutations = [
            json!({"op": "setEnabled", "args": [true], "result": view(true, "HOST-FIXED"), "file": {"enabled": true}}),
            json!({"op": "setName", "args": ["  My Desk  "], "result": view(true, "My Desk"), "file": {"enabled": true, "name": "My Desk"}}),
            json!({"op": "setName", "args": [long_name], "result": view(true, &capped_name), "file": {"enabled": true, "name": capped_name}}),
            json!({"op": "setName", "args": [""], "result": view(true, "HOST-FIXED"), "file": {"enabled": true}}),
            json!({"op": "setDeviceAlias", "args": ["c1", "  Phone  "], "result": {"c1": "Phone"}, "file": {"enabled": true, "deviceAliases": {"c1": "Phone"}}}),
            json!({"op": "setDeviceAlias", "args": ["c2", long_alias], "result": {"c1": "Phone", "c2": capped_alias},
                   "file": {"enabled": true, "deviceAliases": {"c1": "Phone", "c2": capped_alias}}}),
            json!({"op": "setDeviceAlias", "args": ["c1", ""], "result": {"c2": capped_alias}, "file": {"enabled": true, "deviceAliases": {"c2": capped_alias}}}),
            json!({"op": "setEnabled", "args": [false], "result": view(false, "HOST-FIXED"), "file": {"enabled": false, "deviceAliases": {"c2": capped_alias}}}),
        ];
        let dir = tempfile::tempdir().unwrap();
        let settings = fixed_name_settings(dir.path());
        for step in &mutations {
            let args = step["args"].as_array().unwrap();
            let shown = match step["op"].as_str().unwrap() {
                "setEnabled" => settings_view(&settings.set_enabled(args[0].as_bool().unwrap()).unwrap()),
                "setName" => settings_view(&settings.set_name(args[0].as_str().unwrap()).unwrap()),
                _ => serde_json::to_value(settings.set_device_alias(args[0].as_str().unwrap(), args[1].as_str().unwrap()).unwrap()).unwrap(),
            };
            assert_eq!(shown, step["result"], "{} {}", step["op"], step["args"]);
            let file: Value = serde_json::from_slice(&std::fs::read(dir.path().join("settings.json")).unwrap()).unwrap();
            assert_eq!(file, step["file"], "{} {}", step["op"], step["args"]);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_runtime_starts_with_the_relay_off() {
        let dir = tempfile::tempdir().unwrap();
        let publisher = Arc::new(LatePublisher::default());
        let built = build_remote(RemoteInputs {
            dir: dir.path().to_path_buf(),
            migrated_activation: false,
            relay_env: Some("off".into()),
            app_version: ("1.0.0".into(), None),
            durability: mixdog_rt::testing::tokens().durability_io,
            dialer: Arc::new(LateDialer::default()),
            publisher: publisher.clone(),
        })
        .unwrap();
        let seen = Arc::new(Seen::default());
        publisher.bind(seen.clone());
        built.runtime.prepare().await.unwrap();
        built.runtime.start(false).await.unwrap();
        assert!(seen.0.lock().unwrap().iter().any(|(section, _)| *section == SectionName::Remote));
    }
    /// The host name on Windows is the machine's `COMPUTERNAME`.
    #[cfg(windows)]
    #[test]
    fn the_host_name_is_the_computer_name() {
        assert_eq!(host_name(), std::env::var("COMPUTERNAME").unwrap());
    }
    /// The pair-code manager driven through the composed effects: the frames sent to the
    /// relay leg and the code the screen sees after each step.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_pair_code_effects_send_the_request_and_show_the_issued_code() {
        use mixdog_remote::pair_code::PairCode;
        let request = json!([{"type": "pair-code-request", "lease": "$last", "name": "PC-FIXED"}]);
        let clear = json!([{"type": "pair-code-clear"}]);
        let steps = [
            json!({"op": "ensure", "at": 0, "result": null, "sent": request}),
            json!({"op": "ensure", "at": 1000, "result": null, "sent": []}),
            json!({"op": "issued", "at": 2000, "envelope": {"ok": true, "code": "123456", "expiresInMs": 600000, "lease": "$last"}, "result": null, "sent": []}),
            json!({"op": "ensure", "at": 3000, "result": {"code": "123456", "expiresAt": 302000}, "sent": []}),
            json!({"op": "used", "at": 4000, "envelope": {"lease": "$other"}, "result": null, "sent": []}),
            json!({"op": "ensure", "at": 4001, "result": {"code": "123456", "expiresAt": 302000}, "sent": []}),
            json!({"op": "used", "at": 5000, "envelope": {"lease": "$last"}, "result": null, "sent": []}),
            json!({"op": "ensure", "at": 5001, "result": null, "sent": request}),
            json!({"op": "issued", "at": 6000, "envelope": {"ok": true, "code": "654321", "expiresInMs": 100000, "lease": "$other"}, "result": null, "sent": []}),
            json!({"op": "issued", "at": 6100, "envelope": {"ok": true, "code": "654321", "expiresInMs": 100000, "lease": "$last"}, "result": null, "sent": []}),
            json!({"op": "ensure", "at": 6500, "result": {"code": "654321", "expiresAt": 106100}, "sent": []}),
            json!({"op": "ensure", "at": 106100, "result": null, "sent": request}),
            json!({"op": "release", "at": 107000, "result": null, "sent": clear}),
            json!({"op": "release", "at": 108000, "result": null, "sent": []}),
            json!({"op": "ensure", "at": 109000, "result": null, "sent": request}),
            json!({"op": "connected", "at": 109100, "result": null, "sent": request}),
        ];
        let host = "PC-FIXED";
        let sent: Arc<Mutex<Vec<Value>>> = Arc::default();
        let leg = sent.clone();
        // The core ticker needs the executors installed.
        let _tokens = mixdog_rt::testing::tokens();
        let mut effects = ComposedPairCodeEffects::new(
            Box::new(|_| {}),
            mixdog_rt::ticker().clone(),
            Arc::new(|| {}),
            Box::new(move |envelope| {
                leg.lock().unwrap().push(envelope);
                true
            }),
        );
        let mut code = PairCode::new();
        let owner = mixdog_remote::pair_code::PairOwner { id: 1, alive: mixdog_rt::CancellationToken::new() };
        let mut last_lease = String::new();
        for step in &steps {
            let at = step["at"].as_u64().unwrap();
            sent.lock().unwrap().clear();
            let envelope = step["envelope"].as_object().map(|envelope| {
                let mut envelope = envelope.clone();
                let lease = if envelope["lease"] == "$last" { last_lease.clone() } else { "someone-else".to_owned() };
                envelope.insert("lease".into(), json!(lease));
                Value::Object(envelope)
            });
            match step["op"].as_str().unwrap() {
                "ensure" => code.want(&mut effects, host, at, &owner).unwrap(),
                "issued" => code.on_issued(&mut effects, envelope.as_ref().unwrap(), at),
                "used" => code.on_used(&mut effects, envelope.as_ref().unwrap()),
                "release" => code.release(&mut effects, 1),
                _ => code.on_connected(&mut effects, host, at),
            }
            let frames: Vec<Value> = sent
                .lock()
                .unwrap()
                .iter()
                .map(|frame| {
                    let mut frame = frame.clone();
                    if let Some(lease) = frame.get("lease").and_then(Value::as_str).map(str::to_owned) {
                        assert_eq!((lease.len(), lease.bytes().all(|b| b.is_ascii_hexdigit())), (32, true));
                        last_lease = lease;
                        frame["lease"] = json!("$last");
                    }
                    frame
                })
                .collect();
            assert_eq!(Value::Array(frames), step["sent"], "{} at {at}", step["op"]);
            if step["op"] == "ensure" {
                let shown =
                    code.current().filter(|view| view.expires_at > at).map_or(Value::Null, |view| json!({ "code": view.code, "expiresAt": view.expires_at }));
                assert_eq!(shown, step["result"], "ensure at {at}");
            }
        }
    }
}

#[cfg(test)]
mod e2e;
