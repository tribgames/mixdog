//! The video side of one screen session (Node: `screen-webrtc-source.ts`, `createScreenWebrtcSource`): what the
//! viewer's channel is told (`screen-status`, `screen-cursor`, `screen-video`, `screen-helper-challenge`), the
//! sender's track switch between the desktop capture and the helper's drawn frames, and the video runs that gate
//! control on the secure desktop.
//!
//! Video runs: every path change, pipeline stall and loss of the viewer's channel starts a new run (`epoch`),
//! announced to the phone as `screen-video`. Control on the helper path needs both a local delivery of a picture of
//! the current run (`delivered(epoch)`; a watchdog of [`helper_video_stall_ms`] ends the run when deliveries stop)
//! and the phone's `screen-frame-seen` for the current, announced run (`frame_seen(epoch)`). Anything of an older
//! run counts for nothing. Run epochs come from the session (`next_video_run`, minted helper-wide); taking the
//! helper's hold starts a fresh run on the same path. Each helper challenge goes to the phone with the current
//! run, and the phone's grant is relayed only when it names the current run.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::Weak;
use std::time::Duration;

use serde::Serialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::installer::Credential;
use super::installer::TimerHandle;
use super::installer::Timers;
use super::lease::Challenge;
use super::lease::Grant;
use super::lease::Unsub;
use super::router::BoxFuture;
use super::router::RouteOutcome;
use super::switch::STALL_WINDOW;
use super::switch::helper_video_stall_ms;

/// The channel contract's version (`REMOTE_WEBRTC_VERSION`).
const VERSION: u64 = 1;
/// How a helper frame is handed to the sender: raw BGRX rows.
pub(super) const HELPER_FRAME_MIME: &str = "image/x-bgrx";

type Listener<T> = Arc<dyn Fn(&T) + Send + Sync>;

/// Where the picture comes from: the desktop capture, or the helper's frames while it serves the secure desktop.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum VideoPath {
    Capture,
    Helper,
}

/// The screen session as its video side uses it. Status, cursor, geometry and plan are the channel's own
/// objects: this side forwards them and reads only the geometry's `generation` and the plan's `maxFrameRate`.
pub(super) trait VideoScreen<F>: Send + Sync {
    fn status(&self) -> Value;
    fn cursor(&self) -> Option<Value>;
    fn running(&self) -> bool;
    fn geometry(&self) -> Option<Value>;
    fn capture_plan(&self) -> Option<Value>;
    /// A run epoch no session has used.
    fn next_video_run(&self) -> u64;
    /// Declares the run the viewer is shown to the helper (only while the session holds it).
    fn set_video_run(&self, epoch: u64);
    /// Whether the helper's frames of the current run reach the viewer, and the phone saw one.
    fn set_helper_video(&self, delivering: bool);
    fn helper_grant(&self, grant: Grant);
    fn request_helper_install(&self, controller_key: String);
    fn request_helper_credential(&self, controller_key: String, credential: Credential);
    fn release_input(&self) -> BoxFuture<()>;
    fn handle_input(&self, control: Value, generation: u64) -> BoxFuture<RouteOutcome>;
    /// Admits the viewer; the locked geometry, or why not.
    fn start(&self) -> BoxFuture<Result<Value, String>>;
    fn stop(&self, reason: &str) -> BoxFuture<()>;
    /// A new locked geometry.
    fn on_geometry(&self, listener: Listener<Value>) -> Unsub;
    /// The session ended, with its reason.
    fn on_stop(&self, listener: Listener<String>) -> Unsub;
    fn on_status(&self, listener: Listener<Value>) -> Unsub;
    fn on_cursor(&self, listener: Listener<Value>) -> Unsub;
    fn on_helper_challenge(&self, listener: Listener<Challenge>) -> Unsub;
    fn on_helper_hold(&self, listener: Listener<()>) -> Unsub;
    fn on_video_path(&self, listener: Listener<VideoPath>) -> Unsub;
    fn on_frame(&self, listener: Listener<F>) -> Unsub;
}

/// A helper picture handed to the sender, located on the locked geometry of its run.
#[derive(Clone, Debug)]
pub(super) struct SinkFrame<F> {
    pub document_id: Option<String>,
    pub geometry: Value,
    pub epoch: u64,
    pub mime_type: &'static str,
    pub picture: F,
}

/// The WebRTC host's side of one viewer: the sender's track and the viewer's channel.
pub(super) trait VideoSink<F>: Send + Sync {
    fn geometry_changed(&self, key: &str, geometry: Option<Value>);
    fn capture_changed(&self, key: &str);
    fn channel_push(&self, key: &str, message: Value);
    /// The sender's track becomes a drawn one (`true`) or the capture again.
    fn drawn_track(&self, key: &str, drawn: bool);
    fn frame(&self, key: &str, frame: SinkFrame<F>);
}

/// The helper's 16-byte nonce and challenge in canonical padded base64 (Node's `HELPER_NONCE`,
/// `^[A-Za-z0-9+/]{21}[AQgw]==$`).
fn helper_nonce(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 24
        && bytes[..21].iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
        && matches!(bytes[21], b'A' | b'Q' | b'g' | b'w')
        && &bytes[22..] == b"=="
}

/// The `screen-helper-challenge` for a helper challenge and the current run; `None` for a malformed one, which
/// is never forwarded (the helper's pipe admits any process of the PC user).
fn helper_challenge_message(epoch: u64, challenge: &Challenge) -> Option<Value> {
    (epoch >= 1 && helper_nonce(&challenge.nonce) && helper_nonce(&challenge.challenge)).then(|| {
        json!({"v": VERSION, "kind": "screen-helper-challenge", "epoch": epoch, "nonce": challenge.nonce, "challenge": challenge.challenge})
    })
}

struct Run {
    path: VideoPath,
    /// Minted helper-wide: no other session's run has this epoch.
    epoch: u64,
    /// `screen-video` of the run was sent: a capture run at once, a helper run once its first frame is in the
    /// track.
    announced: bool,
    /// The phone's `screen-frame-seen` for the run arrived.
    seen: bool,
    last_delivery: Option<f64>,
    intervals: Vec<f64>,
    watchdog: Option<TimerHandle>,
    /// When the last helper frame was handed over (the frame-rate cap).
    handed_at: f64,
    starting: bool,
}

struct Inner<F> {
    screen: Arc<dyn VideoScreen<F>>,
    sink: Arc<dyn VideoSink<F>>,
    timers: Arc<dyn Timers>,
    key: String,
    on_start_error: Box<dyn Fn(String) + Send + Sync>,
    run: Mutex<Run>,
    subscriptions: Mutex<Vec<Unsub>>,
}

impl<F: Clone + Send + Sync + 'static> Inner<F> {
    fn run(&self) -> MutexGuard<'_, Run> {
        self.run.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn status_message(&self) -> Value {
        json!({"v": VERSION, "kind": "screen-status", "status": self.screen.status()})
    }

    fn cursor_message(cursor: Value) -> Value {
        let mut message = Map::new();
        message.insert("v".into(), json!(VERSION));
        message.insert("kind".into(), json!("screen-cursor"));
        if let Value::Object(fields) = cursor {
            message.extend(fields);
        }
        Value::Object(message)
    }

    fn video_message(&self) -> Value {
        let run = self.run();
        json!({"v": VERSION, "kind": "screen-video", "epoch": run.epoch, "path": run.path})
    }

    /// Control on the helper path: delivered locally and seen by the phone, in this run. Off the helper path the
    /// session ignores the report.
    fn grant(&self) {
        let delivering = {
            let run = self.run();
            run.path == VideoPath::Helper && run.announced && run.seen
        };
        self.screen.set_helper_video(delivering);
    }

    fn clear_watchdog(&self) {
        let watchdog = self.run().watchdog.take();
        if let Some(watchdog) = watchdog {
            watchdog.clear();
        }
    }

    /// A new run on `next`: everything of the old one stops counting, and control on the helper path is
    /// withdrawn until the new run earns it.
    fn new_run(&self, next: VideoPath) {
        self.clear_watchdog();
        {
            let mut run = self.run();
            run.last_delivery = None;
            run.intervals.clear();
        }
        let epoch = self.screen.next_video_run();
        let announced = {
            let mut run = self.run();
            run.epoch = epoch;
            run.path = next;
            run.seen = false;
            run.announced = next == VideoPath::Capture;
            run.announced
        };
        self.screen.set_video_run(epoch);
        self.grant();
        if announced {
            self.sink.channel_push(&self.key, self.video_message());
        }
    }

    fn on_frame(&self, picture: &F) {
        let geometry = self.screen.geometry();
        let plan = self.screen.capture_plan();
        let (Some(geometry), Some(plan)) = (geometry, plan) else {
            return;
        };
        let epoch = {
            let mut run = self.run();
            if run.path != VideoPath::Helper {
                return;
            }
            // No byte budget can be derived without a measured IPC throughput, so the rate is capped by the
            // stream's own frame rate (the helper's 66 ms cadence is slower still).
            let now = self.timers.now_ms();
            let rate = plan["maxFrameRate"].as_f64().unwrap_or(f64::NAN);
            if now - run.handed_at < 1000.0 / rate {
                return;
            }
            run.handed_at = now;
            run.epoch
        };
        let frame = SinkFrame { document_id: None, geometry, epoch, mime_type: HELPER_FRAME_MIME, picture: picture.clone() };
        self.sink.frame(&self.key, frame);
    }
}

/// One viewer's screen video source.
pub(super) struct ScreenVideoSource<F> {
    inner: Arc<Inner<F>>,
}

impl<F: Clone + Send + Sync + 'static> ScreenVideoSource<F> {
    pub(super) fn new(
        screen: Arc<dyn VideoScreen<F>>,
        screen_id: &str,
        sink: Arc<dyn VideoSink<F>>,
        timers: Arc<dyn Timers>,
        on_start_error: impl Fn(String) + Send + Sync + 'static,
    ) -> Self {
        let inner = Arc::new(Inner {
            screen: screen.clone(),
            sink,
            timers,
            key: format!("screen:{screen_id}"),
            on_start_error: Box::new(on_start_error),
            run: Mutex::new(Run {
                path: VideoPath::Capture,
                epoch: 0,
                announced: true,
                seen: false,
                last_delivery: None,
                intervals: Vec::new(),
                watchdog: None,
                handed_at: f64::NEG_INFINITY,
                starting: false,
            }),
            subscriptions: Mutex::new(Vec::new()),
        });
        let weak = Arc::downgrade(&inner);
        let with = move |weak: &Weak<Inner<F>>| weak.upgrade();
        let mut subscriptions = Vec::new();
        {
            let weak = weak.clone();
            subscriptions.push(screen.on_geometry(Arc::new(move |geometry: &Value| {
                if let Some(inner) = with(&weak) {
                    inner.sink.geometry_changed(&inner.key, Some(geometry.clone()));
                    inner.sink.capture_changed(&inner.key);
                }
            })));
        }
        {
            let weak = weak.clone();
            subscriptions.push(screen.on_stop(Arc::new(move |_: &String| {
                if let Some(inner) = with(&weak) {
                    inner.sink.geometry_changed(&inner.key, None);
                }
            })));
        }
        {
            // A stop's own status is pushed before the sink ends the viewer.
            let weak = weak.clone();
            subscriptions.push(screen.on_status(Arc::new(move |_: &Value| {
                if let Some(inner) = with(&weak) {
                    inner.sink.channel_push(&inner.key, inner.status_message());
                }
            })));
        }
        {
            let weak = weak.clone();
            subscriptions.push(screen.on_cursor(Arc::new(move |cursor: &Value| {
                if let Some(inner) = with(&weak) {
                    inner.sink.channel_push(&inner.key, Inner::<F>::cursor_message(cursor.clone()));
                }
            })));
        }
        let first = screen.next_video_run();
        inner.run().epoch = first;
        {
            let weak = weak.clone();
            subscriptions.push(screen.on_helper_challenge(Arc::new(move |challenge: &Challenge| {
                if let Some(inner) = with(&weak) {
                    let epoch = inner.run().epoch;
                    if let Some(message) = helper_challenge_message(epoch, challenge) {
                        inner.sink.channel_push(&inner.key, message);
                    }
                }
            })));
        }
        {
            // Taking the helper's hold: a fresh run (and epoch) on the same path, so nothing the phone saw or
            // signed before counts with the helper.
            let weak = weak.clone();
            subscriptions.push(screen.on_helper_hold(Arc::new(move |_: &()| {
                if let Some(inner) = with(&weak) {
                    let path = inner.run().path;
                    inner.new_run(path);
                }
            })));
        }
        {
            let weak = weak.clone();
            subscriptions.push(screen.on_video_path(Arc::new(move |next: &VideoPath| {
                if let Some(inner) = with(&weak) {
                    if inner.run().path == *next {
                        return;
                    }
                    inner.new_run(*next);
                    inner.sink.drawn_track(&inner.key, *next == VideoPath::Helper);
                }
            })));
        }
        {
            let weak = weak.clone();
            subscriptions.push(screen.on_frame(Arc::new(move |picture: &F| {
                if let Some(inner) = with(&weak) {
                    inner.on_frame(picture);
                }
            })));
        }
        subscriptions.push(screen.on_stop(Arc::new(move |_: &String| {
            if let Some(inner) = with(&weak) {
                inner.clear_watchdog();
            }
        })));
        *inner.subscriptions.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = subscriptions;
        Self { inner }
    }

    /// Starts the session once; its geometry (or none, on a refusal) reaches the sink, and the first run is
    /// declared once the session runs.
    pub(super) fn start(&self) {
        {
            let mut run = self.inner.run();
            if run.starting {
                return;
            }
            run.starting = true;
        }
        let starting = self.inner.screen.start();
        let inner = self.inner.clone();
        self.inner.timers.spawn(Box::pin(async move {
            match starting.await {
                Ok(geometry) => {
                    let epoch = inner.run().epoch;
                    inner.screen.set_video_run(epoch);
                    inner.sink.geometry_changed(&inner.key, Some(geometry));
                }
                Err(error) => {
                    inner.sink.geometry_changed(&inner.key, None);
                    (inner.on_start_error)(error);
                }
            }
        }));
    }

    pub(super) fn stop(&self) {
        self.inner.timers.spawn(self.inner.screen.stop("viewer-left"));
    }

    pub(super) fn page(&self) -> Value {
        let geometry = if self.inner.screen.running() { self.inner.screen.geometry() } else { None };
        json!({"documentId": null, "geometry": geometry})
    }

    /// A viewer's channel input: screen input only, reaching the session with the current geometry's generation.
    pub(super) fn dispatch(&self, control: Value) -> BoxFuture<Result<(), String>> {
        let page_input = !control["type"].as_str().is_some_and(|kind| kind.starts_with("screen-"));
        if page_input {
            return Box::pin(async { Err("remote screen takes screen input only".to_string()) });
        }
        // The host's dispatch carries no generation yet; the current one stands in.
        let generation = self.inner.screen.geometry().and_then(|geometry| geometry["generation"].as_u64()).unwrap_or(0);
        let handled = self.inner.screen.handle_input(control, generation);
        Box::pin(async move {
            match handled.await {
                RouteOutcome::Rejected => Err("remote screen input was not applied".to_string()),
                RouteOutcome::Applied => Ok(()),
            }
        })
    }

    pub(super) fn capture_plan(&self) -> Option<Value> {
        self.inner.screen.capture_plan()
    }

    /// The channel whose phone saw the run is gone: a new run on the helper path, which the next channel must
    /// see for itself; whatever the viewer held is let go.
    pub(super) fn release(&self) -> BoxFuture<()> {
        if self.inner.run().path == VideoPath::Helper {
            self.inner.new_run(VideoPath::Helper);
        }
        self.inner.screen.release_input()
    }

    /// What a promoted channel is told at once: the status, the run when it is announced, the cursor.
    pub(super) fn channel_state(&self) -> Vec<Value> {
        let mut messages = vec![self.inner.status_message()];
        if self.inner.run().announced {
            messages.push(self.inner.video_message());
        }
        if let Some(cursor) = self.inner.screen.cursor() {
            messages.push(Inner::<F>::cursor_message(cursor));
        }
        messages
    }

    /// A helper frame of run `delivery` drew into the sender's track. Only this run's helper frames count.
    pub(super) fn delivered(&self, delivery: u64) {
        let inner = &self.inner;
        let stall = {
            let run = inner.run();
            if run.path != VideoPath::Helper || delivery != run.epoch {
                return;
            }
            drop(run);
            if !inner.screen.running() {
                return;
            }
            let now = inner.timers.now_ms();
            let mut run = inner.run();
            if let Some(last) = run.last_delivery {
                run.intervals.push(now - last);
                if run.intervals.len() > STALL_WINDOW {
                    run.intervals.remove(0);
                }
            }
            run.last_delivery = Some(now);
            helper_video_stall_ms(&run.intervals)
        };
        inner.clear_watchdog();
        // The pipeline stalled: the run ends (control withdrawn, held input released), and the next one needs
        // a delivery and a seen again.
        let weak = Arc::downgrade(inner);
        let watchdog = inner.timers.set_timeout(
            Duration::from_nanos((stall * 1e6).round() as u64),
            Box::new(move || {
                if let Some(inner) = weak.upgrade() {
                    inner.run().watchdog = None;
                    inner.new_run(VideoPath::Helper);
                }
            }),
        );
        let announce = {
            let mut run = inner.run();
            run.watchdog = Some(watchdog);
            let announce = !run.announced;
            run.announced = true;
            announce
        };
        if announce {
            inner.sink.channel_push(&inner.key, inner.video_message());
        }
    }

    /// The phone's `screen-frame-seen` for run `run`: counts only for the current helper run, once announced.
    pub(super) fn frame_seen(&self, run: u64) {
        {
            let current = self.inner.run();
            if current.path != VideoPath::Helper || run != current.epoch || !current.announced {
                return;
            }
        }
        if !self.inner.screen.running() {
            return;
        }
        self.inner.run().seen = true;
        self.inner.grant();
    }

    /// The phone's signed grant: relayed only for the current run (the helper would refuse another, and the
    /// phone must not carry a grant across runs).
    pub(super) fn helper_grant(&self, signed: Grant) {
        if signed.epoch != self.inner.run().epoch {
            return;
        }
        self.inner.screen.helper_grant(signed);
    }

    pub(super) fn helper_install(&self, controller_key: String) {
        self.inner.screen.request_helper_install(controller_key);
    }

    pub(super) fn helper_credential(&self, controller_key: String, credential: Credential) {
        self.inner.screen.request_helper_credential(controller_key, credential);
    }
}
