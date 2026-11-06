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
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::state::StatePublisher;
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
use mixdog_remote::registry::DeviceRegistry;
use mixdog_remote::section::RemoteSection;
use mixdog_remote::section::RemoteSectionValue;
use mixdog_rt::DurabilityIo;
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

impl LateDialer {
    /// `accept` hands an accepted connection to the server's drive loop (`spawn_drive`).
    pub fn bind(&self, hub: ConnectionHub, accept: Accept) -> Result<(), &'static str> {
        self.0.set(LocalDialer::new(hub, accept)).map_err(|_| "the local dialer is already bound")
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
pub struct SectionEvents;

impl RemoteEvents for SectionEvents {
    fn controller_key_delivered(&self, _public_key: &str) {}

    fn owed_access_changed(&self) {}

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
}

/// §F steps 1 and 2. `Err` is the relay URL's sentence (`MIXDOG_RELAY_URL is invalid`, …).
pub fn build_remote(inputs: RemoteInputs) -> Result<BuiltRemote, String> {
    let relay_url = mixdog_services::webhooks::relay::resolve_relay_url(inputs.relay_env.as_deref())?;
    let registry = Arc::new(DeviceRegistry::default());
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
            events: Arc::new(SectionEvents),
        },
        Box::new(|wiring: PairWiring| {
            Box::new(ComposedPairCodeEffects::new(wiring.publish, mixdog_rt::ticker().clone(), wiring.on_tick, wiring.leg))
        }),
    );
    Ok(BuiltRemote { runtime: Arc::new(runtime), registry })
}

#[cfg(test)]
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
}
