//! The live-view host (`apps/desktop/src/main/remote-webrtc/host.ts` at b6f10295a): one
//! [`Viewer`] per paired client × browser source, the sources' newest pictures, and the peer
//! connections' events routed back to their viewer. Phone signals arrive validated by the relay.
//!
//! Where Node's host fed one sender window (one picture in flight per source) the core owns the
//! peers and gives every connection an encoder of its own over the source's shared newest picture
//! (see [`HostEnv::push_picture`]): no picture is in flight, and the pictures a viewer sees are the
//! same, a new connection starting from the newest one. The measurement line (`measure`) is a
//! diagnostic and is not ported.
//!
//! The host is runtime-free: everything it runs later (the input lanes, signal delivery, resize
//! calls) goes through [`HostEnv::spawn`], so a test drives it by polling.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::Weak;

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use futures::channel::mpsc;
use futures::channel::oneshot;
use futures::future::BoxFuture;
use serde_json::Value;
use serde_json::json;

use super::config::Candidate;
use super::config::IceServer;
use super::signal::ClientSignal;
use super::signal::CloseReason;
use super::signal::DesktopSignal;
use super::signal::Geometry;
use super::signal::Resize;
use super::signal::Source;
use super::signal::TransportState;
use super::signal::VideoLimit;
use super::viewer::Page;
use super::viewer::Viewer;
use super::viewer::ViewerEffects;

/// A browser page the host streams: what the host shows now and how it takes the phone's input.
#[async_trait]
pub trait VideoSource: Send + Sync {
    /// A viewer needs pictures (idempotent).
    fn start(&self);
    /// No viewer of the source remains (idempotent).
    fn stop(&self);
    /// The document and the locked geometry the source shows now.
    fn page(&self) -> (Option<String>, Option<Geometry>);
    /// A validated channel input, through the source's own authorization and dispatch path.
    async fn dispatch(&self, control: &Value) -> Result<(), String>;
    async fn resize(&self, request: &Resize) -> Result<(), String>;
    /// The phone's video limit: the source may capture larger, locking a new geometry.
    fn video_limit(&self, limit: VideoLimit);
}

/// One picture of a source, as it arrived: the document and geometry generation it shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Picture {
    pub document_id: Option<String>,
    pub generation: u64,
    pub data: Bytes,
}

/// What the host needs of its surroundings: the peers it drives, the relay it signals through,
/// the sources it resolves, time and a place to run work.
pub trait HostEnv: Send + Sync + 'static {
    fn spawn(&self, work: BoxFuture<'static, ()>);
    /// To one phone, through the E2EE relay. The call itself orders the signal: the host awaits the
    /// returned futures of a client in the order it made the calls.
    fn send_signal(&self, client: &str, signal: &DesktopSignal) -> BoxFuture<'static, Result<(), String>>;
    /// The source a viewer names, or `None` when it is not streamed (to this client).
    fn source(&self, source: &Source, client: &str, signal: &str) -> Option<Arc<dyn VideoSource>>;
    /// A new peer connection for the source. Its encoder starts from the source's newest picture.
    fn open(&self, connection_id: &str, source_key: &str, ice_servers: &[IceServer], receive_codecs: &[String]);
    fn answer(&self, connection_id: &str, sdp: &str);
    fn candidate(&self, connection_id: &str, candidate: &Option<Candidate>);
    fn channel_send(&self, connection_id: &str, text: &str);
    fn close(&self, connection_id: &str);
    /// The newest picture of the source: every connection's encoder reads it, and a connection that
    /// comes up later starts from it.
    fn push_picture(&self, source_key: &str, picture: &Picture);
    /// The source ended: its shared picture goes.
    fn source_closed(&self, source_key: &str);
    fn report(&self, event: &str, data: Value);
    fn new_connection_id(&self) -> String;
    /// Wall clock, milliseconds.
    fn now(&self) -> f64;
    /// Runs `run(handle)` after `ms` unless cleared; returns the handle.
    fn set_timer(&self, ms: u64, run: Arc<dyn Fn(u64) + Send + Sync>) -> u64;
    fn clear_timer(&self, handle: u64);
}

/// What a peer connection tells the host.
#[derive(Debug, Clone)]
pub enum SenderEvent {
    Offer { connection_id: String, sdp: String },
    Candidate { connection_id: String, candidate: Option<Candidate> },
    /// DTLS is up; the certificate is `{fingerprintAlgorithm, fingerprint}`.
    Connected { connection_id: String, certificate: Option<Value> },
    Failed { connection_id: String, reason: CloseReason },
    Channel { connection_id: String, text: String, received_at: f64 },
    /// The source's capture track is live and delivers frames of the current geometry by itself.
    CaptureOk { source_key: String },
    /// No track to send for the source: every connection of it falls back.
    CaptureFailed { source_key: String, detail: String },
    /// The peers are gone (the sender crashed or closed).
    Gone,
}

const CLIENT_ID_INVALID: &str = "remote webrtc client id is invalid.";
const SOURCE_NOT_STREAMED: &str = "remote webrtc source is not streamed.";

fn client_id_valid(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn page_key(document_id: &Option<String>, geometry: &Option<Geometry>) -> String {
    format!("{}|{}", document_id.as_deref().unwrap_or(""), geometry.as_ref().map_or(0, |g| g.generation))
}

fn viewer_key(client: &str, source_key: &str) -> String {
    format!("{client}\u{0}{source_key}")
}

/// A connection state that holds a peer connection.
fn live(state: TransportState) -> bool {
    matches!(state, TransportState::Negotiating | TransportState::Connected | TransportState::Promoting | TransportState::Webrtc)
}

struct Feed {
    source: Arc<dyn VideoSource>,
    /// `documentId|generation` the count below belongs to.
    current_key: String,
    frames_since_current: u64,
}

struct Entry {
    client: String,
    source_key: String,
    /// The viewer's state, kept by its `state` reports: effects run while the viewer is locked, so
    /// they read this instead of asking the viewer.
    state: Mutex<TransportState>,
    viewer: Viewer<Effects>,
}

type Queued = (BoxFuture<'static, Result<(), String>>, String, &'static str, oneshot::Sender<()>);

/// A map that iterates in insertion order, as Node's `Map` does: the order viewers and connections
/// are failed or stopped in is observable in the signals they send.
struct Ordered<V>(Vec<(String, V)>);

impl<V> Default for Ordered<V> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<V> Ordered<V> {
    fn get(&self, key: &str) -> Option<&V> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// Replaces in place, or appends.
    fn insert(&mut self, key: String, value: V) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key, value)),
        }
    }

    fn remove(&mut self, key: &str) -> Option<V> {
        let at = self.0.iter().position(|(k, _)| k == key)?;
        Some(self.0.remove(at).1)
    }

    fn values(&self) -> impl Iterator<Item = &V> {
        self.0.iter().map(|(_, v)| v)
    }

    fn keys(&self) -> impl Iterator<Item = &String> {
        self.0.iter().map(|(k, _)| k)
    }

    fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.0.iter().map(|(k, v)| (k, v))
    }
}
#[derive(Default)]
struct State {
    viewers: Ordered<Arc<Entry>>,
    feeds: HashMap<String, Feed>,
    /// Peer connection id → its viewer.
    connections: Ordered<Arc<Entry>>,
    /// Per client, the signals to its phone in the order they were made.
    outgoing: HashMap<String, mpsc::UnboundedSender<Queued>>,
}

struct Shared {
    env: Arc<dyn HostEnv>,
    state: Mutex<State>,
    /// Signals queued while one phone signal is handled: its call settles after them, so a `demote`
    /// that the phone's `close` caused reaches it before the answer.
    outbox: Mutex<Vec<oneshot::Receiver<()>>>,
    /// Held while a phone signal is handled and its outbox collected.
    turn: Mutex<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    fn wanted(&self, source_key: &str) -> bool {
        lock(&self.state).viewers.values().any(|e| e.source_key == source_key && live(*lock(&e.state)))
    }

    /// Queues `signal` to the client's phone behind the ones made before it.
    fn send(self: &Arc<Self>, client: &str, signal: &DesktopSignal) {
        let call = self.env.send_signal(client, signal);
        let (done, received) = oneshot::channel();
        lock(&self.outbox).push(received);
        let item: Queued = (call, signal.source().key(), signal.type_name(), done);
        let mut state = lock(&self.state);
        let queue = state.outgoing.entry(client.to_owned()).or_insert_with(|| {
            let (queue, items) = mpsc::unbounded();
            self.env.spawn(Box::pin(deliver(self.env.clone(), items)));
            queue
        });
        let _ = queue.unbounded_send(item);
    }

    /// Runs the viewer's input lane if it has work and none is running.
    fn kick(self: &Arc<Self>, entry: &Arc<Entry>) {
        if entry.viewer.wants_pump() {
            let entry = entry.clone();
            self.env.spawn(Box::pin(async move { entry.viewer.pump().await }));
        }
    }
}

/// Awaits one client's signals in the order they were made; a failure is reported and the loop goes on.
async fn deliver(env: Arc<dyn HostEnv>, mut items: mpsc::UnboundedReceiver<Queued>) {
    while let Some((call, source_key, kind, done)) = items.next().await {
        if let Err(error) = call.await {
            env.report("signal-failed", json!({ "source": source_key, "type": kind, "error": error }));
        }
        let _ = done.send(());
    }
}
/// The effects of one viewer: its place in the host.
struct Effects {
    shared: Arc<Shared>,
    entry: Weak<Entry>,
    client: String,
    source_key: String,
    source: Arc<dyn VideoSource>,
}

impl Effects {
    fn entry(&self) -> Option<Arc<Entry>> {
        self.entry.upgrade()
    }
}

#[async_trait]
impl ViewerEffects for Effects {
    fn signal(&self, signal: &DesktopSignal) {
        self.shared.send(&self.client, signal);
    }

    fn open(&self, connection_id: &str, ice_servers: &[IceServer], receive_codecs: &[String]) {
        if let Some(entry) = self.entry() {
            lock(&self.shared.state).connections.insert(connection_id.to_owned(), entry);
        }
        self.source.start();
        self.shared.env.open(connection_id, &self.source_key, ice_servers, receive_codecs);
    }

    fn answer(&self, connection_id: &str, sdp: &str) {
        self.shared.env.answer(connection_id, sdp);
    }

    fn candidate(&self, connection_id: &str, candidate: &Option<Candidate>) {
        self.shared.env.candidate(connection_id, candidate);
    }

    fn channel_send(&self, connection_id: &str, text: &str) {
        self.shared.env.channel_send(connection_id, text);
    }

    fn close(&self, connection_id: &str) {
        let ours = {
            let mut state = lock(&self.shared.state);
            match (state.connections.get(connection_id), self.entry()) {
                (Some(held), Some(entry)) if Arc::ptr_eq(held, &entry) => state.connections.remove(connection_id).is_some(),
                _ => false,
            }
        };
        if !ours {
            return;
        }
        self.shared.env.close(connection_id);
        let others = lock(&self.shared.state).connections.values().any(|other| other.source_key == self.source_key);
        if !self.shared.wanted(&self.source_key) && !others {
            self.source.stop();
        }
    }

    async fn dispatch(&self, control: &Value) -> Result<(), String> {
        self.source.dispatch(control).await
    }

    async fn release(&self, releases: Vec<Value>) {
        // A browser source has no release of its own: the mouse releases the channel still owes.
        for control in releases {
            let _ = self.source.dispatch(&control).await;
        }
    }

    fn page(&self) -> Page {
        let (document_id, geometry) = self.source.page();
        let key = page_key(&document_id, &geometry);
        let frames = lock(&self.shared.state).feeds.get(&self.source_key).filter(|feed| feed.current_key == key).map_or(0, |feed| feed.frames_since_current);
        Page { document_id, geometry, frames_since_current: frames }
    }

    fn new_connection_id(&self) -> String {
        self.shared.env.new_connection_id()
    }

    fn now(&self) -> f64 {
        self.shared.env.now()
    }

    fn set_timer(&self, ms: u64) -> u64 {
        let entry = self.entry.clone();
        let shared = self.shared.clone();
        self.shared.env.set_timer(
            ms,
            Arc::new(move |handle| {
                let Some(entry) = entry.upgrade() else { return };
                if let Err(error) = entry.viewer.timer_fired(handle) {
                    shared.env.report("timer-failed", json!({ "source": entry.source_key, "error": error }));
                }
                shared.kick(&entry);
            }),
        )
    }

    fn clear_timer(&self, handle: u64) {
        self.shared.env.clear_timer(handle);
    }

    fn report(&self, event: &str, data: Value) {
        if event == "state"
            && let Some(to) = data["to"].as_str().and_then(|name| TransportState::ALL.into_iter().find(|s| s.name() == name))
            && let Some(entry) = self.entry()
        {
            *lock(&entry.state) = to;
        }
        let mut merged = json!({ "source": self.source_key });
        if let (Some(into), Value::Object(from)) = (merged.as_object_mut(), data) {
            into.extend(from);
        }
        self.shared.env.report(event, merged);
    }

    fn receiver_stats(&self, _stats: &Value) {}

    fn promoted(&self) {}
}

/// The host: cheap to clone, shared by the signal handler and the peers' event pumps.
#[derive(Clone)]
pub struct LiveHost {
    shared: Arc<Shared>,
}

impl LiveHost {
    pub fn new(env: Arc<dyn HostEnv>) -> Self {
        Self { shared: Arc::new(Shared { env, state: Mutex::default(), outbox: Mutex::default(), turn: Mutex::new(()) }) }
    }

    /// A phone's signal, forwarded by the relay with the client it came from; settles once every
    /// signal it caused has been handed to the relay.
    pub async fn signal(&self, client: &str, signal: &ClientSignal, ice_servers: &[IceServer]) -> Result<(), String> {
        let sent = {
            let _turn = lock(&self.shared.turn);
            lock(&self.shared.outbox).clear();
            self.handle(client, signal, ice_servers)?;
            std::mem::take(&mut *lock(&self.shared.outbox))
        };
        for done in sent {
            let _ = done.await;
        }
        Ok(())
    }

    fn handle(&self, client: &str, signal: &ClientSignal, ice_servers: &[IceServer]) -> Result<(), String> {
        if !client_id_valid(client) {
            return Err(CLIENT_ID_INVALID.to_owned());
        }
        let source_ref = signal.source();
        let source = self.shared.env.source(source_ref, client, signal.type_name());
        let (Some(source), Source::Browser { .. }) = (source, source_ref) else { return Err(SOURCE_NOT_STREAMED.to_owned()) };
        let source_key = source_ref.key();
        let key = viewer_key(client, &source_key);
        let existing = lock(&self.shared.state).viewers.get(&key).cloned();
        let entry = match existing {
            Some(entry) => entry,
            None => {
                let entry = self.create_viewer(client, &source_key, source_ref, source.clone());
                {
                    let mut state = lock(&self.shared.state);
                    state.viewers.insert(key.clone(), entry.clone());
                    state.feeds.entry(source_key.clone()).or_insert_with(|| Feed { source: source.clone(), current_key: String::new(), frames_since_current: 0 });
                }
                // The locked geometry goes to every new viewer first.
                let first = entry.viewer.geometry_changed();
                self.shared.kick(&entry);
                first?;
                entry
            }
        };
        let outcome = match signal {
            ClientSignal::Ready { receive_codecs, video_limit, .. } => {
                // A larger video limit than the stream's frame bound widens the capture before the
                // offer, which then carries the new geometry.
                if let Some(limit) = video_limit {
                    source.video_limit(*limit);
                }
                entry.viewer.ready(receive_codecs.clone(), ice_servers.to_vec())
            }
            ClientSignal::GeometryAck { geometry_generation, .. } => {
                entry.viewer.geometry_ack(*geometry_generation);
                Ok(())
            }
            ClientSignal::ResizeRequest { resize, .. } => {
                let (env, resize, report_key) = (self.shared.env.clone(), resize.clone(), source_key.clone());
                self.shared.env.spawn(Box::pin(async move {
                    if let Err(error) = source.resize(&resize).await {
                        env.report("resize-failed", json!({ "source": report_key, "error": error }));
                    }
                }));
                Ok(())
            }
            // The phone's viewer left: closed, not demoted (the channel's held buttons are still
            // released), and forgotten — its next `ready` is a new viewer.
            ClientSignal::Close { connection, reason: CloseReason::ViewerLeft, .. } => {
                if entry.viewer.view().connection_id.as_deref() == Some(connection.connection_id.as_str()) {
                    self.stop_viewer(&key);
                }
                Ok(())
            }
            other => entry.viewer.signal(other),
        };
        self.shared.kick(&entry);
        outcome
    }

    fn create_viewer(&self, client: &str, source_key: &str, source_ref: &Source, source: Arc<dyn VideoSource>) -> Arc<Entry> {
        let shared = self.shared.clone();
        Arc::new_cyclic(|weak| Entry {
            client: client.to_owned(),
            source_key: source_key.to_owned(),
            state: Mutex::new(TransportState::Relay),
            viewer: Viewer::new(
                source_ref.clone(),
                Effects { shared, entry: weak.clone(), client: client.to_owned(), source_key: source_key.to_owned(), source },
            )
            .expect("a browser source has a viewer"),
        })
    }

    fn stop_viewer(&self, key: &str) {
        let (entry, last_of_client) = {
            let mut state = lock(&self.shared.state);
            let Some(entry) = state.viewers.remove(key) else { return };
            let last = !state.viewers.values().any(|other| other.client == entry.client);
            if last {
                // The delivery loop ends once what is queued has been sent.
                state.outgoing.remove(&entry.client);
            }
            (entry, last)
        };
        let _ = last_of_client;
        if let Err(error) = entry.viewer.stop() {
            self.shared.env.report("stop-failed", json!({ "source": entry.source_key, "error": error }));
        }
        self.shared.kick(&entry);
    }

    /// The client stopped streaming the source (or left the relay).
    pub fn viewer_left(&self, client: &str, source_key: &str) {
        self.stop_viewer(&viewer_key(client, source_key));
    }

    /// A source locked a new geometry generation, or ended (`None`).
    pub fn geometry_changed(&self, source_key: &str, geometry: Option<&Geometry>) {
        let entries: Vec<(String, Arc<Entry>)> =
            lock(&self.shared.state).viewers.iter().filter(|(_, e)| e.source_key == source_key).map(|(k, e)| (k.clone(), e.clone())).collect();
        for (key, entry) in entries {
            if geometry.is_some() {
                if let Err(error) = entry.viewer.geometry_changed() {
                    self.shared.env.report("geometry-failed", json!({ "source": source_key, "error": error }));
                }
                self.shared.kick(&entry);
            } else {
                self.stop_viewer(&key);
            }
        }
        if geometry.is_none() {
            lock(&self.shared.state).feeds.remove(source_key);
            self.shared.env.source_closed(source_key);
        }
    }

    /// A source's newest picture.
    pub fn frame(&self, source_key: &str, picture: Picture) {
        {
            let mut state = lock(&self.shared.state);
            let Some(feed) = state.feeds.get_mut(source_key) else { return };
            let (document_id, geometry) = feed.source.page();
            let key = page_key(&document_id, &geometry);
            if key != feed.current_key {
                feed.current_key = key.clone();
                feed.frames_since_current = 0;
            }
            if format!("{}|{}", picture.document_id.as_deref().unwrap_or(""), picture.generation) == key {
                feed.frames_since_current += 1;
            }
        }
        self.shared.env.push_picture(source_key, &picture);
    }

    /// A source's desktop → phone channel message (already serialized), to each of its viewers
    /// whose channel is up.
    pub fn channel_push(&self, source_key: &str, text: &str) {
        let entries: Vec<Arc<Entry>> = lock(&self.shared.state).viewers.values().filter(|e| e.source_key == source_key).cloned().collect();
        for entry in entries {
            entry.viewer.push(text);
        }
    }

    pub fn dispose(&self) {
        let keys: Vec<String> = lock(&self.shared.state).viewers.keys().cloned().collect();
        for key in keys {
            self.stop_viewer(&key);
        }
    }

    /// The connections' viewers, each once.
    fn connected_entries(&self, only: Option<&str>) -> Vec<Arc<Entry>> {
        let mut seen: Vec<Arc<Entry>> = Vec::new();
        for entry in lock(&self.shared.state).connections.values() {
            if only.is_some_and(|key| entry.source_key != key) || seen.iter().any(|known| Arc::ptr_eq(known, entry)) {
                continue;
            }
            seen.push(entry.clone());
        }
        seen
    }

    fn fail_all(&self, only: Option<&str>) {
        for entry in self.connected_entries(only) {
            if let Err(error) = entry.viewer.fail(CloseReason::SenderFailed) {
                self.shared.env.report("fail-failed", json!({ "source": entry.source_key, "error": error }));
            }
            self.shared.kick(&entry);
        }
    }

    /// A peer connection's event, routed to its viewer.
    pub fn sender_event(&self, event: SenderEvent) {
        let routed = |id: &str| lock(&self.shared.state).connections.get(id).cloned();
        let outcome = match event {
            SenderEvent::Gone => {
                self.fail_all(None);
                return;
            }
            SenderEvent::CaptureOk { source_key } => {
                let mut state = lock(&self.shared.state);
                if let Some(feed) = state.feeds.get_mut(&source_key) {
                    let (document_id, geometry) = feed.source.page();
                    feed.current_key = page_key(&document_id, &geometry);
                    feed.frames_since_current = 1;
                }
                return;
            }
            SenderEvent::CaptureFailed { source_key, detail } => {
                self.shared.env.report("capture-failed", json!({ "source": source_key, "detail": detail }));
                self.fail_all(Some(&source_key));
                return;
            }
            SenderEvent::Offer { connection_id, sdp } => routed(&connection_id).map(|e| (e.clone(), e.viewer.sender_offer(&connection_id, &sdp))),
            SenderEvent::Candidate { connection_id, candidate } => routed(&connection_id).map(|e| {
                e.viewer.sender_candidate(&connection_id, candidate);
                (e, Ok(()))
            }),
            SenderEvent::Connected { connection_id, certificate } => routed(&connection_id).map(|e| (e.clone(), e.viewer.sender_connected(&connection_id, certificate.as_ref()))),
            SenderEvent::Failed { connection_id, reason } => routed(&connection_id).map(|e| (e.clone(), e.viewer.sender_failed(&connection_id, reason))),
            SenderEvent::Channel { connection_id, text, received_at } => routed(&connection_id).map(|e| (e.clone(), e.viewer.channel(&connection_id, &text, received_at))),
        };
        if let Some((entry, result)) = outcome {
            if let Err(error) = result {
                self.shared.env.report("sender-event-failed", json!({ "source": entry.source_key, "error": error }));
            }
            self.shared.kick(&entry);
        }
    }
}
