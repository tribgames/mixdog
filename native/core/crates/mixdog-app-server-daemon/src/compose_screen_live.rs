//! The live view's half of the phone's whole-PC screen (Node: `remote-webrtc/host.ts` with the sender window's capture and drawn
//! tracks, and `screen-webrtc-sources.ts`'s resolver): what turns a screen session of the sources into a video source of the
//! live-view host, and what the session's sink does to the host and the track.
//!
//! - Resolve: a client's screen signal reaches its session through [`PhoneScreens::resolve`], which creates one for the owner's
//!   `ready`; the session is the host's [`VideoSource`] ([`ScreenPage`]: start, stop, the locked geometry, input, release, the
//!   state a promoted channel is told, the phone's `screen-frame-seen` / `screen-helper-*` messages).
//! - Track: the first connection of a screen opens its track (`track`): the display's capture scaled onto the locked geometry
//!   (`LockedCapture`), or the helper's drawn frames while the secure-desktop helper serves. Every connection encodes the same
//!   shared source; a geometry change renews the capture, the helper path switches it in place.
//! - Sink: the session's events (geometry, capture renewals, channel pushes, drawn track, helper frames) are queued by the sink and
//!   applied in order by one task. They are never applied on the session's own thread: the session runs them under its turn, and the
//!   host asks the session (under the turn) while it holds a viewer, so a direct call would wait for each other.
//!
//! Where a screen cannot be captured, the track fails to open and every connection of it falls back (the phone is told it could not
//! be carried); nothing else carries it.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::ids::ConnectionId;
use mixdog_remote::webrtc::capture::SharedSource;
use mixdog_remote::webrtc::host::LiveHost;
use mixdog_remote::webrtc::host::SenderEvent;
use mixdog_remote::webrtc::host::VideoSource;
use mixdog_remote::webrtc::screen::Area;
use mixdog_remote::webrtc::screen::DrawnPicture;
use mixdog_remote::webrtc::screen::DrawnSink;
use mixdog_remote::webrtc::screen::HelperPicture;
use mixdog_remote::webrtc::screen::LockedCapture;
use mixdog_remote::webrtc::screen::LockedSize;
use mixdog_remote::webrtc::screen::drawn_feed;
use mixdog_remote::webrtc::signal::Geometry;
use mixdog_remote::webrtc::signal::HelperCredential;
use mixdog_remote::webrtc::signal::Resize;
use mixdog_remote::webrtc::signal::VideoLimit;
use mixdog_rt::TaskClass;
use mixdog_tools::desktop::screen_source::ScreenFrame;
use mixdog_tools::desktop::screen_source::ScreenSink;
use mixdog_tools::desktop::screen_source::ScreenViewer;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::live_view::PhoneScreens;

/// A screen's source key in the host (`screen:<screenId>`).
const KEY_PREFIX: &str = "screen:";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The helper's track while it serves: where its frames go, and the track itself until the shared source has taken it.
struct Drawn {
    sink: DrawnSink,
    source: Option<Box<dyn MediaFrameSource>>,
}

/// One screen the host streams.
#[derive(Default)]
struct Feed {
    /// The locked geometry's pixel size.
    size: Option<LockedSize>,
    viewer: Option<Arc<ScreenViewer>>,
    /// Every connection's encoder reads this; made by the first connection.
    shared: Option<Arc<SharedSource>>,
    drawn: Option<Drawn>,
}

/// One event of a session, in the order it happened.
enum Op {
    Geometry(String, Option<Value>),
    Capture(String),
    Channel(String, Value),
    Drawn(String, bool),
    Frame(String, ScreenFrame),
}

struct Core {
    host: LiveHost,
    screens: Arc<dyn PhoneScreens>,
    feeds: Mutex<HashMap<String, Feed>>,
}

/// The live view's screens (see the module header).
pub(crate) struct ScreenLive {
    core: Arc<Core>,
    ops: mpsc::UnboundedSender<Op>,
}

struct Sink(mpsc::UnboundedSender<Op>);

impl ScreenSink for Sink {
    fn geometry_changed(&self, key: &str, geometry: Option<Value>) {
        let _ = self.0.send(Op::Geometry(key.to_owned(), geometry));
    }

    fn capture_changed(&self, key: &str) {
        let _ = self.0.send(Op::Capture(key.to_owned()));
    }

    fn channel_push(&self, key: &str, message: Value) {
        let _ = self.0.send(Op::Channel(key.to_owned(), message));
    }

    fn drawn_track(&self, key: &str, drawn: bool) {
        let _ = self.0.send(Op::Drawn(key.to_owned(), drawn));
    }

    fn frame(&self, key: &str, frame: ScreenFrame) {
        let _ = self.0.send(Op::Frame(key.to_owned(), frame));
    }
}

impl ScreenLive {
    /// Must be made inside the runtime.
    pub(crate) fn new(host: LiveHost, screens: Arc<dyn PhoneScreens>) -> Arc<Self> {
        let (ops, mut queue) = mpsc::unbounded_channel();
        let core = Arc::new(Core { host, screens, feeds: Mutex::default() });
        let worker = core.clone();
        mixdog_rt::spawn("live-view-screen", TaskClass::Work, async move {
            while let Some(op) = queue.recv().await {
                worker.apply(op);
            }
        });
        Arc::new(Self { core, ops })
    }

    /// The sink the screen sources report to.
    pub(crate) fn sink(&self) -> Arc<dyn ScreenSink> {
        Arc::new(Sink(self.ops.clone()))
    }

    /// The host's source for a client's screen signal: the session of `screen_id` for its owner, one made for the owner's `ready`.
    pub(crate) fn source(&self, screen_id: &str, connection: ConnectionId, ready: bool) -> Option<Arc<dyn VideoSource>> {
        let viewer = self.core.screens.resolve(screen_id, connection, ready)?;
        lock(&self.core.feeds).entry(format!("{KEY_PREFIX}{screen_id}")).or_default().viewer = Some(viewer.clone());
        Some(Arc::new(ScreenPage { viewer }))
    }

    /// The source every connection of the screen `key` encodes, made by the first one. `Err` is a detail for the log.
    pub(crate) fn track(&self, key: &str) -> Result<Arc<SharedSource>, String> {
        let mut feeds = lock(&self.core.feeds);
        let feed = feeds.get_mut(key).ok_or("the screen has no locked geometry")?;
        if let Some(shared) = &feed.shared {
            return Ok(shared.clone());
        }
        let source = match feed.drawn.as_mut().and_then(|drawn| drawn.source.take()) {
            Some(drawn) => drawn,
            None => self.core.capture(key, feed.size)?,
        };
        let shared = SharedSource::start(source);
        feed.shared = Some(shared.clone());
        Ok(shared)
    }

    /// The screen ended: its track goes.
    pub(crate) fn closed(&self, key: &str) {
        lock(&self.core.feeds).remove(key);
    }
}

impl Core {
    fn apply(&self, op: Op) {
        match op {
            Op::Geometry(key, Some(value)) => match Geometry::parse(&value) {
                Ok(geometry) => {
                    let size = LockedSize { width: geometry.pixel_width as u32, height: geometry.pixel_height as u32 };
                    lock(&self.feeds).entry(key.clone()).or_default().size = Some(size);
                    self.host.geometry_changed(&key, Some(&geometry));
                }
                Err(error) => tracing::warn!(error, key, "a screen's geometry was refused"),
            },
            Op::Geometry(key, None) => {
                lock(&self.feeds).remove(&key);
                self.host.geometry_changed(&key, None);
            }
            Op::Capture(key) => self.recapture(&key),
            Op::Channel(key, message) => self.host.channel_push(&key, &message.to_string()),
            Op::Drawn(key, drawn) => self.draw(&key, drawn),
            Op::Frame(key, frame) => self.frame(&key, frame),
        }
    }

    /// The display's capture scaled onto the locked size, which says once, when its first picture is on its way, that the track
    /// delivers pictures of the current geometry (`CaptureOk`).
    fn capture(&self, key: &str, size: Option<LockedSize>) -> Result<Box<dyn MediaFrameSource>, String> {
        let size = size.ok_or("the screen has no locked geometry")?;
        let screen_id = key.strip_prefix(KEY_PREFIX).ok_or("not a screen's key")?;
        let capture = self.screens.capture(screen_id)?;
        let (host, source_key) = (self.host.clone(), key.to_owned());
        Ok(Box::new(LockedCapture::new(capture, size, Box::new(move || host.sender_event(SenderEvent::CaptureOk { source_key })))))
    }

    /// The geometry changed (the display was rescaled or replaced): the capture is made again at the new size. While the helper
    /// draws, the capture is made again when it ends.
    fn recapture(&self, key: &str) {
        let (shared, size) = {
            let feeds = lock(&self.feeds);
            let Some(feed) = feeds.get(key) else { return };
            match (&feed.shared, &feed.drawn) {
                (Some(shared), None) => (shared.clone(), feed.size),
                _ => return,
            }
        };
        match self.capture(key, size) {
            Ok(capture) => shared.set_source(capture),
            Err(detail) => {
                tracing::warn!(detail, key, "the screen's capture was not renewed");
                self.host.sender_event(SenderEvent::CaptureFailed { source_key: key.to_owned(), detail });
            }
        }
    }

    /// The track becomes the helper's drawn one (`true`) or the capture again, for every connection, in place.
    fn draw(&self, key: &str, on: bool) {
        if !on {
            let had = lock(&self.feeds).get_mut(key).is_some_and(|feed| feed.drawn.take().is_some());
            if had {
                self.recapture(key);
            }
            return;
        }
        let mut feeds = lock(&self.feeds);
        let Some(feed) = feeds.get_mut(key) else { return };
        if feed.drawn.is_some() {
            return;
        }
        // Each picture drawn into the track is local evidence for the run's control on the secure desktop, and a picture of the
        // current geometry in the track.
        let (viewer, host, source_key) = (feed.viewer.clone(), self.host.clone(), key.to_owned());
        let (sink, source) = drawn_feed(Arc::new(move |epoch| {
            if let Some(viewer) = &viewer {
                viewer.delivered(epoch);
            }
            host.sender_event(SenderEvent::CaptureOk { source_key: source_key.clone() });
        }));
        let source: Box<dyn MediaFrameSource> = Box::new(source);
        feed.drawn = Some(match &feed.shared {
            Some(shared) => {
                shared.set_source(source);
                Drawn { sink, source: None }
            }
            None => Drawn { sink, source: Some(source) },
        });
    }

    /// A helper frame, drawn into the locked picture of its own geometry.
    fn frame(&self, key: &str, frame: ScreenFrame) {
        let feeds = lock(&self.feeds);
        let Some(drawn) = feeds.get(key).and_then(|feed| feed.drawn.as_ref()) else { return };
        let pixels = |name: &str| frame.geometry[name].as_u64().and_then(|pixels| u32::try_from(pixels).ok());
        let (Some(width), Some(height)) = (pixels("pixelWidth"), pixels("pixelHeight")) else { return };
        let picture = frame.picture;
        drawn.sink.push(DrawnPicture {
            epoch: frame.epoch,
            size: LockedSize { width, height },
            picture: HelperPicture {
                pixels: picture.pixels,
                rows: picture.rows,
                width: picture.width,
                height: picture.height,
                stride: picture.stride,
                source: Area { x: picture.source.x as f64, y: picture.source.y as f64, width: picture.source.width as f64, height: picture.source.height as f64 },
                target: Area { x: picture.target.x, y: picture.target.y, width: picture.target.width, height: picture.target.height },
            },
        });
    }
}

/// One viewer's screen as the live-view host drives it.
struct ScreenPage {
    viewer: Arc<ScreenViewer>,
}

#[async_trait]
impl VideoSource for ScreenPage {
    fn start(&self) {
        self.viewer.start();
    }

    fn stop(&self) {
        self.viewer.stop();
    }

    fn page(&self) -> (Option<String>, Option<Geometry>) {
        let (document, geometry) = self.viewer.page();
        (document, geometry.and_then(|geometry| Geometry::parse(&geometry).ok()))
    }

    async fn dispatch(&self, control: &Value) -> Result<(), String> {
        self.viewer.dispatch(control.clone()).await
    }

    /// A screen's size follows its display, not the phone's window.
    async fn resize(&self, _request: &Resize) -> Result<(), String> {
        Ok(())
    }

    /// The picture is the display's own size: the phone's limit does not widen it.
    fn video_limit(&self, _limit: VideoLimit) {}

    async fn release(&self, _releases: Vec<Value>) {
        self.viewer.release().await;
    }

    fn channel_state(&self) -> Vec<Value> {
        self.viewer.channel_state()
    }

    fn frame_seen(&self, epoch: u64) {
        self.viewer.frame_seen(epoch);
    }

    fn helper_grant(&self, epoch: u64, challenge: String, signature: String) {
        self.viewer.helper_grant(epoch, challenge, signature);
    }

    fn helper_install(&self, controller_key: String) {
        self.viewer.helper_install(controller_key);
    }

    fn helper_credential(&self, controller_key: String, credential: HelperCredential) {
        self.viewer.helper_credential(controller_key, credential.user, credential.password);
    }
}

#[cfg(test)]
#[path = "compose_screen_live_tests.rs"]
mod tests;
