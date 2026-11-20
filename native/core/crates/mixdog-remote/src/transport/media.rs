//! The media adapter of the direct transport (`main/remote-transport/media.ts`): the relay's HTTP
//! media lane re-expressed as `transport-media` application messages on a session's sequenced
//! stream. The window logic is the relay lane's own ([`serve_media_window`]), so range, version,
//! lease and device semantics and the media encryption are identical on both lanes; only the
//! carrier of the frames differs. The session is the stream's: a request names no `sid`, and the
//! media key and the device a download lease must belong to are this session's.
//!
//! Flow control is the stream core's bulk admission: a record is sealed only while the carrier
//! queue is at or below the low-water mark, the bulk share has room and this stream has credit.
//! The pump waits for that before it reads the next segment, so a stalled phone or a full carrier
//! stops the file reads.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use base64::Engine;
use serde_json::Value;
use tokio::sync::Notify;
use tokio::sync::watch;

use super::consts::MAX_MEDIA_STREAMS;
use super::coordinator::MediaAdapter;
use super::signal::Media;
use super::signal::Role;
use super::signal::read_media;
use crate::clients::table::Revocation;
use crate::media::MediaOutput;
use crate::media::MediaRequest;
use crate::media::MediaSession;
use crate::media::MediaSources;
use crate::media::Permit;
use crate::media::serve_media_window;

/// What the adapter needs from its session's coordinator.
#[async_trait]
pub trait MediaLink: Send + Sync + 'static {
    /// Whether a media record of `stream` may be sealed now.
    fn can_admit(&self, stream: &str) -> bool;
    /// Admits (the same check, at seal time), seals and pushes one media message as a bulk record
    /// of `stream`, or, without a stream, as an ordinary record. `Ok(false)`: refused before
    /// sealing (nothing sealed). `Err`: the session ended. The `permit` is the authority the message is sent under, and the wait
    /// inside the send is interruptible by its end, whatever the message is: its end withdraws a message still waiting in the queue
    /// if it is not yet sealed. The guarantee is about content: no media bytes are committed after the end, and nothing waits in
    /// order to send a terminal message. A control message (`end`, `error`) queued before the end may or may not go out, since
    /// capacity can return just before the withdrawal runs. Only a `gated` message (a delivery of the file's bytes) is also committed
    /// under the permit: asked at the write, in one step with sealing and pushing (as a `WriteGate`), and when it refuses nothing is
    /// sealed (`Ok(false)`).
    async fn send(&self, message: Value, stream: Option<&str>, permit: Option<Permit>, gated: bool) -> Result<bool, ()>;
    /// The phone broke the media bound: the session ends as for any other protocol violation.
    fn protocol_error(&self);
}

struct Stream {
    id: String,
    aborted: AtomicBool,
    wake: watch::Sender<u64>,
    /// Set while this stream's pump waits in [`Inner::changed`] for room or an abort; cleared by whoever wakes it.
    parked: AtomicBool,
    /// What permits this stream's deliveries, once its source is known: its bytes are committed under it.
    permit: Mutex<Option<Permit>>,
}

impl Stream {
    fn new(id: &str) -> Arc<Self> {
        Arc::new(Self {
            id: id.to_owned(),
            aborted: AtomicBool::new(false),
            wake: watch::channel(0).0,
            parked: AtomicBool::new(false),
            permit: Mutex::new(None),
        })
    }

    fn permit(&self) -> Option<Permit> {
        self.permit.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::Acquire)
    }

    fn wake(&self) {
        self.parked.store(false, Ordering::Release);
        self.wake.send_modify(|epoch| *epoch += 1);
    }
}

#[derive(Default)]
struct State {
    streams: HashMap<String, Arc<Stream>>,
    /// Ids of refused requests whose `error` is not sealed yet, oldest first. A conforming phone
    /// never has more than the stream limit outstanding, so this holds at most that many; one more
    /// ends the session.
    refusals: Vec<String>,
    refusing: bool,
    closed: bool,
}

struct Inner<L: MediaLink> {
    link: Arc<L>,
    sources: Arc<dyn MediaSources>,
    media_key: Option<[u8; 32]>,
    device: Option<String>,
    /// The session's credential capability, taken when the session opened: every stream carries it from before it spawns.
    revocation: Revocation,
    state: Mutex<State>,
    refuser: Arc<Stream>,
    /// Counts writable notifications. A waiter compares it with the value it saw before its
    /// admission check or send, so a notification that came in between is never slept through.
    generation: AtomicU64,
    /// Notified whenever a pump reaches a resting point: it parks, or it ends. See [`TransportMedia::settled`].
    activity: Notify,
}

pub struct TransportMedia<L: MediaLink> {
    inner: Arc<Inner<L>>,
}

impl<L: MediaLink> Clone for TransportMedia<L> {
    fn clone(&self) -> Self {
        Self { inner: self.inner.clone() }
    }
}

const ALLOWED_VARIANTS: [&str; 4] = ["original", "thumb", "display", "download"];

impl<L: MediaLink> Inner<L> {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Resolves on the first notification after `seen` (at once if one already came) or on an
    /// abort. Subscribed before the check, so nothing between can be lost.
    ///
    /// The wait is also the stream's authority's: the credential's end or its lease's end releases it (the stream is aborted), so
    /// a pump parked for room that never returns is not kept with its source. Both the wake and the end are subscribed before the
    /// predicates are tested; the end is persistent, so one published before the subscription releases the wait at once.
    async fn changed(&self, stream: &Stream, seen: u64) {
        let mut wake = stream.wake.subscribe();
        let authority = self.authority(stream);
        let ended = authority.ended();
        tokio::pin!(ended);
        if authority.is_ended() {
            Self::abort(stream);
            return;
        }
        if stream.is_aborted() || self.generation() != seen {
            return;
        }
        stream.parked.store(true, Ordering::Release);
        self.activity.notify_waiters();
        tokio::select! {
            _ = wake.changed() => {}
            () = &mut ended => Self::abort(stream),
        }
        stream.parked.store(false, Ordering::Release);
    }

    /// What the stream's deliveries and waits are made under: its permit once the source is known, the session's credential before.
    fn authority(&self, stream: &Stream) -> Permit {
        stream.permit().unwrap_or_else(|| Permit::new(self.revocation.clone(), None))
    }

    fn abort(stream: &Stream) {
        stream.aborted.store(true, Ordering::Release);
        stream.wake();
    }

    /// The reader and every record wait here for room, never the coordinator.
    async fn admissible(&self, stream: &Stream) {
        loop {
            if stream.is_aborted() {
                return;
            }
            let seen = self.generation();
            if self.link.can_admit(&stream.id) {
                return;
            }
            self.changed(stream, seen).await;
        }
    }

    /// `bytes`: a delivery of the file's bytes (a 200 head, the meta, a segment), committed under the stream's permit as the write
    /// gate of its record, after the last wait for room: a revoked credential or an ended lease seals nothing and ends the stream
    /// (a record already in the sequence is never dropped to leave a hole: the coordinator ends the session instead).
    async fn deliver(&self, stream: &Stream, message: Media, bytes: bool) {
        loop {
            self.admissible(stream).await;
            if stream.is_aborted() {
                return;
            }
            if bytes && stream.permit().is_none() {
                Self::abort(stream);
                return;
            }
            // Every send that can wait carries the authority's end for cancellation (an `end` or an `error` queued for room is
            // released by it as a delivery is); only the bytes are also committed under it.
            let permit = self.authority(stream);
            let seen = self.generation();
            let sent = match self.link.send(message.to_json(), Some(&stream.id), Some(permit.clone()), bytes).await {
                Ok(sent) => sent,
                Err(()) => {
                    Self::abort(stream);
                    return;
                }
            };
            if sent || stream.is_aborted() {
                return;
            }
            // Refused by the permit, or withdrawn by its end, rather than for room: the stream is over. No terminal message is
            // sent in its place, since that would wait for capacity; one already queued may still have gone out.
            if permit.is_ended() || (bytes && !permit.commit(&mut || {})) {
                Self::abort(stream);
                return;
            }
            // Another record took the room between the check and the seal; room that came back
            // while the send was pending is retried at once.
            self.changed(stream, seen).await;
        }
    }

    /// One loop seals every queued refusal, as ordinary records: refusals never wait on bulk
    /// admission and never hold a promise per request.
    async fn refuse(&self) {
        loop {
            let id = {
                let mut state = self.state();
                match state.refusals.first() {
                    Some(id) if !state.closed => id.clone(),
                    _ => {
                        // Cleared with the check that ends the loop, so a refusal queued after it starts a pump.
                        state.refusing = false;
                        drop(state);
                        self.activity.notify_waiters();
                        return;
                    }
                }
            };
            let seen = self.generation();
            let sent = match self.link.send(Media::Error { id: id.clone() }.to_json(), None, None, false).await {
                Ok(sent) => sent,
                Err(()) => {
                    self.state().refusing = false;
                    self.activity.notify_waiters();
                    return;
                }
            };
            if sent {
                let mut state = self.state();
                if let Some(at) = state.refusals.iter().position(|queued| *queued == id) {
                    state.refusals.remove(at);
                }
            } else {
                self.changed(&self.refuser, seen).await;
            }
        }
    }

    fn close(&self) {
        let streams: Vec<Arc<Stream>> = {
            let mut state = self.state();
            if state.closed {
                return;
            }
            state.closed = true;
            state.refusals.clear();
            state.streams.values().cloned().collect()
        };
        for stream in streams {
            Self::abort(&stream);
        }
        Self::abort(&self.refuser);
    }
}

/// Where one window's answer goes: the session's stream, one bulk admission at a time.
struct StreamOutput<L: MediaLink> {
    inner: Arc<Inner<L>>,
    stream: Arc<Stream>,
}

#[async_trait]
impl<L: MediaLink> MediaOutput for StreamOutput<L> {
    fn aborted(&self) -> bool {
        self.stream.is_aborted()
    }

    async fn ready(&mut self) {
        self.inner.admissible(&self.stream).await;
    }

    fn permit(&mut self, permit: Permit) {
        *self.stream.permit.lock().unwrap_or_else(PoisonError::into_inner) = Some(permit);
    }

    async fn head(&mut self, status: u16) {
        self.inner.deliver(&self.stream, Media::Head { id: self.stream.id.clone(), status }, status == 200).await;
    }

    async fn chunk(&mut self, frame: Vec<u8>) {
        let frame = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(frame);
        self.inner.deliver(&self.stream, Media::Chunk { id: self.stream.id.clone(), frame }, true).await;
    }

    async fn end(&mut self) {
        self.inner.deliver(&self.stream, Media::End { id: self.stream.id.clone() }, false).await;
    }

    async fn error(&mut self) {
        self.inner.deliver(&self.stream, Media::Error { id: self.stream.id.clone() }, false).await;
    }
}

impl<L: MediaLink> TransportMedia<L> {
    pub fn new(link: Arc<L>, sources: Arc<dyn MediaSources>, media_key: Option<[u8; 32]>, device: Option<String>) -> Self {
        Self::under(link, sources, media_key, device, Revocation::default())
    }

    /// [`new`](Self::new) for a session whose credential's capability the client table owns: every stream of the session carries
    /// it, and one already revoked serves nothing.
    pub fn under(link: Arc<L>, sources: Arc<dyn MediaSources>, media_key: Option<[u8; 32]>, device: Option<String>, revocation: Revocation) -> Self {
        Self {
            inner: Arc::new(Inner {
                link,
                sources,
                media_key,
                device,
                revocation,
                state: Mutex::new(State::default()),
                refuser: Stream::new(""),
                generation: AtomicU64::new(0),
                activity: Notify::new(),
            }),
        }
    }

    /// One authenticated application payload from the phone: true when it was a media message
    /// (consumed, a malformed one included).
    pub fn receive(&self, payload: &Value) -> bool {
        let message = match read_media(payload, Role::Client) {
            Err(_) => return true,
            Ok(None) => return false,
            Ok(Some(message)) => message,
        };
        let inner = &self.inner;
        let id = message.id().to_owned();
        let mut state = inner.state();
        let active = state.streams.get(&id).cloned();
        let queued = state.refusals.iter().position(|queued| *queued == id);
        if let Media::Cancel { .. } = message {
            if let Some(active) = active {
                drop(state);
                Inner::<L>::abort(&active);
                state = inner.state();
            }
            // The phone stopped waiting: its refusal need not be sent.
            if let Some(at) = queued {
                state.refusals.remove(at);
            }
            return true;
        }
        let Media::Request { asset_id, variant, range, enc, .. } = message else { return true };
        // An id is one stream for its whole life; a repeat is ignored.
        if state.closed || active.is_some() || queued.is_some() {
            return true;
        }
        if state.streams.len() >= MAX_MEDIA_STREAMS {
            // As the relay refuses a 33rd stream before any head (503). Nothing is allocated for
            // it but its id in the bounded refusal queue.
            if state.refusals.len() >= MAX_MEDIA_STREAMS {
                drop(state);
                inner.close();
                inner.link.protocol_error();
                return true;
            }
            state.refusals.push(id);
            // Claimed here, under the lock that checked it: a second overflow before the pump task
            // runs must not start another pump for the same queue head (Node sets it before yielding).
            let start = !std::mem::replace(&mut state.refusing, true);
            drop(state);
            if start {
                let inner = inner.clone();
                tokio::spawn(async move { inner.refuse().await });
            }
            return true;
        }
        let stream = Stream::new(&id);
        state.streams.insert(id.clone(), stream.clone());
        drop(state);
        let inner = inner.clone();
        tokio::spawn(async move {
            let mut out = StreamOutput { inner: inner.clone(), stream: stream.clone() };
            // The relay's own route check (asset id shape, known variants), which answers 404 on
            // the HTTP lane before the desktop is asked.
            if ALLOWED_VARIANTS.contains(&variant.as_str()) {
                let request = MediaRequest { id: id.clone(), asset_id, variant, method: "GET".to_owned(), range, sid: String::new(), enc };
                let session = MediaSession { media_key: inner.media_key, device: inner.device.clone(), revocation: inner.revocation.clone() };
                serve_media_window(inner.sources.as_ref(), &request, &session, &mut out).await;
            } else {
                out.head(404).await;
                out.end().await;
            }
            let mut state = inner.state();
            if state.streams.get(&id).is_some_and(|current| Arc::ptr_eq(current, &stream)) {
                state.streams.remove(&id);
            }
            drop(state);
            inner.activity.notify_waiters();
        });
        true
    }

    /// Admission may have opened: an ack advance, the carrier's drain, a carrier change.
    pub fn writable(&self) {
        let inner = &self.inner;
        inner.generation.fetch_add(1, Ordering::AcqRel);
        let streams: Vec<Arc<Stream>> = inner.state().streams.values().cloned().collect();
        for stream in streams {
            stream.wake();
        }
        inner.refuser.wake();
    }

    /// The session ended: every pump stops; nothing more is sent.
    pub fn close(&self) {
        self.inner.close();
    }

    /// Pumps that are neither parked for room nor ended: running, or waiting on something outside the adapter (a send, a read).
    pub fn busy(&self) -> usize {
        let state = self.inner.state();
        // A parked pump whose authority has ended is not at rest: the end is a waker (it releases the wait in `changed`), but it does
        // not clear `parked` itself, the pump does when it runs. Until it has, the pump has a step to take (abort and leave).
        let streams = state.streams.values().filter(|stream| !stream.parked.load(Ordering::Acquire) || self.inner.authority(stream).is_ended()).count();
        streams + usize::from(state.refusing && !self.inner.refuser.parked.load(Ordering::Acquire))
    }

    /// Resolves once every pump has reached a resting point: it ended, is parked for room, or waits on one of the `held` things
    /// outside the adapter (sends and reads the caller keeps pending; `external` is notified when that count grows). A pump leaves
    /// motion only by parking or ending, and each announces it, so this needs no clock and no count of wake-ups.
    pub async fn settled(&self, held: impl Fn() -> usize, external: &Notify) {
        loop {
            let mine = self.inner.activity.notified();
            let theirs = external.notified();
            tokio::pin!(mine, theirs);
            mine.as_mut().enable();
            theirs.as_mut().enable();
            if self.busy() == held() {
                return;
            }
            tokio::select! {
                () = &mut mine => {}
                () = &mut theirs => {}
            }
        }
    }

    /// Running pumps (at most [`MAX_MEDIA_STREAMS`]).
    pub fn active(&self) -> usize {
        self.inner.state().streams.len()
    }
}

/// The adapter as the coordinator holds it.
impl<L: MediaLink> MediaAdapter for TransportMedia<L> {
    fn receive(&mut self, payload: &Value) -> bool {
        TransportMedia::receive(self, payload)
    }

    fn writable(&mut self) {
        TransportMedia::writable(self);
    }

    fn close(&mut self) {
        TransportMedia::close(self);
    }
}
