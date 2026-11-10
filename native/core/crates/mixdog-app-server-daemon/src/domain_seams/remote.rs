//! `remote` and `local_target`: the one `RemoteRuntime` of the core and the dialer that serves
//! phones from this core (compose-seams.md §F).
//!
//! The runtime needs the section publisher and the dialer before the server exists, and both
//! come from things built after it (`compose_domains`' `StateRuntime`, the server's connection
//! hub). [`LatePublisher`] and [`LateDialer`] are bound once those exist; the runtime is
//! `prepare`d after both are bound.

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

/// The `StatePublisher` of `compose_domains` (`ComposedDomains::state.publisher`), which exists
/// only after the runtime did: publications made before [`bind`](Self::bind) are kept and
/// delivered in order when it is bound.
#[derive(Default)]
pub struct LatePublisher {
    state: Mutex<(Option<Arc<dyn StatePublisher>>, Vec<(SectionName, Option<String>, SectionChange)>)>,
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
}

/// What the runtime tells the desktop beyond the `remote` section. An accepted controller key
/// and an owed revocation are already in the section the runtime publishes right after the event
/// (`controllerKeys`, `owedKeys`), which the desktop reads; only the relay failure has no
/// section field, so it is logged.
pub struct SectionEvents {
    cleanup: OnceLock<Arc<dyn DeviceCleanup>>,
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
        Self { cleanup: OnceLock::new() }
    }

    pub fn bind(&self, cleanup: Arc<dyn DeviceCleanup>) -> Result<(), &'static str> {
        self.cleanup.set(cleanup).map_err(|_| "the device cleanup is already bound")
    }
}

impl Default for SectionEvents {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteEvents for SectionEvents {
    fn controller_key_delivered(&self, _public_key: &str) {}

    fn owed_access_changed(&self) {}

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

    fn status(&self, value: Value) {
        tracing::warn!(%value, "remote access relay status");
    }
}

/// `os.hostname()`.
#[cfg(windows)]
fn host_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
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
    /// The remote-access files directory (the data directory).
    pub dir: PathBuf,
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

/// §F steps 1 and 2. `Err` is the relay URL's sentence (`MIXDOG_RELAY_URL is invalid`, …).
pub fn build_remote(inputs: RemoteInputs) -> Result<BuiltRemote, String> {
    let relay_url = resolve_relay_url(inputs.relay_env.as_deref())?;
    let registry = Arc::new(DeviceRegistry::default());
    let events = Arc::new(SectionEvents::new());
    let section = Arc::new(RemoteSection::new(inputs.publisher, RemoteSectionValue::default()));
    let settings = Arc::new(AccessSettings::new(inputs.dir.clone(), Arc::new(host_name)));
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
        Box::new(|wiring: PairWiring| {
            Box::new(ComposedPairCodeEffects::new(wiring.publish, mixdog_rt::ticker().clone(), wiring.on_tick, wiring.leg))
        }),
    );
    Ok(BuiltRemote { runtime: Arc::new(runtime), registry, events })
}

/// `CoreHandle::connection_opened` for the paired-device registry: a client that connected from
/// this machine (`Local`, or an SSH tunnel's `Ssh`) is recorded under the identity its
/// `initialize` stated, so approvals stamp its device (compose-seams §F step 7). A relay
/// connection is recorded by the dialer that opened it, with the peer id the registry follows to
/// the paired device; a local client that claims to be a phone or a remote desktop is not
/// recorded, because only a paired relay peer is one.
pub fn register_local(registry: &DeviceRegistry, connection: ConnectionId, origin: Origin, device: &str, kind: ConnectionKind) {
    if origin == Origin::Relay {
        return;
    }
    let kind = match kind {
        ConnectionKind::Desktop => LocalKind::Desktop,
        ConnectionKind::Tui => LocalKind::Tui,
        ConnectionKind::Cli => LocalKind::Cli,
        ConnectionKind::ChannelBridge => LocalKind::ChannelBridge,
        ConnectionKind::Phone | ConnectionKind::RemoteDesktop => return,
    };
    registry.connect_local(connection.0, device, kind);
}

/// The paired credential a connection acts as, for the phone file grants (SPEC.md R44, DS 4.7): that of a relay peer attached after
/// its handshake. A local client, whatever device name or kind it states, and a peer whose pairing ended have none.
pub fn phone_credential(registry: Arc<DeviceRegistry>) -> Arc<dyn Fn(ConnectionId) -> Option<String> + Send + Sync> {
    Arc::new(move |connection| registry.describe(connection.0).map(|described| described.credential).filter(|credential| !credential.is_empty()))
}

/// The services that hold a paired device's state, as `remote-relay.ts` `revokeClient` reaches them: the one-file grants, the
/// transfers of the device's connections and its notification preferences.
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
    pub live_view: Arc<std::sync::OnceLock<std::sync::Weak<crate::live_view::LiveViewService>>>,
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
            if credential_id == "pc" || devices.remove(credential_id).is_none() {
                return;
            }
            let _ = self.config.write("notifications.devices", Value::Object(devices), mixdog_protocol::ConfigWriteMode::Replace).await;
        })
    }
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

/// Opens the core's relay once it serves (DS §7.2 "relay starts at core boot"; compose-seams §F
/// step 3, Node's `remoteAccessStart`): the dialer is bound to the server's connection hub by
/// then. Starts publishing `hostState.remoteViewing`, loads the roster and connects if remote
/// access was activated and is enabled. A failure is logged, not fatal: `start` has already
/// published relay status `failed` and retries with backoff.
pub async fn start_remote(remote: &BuiltRemote, publisher: Arc<dyn StatePublisher>) {
    mixdog_rt::spawn("remote-viewing", TaskClass::Work, publish_remote_viewing(Arc::downgrade(&remote.registry), publisher));
    if let Err(error) = remote.runtime.prepare().await {
        tracing::warn!(%error, "remote access roster did not load");
    }
    if let Err(error) = remote.runtime.start(false).await {
        tracing::warn!(%error, "remote access did not start");
    }
}

#[cfg(test)]
mod e2e;

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test lays out its fixture files with blocking calls on the test thread")]
mod tests {
    use super::*;

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

    #[tokio::test]
    async fn a_phone_dialing_before_the_server_exists_is_refused() {
        assert!(LateDialer::default().dial("peer").await.is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_runtime_starts_with_the_relay_off() {
        let dir = tempfile::tempdir().unwrap();
        let publisher = Arc::new(LatePublisher::default());
        let built = build_remote(RemoteInputs {
            dir: dir.path().to_path_buf(),
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

    #[test]
    fn the_relay_url_resolves_as_the_desktop_resolves_it() {
        for case in crate::domain_seams::golden()["remote"]["relayUrl"].as_array().unwrap() {
            let resolved = resolve_relay_url(case["env"].as_str());
            match case["error"].as_str() {
                Some(error) => assert_eq!(resolved, Err(error.to_owned()), "{}", case["env"]),
                None => assert_eq!(resolved, Ok(case["url"].as_str().map(str::to_owned)), "{}", case["env"]),
            }
        }
    }

    /// Node's `os.hostname()` is the machine's `COMPUTERNAME` on Windows, as recorded there.
    #[cfg(windows)]
    #[test]
    fn the_host_name_is_the_one_nodes_os_hostname_returns() {
        let recorded = &crate::domain_seams::golden()["remote"]["hostName"];
        assert_eq!(recorded["platform"], "win32");
        assert_eq!(recorded["hostname"], recorded["computerName"]);
        assert_eq!(host_name(), std::env::var("COMPUTERNAME").unwrap());
    }

    fn settings_view(view: &mixdog_remote::access::SettingsView) -> Value {
        serde_json::json!({ "enabled": view.enabled, "name": view.name, "defaultName": view.default_name })
    }

    fn fixed_name_settings(dir: &std::path::Path) -> AccessSettings {
        AccessSettings::new(dir, Arc::new(|| "HOST-FIXED".to_owned()))
    }

    /// Node's settings store over the recorded folders: the switch follows the activation files,
    /// the name falls back to the default, and what is not the right type is ignored.
    #[test]
    fn the_access_settings_read_as_nodes_store_reads_them() {
        for case in crate::domain_seams::golden()["remote"]["settings"]["reads"].as_array().unwrap() {
            let dir = tempfile::tempdir().unwrap();
            for (rel, text) in case["files"].as_object().unwrap() {
                std::fs::write(dir.path().join(rel), text.as_str().unwrap()).unwrap();
            }
            let settings = fixed_name_settings(dir.path());
            let name = &case["name"];
            assert_eq!(settings_view(&settings.read()), case["view"], "{name}");
            assert_eq!(settings.disabled(), case["disabled"].as_bool().unwrap(), "{name}");
            assert_eq!(serde_json::to_value(settings.device_aliases()).unwrap(), case["aliases"], "{name}");
            let mut listed: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
            listed.sort();
            assert_eq!(serde_json::to_value(listed).unwrap(), case["after"], "{name}");
        }
    }

    #[test]
    fn the_access_settings_change_as_nodes_store_changes_them() {
        let dir = tempfile::tempdir().unwrap();
        let settings = fixed_name_settings(dir.path());
        for step in crate::domain_seams::golden()["remote"]["settings"]["mutations"].as_array().unwrap() {
            let args = step["args"].as_array().unwrap();
            let shown = match step["op"].as_str().unwrap() {
                "setEnabled" => settings_view(&settings.set_enabled(args[0].as_bool().unwrap()).unwrap()),
                "setName" => settings_view(&settings.set_name(args[0].as_str().unwrap()).unwrap()),
                _ => serde_json::to_value(settings.set_device_alias(args[0].as_str().unwrap(), args[1].as_str().unwrap()).unwrap()).unwrap(),
            };
            assert_eq!(shown, step["result"], "{} {}", step["op"], step["args"]);
            let file: Value = serde_json::from_slice(&std::fs::read(dir.path().join("remote-access-settings.json")).unwrap()).unwrap();
            assert_eq!(file, step["file"], "{} {}", step["op"], step["args"]);
        }
    }

    /// Node's pair-code manager replayed through the composed effects: the frames sent to the
    /// relay leg and the code the screen sees after each step.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_pair_code_effects_send_and_show_what_nodes_manager_does() {
        use mixdog_remote::pair_code::PairCode;
        use serde_json::json;
        let golden = crate::domain_seams::golden();
        let pair = &golden["remote"]["pairCode"];
        let host = pair["hostName"].as_str().unwrap();
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
        let mut last_lease = String::new();
        for step in pair["steps"].as_array().unwrap() {
            let at = step["at"].as_u64().unwrap();
            sent.lock().unwrap().clear();
            let envelope = step["envelope"].as_object().map(|envelope| {
                let mut envelope = envelope.clone();
                let lease = if envelope["lease"] == "$last" { last_lease.clone() } else { "someone-else".to_owned() };
                envelope.insert("lease".into(), json!(lease));
                Value::Object(envelope)
            });
            match step["op"].as_str().unwrap() {
                "ensure" => code.want(&mut effects, host, at),
                "issued" => code.on_issued(&mut effects, envelope.as_ref().unwrap(), at),
                "used" => code.on_used(&mut effects, envelope.as_ref().unwrap()),
                "release" => code.release(&mut effects),
                _ => code.on_connected(&mut effects, host),
            }
            let frames: Vec<Value> = sent
                .lock()
                .unwrap()
                .iter()
                .map(|frame| {
                    let mut frame = frame.clone();
                    if let Some(lease) = frame.get("lease").and_then(Value::as_str).map(str::to_owned) {
                        assert_eq!((lease.len(), lease.bytes().all(|b| b.is_ascii_hexdigit())), (pair["defaultLease"]["length"].as_u64().unwrap() as usize, pair["defaultLease"]["hex"].as_bool().unwrap()));
                        last_lease = lease;
                        frame["lease"] = json!("$last");
                    }
                    frame
                })
                .collect();
            assert_eq!(Value::Array(frames), step["sent"], "{} at {at}", step["op"]);
            if step["op"] == "ensure" {
                let shown = code.current().filter(|view| view.expires_at > at).map_or(Value::Null, |view| json!({ "code": view.code, "expiresAt": view.expires_at }));
                assert_eq!(shown, step["result"], "ensure at {at}");
            }
        }
    }
}