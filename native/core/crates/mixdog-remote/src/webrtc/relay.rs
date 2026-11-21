//! The service end of the live-view signalling (`apps/desktop/src/main/remote-webrtc/relay.ts` at
//! b6f10295a): validates a phone's signal, checks the client streams the source it names, forwards
//! it to the viewer host, and carries the host's signals to that one phone.
//!
//! It also mirrors the input-ownership barrier at the point where relay frames are decoded in
//! order: from a decoded `promote-ack` until the matching `demote-ack`, the client's relay page
//! input for that source is refused, and its JPEG images are withheld while the channel owns the
//! view.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use serde_json::Value;
use serde_json::json;

use super::config::IceServer;
use super::signal::ClientSignal;
use super::signal::DesktopSignal;
use super::signal::SIGNAL_EVENT;
use super::signal::Source;

/// The relay connection a phone signal arrived on. A client id the relay reuses for a new
/// connection names a different origin.
pub type Origin = u64;

const SCREEN_REFUSED: &str = "Remote screen is not allowed for this device.";
const SOURCE_REFUSED: &str = "remote webrtc source is not streamed by this client.";

#[async_trait]
pub trait RelayDeps: Send + Sync {
    /// The client holds a live stream subscription of this browser session.
    fn subscribed(&self, client: &str, session: &str) -> bool;
    /// The client's subscription is a take-over still waiting for its first picture of the fitted layout.
    fn awaiting_fit(&self, client: &str, session: &str) -> bool;
    /// The whole-PC screen source is allowed for the connection that delivered the signal.
    async fn screen_authorized(&self, client: &str, origin: Origin) -> bool;
    /// Withhold (false) or resume (true) that client's JPEG images of the session. Called with the relay's state locked, so what it
    /// must send waits for [`RelayDeps::released`].
    fn set_images(&self, client: &str, session: &str, enabled: bool);
    /// The relay released its state after a step that may have called `set_images`: what that queued may go out now.
    fn released(&self) {}
    async fn resolve_ice_servers(&self) -> Result<Vec<IceServer>, String>;
    /// To the viewer host: a phone signal (a `ready` with the ICE servers).
    async fn forward(&self, client: &str, signal: &ClientSignal, ice_servers: Option<&[IceServer]>, origin: Origin) -> Result<(), String>;
    /// The viewer's departure, sent to the host without waiting for it.
    fn viewer_left(&self, client: &str, source_key: &str);
    /// The host's display list.
    async fn screen_displays(&self) -> Result<Value, String>;
    /// One encrypted, non-droppable push to that client.
    async fn send(&self, client: &str, payload: Value) -> Result<(), String>;
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Owner {
    Relay,
    Channel,
    None,
}

struct Ownership {
    connection_id: String,
    /// The epoch `promote` named, until a `demote` supersedes it.
    promote_epoch: Option<u64>,
    owner: Owner,
    /// The epoch `demote` named while the owner is `None`.
    demote_epoch: u64,
}

#[derive(Default)]
struct State {
    ownership: HashMap<String, Ownership>,
    /// The `ready` per client × source still resolving its ICE servers; a newer `ready` or the
    /// viewer's departure makes an older one stale.
    attempts: HashMap<String, PendingReady>,
    screen_replays: HashMap<String, HashMap<Origin, ScreenReplay>>,
    serial: u64,
}

const SCREEN_REPLAY_LIMIT: usize = 64;
const SCREEN_RESYNC: &str = "Screen signaling needs resynchronization. Reconnect before starting another screen viewer.";

struct ScreenReplay {
    // Attempt IDs are unique within the authenticated origin, but execution
    // order is not guaranteed. Only known cancellations enter the exact ranges.
    starts: HashMap<u64, String>,
    retired: Vec<(u64, u64)>,
    early_closes: Vec<(String, u64)>,
    needs_resync: bool,
    // Only this connection's final screen handoffs are serialized, never ICE or authorization.
    handoff: Arc<tokio::sync::Semaphore>,
}

impl Default for ScreenReplay {
    fn default() -> Self {
        Self { starts: HashMap::new(), retired: Vec::new(), early_closes: Vec::new(), needs_resync: false, handoff: Arc::new(tokio::sync::Semaphore::new(1)) }
    }
}

impl ScreenReplay {
    fn allows_ready(&mut self, source_key: &str, id: u64) -> Result<bool, String> {
        if self.is_retired(id) {
            return Ok(false);
        }
        if let Some(source) = self.starts.get(&id) {
            return Ok(source == source_key);
        }
        if let Some(index) = self.early_closes.iter().position(|(source, attempt)| source == source_key && *attempt == id) {
            self.early_closes.swap_remove(index);
            self.retire(id);
            return Ok(false);
        }
        self.reserve()?;
        self.starts.insert(id, source_key.to_owned());
        Ok(true)
    }

    fn cancel(&mut self, source_key: &str, id: u64) -> Result<(), String> {
        if self.is_retired(id) {
            return Ok(());
        }
        if let Some(source) = self.starts.get(&id) {
            if source == source_key {
                self.starts.remove(&id);
                self.retire(id);
            }
        } else if !self.early_closes.iter().any(|(source, attempt)| source == source_key && *attempt == id) {
            self.reserve()?;
            self.early_closes.push((source_key.to_owned(), id));
        }
        Ok(())
    }

    fn is_retired(&self, id: u64) -> bool {
        self.retired.iter().any(|&(first, last)| first <= id && id <= last)
    }

    fn retire(&mut self, id: u64) {
        // Replaces an existing slot; merging adjacent IDs never fills a hole.
        let (mut first, mut last) = (id, id);
        self.retired.retain(|&(lo, hi)| {
            if lo > id.saturating_add(1) || hi.saturating_add(1) < id {
                return true;
            }
            first = first.min(lo);
            last = last.max(hi);
            false
        });
        self.retired.push((first, last));
    }

    fn reserve(&mut self) -> Result<(), String> {
        if self.needs_resync || self.starts.len() + self.retired.len() + self.early_closes.len() >= SCREEN_REPLAY_LIMIT {
            // An unmatched close may no longer be recorded. Never admit a new ID
            // on this origin again; the RPC error asks for a fresh authenticated
            // connection. Repeats and closes for known viewers still work.
            self.needs_resync = true;
            return Err(SCREEN_RESYNC.to_owned());
        }
        Ok(())
    }
}

impl State {
    fn screen_replay(&mut self, client: &str, origin: Origin) -> &mut ScreenReplay {
        self.screen_replays.entry(client.to_owned()).or_default().entry(origin).or_default()
    }

    fn existing_replay(&mut self, client: &str, origin: Origin) -> Option<&mut ScreenReplay> {
        self.screen_replays.get_mut(client)?.get_mut(&origin)
    }
}

#[derive(PartialEq)]
struct PendingReady {
    serial: u64,
    viewer_attempt: Option<u64>,
    origin: Origin,
}

pub struct Relay<D> {
    deps: D,
    state: Mutex<State>,
}

fn key(client: &str, source_key: &str) -> String {
    format!("{client}\u{0}{source_key}")
}

fn session_of(source: &Source) -> Option<&str> {
    source.session_id()
}

impl<D: RelayDeps> Relay<D> {
    pub fn new(deps: D) -> Self {
        Self { deps, state: Mutex::new(State::default()) }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn release(&self, client: &str, source_key: &str, session: Option<&str>) {
        let entry = self.state().ownership.remove(&key(client, source_key));
        if let (Some(entry), Some(session)) = (entry, session)
            && entry.owner == Owner::Channel
        {
            self.deps.set_images(client, session, true);
            self.deps.released();
        }
    }

    /// Decode-time step of a phone's signal (refuses an invalid or unauthorized one).
    pub fn accept(&self, client: &str, raw: &Value) -> Result<ClientSignal, String> {
        let signal = ClientSignal::parse(raw)?;
        // A screen source is authorized in `forward`, for the connection that delivered it; it has
        // no relay input or JPEG view to gate here.
        let Some(session) = session_of(signal.source()) else {
            return Ok(signal);
        };
        if !self.deps.subscribed(client, session) {
            return Err(SOURCE_REFUSED.to_owned());
        }
        let owner_key = key(client, &signal.source().key());
        let mut state = self.state();
        let settled = match (state.ownership.get_mut(&owner_key), &signal) {
            (Some(entry), ClientSignal::PromoteAck { connection, input_epoch })
                if entry.owner == Owner::Relay && entry.connection_id == connection.connection_id && entry.promote_epoch == Some(*input_epoch) =>
            {
                entry.owner = Owner::Channel;
                self.deps.set_images(client, session, false);
                false
            }
            (Some(entry), ClientSignal::DemoteAck { connection, input_epoch }) => {
                entry.owner == Owner::None && entry.connection_id == connection.connection_id && entry.demote_epoch == *input_epoch
            }
            _ => false,
        };
        if settled {
            state.ownership.remove(&owner_key);
        }
        drop(state);
        self.deps.released();
        Ok(signal)
    }

    /// Execution step: hand the signal to the host, a `ready` with the ICE servers. `origin` is the
    /// connection that delivered it; a screen signal is authorized and forwarded for that
    /// connection only. A screen resync error requires a fresh authenticated connection, not a
    /// retry on this one.
    pub async fn forward(&self, client: &str, signal: &ClientSignal, origin: Origin) -> Result<(), String> {
        match signal {
            ClientSignal::Ready { source, viewer_attempt, .. } => self.forward_ready(client, signal, source, viewer_attempt, origin).await,
            ClientSignal::CancelScreen { source, viewer_attempt, .. } => self.forward_cancel_screen(client, signal, source, *viewer_attempt, origin).await,
            _ => self.forward_plain(client, signal, origin).await,
        }
    }

    async fn forward_cancel_screen(&self, client: &str, signal: &ClientSignal, source: &Source, viewer_attempt: u64, origin: Origin) -> Result<(), String> {
        let handoff = self.state().screen_replay(client, origin).handoff.clone();
        if !self.deps.screen_authorized(client, origin).await {
            return Err(SCREEN_REFUSED.to_owned());
        }
        let _handoff = handoff.acquire().await.expect("the handoff gate is never closed");
        let source_key = source.key();
        let key = key(client, &source_key);
        {
            let mut state = self.state();
            let matches = state.attempts.get(&key).is_some_and(|pending| pending.origin == origin && pending.viewer_attempt == Some(viewer_attempt));
            let Some(replay) = state.existing_replay(client, origin).filter(|replay| Arc::ptr_eq(&replay.handoff, &handoff)) else {
                return Ok(());
            };
            replay.cancel(&source_key, viewer_attempt)?;
            if matches {
                state.attempts.remove(&key);
            }
        }
        self.deps.forward(client, signal, None, origin).await
    }

    async fn forward_plain(&self, client: &str, signal: &ClientSignal, origin: Origin) -> Result<(), String> {
        if matches!(signal.source(), Source::Screen { .. }) && !self.deps.screen_authorized(client, origin).await {
            return Err(SCREEN_REFUSED.to_owned());
        }
        if let (ClientSignal::MediaReady { .. }, Source::Browser { session_id }) = (signal, signal.source())
            && self.deps.awaiting_fit(client, session_id)
        {
            return Ok(());
        }
        self.deps.forward(client, signal, None, origin).await
    }

    async fn forward_ready(&self, client: &str, signal: &ClientSignal, source: &Source, viewer_attempt: &Option<u64>, origin: Origin) -> Result<(), String> {
        // The attempt is registered before anything is awaited, so the order `ready`s were
        // decoded in decides which one is current.
        let source_key = source.key();
        let attempt_key = key(client, &source_key);
        let session = session_of(source);
        let (attempt, handoff) = {
            let mut state = self.state();
            if let Some(id) = viewer_attempt {
                let allowed = state.screen_replay(client, origin).allows_ready(&source_key, *id)?;
                let newer = state.attempts.get(&attempt_key).is_some_and(|pending| pending.origin == origin && pending.viewer_attempt > Some(*id));
                if !allowed || newer {
                    return Ok(());
                }
            }
            let handoff = session.is_none().then(|| state.screen_replay(client, origin).handoff.clone());
            state.serial += 1;
            let serial = state.serial;
            state.attempts.insert(attempt_key.clone(), PendingReady { serial, viewer_attempt: *viewer_attempt, origin });
            (serial, handoff)
        };
        // The viewer may leave or a newer `ready` take over at every await: this one is then dropped.
        let current = || self.state().attempts.get(&attempt_key).is_some_and(|pending| pending.serial == attempt);
        let authorized = || async {
            match session {
                None => self.deps.screen_authorized(client, origin).await,
                Some(session) => self.deps.subscribed(client, session),
            }
        };
        let refuse = || {
            let mut state = self.state();
            if state.attempts.get(&attempt_key).is_some_and(|pending| pending.serial == attempt) {
                state.attempts.remove(&attempt_key);
            }
            Err(if session.is_none() { SCREEN_REFUSED } else { SOURCE_REFUSED }.to_owned())
        };
        if session.is_none() {
            let allowed = authorized().await;
            if !current() {
                return Ok(());
            }
            if !allowed {
                return refuse();
            }
        }
        // Fresh per connection attempt (the credential cache decides reuse).
        let ice_servers = self.deps.resolve_ice_servers().await?;
        if !current() {
            return Ok(());
        }
        let allowed = authorized().await;
        let _handoff = if let Some(handoff) = &handoff { Some(handoff.acquire().await.expect("the handoff gate is never closed")) } else { None };
        if !allowed {
            if !current() {
                return Ok(());
            }
            return refuse();
        }
        {
            let mut state = self.state();
            if !state.attempts.get(&attempt_key).is_some_and(|pending| pending.serial == attempt) {
                return Ok(());
            }
            state.attempts.remove(&attempt_key);
        }
        self.deps.forward(client, signal, Some(&ice_servers), origin).await
    }

    /// A host signal to its phone.
    pub async fn send(&self, client: &str, raw: &Value) -> Result<(), String> {
        let signal = DesktopSignal::parse(raw)?;
        let session = session_of(signal.source());
        let source_key = signal.source().key();
        let owner_key = key(client, &source_key);
        match &signal {
            DesktopSignal::Offer { connection, .. } => {
                self.release(client, &source_key, session);
                self.state().ownership.insert(
                    owner_key,
                    Ownership { connection_id: connection.connection_id.clone(), promote_epoch: None, owner: Owner::Relay, demote_epoch: 0 },
                );
            }
            DesktopSignal::Promote { connection, input_epoch, .. } => {
                if let Some(entry) = self.state().ownership.get_mut(&owner_key)
                    && entry.connection_id == connection.connection_id
                    && entry.owner == Owner::Relay
                {
                    entry.promote_epoch = Some(*input_epoch);
                }
            }
            DesktopSignal::Demote { connection, input_epoch, .. } => {
                if let Some(entry) = self.state().ownership.get_mut(&owner_key)
                    && entry.connection_id == connection.connection_id
                {
                    // JPEG comes back at once; no page input until the phone's ack.
                    if let (Owner::Channel, Some(session)) = (entry.owner, session) {
                        self.deps.set_images(client, session, true);
                    }
                    entry.owner = Owner::None;
                    entry.promote_epoch = None;
                    entry.demote_epoch = *input_epoch;
                }
            }
            DesktopSignal::Close { connection, .. } => {
                let owned = self.state().ownership.get(&owner_key).is_some_and(|entry| entry.connection_id == connection.connection_id);
                if owned {
                    self.release(client, &source_key, session);
                }
            }
            DesktopSignal::Geometry { .. } | DesktopSignal::Candidate { .. } => {}
        }
        self.deps.released();
        self.deps.send(client, json!({ "event": SIGNAL_EVENT, "payload": signal.to_json() })).await
    }

    /// The displays a client may choose, once its connection's screen access is checked.
    pub async fn screen_displays(&self, client: &str, origin: Origin) -> Result<Value, String> {
        if !self.deps.screen_authorized(client, origin).await {
            return Err(SCREEN_REFUSED.to_owned());
        }
        self.deps.screen_displays().await
    }

    /// Whether this client's relay page input for the session may run now.
    pub fn relay_input_allowed(&self, client: &str, session: &str) -> bool {
        let source = Source::Browser { session_id: session.to_owned() };
        let owner = self.state().ownership.get(&key(client, &source.key())).map(|entry| entry.owner);
        !matches!(owner, Some(Owner::Channel | Owner::None))
    }

    /// The client's connection left the relay registry: its screen `ready`s still resolving are
    /// cancelled (dropped, never forwarded).
    pub fn connection_removed(&self, client: &str) {
        let prefix = key(client, "screen:");
        let mut state = self.state();
        state.attempts.retain(|attempt, _| !attempt.starts_with(&prefix));
        state.screen_replays.remove(client);
    }

    /// The client stopped streaming the session (or left the relay).
    pub fn viewer_left(&self, client: &str, session: &str) {
        let source_key = Source::Browser { session_id: session.to_owned() }.key();
        self.release(client, &source_key, Some(session));
        self.state().attempts.remove(&key(client, &source_key));
        self.deps.viewer_left(client, &source_key);
    }
}
