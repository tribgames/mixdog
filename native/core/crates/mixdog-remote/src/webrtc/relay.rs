//! The service end of the live-view signalling (`apps/desktop/src/main/remote-webrtc/relay.ts` at
//! b6f10295a): validates a phone's signal, checks the client streams the source it names, forwards
//! it to the viewer host, and carries the host's signals to that one phone.
//!
//! It also mirrors the input-ownership barrier at the point where relay frames are decoded in
//! order: from a decoded `promote-ack` until the matching `demote-ack`, the client's relay page
//! input for that source is refused, and its JPEG images are withheld while the channel owns the
//! view.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::PoisonError;

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
    /// Withhold (false) or resume (true) that client's JPEG images of the session.
    fn set_images(&self, client: &str, session: &str, enabled: bool);
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
    attempts: HashMap<String, u64>,
    serial: u64,
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
                if entry.owner == Owner::Relay
                    && entry.connection_id == connection.connection_id
                    && entry.promote_epoch == Some(*input_epoch) =>
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
        Ok(signal)
    }

    /// Execution step: hand the signal to the host, a `ready` with the ICE servers. `origin` is the
    /// connection that delivered it; a screen signal is authorized and forwarded for that
    /// connection only.
    pub async fn forward(&self, client: &str, signal: &ClientSignal, origin: Origin) -> Result<(), String> {
        let ClientSignal::Ready { source, .. } = signal else {
            if matches!(signal.source(), Source::Screen { .. }) && !self.deps.screen_authorized(client, origin).await {
                return Err(SCREEN_REFUSED.to_owned());
            }
            // A take-over is promoted only after its first picture of the fitted layout went out:
            // earlier media-readys are dropped, the phone re-sends.
            if let (ClientSignal::MediaReady { .. }, Source::Browser { session_id }) = (signal, signal.source())
                && self.deps.awaiting_fit(client, session_id)
            {
                return Ok(());
            }
            return self.deps.forward(client, signal, None, origin).await;
        };
        // The attempt is registered before anything is awaited, so the order `ready`s were
        // decoded in decides which one is current.
        let attempt_key = key(client, &source.key());
        let attempt = {
            let mut state = self.state();
            state.serial += 1;
            let attempt = state.serial;
            state.attempts.insert(attempt_key.clone(), attempt);
            attempt
        };
        // The viewer may leave or a newer `ready` take over at every await: this one is then dropped.
        let current = || self.state().attempts.get(&attempt_key) == Some(&attempt);
        let session = session_of(source);
        let authorized = || async {
            match session {
                None => self.deps.screen_authorized(client, origin).await,
                Some(session) => self.deps.subscribed(client, session),
            }
        };
        let refuse = || {
            self.state().attempts.remove(&attempt_key);
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
        if !current() {
            return Ok(());
        }
        if !allowed {
            return refuse();
        }
        self.state().attempts.remove(&attempt_key);
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
        self.state().attempts.retain(|attempt, _| !attempt.starts_with(&prefix));
    }

    /// The client stopped streaming the session (or left the relay).
    pub fn viewer_left(&self, client: &str, session: &str) {
        let source_key = Source::Browser { session_id: session.to_owned() }.key();
        self.release(client, &source_key, Some(session));
        self.state().attempts.remove(&key(client, &source_key));
        self.deps.viewer_left(client, &source_key);
    }
}
