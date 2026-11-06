//! The live remote-access runtime (`createRelayLeg` + `startRemoteRelay` + the claim arbiter of the
//! Node product): activation, one relay leg with redial, the phone channels, pairing claims, the
//! pair code, paired-device bookkeeping and the single publisher of the `remote` section.
//!
//! One state value behind one short lock; nothing is awaited while it is held. Phone traffic is
//! decrypted here and handed to the bridge byte for byte (R25); a slow phone stalls only its own
//! bridge task.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use super::settings::{AccessSettings, SettingsView};
use crate::bridge::{Bridge, Dialer, Frame, PhoneSink, ToPhone};
use crate::clients::{ClaimBindings, ClaimRequest, ClaimStep, ClientTable, Received, ReadyContext, challenge_flags, parse_client_list, revoke_payload};
use crate::e2ee::{Sealed, ServerIdentity};
use crate::identity::{
    ClientInfo, ControllerKeyRecord, DeviceFiles, DeviceIdentity, OwedAccess, Roster, SecretError, load_or_create_e2ee_identity,
    load_or_create_pairing_token, rotate_e2ee_identity, rotate_pairing_token,
};
use crate::leg::caps::{NativePlatform, RelayCaps};
use crate::leg::control::{ControlError, ControlRequests};
use crate::leg::frame::{Payload, encode_binary_frame, json_frame};
use crate::leg::inbound::Inbound;
use crate::leg::socket::{LegConfig, LegEvent, Outgoing, run_leg, validated_relay_url};
use crate::leg::{MAX_WS_PAYLOAD_BYTES, open_envelopes};
use crate::pair_code::{PairCode, PairCodeEffects, PairCodeView};
use crate::push::native_crypto::{NativePushContent, Reason, collapse_key, encrypt_native_push_fresh};
use crate::push::web::{RelayWebPush, WebPushTarget, encrypt_for_target};
use crate::push::native::{NativePushInput, NativePushStore, NativePushSubscription, bind_envelope, invalid_token_of, unbind_envelope};
use crate::registry::DeviceRegistry;
use crate::section::{RemoteSection, claim_value};

/// A claim that nobody answered is denied this long after it arrived (`REMOTE_CLAIM_TIMEOUT_MS`).
pub const CLAIM_TIMEOUT_MS: u64 = 295_000;
const RETRY_BASE: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(300);
const HOST_NAME_MAX: usize = 80;
const OUT_QUEUE: usize = 256;

const RELAY_UNAVAILABLE: &str = "The relay is not connected right now.";
/// The body of an error notification when the PC gives no words of its own
/// (desktop-turn-notifier.ts `TURN_FAILED_TEXT`).
const TURN_FAILED_TEXT: &str = "The turn stopped with an error.";

/// One decided notification for one paired device.
#[derive(Clone, Debug)]
pub struct PushDelivery {
    pub device_id: String,
    pub session_id: String,
    pub title: String,
    pub body: String,
    pub reason: Reason,
    /// This PC's relay device id: the phone opens the session on the PC that sent it.
    pub host_id: String,
    /// The tool approval an approval-pending push is about: its id (already clipped to 120
    /// units) and whether the phone may offer Allow. Native content only, inside the
    /// encryption; `allowOnce` is written only when true.
    pub approval: Option<(String, bool)>,
}

/// Writes a frame to the open relay leg; false when there is none.
pub type LegSend = Box<dyn FnMut(Value) -> bool + Send>;
/// The remote section publisher's entry for the pair code.
pub type PairCodeSink = Box<dyn FnMut(Option<&PairCodeView>) + Send>;
/// What the core ticker runs at the pair code's deadline; it only wakes the runtime.
pub type OnTick = Arc<dyn Fn() + Send + Sync>;

/// The pieces the composition's `PairCodeEffects` is built from. The runtime creates them first
/// (it owns the leg and the section), so the effects can name them without a cycle.
pub struct PairWiring {
    pub leg: LegSend,
    pub publish: PairCodeSink,
    pub on_tick: OnTick,
}

/// Builds the pair-code effects from the runtime's wiring (adds the core ticker).
pub type PairEffectsFactory = Box<dyn FnOnce(PairWiring) -> Box<dyn PairCodeEffects + Send> + Send>;

/// The current leg's outgoing queue, shared with the pair-code effects and the sink.
#[derive(Clone, Default)]
pub struct LegLink {
    out: Arc<Mutex<Option<mpsc::Sender<Outgoing>>>>,
}

impl LegLink {
    fn slot(&self) -> MutexGuard<'_, Option<mpsc::Sender<Outgoing>>> {
        self.out.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set(&self, out: Option<mpsc::Sender<Outgoing>>) {
        *self.slot() = out;
    }

    /// Queues one envelope; false when no leg is open or its queue is full.
    pub fn send(&self, envelope: &Value) -> bool {
        self.send_out(Outgoing::Text(envelope.to_string()))
    }

    fn send_out(&self, out: Outgoing) -> bool {
        self.slot().as_ref().is_some_and(|tx| tx.try_send(out).is_ok())
    }

    /// The closure `ComposedPairCodeEffects` takes as its `LegSend`.
    pub fn sender(&self) -> LegSend {
        let link = self.clone();
        Box::new(move |envelope| link.send(&envelope))
    }

    async fn send_wait(&self, out: Outgoing) -> bool {
        let tx = self.slot().clone();
        match tx {
            Some(tx) => tx.send(out).await.is_ok(),
            None => false,
        }
    }
}

/// What the runtime tells the desktop app beyond the `remote` section.
pub trait RemoteEvents: Send + Sync {
    /// An accepted controller key: the desktop app enrolls it (every connection delivers again).
    fn controller_key_delivered(&self, public_key: &str);
    /// A pairing removal owed PC access revocations.
    fn owed_access_changed(&self);
    /// A relay leg failed to come up (status `failed`) or recovered.
    fn status(&self, value: Value);
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RemoteError {
    #[error("Remote access is not running.")]
    NotRunning,
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Failed(String),
}

impl From<ControlError> for RemoteError {
    fn from(error: ControlError) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<SecretError> for RemoteError {
    fn from(error: SecretError) -> Self {
        Self::Failed(error.to_string())
    }
}

pub struct RuntimeConfig {
    /// The directory of the remote-access files (settings, activation, identities, roster).
    pub dir: PathBuf,
    /// The resolved relay URL; `None` keeps the leg off.
    pub relay_url: Option<String>,
    pub app_version: Option<(String, Option<String>)>,
    pub durability: DurabilityIo,
    pub dialer: Arc<dyn Dialer>,
    pub registry: Arc<DeviceRegistry>,
    pub section: Arc<RemoteSection>,
    pub settings: Arc<AccessSettings>,
    pub link: LegLink,
    pub events: Arc<dyn RemoteEvents>,
}

struct PendingClaim {
    request: ClaimRequest,
    cancel: CancellationToken,
}

/// Everything that exists while a leg is up (or being redialed).
struct Live {
    identity: Arc<ServerIdentity>,
    pairing_token: String,
    device: DeviceIdentity,
    controls: Arc<ControlRequests>,
    cancel: CancellationToken,
}

struct State {
    live: Option<Arc<Live>>,
    connected: bool,
    caps: RelayCaps,
    table: ClientTable,
    claims: ClaimBindings,
    pending_claims: BTreeMap<String, PendingClaim>,
    pair_code: PairCode,
    pair_effects: Box<dyn PairCodeEffects + Send>,
    native: Option<NativePushStore>,
    /// Relay-owned Web Push targets of the current leg; `None` while the relay is off.
    web: Option<RelayWebPush>,
    retry: Duration,
    retry_cancel: Option<CancellationToken>,
}

struct Inner {
    cfg: RuntimeConfig,
    state: Mutex<State>,
    roster: tokio::sync::OnceCell<Arc<Mutex<Roster>>>,
    /// Starts, rotations and stops run one at a time; a permit is held across the relay dial.
    gate: tokio::sync::Semaphore,
    bridge: Bridge,
}

#[derive(Clone)]
pub struct RemoteRuntime {
    inner: Arc<Inner>,
}

/// The phone-bound half of the bridge: seals each core frame for its phone and writes it to the
/// leg. A phone whose channel is gone is dropped.
#[derive(Clone)]
pub struct RuntimeSink {
    inner: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    fn host_name(&self) -> String {
        mixdog_js::slice_utf16(&self.cfg.settings.read().name, HOST_NAME_MAX)
    }

    /// Waits for the one place in a start, rotation or stop.
    async fn enter(&self) -> tokio::sync::SemaphorePermit<'_> {
        self.gate.acquire().await.unwrap_or_else(|_| unreachable!("the gate is never closed"))
    }

    /// Runs `job` on the durability lane (the secret files and the roster live there).
    async fn durable<R: Send + 'static>(&self, job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> Result<R, RemoteError> {
        let handle = self
            .cfg
            .durability
            .submit(&CancellationToken::new(), job)
            .map_err(|_| RemoteError::Failed("The durability lane is full.".into()))?;
        handle.await.map_err(|_| RemoteError::Failed("The durability lane dropped the job.".into()))
    }

    async fn roster(&self) -> Result<Arc<Mutex<Roster>>, RemoteError> {
        self.roster
            .get_or_try_init(|| async {
                let dir = self.cfg.dir.clone();
                let loaded = self.durable(move |lane| Roster::load(lane, &dir)).await??;
                Ok::<_, RemoteError>(Arc::new(Mutex::new(loaded)))
            })
            .await
            .cloned()
    }

    /// Runs a roster mutation on the durability lane.
    async fn with_roster<R: Send + 'static>(
        &self,
        job: impl FnOnce(&mut Roster, &InLane<DurabilityIo>) -> R + Send + 'static,
    ) -> Result<R, RemoteError> {
        let roster = self.roster().await?;
        self.durable(move |lane| job(&mut lock(&roster), lane)).await
    }

    /// Publishes the whole `remote` section from the current state.
    fn refresh(&self) {
        let (running, connected, claims, live) = {
            let state = self.state();
            let now = now_ms();
            let claims: Vec<Value> =
                state.pending_claims.values().filter(|p| p.request.expires_at > now).map(|p| claim_value(&p.request)).collect();
            (state.live.is_some(), state.connected, claims, state.live.clone())
        };
        let settings = self.cfg.settings.read();
        let (clients, controller_keys, owed_keys) = match self.roster.get() {
            Some(roster) => {
                let roster = lock(roster);
                (self.with_aliases(roster.list()), roster.controller_keys(), roster.owed_access())
            }
            None => (Vec::new(), Vec::new(), OwedAccess { keys: Vec::new(), unknown: 0 }),
        };
        let info = self.info(&settings, running, connected, live.as_deref(), &clients);
        let settings_value = serde_json::to_value(&settings).unwrap_or(Value::Null);
        self.cfg.section.update(|value| {
            value.info = info;
            value.settings = settings_value;
            value.claims = claims;
            value.clients = clients;
            value.controller_keys = controller_keys;
            value.owed_keys = owed_keys;
        });
    }

    fn with_aliases(&self, rows: Vec<ClientInfo>) -> Vec<Value> {
        let aliases = self.cfg.settings.device_aliases();
        rows.into_iter()
            .map(|row| {
                let alias = aliases.get(&row.id).cloned();
                let mut value = serde_json::to_value(&row).unwrap_or(Value::Null);
                if let (Some(alias), Some(map)) = (alias, value.as_object_mut()) {
                    map.insert("alias".into(), Value::String(alias));
                }
                value
            })
            .collect()
    }

    /// Today's descriptor: the relay's client URL and token plus the paired devices, `null` while
    /// no leg runs (and access is not switched off).
    fn info(&self, settings: &SettingsView, running: bool, connected: bool, live: Option<&Live>, clients: &[Value]) -> Value {
        match live {
            Some(live) => {
                let client_url = self
                    .cfg
                    .relay_url
                    .as_deref()
                    .and_then(|url| crate::leg::socket::relay_client_url(url, &live.device.device_id).ok())
                    .unwrap_or_default();
                json!({ "relay": { "clientUrl": client_url, "token": live.pairing_token, "clients": clients }, "enabled": true, "connected": connected })
            }
            None if !settings.enabled || !running => {
                json!({ "relay": { "clientUrl": "", "token": "", "clients": clients }, "enabled": false })
            }
            None => Value::Null,
        }
    }

    fn live(&self) -> Result<Arc<Live>, RemoteError> {
        self.state().live.clone().ok_or(RemoteError::NotRunning)
    }

    fn drop_claim(&self, claim_id: &str) -> Option<PendingClaim> {
        self.state().pending_claims.remove(claim_id)
    }

    fn pair_effects_call<R>(&self, f: impl FnOnce(&mut PairCode, &mut dyn PairCodeEffects) -> R) -> R {
        let mut state = self.state();
        let State { pair_code, pair_effects, .. } = &mut *state;
        f(pair_code, pair_effects.as_mut())
    }
}

impl RemoteRuntime {
    pub fn new(cfg: RuntimeConfig, factory: PairEffectsFactory) -> Self {
        let link = cfg.link.clone();
        let wake = Arc::new(tokio::sync::Notify::new());
        let section = cfg.section.clone();
        let wiring = PairWiring {
            leg: link.sender(),
            publish: Box::new(move |code| section.set_pair_code(code)),
            on_tick: {
                let wake = wake.clone();
                Arc::new(move || wake.notify_one())
            },
        };
        let pair_effects = factory(wiring);
        let dialer = cfg.dialer.clone();
        let inner = Arc::new_cyclic(|weak: &std::sync::Weak<Inner>| {
            let sink: Arc<dyn PhoneSink> = Arc::new(WeakSink { inner: weak.clone() });
            Inner {
                cfg,
                state: Mutex::new(State {
                    live: None,
                    connected: false,
                    caps: RelayCaps::default(),
                    table: ClientTable::default(),
                    claims: ClaimBindings::default(),
                    pending_claims: BTreeMap::new(),
                    pair_code: PairCode::new(),
                    pair_effects,
                    native: None,
                    web: None,
                    retry: Duration::ZERO,
                    retry_cancel: None,
                }),
                roster: tokio::sync::OnceCell::new(),
                gate: tokio::sync::Semaphore::new(1),
                bridge: Bridge::new(dialer, sink),
            }
        });
        // The ticker's notification becomes `on_tick` on the runtime's own task.
        let weak = Arc::downgrade(&inner);
        tokio::spawn(async move {
            loop {
                wake.notified().await;
                let Some(inner) = weak.upgrade() else { return };
                let now = now_ms();
                inner.pair_effects_call(|code, fx| code.on_tick(fx, now));
            }
        });
        Self { inner }
    }

    /// The `PhoneSink` of the bridge, for compositions that build their own `Bridge`.
    pub fn sink(&self) -> RuntimeSink {
        RuntimeSink { inner: self.inner.clone() }
    }

    /// Points new bridged phones at another target core (an SSH server core, or back).
    pub fn set_target(&self, dialer: Arc<dyn Dialer>) {
        self.inner.bridge.set_target(dialer);
    }

    pub fn settings(&self) -> SettingsView {
        self.inner.cfg.settings.read()
    }

    /// Loads the roster and publishes the section (the first publish of real state).
    pub async fn prepare(&self) -> Result<(), RemoteError> {
        self.inner.roster().await?;
        self.inner.refresh();
        Ok(())
    }

    /// `explicit` is a user remote-access action: it activates (and persists) remote access.
    /// Boot, resume and retry starts only connect once activated, so a fresh install never
    /// registers on the relay on its own.
    pub async fn start(&self, explicit: bool) -> Result<(), RemoteError> {
        let _gate = self.inner.enter().await;
        self.start_gated(explicit).await
    }

    async fn start_gated(&self, explicit: bool) -> Result<(), RemoteError> {
        let inner = &self.inner;
        if inner.state().live.is_some() {
            if explicit {
                self.activate().await?;
            }
            return Ok(());
        }
        if inner.cfg.settings.disabled() {
            return Ok(());
        }
        let Some(relay_url) = inner.cfg.relay_url.clone() else { return Ok(()) };
        if explicit {
            self.activate().await?;
        } else if !inner.cfg.settings.is_activated() {
            return Ok(());
        }
        match self.bring_up(relay_url).await {
            Ok(()) => {
                let mut state = inner.state();
                state.retry = Duration::ZERO;
                if let Some(cancel) = state.retry_cancel.take() {
                    cancel.cancel();
                }
                drop(state);
                inner.refresh();
                Ok(())
            }
            Err(error) => {
                inner.cfg.events.status(json!({ "leg": "relay", "status": "failed", "error": error.to_string() }));
                self.schedule_retry();
                Err(error)
            }
        }
    }

    async fn activate(&self) -> Result<(), RemoteError> {
        let settings = self.inner.cfg.settings.clone();
        self.inner.durable(move |_| settings.activate()).await?.map_err(|e| RemoteError::Failed(e.to_string()))
    }

    /// A damaged revocation record may have lost a revocation, and no older copy proves it did
    /// not. So every paired phone is revoked and must pair again: the pairing token, device and
    /// E2EE identities are replaced, which works offline and before any relay leg opens.
    async fn reset_pairing_after_lost_revocations(&self) -> Result<(), RemoteError> {
        let dir = self.inner.cfg.dir.clone();
        let roster = self.inner.roster().await?;
        let damaged = {
            let roster_repair = lock(&roster).repair_required();
            if roster_repair {
                true
            } else {
                let files = DeviceFiles::new(dir.clone());
                self.inner.durable(move |lane| files.queue_damaged(lane).unwrap_or(true)).await?
            }
        };
        if damaged {
            self.rotate_identities().await?;
        }
        Ok(())
    }

    /// New pairing token, device and E2EE identities, and the roster cleared (its controller keys
    /// are owed first, in the same write).
    async fn rotate_identities(&self) -> Result<(), RemoteError> {
        let dir = self.inner.cfg.dir.clone();
        let roster = self.inner.roster().await?;
        self.inner
            .durable(move |lane| -> Result<(), SecretError> {
                lock(&roster).clear(lane)?;
                rotate_pairing_token(lane, &dir)?;
                DeviceFiles::new(dir.clone()).rotate(lane)?;
                rotate_e2ee_identity(lane, &dir)?;
                Ok(())
            })
            .await??;
        self.inner.cfg.events.owed_access_changed();
        Ok(())
    }

    async fn bring_up(&self, relay_url: String) -> Result<(), RemoteError> {
        validated_relay_url(&relay_url).map_err(|e| RemoteError::Failed(e.to_string()))?;
        self.reset_pairing_after_lost_revocations().await?;
        let dir = self.inner.cfg.dir.clone();
        let (token, device, identity, native) = self
            .inner
            .durable(move |lane| -> Result<_, SecretError> {
                let token = load_or_create_pairing_token(lane, &dir)?;
                let device = DeviceFiles::new(dir.clone()).load_or_create(lane)?;
                let identity = load_or_create_e2ee_identity(lane, &dir)?;
                let native = NativePushStore::load(lane, &dir)?;
                Ok((token, device, identity, native))
            })
            .await??;
        let (events_tx, events_rx) = mpsc::channel(OUT_QUEUE);
        let (out_tx, out_rx) = mpsc::channel(OUT_QUEUE);
        let cancel = CancellationToken::new();
        let live = Arc::new(Live {
            identity: Arc::new(identity),
            pairing_token: token,
            device: device.clone(),
            controls: Arc::new(ControlRequests::default()),
            cancel: cancel.clone(),
        });
        {
            let mut state = self.inner.state();
            state.live = Some(live.clone());
            state.native = Some(native);
            state.web = Some(RelayWebPush::new((*live.identity).clone()));
        }
        self.inner.cfg.link.set(Some(out_tx));
        let config = LegConfig::desktop(relay_url, device, MAX_WS_PAYLOAD_BYTES as usize);
        tokio::spawn(run_leg(config, events_tx, out_rx, cancel.clone()));
        let runtime = self.clone();
        tokio::spawn(async move { runtime.serve(live, events_rx).await });
        Ok(())
    }

    fn schedule_retry(&self) {
        let mut state = self.inner.state();
        if state.retry_cancel.is_some() || state.live.is_some() {
            return;
        }
        state.retry = if state.retry.is_zero() { RETRY_BASE } else { (state.retry * 2).min(RETRY_MAX) };
        let (delay, cancel) = (state.retry, CancellationToken::new());
        state.retry_cancel = Some(cancel.clone());
        drop(state);
        let runtime = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = cancel.cancelled() => {}
                () = tokio::time::sleep(delay) => {
                    lock(&runtime.inner.state).retry_cancel = None;
                    let _ = runtime.start(false).await;
                }
            }
        });
    }

    /// Switched off: no retry; the leg is closed (`before_close` has read its list one last time).
    pub async fn stop(&self) -> Result<(), RemoteError> {
        let _gate = self.inner.enter().await;
        if let Some(cancel) = self.inner.state().retry_cancel.take() {
            cancel.cancel();
        }
        if self.inner.state().live.is_some() {
            // The paired devices are remembered while the relay can still be asked.
            let _ = self.remember_clients().await;
        }
        self.close_leg();
        self.inner.refresh();
        Ok(())
    }

    /// The runtime ends (core shutdown).
    pub async fn close(&self) {
        let _gate = self.inner.enter().await;
        if let Some(cancel) = self.inner.state().retry_cancel.take() {
            cancel.cancel();
        }
        self.close_leg();
    }

    fn close_leg(&self) {
        let (live, peers) = {
            let mut state = self.inner.state();
            let live = state.live.take();
            state.connected = false;
            state.native = None;
            (live, state.table.close_all())
        };
        if let Some(live) = live {
            live.cancel.cancel();
            live.controls.reject_all(&ControlError::Failed("Relay client is closed.".into()));
        }
        self.inner.cfg.link.set(None);
        self.inner.bridge.close_all();
        for peer in peers {
            self.inner.cfg.registry.detach_peer(&peer);
        }
        self.inner.cfg.registry.detach_all_peers();
    }

    /// New pairing token, device and E2EE identities: every paired phone pairs again.
    pub async fn rotate(&self) -> Result<(), RemoteError> {
        {
            let _gate = self.inner.enter().await;
            self.start_gated(true).await?;
        }
        let _gate = self.inner.enter().await;
        self.close_leg();
        self.rotate_identities().await?;
        self.start_gated(true).await?;
        Ok(())
    }

    // ---- settings -------------------------------------------------------------------------

    pub async fn set_enabled(&self, enabled: bool) -> Result<SettingsView, RemoteError> {
        let settings = self.inner.cfg.settings.clone();
        self.inner.durable(move |_| settings.set_enabled(enabled)).await?.map_err(|e| RemoteError::Failed(e.to_string()))?;
        if enabled {
            self.start(true).await?;
        } else {
            self.stop().await?;
        }
        self.inner.refresh();
        Ok(self.inner.cfg.settings.read())
    }

    pub async fn set_name(&self, name: &str) -> Result<SettingsView, RemoteError> {
        let settings = self.inner.cfg.settings.clone();
        let name = name.to_owned();
        let view = self.inner.durable(move |_| settings.set_name(&name)).await?.map_err(|e| RemoteError::Failed(e.to_string()))?;
        self.push_name();
        self.inner.refresh();
        Ok(view)
    }

    pub async fn set_client_alias(&self, client_id: &str, alias: &str) -> Result<(), RemoteError> {
        let settings = self.inner.cfg.settings.clone();
        let (id, alias) = (client_id.to_owned(), alias.to_owned());
        self.inner.durable(move |_| settings.set_device_alias(&id, &alias)).await?.map_err(|e| RemoteError::Failed(e.to_string()))?;
        self.inner.refresh();
        Ok(())
    }

    pub fn push_name(&self) {
        let name = self.inner.host_name();
        self.inner.cfg.link.send(&json!({ "type": "desktop-name", "name": name }));
    }

    // ---- the live relay -------------------------------------------------------------------

    async fn control(&self, kind: &str, payload: Map<String, Value>) -> Result<Value, RemoteError> {
        let live = self.inner.live()?;
        let link = self.inner.cfg.link.clone();
        live.controls.request(kind, payload, |envelope| link.send(&envelope)).await.map_err(RemoteError::from)
    }

    /// The relay's paired-device list; remembered with pending removals marked.
    pub async fn list_clients(&self) -> Result<Vec<Value>, RemoteError> {
        let rows = self.control("list-clients", Map::new()).await?;
        let listed = parse_client_list(&rows);
        let remembered = listed.clone();
        self.inner.with_roster(move |roster, lane| roster.remember(lane, &remembered)).await??;
        let roster = self.inner.roster().await?;
        let pending = lock(&roster).pending();
        let marked = listed.into_iter().map(|row| ClientInfo { pending_removal: pending.contains(&row.id), ..row }).collect();
        Ok(self.inner.with_aliases(marked))
    }

    async fn remember_clients(&self) -> Result<(), RemoteError> {
        self.list_clients().await.map(|_| ())
    }

    /// Today's descriptor: `null` while the relay cannot be asked.
    pub async fn descriptor(&self) -> Result<Value, RemoteError> {
        let settings = self.inner.cfg.settings.read();
        if self.inner.state().live.is_none() {
            let roster = self.inner.roster().await?;
            let clients = self.inner.with_aliases(lock(&roster).list());
            return Ok(if settings.enabled && self.inner.cfg.settings.is_activated() {
                Value::Null
            } else {
                json!({ "relay": { "clientUrl": "", "token": "", "clients": clients }, "enabled": false })
            });
        }
        let Ok(clients) = self.list_clients().await else { return Ok(Value::Null) };
        let live = self.inner.live()?;
        let info = self.inner.info(&settings, true, self.inner.state().connected, Some(&live), &clients);
        Ok(info)
    }

    /// `ensure` (default), `renew` or `release` the Settings › Connection pair code.
    pub async fn pair_code(&self, action: &str) -> Result<Value, RemoteError> {
        if action != "release" {
            self.start(true).await?;
        }
        let host = self.inner.host_name();
        let now = now_ms();
        let live = self.inner.state().live.is_some();
        self.inner.pair_effects_call(|code, fx| match action {
            "release" => code.release(fx),
            "renew" => code.renew(fx, &host),
            _ => code.want(fx, &host, now),
        });
        if !live || action == "release" {
            return Ok(Value::Null);
        }
        let held = self.inner.state().pair_code.current().cloned();
        Ok(PairCodeView::to_value(held.as_ref()))
    }

    /// Unpairs a device. Recorded before the relay is asked, and in force at once: until the relay
    /// confirms it the device stays unpaired, and each (re)connection retries it.
    pub async fn revoke_client(&self, client_id: &str) -> Result<Value, RemoteError> {
        if !is_credential_id(client_id) {
            return Err(RemoteError::Invalid("Invalid remote client id.".into()));
        }
        let _ = self.start(true).await;
        let id = client_id.to_owned();
        if self.inner.state().live.is_none() {
            // Off: forget it now, tell the relay on the next enable.
            if !self.inner.cfg.settings.disabled() {
                return Ok(Value::Null);
            }
            let queued = id.clone();
            self.inner.with_roster(move |roster, lane| roster.queue_revoke(lane, &queued)).await??;
            self.inner.cfg.events.owed_access_changed();
            self.inner.refresh();
            return self.descriptor().await;
        }
        let queued = id.clone();
        let recorded = self.inner.with_roster(move |roster, lane| roster.queue_revoke(lane, &queued).map(|()| roster.revocation(&queued))).await;
        self.drop_credential(client_id);
        let sent = self.control("revoke-client", revoke_payload(client_id)).await;
        self.inner.cfg.events.owed_access_changed();
        if let (Ok(Ok(Some(revocation))), Ok(_)) = (&recorded, &sent) {
            let (applied, revocation) = (id.clone(), *revocation);
            self.inner.with_roster(move |roster, lane| roster.applied(lane, &applied, revocation)).await??;
        }
        sent?;
        self.inner.refresh();
        self.descriptor().await
    }

    /// Every live connection of an unpaired credential loses access now.
    fn drop_credential(&self, credential_id: &str) {
        let (peers, out) = {
            let mut state = self.inner.state();
            let peers = state.table.revoke(credential_id);
            (peers, state.live.is_some())
        };
        for peer in &peers {
            self.inner.bridge.close_peer(peer);
            self.inner.cfg.registry.detach_peer(peer);
            if out {
                self.inner.cfg.link.send(&json!({ "type": "close-client", "clientId": peer, "reason": "device unpaired" }));
            }
        }
    }

    /// Revocations queued while access was off or the relay down, applied once the relay answers.
    async fn drain_pending_revokes(&self) {
        for _attempt in 0..80 {
            let Ok(roster) = self.inner.roster().await else { return };
            if lock(&roster).pending().is_empty() {
                return;
            }
            if self.inner.state().live.is_none() || self.list_clients().await.is_err() {
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
            let queued = lock(&roster).pending();
            for id in queued {
                // Checked right before the send: an entry withdrawn meanwhile is not sent.
                let Some(revocation) = lock(&roster).revocation(&id) else { continue };
                if self.control("revoke-client", revoke_payload(&id)).await.is_ok() {
                    let applied = id.clone();
                    let _ = self.inner.with_roster(move |roster, lane| roster.applied(lane, &applied, revocation)).await;
                }
            }
            self.inner.refresh();
            return;
        }
    }

    /// System resume: the socket is likely half-dead after sleep. The leg is redialed once, from
    /// the first retry delay.
    pub async fn resume(&self) -> Result<(), RemoteError> {
        let live = self.inner.state().live.clone();
        let Some(live) = live else { return self.start(false).await };
        live.cancel.cancel();
        let _gate = self.inner.enter().await;
        self.close_leg();
        self.start_gated(false).await
    }

    /// The OS is about to sleep: nothing the relay client timed before this point can be trusted
    /// afterwards. The leg closes without error spam; `resume` brings it back.
    pub fn suspend(&self) {
        self.close_leg();
        self.inner.refresh();
    }

    // ---- claims ---------------------------------------------------------------------------

    /// The window answered an approval prompt. False when no such prompt is open.
    pub async fn resolve_claim(&self, claim_id: &str, approved: bool) -> Result<bool, RemoteError> {
        let Some(pending) = self.inner.drop_claim(claim_id) else { return Ok(false) };
        pending.cancel.cancel();
        let live = self.inner.live().ok();
        let approved = approved && live.is_some();
        let (answer, client) = {
            let state = self.inner.state();
            let material = live.as_ref().map(|l| l.identity.pairing());
            let answer = match material {
                Some(material) => state.claims.answer(claim_id, approved, &material),
                None => crate::clients::claims::deny(claim_id),
            };
            (answer, state.claims.client_of(claim_id).map(str::to_owned))
        };
        let approving = answer.get("type").and_then(Value::as_str) == Some("claim-approve");
        self.inner.cfg.link.send(&answer);
        if approving && let Some(client) = client {
            // Approving the device again is an explicit re-pair: an unpair still queued for it is
            // withdrawn (the next drain would revoke the new pairing).
            let _ = self.inner.with_roster(move |roster, lane| roster.repaired(lane, &client)).await;
        }
        self.inner.refresh();
        Ok(true)
    }

    fn open_claim(&self, request: ClaimRequest) {
        let now = now_ms();
        let expires_at = request.expires_at.min(now + CLAIM_TIMEOUT_MS);
        let request = ClaimRequest { expires_at, ..request };
        let cancel = CancellationToken::new();
        let replaced: Vec<PendingClaim> = {
            let mut state = self.inner.state();
            // One container can have only one live prompt: a newer request replaces an older key
            // its reloaded page can no longer use.
            let stale: Vec<String> =
                state.pending_claims.iter().filter(|(_, p)| p.request.client_id == request.client_id).map(|(id, _)| id.clone()).collect();
            let replaced = stale.iter().filter_map(|id| state.pending_claims.remove(id)).collect();
            state.pending_claims.insert(request.claim_id.clone(), PendingClaim { request: request.clone(), cancel: cancel.clone() });
            replaced
        };
        for old in replaced {
            old.cancel.cancel();
            self.inner.cfg.link.send(&crate::clients::claims::deny(&old.request.claim_id));
        }
        let runtime = self.clone();
        let (claim_id, wait) = (request.claim_id, Duration::from_millis(expires_at.saturating_sub(now)));
        tokio::spawn(async move {
            tokio::select! {
                () = cancel.cancelled() => {}
                () = tokio::time::sleep(wait) => { let _ = runtime.resolve_claim(&claim_id, false).await; }
            }
        });
        self.inner.refresh();
    }

    // ---- controller keys ------------------------------------------------------------------

    /// A paired connection's key delivery; rejects anything else.
    pub async fn deliver_controller_key(&self, credential_id: &str, public_key: &str) -> Result<bool, RemoteError> {
        if credential_id.is_empty() {
            return Err(RemoteError::Invalid("This connection has no paired device identity.".into()));
        }
        let roster = self.inner.roster().await?;
        if lock(&roster).pending().iter().any(|id| id == credential_id) {
            return Err(RemoteError::Invalid("This device is no longer paired.".into()));
        }
        if !crate::identity::roster::is_controller_key(public_key) {
            return Err(RemoteError::Invalid("The controller key is invalid.".into()));
        }
        let (id, key) = (credential_id.to_owned(), public_key.to_owned());
        self.inner.with_roster(move |roster, lane| roster.set_controller_key(lane, &id, &key)).await??;
        self.inner.cfg.events.controller_key_delivered(public_key);
        self.inner.refresh();
        Ok(true)
    }

    pub async fn controller_keys(&self) -> Result<Vec<ControllerKeyRecord>, RemoteError> {
        let roster = self.inner.roster().await?;
        let keys = lock(&roster).controller_keys();
        Ok(keys)
    }

    pub async fn owed_controller_keys(&self) -> Result<OwedAccess, RemoteError> {
        let roster = self.inner.roster().await?;
        let owed = lock(&roster).owed_access();
        Ok(owed)
    }

    /// The desktop app took these over durably.
    pub async fn settle_owed(&self, keys: Vec<String>, unknown: u64) -> Result<(), RemoteError> {
        self.inner.with_roster(move |roster, lane| roster.settle_owed_access(lane, &keys, unknown)).await??;
        self.inner.refresh();
        Ok(())
    }

    // ---- native push ----------------------------------------------------------------------

    pub fn native_platforms(&self) -> Vec<NativePlatform> {
        self.inner.state().caps.native_platforms().to_vec()
    }

    pub async fn register_native_push(&self, client_id: &str, input: &Value) -> Result<bool, RemoteError> {
        let mut state_native = lock(&self.inner.state).native.take().ok_or_else(|| RemoteError::Invalid("Native push is unavailable on this connection.".into()))?;
        let platforms = self.native_platforms();
        let platform_ok = input.get("platform").and_then(Value::as_str).is_some_and(|p| platforms.iter().any(|known| known.name() == p));
        if !platform_ok {
            lock(&self.inner.state).native = Some(state_native);
            return Err(RemoteError::Invalid("Native push is unavailable for this platform.".into()));
        }
        let id = client_id.to_owned();
        let value = input.clone();
        let result = self
            .inner
            .durable(move |lane| {
                let input = NativePushInput {
                    client_id: &id,
                    platform: value.get("platform").unwrap_or(&Value::Null),
                    token: value.get("token").unwrap_or(&Value::Null),
                    public_key: value.get("publicKey").unwrap_or(&Value::Null),
                    sandbox: value.get("sandbox"),
                };
                let row = state_native.register(lane, &input, now_ms());
                (state_native, row)
            })
            .await;
        let (store, row) = result?;
        let envelope = {
            let mut state = self.inner.state();
            state.native = Some(store);
            row.as_ref().ok().and_then(|row| bind_envelope(row, &state.caps))
        };
        let row = row.map_err(|e| RemoteError::Invalid(e.to_string()))?;
        if let Some(envelope) = envelope {
            self.inner.cfg.link.send(&envelope);
        }
        let _: NativePushSubscription = row;
        Ok(true)
    }

    pub async fn remove_native_push(&self, client_id: &str, token: Option<&str>) -> Result<bool, RemoteError> {
        let store = lock(&self.inner.state).native.take().ok_or_else(|| RemoteError::Invalid("Native push is unavailable on this connection.".into()))?;
        let (id, token) = (client_id.to_owned(), token.map(str::to_owned));
        let (store, removed) = self
            .inner
            .durable(move |lane| {
                let mut store = store;
                let removed = store.remove(lane, &id, token.as_deref());
                (store, removed)
            })
            .await?;
        lock(&self.inner.state).native = Some(store);
        let removed = removed?;
        for row in &removed {
            self.inner.cfg.link.send(&unbind_envelope(row));
        }
        Ok(!removed.is_empty())
    }

    // ---- delivery (push-notifier.ts sendPush) ------------------------------------------------

    /// Whether this PC has an open relay leg.
    pub fn is_connected(&self) -> bool {
        self.inner.state().connected
    }

    /// This PC's relay device id (the `/d/<deviceId>/` route); empty while the relay is off.
    pub fn host_id(&self) -> String {
        self.inner.state().live.as_ref().map(|live| live.device.device_id.clone()).unwrap_or_default()
    }

    /// The client ids (paired credentials) of every phone that is not awaiting removal; empty
    /// until the roster has loaded (`prepare`).
    pub fn paired_devices(&self) -> Vec<String> {
        self.inner
            .roster
            .get()
            .map(|roster| lock(roster).list().into_iter().filter(|row| !row.pending_removal).map(|row| row.id).collect())
            .unwrap_or_default()
    }

    /// The paired devices with their roster rows (`id`, `browser`, `created_at`, ...), without
    /// those pending removal. Empty until `prepare()` has loaded the roster.
    pub fn paired_clients(&self) -> Vec<ClientInfo> {
        self.inner
            .roster
            .get()
            .map(|roster| lock(roster).list().into_iter().filter(|row| !row.pending_removal).collect())
            .unwrap_or_default()
    }

    /// Whether an attached connection of the paired credential `client_id` is painting
    /// `thread_id`: the question of native and relay Web Push, which are keyed by credential
    /// (`remote-relay-session-wiring.ts:146`). The phone states it with
    /// `ui/screenSessions/changed`, which the core records in the registry.
    pub fn is_credential_foreground(&self, client_id: &str, thread_id: &str) -> bool {
        self.inner.cfg.registry.credential_shows(client_id, thread_id)
    }

    /// Whether an attached connection that reported `browser_id` is painting `thread_id`: the
    /// question of direct Web Push, which is keyed by the browser id (`:159-160`). A phone's
    /// report never answers for a credential.
    pub fn is_browser_foreground(&self, browser_id: &str, thread_id: &str) -> bool {
        self.inner.cfg.registry.browser_shows(browser_id, thread_id)
    }

    /// Delivers one notification the engine decided on to one paired device, over every path
    /// that device registered: relay-owned Web Push, native push, and the PC-signed legacy
    /// subscription (only for a browser that holds no relay association). `Err` is the sentence
    /// shown to the user when nothing was handed over.
    pub async fn deliver_push(&self, push: &PushDelivery) -> Result<(), String> {
        let (host_id, reason) = (mixdog_js::slice_utf16(&push.host_id, 64), push.reason);
        let mut data = serde_json::Map::new();
        data.insert("sessionId".into(), json!(push.session_id));
        data.insert("reason".into(), json!(reason.name()));
        let mut payload = serde_json::Map::new();
        if !host_id.is_empty() {
            payload.insert("hostId".into(), json!(host_id));
            data.insert("hostId".into(), json!(host_id));
        }
        payload.insert("sessionId".into(), json!(push.session_id));
        payload.insert("title".into(), json!(push.title));
        payload.insert("body".into(), json!(push.body));
        payload.insert("reason".into(), json!(reason.name()));
        payload.insert("data".into(), Value::Object(data));
        let payload = mixdog_js::json_stringify(&Value::Object(payload));

        let mut sent = 0usize;
        let mut failures: Vec<String> = Vec::new();
        let (relay_targets, all_targets, native_rows, connected) = {
            let state = self.inner.state();
            let web = state.web.as_ref().filter(|_| state.caps.web_push());
            let all: Vec<WebPushTarget> = web.map(|w| w.targets().to_vec()).unwrap_or_default();
            let mine = all.iter().filter(|t| t.client_id == push.device_id).cloned().collect::<Vec<_>>();
            let native = state.native.as_ref().map(|s| s.list().to_vec()).unwrap_or_default();
            (mine, all, native, state.connected)
        };
        for target in &relay_targets {
            match encrypt_for_target(target, payload.as_bytes()) {
                Err(_) => failures.push("The browser’s subscription keys are invalid.".into()),
                Ok(body) => {
                    if self.inner.cfg.link.send(&RelayWebPush::send_envelope(target, &body)) {
                        sent += 1;
                    } else {
                        failures.push(RELAY_UNAVAILABLE.into());
                    }
                }
            }
        }
        for row in native_rows.iter().filter(|row| row.client_id == push.device_id) {
            let body = if reason == Reason::TurnFailed && push.body.is_empty() { TURN_FAILED_TEXT } else { push.body.as_str() };
            let (title, body) = NativePushContent::clip(&push.title, body);
            let content = NativePushContent {
                title,
                body,
                session_id: push.session_id.clone(),
                reason,
                approval_id: push.approval.as_ref().map(|(id, _)| id.clone()),
                allow_once: push.approval.as_ref().filter(|(_, allow)| *allow).map(|_| true),
                host_id: (!host_id.is_empty()).then(|| host_id.clone()),
            };
            let Ok(mx) = encrypt_native_push_fresh(&row.public_key, &content) else { continue };
            let message = json!({
                "platform": row.platform, "token": row.token, "sandbox": row.sandbox, "mx": mx,
                "reason": reason.for_relay(), "collapseKey": collapse_key(&push.session_id, reason),
            });
            let envelope = {
                let state = self.inner.state();
                crate::push::native::send_envelope(&row.platform, &message, &state.caps, connected)
            };
            if envelope.is_some_and(|envelope| self.inner.cfg.link.send(&envelope)) {
                sent += 1;
            } else {
                failures.push(RELAY_UNAVAILABLE.into());
            }
        }
        // The legacy subscription is dropped from the direct path once that same browser holds a
        // relay association, or its endpoint is one.
        if self.legacy_push().is_ok() {
            let listed = self.inner.durable({
                let store = crate::push::legacy::LegacyPushStore::new(&self.inner.cfg.dir);
                move |lane| store.list(lane).and_then(|rows| store.keys(lane).map(|keys| (rows, keys)))
            });
            if let Ok(Ok((rows, keys))) = listed.await {
                let browsers: std::collections::HashSet<&str> = all_targets.iter().map(|t| t.client_id.as_str()).collect();
                let endpoints: std::collections::HashSet<&str> = all_targets.iter().map(|t| t.endpoint.as_str()).collect();
                let poster = crate::push::legacy::ReqwestPoster::new();
                for row in rows.iter().filter(|row| row.client_id == push.device_id) {
                    if endpoints.contains(row.endpoint.as_str()) || (!row.client_id.is_empty() && browsers.contains(row.client_id.as_str())) {
                        continue;
                    }
                    let result = crate::push::legacy::send_web_push(&poster, row, &payload, &keys, now_ms()).await;
                    if result.expired {
                        failures.push("The push service no longer accepts this browser’s subscription.".into());
                        let (store, endpoint) = (crate::push::legacy::LegacyPushStore::new(&self.inner.cfg.dir), row.endpoint.clone());
                        let _ = self.inner.durable(move |lane| store.remove(lane, &endpoint)).await;
                    } else if result.status_code >= 400 || result.error.is_some() {
                        let why = result.error.unwrap_or_else(|| result.status_code.to_string());
                        failures.push(format!("The push service refused it ({why})."));
                    } else {
                        sent += 1;
                    }
                }
            }
        }
        match (sent, failures.into_iter().next()) {
            (0, Some(first)) => Err(first),
            _ => Ok(()),
        }
    }

    // ---- PC-signed Web Push (remote-push-methods.ts) ---------------------------------------

    /// The store of this PC's own VAPID identity and browsers; present while the relay runs
    /// (`requiredPush()` throws otherwise).
    fn legacy_push(&self) -> Result<crate::push::legacy::LegacyPushStore, RemoteError> {
        if self.inner.state().live.is_none() {
            return Err(RemoteError::Invalid("Push notifications are unavailable on this connection.".into()));
        }
        Ok(crate::push::legacy::LegacyPushStore::new(&self.inner.cfg.dir))
    }

    fn legacy_error(error: crate::push::legacy::LegacyPushError) -> RemoteError {
        match error {
            crate::push::legacy::LegacyPushError::Invalid(message) => RemoteError::Invalid(message),
            crate::push::legacy::LegacyPushError::Store(error) => RemoteError::Failed(error.to_string()),
        }
    }

    /// The applicationServerKey a browser subscribes with; minted on first ask.
    pub async fn push_public_key(&self) -> Result<String, RemoteError> {
        let store = self.legacy_push()?;
        self.inner.durable(move |lane| store.public_key(lane)).await?.map_err(|e| RemoteError::Failed(e.to_string()))
    }

    pub async fn register_push_subscription(&self, input: &Value) -> Result<bool, RemoteError> {
        let store = self.legacy_push()?;
        let input = input.clone();
        self.inner.durable(move |lane| store.register(lane, &input, now_ms())).await?.map_err(Self::legacy_error)?;
        Ok(true)
    }

    pub async fn remove_push_subscription(&self, endpoint: &Value) -> Result<bool, RemoteError> {
        let store = self.legacy_push()?;
        let endpoint = crate::push::legacy::required_string(Some(endpoint), "endpoint").map_err(Self::legacy_error)?;
        self.inner.durable(move |lane| store.remove(lane, &endpoint)).await?.map_err(|e| RemoteError::Failed(e.to_string()))
    }

    // ---- the leg's event loop ---------------------------------------------------------------

    async fn serve(&self, live: Arc<Live>, mut events: mpsc::Receiver<LegEvent>) {
        loop {
            let event = tokio::select! {
                () = live.cancel.cancelled() => return,
                event = events.recv() => match event { Some(event) => event, None => return },
            };
            match event {
                LegEvent::Open => self.on_open(&live).await,
                LegEvent::Lost { .. } => self.on_lost(&live),
                LegEvent::Raw(_) => {}
                LegEvent::Inbound(inbound) => self.on_inbound(&live, inbound).await,
            }
        }
    }

    async fn on_open(&self, live: &Arc<Live>) {
        let name = self.inner.host_name();
        {
            let mut state = self.inner.state();
            // Nothing the previous leg declared survives into this one.
            state.caps.reset();
            state.connected = true;
            if let Some(web) = state.web.as_mut() {
                web.reset();
            }
        }
        let version = self.inner.cfg.app_version.as_ref().map(|(v, r)| (v.as_str(), r.as_deref()));
        for frame in open_envelopes(&name, version, &live.pairing_token) {
            self.inner.cfg.link.send(&frame);
        }
        // A fresh leg holds no code of ours: ask for a new one if the screen is open.
        self.inner.pair_effects_call(|code, fx| code.on_connected(fx, &name));
        self.inner.refresh();
        let runtime = self.clone();
        tokio::spawn(async move { runtime.drain_pending_revokes().await });
    }

    fn on_lost(&self, live: &Arc<Live>) {
        let peers = {
            let mut state = self.inner.state();
            state.connected = false;
            state.table.close_all()
        };
        live.controls.reject_all(&ControlError::Failed("Relay disconnected.".into()));
        self.inner.bridge.close_all();
        for peer in peers {
            self.inner.cfg.registry.detach_peer(&peer);
        }
        self.inner.refresh();
    }

    async fn on_inbound(&self, live: &Arc<Live>, inbound: Inbound) {
        match inbound {
            Inbound::Capabilities(envelope) => {
                let (update, bindings) = {
                    let mut state = self.inner.state();
                    let update = state.caps.handle(&envelope);
                    let bindings: Vec<Value> = if update.rebind_native_push {
                        state.native.as_ref().map(|s| s.list().iter().filter_map(|row| bind_envelope(row, &state.caps)).collect()).unwrap_or_default()
                    } else {
                        Vec::new()
                    };
                    (update, bindings)
                };
                let _ = update;
                for envelope in bindings {
                    self.inner.cfg.link.send(&envelope);
                }
            }
            Inbound::ControlAnswer(envelope) => live.controls.settle(&envelope),
            Inbound::PairCode(envelope) => {
                let now = now_ms();
                self.inner.pair_effects_call(|code, fx| {
                    if envelope.get("type").and_then(Value::as_str) == Some("pair-code-used") {
                        code.on_used(fx, &envelope);
                    } else {
                        code.on_issued(fx, &envelope, now);
                    }
                });
            }
            Inbound::ClientClaim(envelope) => {
                let step = self.inner.state().claims.deliver(&envelope, now_ms());
                match step {
                    ClaimStep::Ignore => {}
                    ClaimStep::Conflict(deny) => {
                        // The conflicting delivery denies the first claim too.
                        let claim_id = envelope.get("claimId").and_then(Value::as_str).unwrap_or_default().to_owned();
                        if let Some(pending) = self.inner.drop_claim(&claim_id) {
                            pending.cancel.cancel();
                        }
                        self.inner.cfg.link.send(&deny);
                        self.inner.refresh();
                    }
                    ClaimStep::Ask(request) => self.open_claim(request),
                }
            }
            Inbound::ClientOpen { client_id, credential_id } => self.on_client_open(&client_id, &credential_id).await,
            Inbound::ClientClose(client_id) => {
                self.inner.state().table.close(&client_id);
                self.inner.bridge.close_peer(&client_id);
                self.inner.cfg.registry.detach_peer(&client_id);
            }
            Inbound::Frame { client_id, payload } => self.on_frame(live, &client_id, payload).await,
            Inbound::FrameTooLarge(envelope) => {
                if let Some(limit) = envelope.get("limit").and_then(Value::as_u64) {
                    self.inner.state().caps.learn_refused_limit(limit);
                }
            }
            Inbound::NativePushResult(result) => {
                if let Some(token) = invalid_token_of(&result).map(str::to_owned) {
                    let store = lock(&self.inner.state).native.take();
                    if let Some(mut store) = store {
                        let (store, _) = self
                            .inner
                            .durable(move |lane| {
                                let removed = store.remove_token(lane, &token);
                                (store, removed)
                            })
                            .await
                            .unwrap_or_else(|_| unreachable!("a lane job returns"));
                        lock(&self.inner.state).native = Some(store);
                    }
                }
            }
            Inbound::WebPushSubscriptions(envelope) => {
                let replies = {
                    let mut state = self.inner.state();
                    let offers = state.caps.web_push();
                    state.web.as_mut().map(|web| web.update(&envelope, offers).0).unwrap_or_default()
                };
                for reply in replies {
                    self.inner.cfg.link.send(&reply);
                }
            }
            // Media and the phone ICE are served by their own modules over the same leg; the
            // envelopes are theirs. A Web Push result only feeds diagnostics, which are not shown.
            Inbound::WebPushResult(_) | Inbound::Media(_) | Inbound::Ignored => {}
        }
    }

    async fn on_client_open(&self, client_id: &str, credential_id: &str) {
        let roster = self.inner.roster().await.ok();
        // A device whose unpair is recorded is refused, new connections included.
        if roster.is_some_and(|roster| !credential_id.is_empty() && lock(&roster).pending().iter().any(|id| id == credential_id)) {
            self.inner.cfg.link.send(&json!({ "type": "close-client", "clientId": client_id, "reason": "device unpaired" }));
            return;
        }
        let text = {
            let mut state = self.inner.state();
            let flags = challenge_flags(state.caps.binary_frames(), true, false);
            state.table.open(client_id, credential_id, &flags)
        };
        match text {
            Some(text) => {
                self.inner.cfg.link.send(&json_frame(client_id, &text));
            }
            None => {
                self.inner.cfg.link.send(&json!({ "type": "close-client", "clientId": client_id, "reason": "remote client limit reached" }));
            }
        }
    }

    async fn on_frame(&self, live: &Arc<Live>, client_id: &str, payload: Payload) {
        let host = self.inner.host_name();
        let routing = Map::new();
        let received = {
            let mut state = self.inner.state();
            state.table.receive(&live.identity, client_id, &payload, &ReadyContext { host_name: &host, routing: &routing })
        };
        match received {
            Received::Dropped => {}
            Received::Ready(frames) => {
                for sealed in frames {
                    self.inner.write_sealed(client_id, sealed).await;
                }
                self.attach_peer(client_id).await;
                self.inner.bridge.client_open(client_id);
            }
            Received::Plain { bytes, binary } => {
                let frame = if binary {
                    Frame::Binary(bytes)
                } else {
                    match String::from_utf8(bytes) {
                        Ok(text) => Frame::Text(text),
                        Err(_) => return self.close_client(client_id, "invalid encrypted relay frame"),
                    }
                };
                self.inner.bridge.from_phone(client_id, frame).await;
            }
            Received::Close(reason) => self.close_client(client_id, reason),
        }
    }

    /// Names the paired device behind an established channel for the approvals' device stamp:
    /// `deviceNameFor` (remote-relay-device-methods.ts:47) — the local alias, else the name the
    /// relay lists for the credential (trimmed, 80 units); empty falls to `connectionDevice`'s
    /// 'Web app' (remote-session-methods.ts:42).
    async fn attach_peer(&self, client_id: &str) {
        let credential = self.inner.state().table.credential_of(client_id).map(str::to_owned).unwrap_or_default();
        let row = match self.inner.roster().await {
            Ok(roster) => lock(&roster).list().into_iter().find(|row| row.id == credential),
            Err(_) => None,
        };
        let browser = row.as_ref().map(|row| row.browser.clone()).unwrap_or_default();
        let alias = self.inner.cfg.settings.device_aliases().get(&credential).cloned().unwrap_or_default();
        let listed = row.map(|row| mixdog_js::slice_utf16(mixdog_js::js_trim(&row.name), 80)).unwrap_or_default();
        let name = if !alias.is_empty() { alias } else { listed };
        let device = if name.is_empty() { crate::registry::DEFAULT_DEVICE_NAME } else { &name };
        self.inner.cfg.registry.attach_peer(client_id, &credential, device, &browser);
    }

    fn close_client(&self, client_id: &str, reason: &str) {
        self.inner.state().table.close(client_id);
        self.inner.bridge.close_peer(client_id);
        self.inner.cfg.registry.detach_peer(client_id);
        self.inner.cfg.link.send(&json!({ "type": "close-client", "clientId": client_id, "reason": reason }));
    }

    /// The `Devices` registry the approvals read (the composition shares it with the server).
    pub fn registry(&self) -> Arc<DeviceRegistry> {
        self.inner.cfg.registry.clone()
    }
}

fn is_credential_id(value: &str) -> bool {
    (8..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'-')
}

impl Inner {
    /// Seals one frame for a phone and writes it to the leg: binary relay frames when the relay
    /// takes them, otherwise JSON text frames.
    async fn write_sealed(&self, client_id: &str, sealed: Sealed) {
        let binary_frames = self.state().caps.binary_frames();
        let out = match sealed {
            Sealed::Text(text) => Outgoing::Text(json_frame(client_id, &text).to_string()),
            Sealed::Binary(bytes) => match binary_frames.then(|| encode_binary_frame(client_id, &bytes, false, false)).flatten() {
                Some(frame) => Outgoing::Binary(frame),
                None => {
                    use base64::Engine;
                    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    Outgoing::Text(json!({ "type": "frame", "clientId": client_id, "data": data }).to_string())
                }
            },
        };
        self.cfg.link.send_wait(out).await;
    }
}

struct WeakSink {
    inner: std::sync::Weak<Inner>,
}

#[async_trait]
impl PhoneSink for WeakSink {
    async fn deliver(&self, message: ToPhone) {
        if let Some(inner) = self.inner.upgrade() {
            RuntimeSink { inner }.deliver(message).await;
        }
    }
}

#[async_trait]
impl PhoneSink for RuntimeSink {
    async fn deliver(&self, message: ToPhone) {
        match message {
            ToPhone::Frame { peer_id, frame } => {
                let (bytes, binary) = match frame {
                    Frame::Text(text) => (text.into_bytes(), false),
                    Frame::Binary(bytes) => (bytes, true),
                };
                let sealed = self.inner.state().table.seal(&peer_id, &bytes, binary);
                if let Ok(sealed) = sealed {
                    self.inner.write_sealed(&peer_id, sealed).await;
                }
            }
            ToPhone::Close { peer_id, code: _, reason } => {
                self.inner.state().table.close(&peer_id);
                self.inner.cfg.registry.detach_peer(&peer_id);
                self.inner.cfg.link.send(&json!({ "type": "close-client", "clientId": peer_id, "reason": reason }));
            }
        }
    }
}
