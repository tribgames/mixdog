//! The phone's whole-PC screen sources as the core's live view uses them (Node: `remote-screen/screen-webrtc-sources.ts`,
//! `createRemoteScreenSources`, with the access rules of `screen-access-publisher.ts` and the display list of
//! `host/screen-displays.ts`). At most one live session per display, owned by the paired client that opened it; the
//! session itself (geometry and its generations, the pointer mapping, the secure-desktop switch, release on exit) is
//! `computer_screen::session`, its video side `computer_screen::video`, and this file is what joins them to the core:
//!
//! - Access: pairing is the approval. The remote layer tells the book which relay connection of a client is a paired,
//!   E2EE-established one ([`ScreenSources::grant`]) and when that access ends ([`ScreenSources::withdraw`]: `ViewerLeft`
//!   when the connection left, a network change, the device keeps its pairing; `Revoked` when it was unpaired). A session
//!   is bound to the connection it was opened for and reads the book live: a withdrawal, or a grant of another
//!   connection under the same client id, stops it at once. The core calls these in process and in order, so the epoch and
//!   revision Node carried across its window hop (a grant that could land after the deny that followed it) have no
//!   counterpart.
//! - Resolve: a client's `ready` for a display nobody holds creates a session and starts it at once; its later signals
//!   reach the same session; another client's are refused while it lives; any other signal never creates one.
//! - Frames: the in-process capture of the display (`ComputerBackend::screen_source`) and, where it cannot capture, the
//!   desktop's pixels (`host/computer/pixels`, [`DisplayPixels`]). The helper's drawn frames reach the sender through
//!   [`ScreenSink::frame`].
//! - Indicator, password requests and the input host are ports the composition fills ([`ScreenIndicatorPort`],
//!   [`ScreenPcAccessPort`], [`ScreenInputHost`]); the Electron objects stay in the desktop.
//! - Close ([`ScreenSources::stop_for_quit`], [`ScreenSources::dispose`]): latched at once and for good. Every session still
//!   running or releasing is stopped within [`QUIT_BUDGET_MS`], the access is cleared, every later resolve or grant is
//!   refused, and the secure-desktop client is disposed once every session released.
//!
//! This module is declared inside `computer_screen` (`#[path]`), so it reaches the session, the lease and the timers
//! that are private to that module; what it offers outside is the public surface below.

use std::collections::HashMap;
use std::ops::Range;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::Shared;
use futures::future::join_all;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::DisplayId;
use mixdog_core_api::domain::computer::DisplayInfo;
use mixdog_core_api::domain::computer::ScreenInput;
use mixdog_core_api::domain::media::FrameSourceKind;
use mixdog_core_api::domain::media::MediaError;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::media::VideoFrame;
use serde_json::Value;
use serde_json::json;

use super::helper_client::LinkConnector;
use super::installer::Credential;
use super::installer::InstallState;
use super::installer::Timers;
use super::installer::TokioTimers;
use super::installer_port::PcAccessHelper;
use super::lease::Grant;
use super::lease::HelperFrame;
use super::lease::Listener;
use super::lease::ListenerSet;
use super::lease::SecureDesktopLease;
use super::lease::Unsub;
use super::router::BoxFuture;
use super::router::RouteOutcome;
use super::router::next_turn;
use super::service::ScreenControl;
use super::session::AbortSignal;
use super::session::CredentialResult;
use super::session::DipRect;
use super::session::HelperPicture;
use super::session::HostCommand;
use super::session::IndicatorView;
use super::session::PixelRect;
use super::session::ScreenDisplay;
use super::session::ScreenDisplays;
use super::session::ScreenHost;
use super::session::ScreenIndicator;
use super::session::ScreenPcAccess;
use super::session::ScreenSession;
use super::session::SessionDeps;
use super::session::SharedCredential;
use super::session::ViewerAuthorization;
use super::session::number;
use super::switch::LocalDesktop;
use super::video::ScreenVideoSource;
use super::video::SinkFrame;
use super::video::VideoPath;
use super::video::VideoScreen;
use super::video::VideoSink;

/// Every session is stopped within this at app quit (`SCREEN_QUIT_BUDGET_MS`).
pub const QUIT_BUDGET_MS: u64 = 5_000;
/// The longest label the indicator is given, in UTF-16 code units (`MAX_LABEL`).
const MAX_LABEL: usize = 120;
/// The longest client or connection id (`MAX_ID`).
const MAX_ID: usize = 64;
/// The pause between two pictures read from the desktop's pixels.
const PIXELS_INTERVAL: Duration = Duration::from_millis(100);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------------------------------------------
// The public surface

/// How a client's screen access ended, which is its session's stop reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenAccessEnd {
    /// The connection left the relay (a network change, the app closed): the phone asks again from its next connection.
    ViewerLeft,
    /// The device was unpaired.
    Revoked,
}

impl ScreenAccessEnd {
    fn reason(self) -> &'static str {
        match self {
            Self::ViewerLeft => "viewer-left",
            Self::Revoked => "revoked",
        }
    }
}

/// A rectangle in desktop pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PixelArea {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// A rectangle in (possibly fractional) video pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VideoArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The part of a secure-desktop helper frame that shows the display, for the sender to crop and scale.
#[derive(Clone, Debug, PartialEq)]
pub struct HelperPictureFrame {
    /// The frame's pixels; the picture's rows are `rows` of it.
    pub pixels: Arc<Vec<u8>>,
    pub rows: Range<usize>,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    /// The display's part of those rows, in their pixels.
    pub source: PixelArea,
    /// Where that part lands in the locked picture; the rest stays black.
    pub target: VideoArea,
}

/// A helper picture handed to the sender, located on the locked geometry of its video run.
#[derive(Clone, Debug, PartialEq)]
pub struct ScreenFrame {
    pub document_id: Option<String>,
    pub geometry: Value,
    pub epoch: u64,
    pub mime_type: &'static str,
    pub picture: HelperPictureFrame,
}

/// The live view's side of every viewer: the sender's track and the viewer's channel. `key` is `screen:<screenId>`.
pub trait ScreenSink: Send + Sync {
    /// The locked geometry changed, or `None` when the session ended or was refused.
    fn geometry_changed(&self, key: &str, geometry: Option<Value>);
    /// The sender renews its capture track.
    fn capture_changed(&self, key: &str);
    fn channel_push(&self, key: &str, message: Value);
    /// The sender's track becomes the helper's drawn one (`true`) or the capture again.
    fn drawn_track(&self, key: &str, drawn: bool);
    fn frame(&self, key: &str, frame: ScreenFrame);
}

/// What the on-PC indicator shows, with its one-click stop.
pub struct IndicatorState {
    pub client_label: String,
    pub controlling: bool,
    pub screen_id: String,
    pub on_stop: Arc<dyn Fn() + Send + Sync>,
}

/// One session's place on the on-PC remote-control indicator (Node: `screen-indicator.ts`, an Electron window).
pub trait ScreenIndicatorPort: Send + Sync {
    fn show(&self, state: IndicatorState);
    /// Whether the viewer now controls. The pill does not tell viewing from controlling, so a port may ignore it.
    fn update(&self, controlling: bool);
    fn hide(&self);
}

/// How a password request ended: the installer's key-change outcome name, or `busy`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PcAccessAnswer {
    pub outcome: String,
    pub state: InstallState,
    pub detail: Option<String>,
}

/// PC access as a session uses it for the phone's Windows-password request (the core's `approve_with_credential`).
pub trait ScreenPcAccessPort: Send + Sync {
    /// Whether the account signed in on the PC is an administrator; `None` when that could not be told.
    fn account_is_admin(&self) -> BoxFuture<Result<Option<bool>, String>>;
    /// The install-or-enroll authorized by the phone's password. `cancelled` turns true when the session ends: a request
    /// still queued then runs nothing, one already dispatched finishes.
    fn approve_with_credential(
        &self,
        client_id: String,
        public_key: String,
        credential: Credential,
        cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> BoxFuture<Result<PcAccessAnswer, String>>;
}

/// The input desktop as the input host's watcher reports it: its name, the consent UAC prompt, the sign-in screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputDesktop {
    pub input_desktop: Option<String>,
    pub consent: bool,
    pub logon_ui: bool,
}

/// The input host of the ordinary desktop, started with each session.
pub trait ScreenInputHost: Send + Sync {
    /// Completes once the host serves.
    fn start(&self) -> BoxFuture<Result<(), String>>;
    /// Applies one input; the `ok` fields of the answer, the error code otherwise.
    fn input(&self, input: ScreenInput) -> BoxFuture<Result<Vec<String>, String>>;
    /// Reads the cursor back (`x`, `y` in desktop pixels).
    fn cursor(&self) -> BoxFuture<Result<Vec<String>, String>>;
    fn desktop(&self) -> Option<InputDesktop>;
    /// The Windows session the host runs in.
    fn session(&self) -> Option<u32>;
    fn on_desktop(&self, listener: Listener<InputDesktop>) -> Unsub;
    /// An exit this side did not ask for.
    fn on_exit(&self, listener: Listener<()>) -> Unsub;
    /// Releases what the host holds, then ends it.
    fn stop(&self) -> BoxFuture<()>;
    /// Ends the host at once, without its release-on-quit.
    fn kill(&self);
}

/// The desktop's own capture of a display, for a display the in-process capture cannot read (`host/computer/pixels`).
pub trait DisplayPixels: Send + Sync {
    /// One picture of `display`.
    fn frame(&self, display: DisplayId) -> BoxFuture<Result<VideoFrame, MediaError>>;
}

/// What the screen sources are built from.
pub struct ScreenSourcesDeps {
    /// The in-process computer backend: the displays and their capture.
    pub backend: Arc<dyn ComputerBackend>,
    /// PC access's handle on the one secure-desktop installer: the screen control's helper is installed through the same
    /// instance, so there is one admin action at a time across both.
    pub installer: Arc<PcAccessHelper>,
    /// A fresh input host per session.
    pub input_host: Arc<dyn Fn() -> Arc<dyn ScreenInputHost> + Send + Sync>,
    /// A fresh indicator per session.
    pub indicator: Arc<dyn Fn() -> Arc<dyn ScreenIndicatorPort> + Send + Sync>,
    /// Absent: the phone's password request is answered `unavailable`.
    pub pc_access: Option<Arc<dyn ScreenPcAccessPort>>,
    /// Absent: a display the in-process capture cannot read has no pictures.
    pub pixels: Option<Arc<dyn DisplayPixels>>,
    pub sink: Arc<dyn ScreenSink>,
    /// Starts, stops, transitions and start failures (`{type: "start-failed", clientId, screenId, error}`); never input
    /// content.
    pub log: Arc<dyn Fn(Value) + Send + Sync>,
}

// ---------------------------------------------------------------------------------------------------------------
// Access

type AccessListener = Arc<dyn Fn(&Option<ScreenAccessEnd>) + Send + Sync>;

struct Held {
    connection: String,
    label: String,
}

#[derive(Default)]
struct BookState {
    grants: HashMap<String, Held>,
    listeners: HashMap<String, Vec<(u64, AccessListener)>>,
    next: u64,
}

/// Each client's screen access, with the listeners of the sessions that read it.
#[derive(Default)]
struct AccessBook {
    state: Mutex<BookState>,
}

/// `text` cut to `units` UTF-16 code units, as JavaScript's `slice` does (never inside a surrogate pair).
fn utf16_prefix(text: &str, units: usize) -> String {
    let mut taken = 0;
    let mut end = 0;
    for character in text.chars() {
        taken += character.len_utf16();
        if taken > units {
            break;
        }
        end += character.len_utf8();
    }
    text[..end].to_string()
}

impl AccessBook {
    fn state(&self) -> MutexGuard<'_, BookState> {
        lock(&self.state)
    }

    /// Tells the client's listeners, none of the book's locks held.
    fn notify(&self, client: &str, ended: Option<ScreenAccessEnd>) {
        let listeners: Vec<AccessListener> = self.state().listeners.get(client).map(|held| held.iter().map(|(_, listener)| listener.clone()).collect()).unwrap_or_default();
        for listener in listeners {
            listener(&ended);
        }
    }

    fn grant(&self, client: &str, connection: &str, label: &str) -> Result<(), String> {
        let id_valid = |id: &str| !id.is_empty() && id.encode_utf16().count() <= MAX_ID;
        if !id_valid(client) || !id_valid(connection) {
            return Err("remote screen access is invalid.".to_string());
        }
        self.state().grants.insert(client.to_string(), Held { connection: connection.to_string(), label: utf16_prefix(label, MAX_LABEL) });
        self.notify(client, None);
        Ok(())
    }

    /// The client's access is gone: its sessions see it, then stop for `ended`.
    fn withdraw(&self, client: &str, ended: ScreenAccessEnd) {
        if self.state().grants.remove(client).is_some() {
            self.notify(client, Some(ended));
        }
    }

    fn connection_of(&self, client: &str) -> Option<String> {
        self.state().grants.get(client).map(|held| held.connection.clone())
    }

    fn label_of(&self, client: &str) -> Option<(String, String)> {
        self.state().grants.get(client).map(|held| (held.connection.clone(), held.label.clone()))
    }

    fn subscribe(self: &Arc<Self>, client: &str, listener: AccessListener) -> Unsub {
        let id = {
            let mut state = self.state();
            state.next += 1;
            let id = state.next;
            state.listeners.entry(client.to_string()).or_default().push((id, listener));
            id
        };
        let (book, client) = (self.clone(), client.to_string());
        Box::new(move || {
            let mut state = book.state();
            if let Some(listeners) = state.listeners.get_mut(&client) {
                listeners.retain(|(held, _)| *held != id);
                if listeners.is_empty() {
                    state.listeners.remove(&client);
                }
            }
        })
    }

    /// Close: nothing is told, nothing is kept.
    fn clear(&self) {
        let mut state = self.state();
        state.grants.clear();
        state.listeners.clear();
    }
}

/// One session's reading of the book: bound to the connection its access was decided for.
struct SessionAccess {
    book: Arc<AccessBook>,
    client: String,
    connection: String,
    /// Access lost any other way (another connection's grant under the id) is no departure of this one's.
    ended: Arc<Mutex<ScreenAccessEnd>>,
}

impl ViewerAuthorization for SessionAccess {
    fn paired(&self) -> bool {
        self.book.connection_of(&self.client).as_deref() == Some(self.connection.as_str())
    }

    fn lost(&self) -> String {
        lock(&self.ended).reason().to_string()
    }

    fn on_change(&self, listener: Listener<()>) -> Unsub {
        let ended = self.ended.clone();
        self.book.subscribe(
            &self.client,
            Arc::new(move |why: &Option<ScreenAccessEnd>| {
                if let Some(why) = why {
                    *lock(&ended) = *why;
                }
                listener(&());
            }),
        )
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Displays

fn screen_display(index: usize, info: &DisplayInfo, primary: bool) -> ScreenDisplay {
    let scale = f64::from(info.scale_percent.max(1)) / 100.0;
    ScreenDisplay {
        screen_id: info.id.0.to_string(),
        label: format!("Display {}", index + 1),
        primary,
        scale_factor: scale,
        bounds: DipRect { x: f64::from(info.x) / scale, y: f64::from(info.y) / scale, width: f64::from(info.width) / scale, height: f64::from(info.height) / scale },
        physical: PixelRect { x: i64::from(info.x), y: i64::from(info.y), width: i64::from(info.width), height: i64::from(info.height) },
        capture_source_id: format!("screen:{}", info.id.0),
    }
}

/// The displays as the picker lists them; the primary one is the display at the origin, else the first.
fn screen_displays(infos: &[DisplayInfo]) -> Vec<ScreenDisplay> {
    let primary = infos.iter().position(|info| info.x == 0 && info.y == 0).unwrap_or(0);
    infos.iter().enumerate().map(|(index, info)| screen_display(index, info, index == primary)).collect()
}

/// A display as the phone's picker lists it (`summarizeScreenDisplay`).
fn summarize_display(display: &ScreenDisplay) -> Value {
    json!({
        "screenId": display.screen_id,
        "label": display.label,
        "primary": display.primary,
        "pixelWidth": display.physical.width,
        "pixelHeight": display.physical.height,
        "scaleFactor": number(display.scale_factor),
    })
}

/// The PC's displays: read from the backend, kept until the next read (a read that fails leaves the list as it was).
struct DisplaySet {
    backend: Arc<dyn ComputerBackend>,
    current: Mutex<Vec<ScreenDisplay>>,
    changes: Arc<ListenerSet<()>>,
}

impl DisplaySet {
    fn new(backend: Arc<dyn ComputerBackend>) -> Self {
        let set = Self { backend, current: Mutex::new(Vec::new()), changes: ListenerSet::new() };
        set.refresh();
        set
    }

    fn refresh(&self) {
        if let Ok(infos) = self.backend.displays() {
            *lock(&self.current) = screen_displays(&infos);
        }
    }

    fn changed(&self) {
        self.refresh();
        self.changes.call(&());
    }
}

impl ScreenDisplays for DisplaySet {
    fn list(&self) -> Vec<ScreenDisplay> {
        lock(&self.current).clone()
    }

    fn on_change(&self, listener: Listener<()>) -> Unsub {
        self.changes.add(listener)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Frames

/// Pictures of a display read one at a time from the desktop's pixels, a pause apart.
struct PixelsSource {
    display: DisplayId,
    pixels: Arc<dyn DisplayPixels>,
    timers: Arc<dyn Timers>,
    seq: u64,
}

#[async_trait]
impl MediaFrameSource for PixelsSource {
    fn kind(&self) -> FrameSourceKind {
        FrameSourceKind::Screen { display: self.display.0 }
    }

    async fn next_frame(&mut self) -> Result<Option<VideoFrame>, MediaError> {
        // Cancel-safe: the pause and the read consume nothing until the picture is returned.
        if self.seq > 0 {
            self.timers.sleep(PIXELS_INTERVAL).await;
        }
        let mut frame = self.pixels.frame(self.display).await?;
        frame.seq = self.seq;
        self.seq += 1;
        Ok(Some(frame))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Adapters between the ports and the session's own traits

struct InputHostAdapter(Arc<dyn ScreenInputHost>);

fn local_desktop(desktop: &InputDesktop) -> LocalDesktop {
    LocalDesktop { input_desktop: desktop.input_desktop.clone(), consent: desktop.consent, logon_ui: desktop.logon_ui }
}

impl ScreenHost for InputHostAdapter {
    fn start(&self) -> BoxFuture<Result<(), String>> {
        self.0.start()
    }

    fn command(&self, command: HostCommand) -> BoxFuture<Result<Vec<String>, String>> {
        match command {
            HostCommand::Input(input) => self.0.input(input),
            HostCommand::Cursor => self.0.cursor(),
        }
    }

    fn desktop(&self) -> Option<LocalDesktop> {
        self.0.desktop().as_ref().map(local_desktop)
    }

    fn session(&self) -> Option<u32> {
        self.0.session()
    }

    fn on_desktop(&self, listener: Listener<LocalDesktop>) -> Unsub {
        self.0.on_desktop(Arc::new(move |desktop: &InputDesktop| listener(&local_desktop(desktop))))
    }

    fn on_exit(&self, listener: Listener<()>) -> Unsub {
        self.0.on_exit(listener)
    }

    fn stop(&self) -> BoxFuture<()> {
        self.0.stop()
    }

    fn kill(&self) {
        self.0.kill();
    }
}

struct IndicatorAdapter(Arc<dyn ScreenIndicatorPort>);

impl ScreenIndicator for IndicatorAdapter {
    fn show(&self, view: IndicatorView) {
        self.0.show(IndicatorState { client_label: view.client_label, controlling: view.controlling, screen_id: view.screen_id, on_stop: view.on_stop });
    }

    fn update(&self, controlling: bool) {
        self.0.update(controlling);
    }

    fn hide(&self) {
        self.0.hide();
    }
}

struct PcAccessAdapter(Arc<dyn ScreenPcAccessPort>);

impl ScreenPcAccess for PcAccessAdapter {
    fn account_is_admin(&self) -> BoxFuture<Result<Option<bool>, String>> {
        self.0.account_is_admin()
    }

    fn approve_with_credential(&self, client_id: &str, public_key: &str, credential: SharedCredential, signal: AbortSignal) -> BoxFuture<Result<CredentialResult, String>> {
        // The session empties its copy once the request ended; the port owns the one it is handed.
        let handed = lock(&credential).clone();
        let answered = self.0.approve_with_credential(client_id.to_string(), public_key.to_string(), handed, Arc::new(move || signal.aborted()));
        Box::pin(async move { answered.await.map(|answer| CredentialResult { outcome: answer.outcome, state: answer.state, detail: answer.detail }) })
    }
}

fn helper_picture_frame(picture: HelperPicture) -> HelperPictureFrame {
    HelperPictureFrame {
        pixels: picture.pixels,
        rows: picture.rows,
        width: picture.width,
        height: picture.height,
        stride: picture.stride,
        source: PixelArea { x: picture.source.x, y: picture.source.y, width: picture.source.width, height: picture.source.height },
        target: VideoArea { x: picture.target.x, y: picture.target.y, width: picture.target.width, height: picture.target.height },
    }
}

struct SinkAdapter(Arc<dyn ScreenSink>);

impl VideoSink<HelperPicture> for SinkAdapter {
    fn geometry_changed(&self, key: &str, geometry: Option<Value>) {
        self.0.geometry_changed(key, geometry);
    }

    fn capture_changed(&self, key: &str) {
        self.0.capture_changed(key);
    }

    fn channel_push(&self, key: &str, message: Value) {
        self.0.channel_push(key, message);
    }

    fn drawn_track(&self, key: &str, drawn: bool) {
        self.0.drawn_track(key, drawn);
    }

    fn frame(&self, key: &str, frame: SinkFrame<HelperPicture>) {
        self.0.frame(
            key,
            ScreenFrame { document_id: frame.document_id, geometry: frame.geometry, epoch: frame.epoch, mime_type: frame.mime_type, picture: helper_picture_frame(frame.picture) },
        );
    }
}

/// The session as its video side uses it.
impl VideoScreen<HelperPicture> for ScreenSession {
    fn status(&self) -> Value {
        ScreenSession::status(self)
    }

    fn cursor(&self) -> Option<Value> {
        ScreenSession::cursor(self)
    }

    fn running(&self) -> bool {
        ScreenSession::running(self)
    }

    fn geometry(&self) -> Option<Value> {
        ScreenSession::geometry(self)
    }

    fn capture_plan(&self) -> Option<Value> {
        ScreenSession::capture_plan(self)
    }

    fn next_video_run(&self) -> u64 {
        ScreenSession::next_video_run(self)
    }

    fn set_video_run(&self, epoch: u64) {
        ScreenSession::set_video_run(self, epoch);
    }

    fn set_helper_video(&self, delivering: bool) {
        ScreenSession::set_helper_video(self, delivering);
    }

    fn helper_grant(&self, grant: Grant) {
        ScreenSession::helper_grant(self, grant);
    }

    fn request_helper_install(&self, controller_key: String) {
        ScreenSession::request_helper_install(self, &controller_key);
    }

    fn request_helper_credential(&self, controller_key: String, credential: Credential) {
        ScreenSession::request_helper_credential(self, &controller_key, Arc::new(Mutex::new(credential)));
    }

    fn release_input(&self) -> BoxFuture<()> {
        ScreenSession::release_input(self)
    }

    fn handle_input(&self, control: Value, generation: u64) -> BoxFuture<RouteOutcome> {
        ScreenSession::handle_input(self, &control, generation)
    }

    fn start(&self) -> BoxFuture<Result<Value, String>> {
        ScreenSession::start(self)
    }

    fn stop(&self, reason: &str) -> BoxFuture<()> {
        ScreenSession::stop(self, reason, None)
    }

    fn on_geometry(&self, listener: Listener<Value>) -> Unsub {
        ScreenSession::on_geometry(self, listener)
    }

    fn on_stop(&self, listener: Listener<String>) -> Unsub {
        ScreenSession::on_stop(self, listener)
    }

    fn on_status(&self, listener: Listener<Value>) -> Unsub {
        ScreenSession::on_status(self, listener)
    }

    fn on_cursor(&self, listener: Listener<Value>) -> Unsub {
        ScreenSession::on_cursor(self, listener)
    }

    fn on_helper_challenge(&self, listener: Listener<super::lease::Challenge>) -> Unsub {
        ScreenSession::on_helper_challenge(self, listener)
    }

    fn on_helper_hold(&self, listener: Listener<()>) -> Unsub {
        ScreenSession::on_helper_hold(self, listener)
    }

    fn on_video_path(&self, listener: Listener<VideoPath>) -> Unsub {
        ScreenSession::on_video_path(self, listener)
    }

    fn on_frame(&self, listener: Listener<HelperPicture>) -> Unsub {
        ScreenSession::on_frame(self, listener)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// One viewer's source

/// One viewer's whole-PC screen: what the live view's host drives as the video source of `screen:<screenId>`.
pub struct ScreenViewer {
    video: ScreenVideoSource<HelperPicture>,
    screen: Arc<ScreenSession>,
}

impl ScreenViewer {
    /// A viewer needs pictures: admits the viewer and locks the geometry once (idempotent).
    pub fn start(&self) {
        self.video.start();
    }

    /// No viewer of the source remains: the session ends as `viewer-left` (idempotent).
    pub fn stop(&self) {
        self.video.stop();
    }

    /// The document (none for a screen) and the locked geometry now.
    pub fn page(&self) -> (Option<String>, Option<Value>) {
        let page = self.video.page();
        (None, Some(page["geometry"].clone()).filter(|geometry| !geometry.is_null()))
    }

    /// The generation of the locked geometry; input of another generation is refused by the session.
    pub fn geometry_generation(&self) -> Option<u64> {
        self.screen.geometry().and_then(|geometry| geometry["generation"].as_u64())
    }

    /// A validated `screen-*` channel input, through the session's authorization and dispatch path.
    pub fn dispatch(&self, control: Value) -> BoxFuture<Result<(), String>> {
        self.video.dispatch(control)
    }

    /// The capture plan the sender opens its track from; `None` unless running.
    pub fn capture_plan(&self) -> Option<Value> {
        self.video.capture_plan()
    }

    /// The viewer's channel is gone: whatever it held is let go.
    pub fn release(&self) -> BoxFuture<()> {
        self.video.release()
    }

    /// What a promoted channel is told at once: the status, the run when announced, the cursor.
    pub fn channel_state(&self) -> Vec<Value> {
        self.video.channel_state()
    }

    /// A helper frame of run `run` drew into the sender's track.
    pub fn delivered(&self, run: u64) {
        self.video.delivered(run);
    }

    /// The phone's `screen-frame-seen` for run `run`.
    pub fn frame_seen(&self, run: u64) {
        self.video.frame_seen(run);
    }

    /// The phone's `screen-helper-grant`: relayed only when it names the current run.
    pub fn helper_grant(&self, epoch: u64, challenge: String, signature: String) {
        self.video.helper_grant(Grant { challenge, epoch, signature });
    }

    /// The phone's `screen-helper-install` with its controller key.
    pub fn helper_install(&self, controller_key: String) {
        self.video.helper_install(controller_key);
    }

    /// The same with the Windows password the phone typed.
    pub fn helper_credential(&self, controller_key: String, user: Option<String>, password: String) {
        self.video.helper_credential(controller_key, Credential { user, password });
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The sources

struct Live {
    id: u64,
    client: String,
    viewer: Arc<ScreenViewer>,
}

#[derive(Default)]
struct Registry {
    closing: bool,
    /// Live sessions by display.
    sessions: HashMap<String, Live>,
    /// Every session not yet released, for the quit budget.
    unreleased: Vec<(u64, Arc<ScreenSession>)>,
    next: u64,
}

struct Parts {
    control: ScreenControl,
    backend: Arc<dyn ComputerBackend>,
    displays: Arc<DisplaySet>,
    book: Arc<AccessBook>,
    input_host: Arc<dyn Fn() -> Arc<dyn ScreenInputHost> + Send + Sync>,
    indicator: Arc<dyn Fn() -> Arc<dyn ScreenIndicatorPort> + Send + Sync>,
    pc_access: Option<Arc<dyn ScreenPcAccess>>,
    pixels: Option<Arc<dyn DisplayPixels>>,
    sink: Arc<dyn VideoSink<HelperPicture>>,
    log: Arc<dyn Fn(Value) + Send + Sync>,
    timers: Arc<dyn Timers>,
    registry: Mutex<Registry>,
    /// Held while a session is created, so two `ready`s of one display never create two. Never taken by a path the turn runs.
    creating: Mutex<()>,
    /// The close, once begun: later calls share it.
    closed: Mutex<Option<Shared<BoxFuture<()>>>>,
}

/// The phone's whole-PC screen sources (see the module header).
pub struct ScreenSources {
    parts: Arc<Parts>,
}

impl ScreenSources {
    /// Must be made inside the runtime.
    pub fn new(deps: ScreenSourcesDeps) -> Self {
        let timers: Arc<dyn Timers> = Arc::new(TokioTimers::new());
        let control = ScreenControl::new(Arc::new(LinkConnector::installed(timers.clone())), deps.installer, timers.clone());
        Self::assemble(control, timers, deps.backend, deps.input_host, deps.indicator, deps.pc_access, deps.pixels, deps.sink, deps.log)
    }

    #[allow(clippy::too_many_arguments, reason = "the parts of one composition, named at its two call sites")]
    fn assemble(
        control: ScreenControl,
        timers: Arc<dyn Timers>,
        backend: Arc<dyn ComputerBackend>,
        input_host: Arc<dyn Fn() -> Arc<dyn ScreenInputHost> + Send + Sync>,
        indicator: Arc<dyn Fn() -> Arc<dyn ScreenIndicatorPort> + Send + Sync>,
        pc_access: Option<Arc<dyn ScreenPcAccessPort>>,
        pixels: Option<Arc<dyn DisplayPixels>>,
        sink: Arc<dyn ScreenSink>,
        log: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Self {
        let parts = Parts {
            control,
            displays: Arc::new(DisplaySet::new(backend.clone())),
            backend,
            book: Arc::new(AccessBook::default()),
            input_host,
            indicator,
            pc_access: pc_access.map(|port| Arc::new(PcAccessAdapter(port)) as Arc<dyn ScreenPcAccess>),
            pixels,
            sink: Arc::new(SinkAdapter(sink)),
            log,
            timers,
            registry: Mutex::new(Registry::default()),
            creating: Mutex::new(()),
            closed: Mutex::new(None),
        };
        Self { parts: Arc::new(parts) }
    }

    /// `connection` of `client` is a paired, E2EE-established relay connection and still connected; `label` is what the
    /// on-PC indicator calls the phone. Called before the client's screen `ready` is forwarded. Refused after close.
    pub fn grant(&self, client: &str, connection: &str, label: &str) -> Result<(), String> {
        if lock(&self.parts.registry).closing {
            return Err("remote screen sources are closed.".to_string());
        }
        self.parts.book.grant(client, connection, label)?;
        self.parts.displays.refresh();
        Ok(())
    }

    /// The client's access ended (see [`ScreenAccessEnd`]): its session stops at once.
    pub fn withdraw(&self, client: &str, ended: ScreenAccessEnd) {
        self.parts.book.withdraw(client, ended);
    }

    /// The displays a phone may choose, as it reads them now.
    pub fn displays(&self) -> Vec<Value> {
        self.parts.displays.refresh();
        self.parts.displays.list().iter().map(summarize_display).collect()
    }

    /// Displays were added, removed or rescaled: sessions re-read their geometry.
    pub fn displays_changed(&self) {
        self.parts.displays.changed();
    }

    /// The pictures of display `screen_id` for the sender's capture track.
    pub fn capture(&self, screen_id: &str) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
        let unknown = || ComputerError::InvalidInput { reason: format!("unknown display {screen_id}") };
        let display = DisplayId(screen_id.parse().map_err(|_| unknown())?);
        if !self.parts.displays.list().iter().any(|listed| listed.screen_id == screen_id) {
            return Err(unknown());
        }
        match self.parts.backend.screen_source(display) {
            Ok(source) => Ok(source),
            Err(error @ (ComputerError::Unavailable { .. } | ComputerError::Failed { .. })) => match &self.parts.pixels {
                Some(pixels) => Ok(Box::new(PixelsSource { display, pixels: pixels.clone(), timers: self.parts.timers.clone(), seq: 0 })),
                None => Err(error),
            },
            Err(error) => Err(error),
        }
    }

    /// The live view's resolver for a screen source: the session of `screen_id` for its owner, a new one for the owner's
    /// `ready` when nobody holds it, otherwise none.
    pub fn resolve(&self, screen_id: &str, client: &str, ready: bool) -> Option<Arc<ScreenViewer>> {
        let key = format!("screen:{screen_id}");
        let _creating = lock(&self.parts.creating);
        {
            let registry = lock(&self.parts.registry);
            if registry.closing {
                return None;
            }
            if let Some(live) = registry.sessions.get(&key) {
                return (live.client == client).then(|| live.viewer.clone());
            }
        }
        if !ready {
            return None;
        }
        let (viewer, screen, lease, id) = self.create(&key, screen_id, client)?;
        let refused = {
            let mut registry = lock(&self.parts.registry);
            if registry.closing {
                true
            } else {
                registry.sessions.insert(key, Live { id, client: client.to_string(), viewer: viewer.clone() });
                registry.unreleased.push((id, screen.clone()));
                false
            }
        };
        if refused {
            // Closed while it was made: nothing started, so there is nothing to release but the helper's hold.
            lease.dispose();
            return None;
        }
        viewer.start();
        Some(viewer)
    }

    fn create(&self, key: &str, screen_id: &str, client: &str) -> Option<(Arc<ScreenViewer>, Arc<ScreenSession>, Arc<SecureDesktopLease<HelperFrame>>, u64)> {
        let parts = &self.parts;
        // The session belongs to the connection its access was decided for: the access of any other connection under the
        // same client id is none of its.
        let (connection, label) = parts.book.label_of(client)?;
        let id = {
            let mut registry = lock(&parts.registry);
            registry.next += 1;
            registry.next
        };
        // The session's hold on the shared helper; let go once it released (its releases may go through the helper), or
        // when it never started.
        let lease = parts.control.lease();
        let make_host = parts.input_host.clone();
        let log = parts.log.clone();
        let screen = Arc::new(ScreenSession::new(SessionDeps {
            client_id: client.to_string(),
            client_label: label,
            screen_id: screen_id.to_string(),
            displays: parts.displays.clone(),
            authorization: Arc::new(SessionAccess { book: parts.book.clone(), client: client.to_string(), connection, ended: Arc::new(Mutex::new(ScreenAccessEnd::Revoked)) }),
            create_input_host: Box::new(move || Arc::new(InputHostAdapter(make_host())) as Arc<dyn ScreenHost>),
            secure_desktop: lease.clone(),
            pc_access: parts.pc_access.clone(),
            indicator: Arc::new(IndicatorAdapter((parts.indicator)())),
            log: Box::new(move |event| log(event)),
            timers: parts.timers.clone(),
            max_frame_rate: None,
            sample_cursor: true,
            shutdown_deadline_ms: None,
        }));
        let on_error = {
            let (weak, screen, lease, key) = (Arc::downgrade(parts), screen.clone(), lease.clone(), key.to_string());
            let (client, screen_id) = (client.to_string(), screen_id.to_string());
            move |error: String| {
                let Some(parts) = weak.upgrade() else { return };
                forget(&parts, &key, id);
                let (released, lease) = (screen.released(), lease.clone());
                parts.timers.spawn(Box::pin(async move {
                    released.await;
                    lease.dispose();
                }));
                (parts.log)(json!({"type": "start-failed", "clientId": client, "screenId": screen_id, "error": error}));
            }
        };
        let video = ScreenVideoSource::<HelperPicture>::new(screen.clone(), screen_id, parts.sink.clone(), parts.timers.clone(), on_error);
        let viewer = Arc::new(ScreenViewer { video, screen: screen.clone() });
        {
            // Weak: the session's own listener must not keep it alive.
            let (weak, stopped, lease, key) = (Arc::downgrade(parts), Arc::downgrade(&screen), lease.clone(), key.to_string());
            drop(screen.on_stop(Arc::new(move |_: &String| {
                let Some(parts) = weak.upgrade() else { return };
                forget(&parts, &key, id);
                // `released()` is the running stop once this listener has returned.
                let (stopped, lease, weak) = (stopped.clone(), lease.clone(), Arc::downgrade(&parts));
                parts.timers.spawn(Box::pin(async move {
                    next_turn().await;
                    if let Some(screen) = stopped.upgrade() {
                        screen.released().await;
                    }
                    if let Some(parts) = weak.upgrade() {
                        lock(&parts.registry).unreleased.retain(|(held, _)| *held != id);
                    }
                    lease.dispose();
                }));
            })));
        }
        Some((viewer, screen, lease, id))
    }

    /// Latches closed (synchronously), stops every session under [`QUIT_BUDGET_MS`], clears the access, and disposes the
    /// secure-desktop client once every session released. Later calls share the first one's completion.
    pub fn stop_for_quit(&self) -> BoxFuture<()> {
        let mut closed = lock(&self.parts.closed);
        if let Some(closing) = closed.as_ref() {
            return Box::pin(closing.clone());
        }
        // Latched before the snapshot: nothing a stop triggers can open a session.
        let sessions: Vec<Arc<ScreenSession>> = {
            let mut registry = lock(&self.parts.registry);
            registry.closing = true;
            registry.sessions.clear();
            registry.unreleased.iter().map(|(_, screen)| screen.clone()).collect()
        };
        self.parts.book.clear();
        let stops: Vec<BoxFuture<()>> = sessions.iter().map(|screen| screen.stop("user", Some(QUIT_BUDGET_MS))).collect();
        let parts = self.parts.clone();
        let closing: Shared<BoxFuture<()>> = (Box::pin(async move {
            join_all(stops).await;
            parts.control.dispose();
        }) as BoxFuture<()>)
            .shared();
        *closed = Some(closing.clone());
        Box::pin(closing)
    }

    /// The host goes away: closes as at quit.
    pub fn dispose(&self) -> BoxFuture<()> {
        self.stop_for_quit()
    }
}

/// The session `id` of `key` is over: it is no longer the display's.
fn forget(parts: &Parts, key: &str, id: u64) {
    let mut registry = lock(&parts.registry);
    if registry.sessions.get(key).is_some_and(|live| live.id == id) {
        registry.sessions.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::computer::ComputerRequest;
    use mixdog_core_api::domain::computer::ComputerStatus;
    use mixdog_core_api::domain::computer::DesktopIdentity;
    use mixdog_core_api::domain::computer::InputOutcome;
    use mixdog_core_api::domain::media::PixelFormat;
    use mixdog_core_api::domain::mock::MockComputerBackend;
    use mixdog_core_api::domain::tool::ToolPart;
    use tokio::sync::mpsc::UnboundedReceiver;
    use tokio::sync::mpsc::UnboundedSender;
    use tokio_util::sync::CancellationToken;

    use super::super::helper_client::Dialing;
    use super::super::helper_client::HelperConnector;
    use super::super::helper_client::PipeEvents;
    use super::super::installer::HelperStatus;
    use super::super::installer::InstallOutcome;
    use super::super::installer::InstallResult;
    use super::super::lease::InstallPort;
    use super::*;

    fn done<T: Send + 'static>(value: T) -> BoxFuture<T> {
        Box::pin(async move { value })
    }

    /// No helper is installed: the secure desktop stays blocked and nothing is dialled.
    struct NoHelper;

    impl HelperConnector for NoHelper {
        fn available(&self) -> bool {
            false
        }
        fn connect(&self, _: Arc<dyn PipeEvents>) -> Dialing {
            Dialing { done: Box::pin(async { Err("the helper is not installed".to_string()) }), abort: Box::new(|| {}) }
        }
    }

    struct NotInstalled;

    impl InstallPort for NotInstalled {
        fn state(&self, _: Option<String>) -> BoxFuture<InstallState> {
            done(InstallState::NotInstalled)
        }
        fn request(&self, _: String) -> BoxFuture<InstallResult> {
            done(InstallResult { outcome: InstallOutcome::Unavailable, state: InstallState::NotInstalled, detail: None })
        }
        fn ensure_running(&self) -> BoxFuture<HelperStatus> {
            done(HelperStatus { installed: false, running: false, version: None })
        }
    }

    struct Host;

    impl ScreenInputHost for Host {
        fn start(&self) -> BoxFuture<Result<(), String>> {
            done(Ok(()))
        }
        fn input(&self, _: ScreenInput) -> BoxFuture<Result<Vec<String>, String>> {
            done(Ok(Vec::new()))
        }
        fn cursor(&self) -> BoxFuture<Result<Vec<String>, String>> {
            done(Ok(vec!["10".to_string(), "20".to_string()]))
        }
        fn desktop(&self) -> Option<InputDesktop> {
            Some(InputDesktop { input_desktop: Some("Default".to_string()), consent: false, logon_ui: false })
        }
        fn session(&self) -> Option<u32> {
            Some(1)
        }
        fn on_desktop(&self, _: Listener<InputDesktop>) -> Unsub {
            Box::new(|| {})
        }
        fn on_exit(&self, _: Listener<()>) -> Unsub {
            Box::new(|| {})
        }
        fn stop(&self) -> BoxFuture<()> {
            done(())
        }
        fn kill(&self) {}
    }

    struct Pill;

    impl ScreenIndicatorPort for Pill {
        fn show(&self, _: IndicatorState) {}
        fn update(&self, _: bool) {}
        fn hide(&self) {}
    }

    type Told = (String, Option<Value>);

    /// Reports each geometry the sink is told.
    struct Sink(UnboundedSender<Told>);

    impl ScreenSink for Sink {
        fn geometry_changed(&self, key: &str, geometry: Option<Value>) {
            drop(self.0.send((key.to_string(), geometry)));
        }
        fn capture_changed(&self, _: &str) {}
        fn channel_push(&self, _: &str, _: Value) {}
        fn drawn_track(&self, _: &str, _: bool) {}
        fn frame(&self, _: &str, _: ScreenFrame) {}
    }

    /// The mock backend, except for what a test changes: whether the screen can be captured, and whether the displays read.
    struct Backend {
        inner: MockComputerBackend,
        captures: bool,
        reads: bool,
    }

    impl Backend {
        fn new(captures: bool, reads: bool) -> Arc<Self> {
            Arc::new(Self { inner: MockComputerBackend::default(), captures, reads })
        }
    }

    #[async_trait]
    impl ComputerBackend for Backend {
        async fn run(&self, request: ComputerRequest, cancel: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
            self.inner.run(request, cancel).await
        }
        fn inject(&self, input: ScreenInput) -> Result<InputOutcome, ComputerError> {
            self.inner.inject(input)
        }
        fn release_input(&self) -> Result<u32, ComputerError> {
            self.inner.release_input()
        }
        fn input_desktop(&self) -> Option<DesktopIdentity> {
            self.inner.input_desktop()
        }
        fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
            if self.reads { self.inner.displays() } else { Err(ComputerError::Unavailable { reason: "no displays".to_string() }) }
        }
        fn screen_source(&self, display: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
            if self.captures {
                self.inner.screen_source(display)
            } else {
                Err(ComputerError::Unavailable { reason: "the helper does not capture".to_string() })
            }
        }
        fn status(&self) -> ComputerStatus {
            self.inner.status()
        }
    }

    struct Pixels;

    impl DisplayPixels for Pixels {
        fn frame(&self, _: DisplayId) -> BoxFuture<Result<VideoFrame, MediaError>> {
            done(Ok(VideoFrame { width: 2, height: 2, stride: 0, format: PixelFormat::Jpeg, data: bytes::Bytes::from_static(b"jpeg"), seq: 99, captured_at: Duration::ZERO }))
        }
    }

    fn sources_with(backend: Arc<dyn ComputerBackend>, pixels: Option<Arc<dyn DisplayPixels>>) -> (ScreenSources, UnboundedReceiver<Told>) {
        let (events, received) = tokio::sync::mpsc::unbounded_channel();
        let timers: Arc<dyn Timers> = Arc::new(TokioTimers::new());
        let control = ScreenControl::new(Arc::new(NoHelper), Arc::new(NotInstalled), timers.clone());
        let sources = ScreenSources::assemble(
            control,
            timers,
            backend,
            Arc::new(|| Arc::new(Host) as Arc<dyn ScreenInputHost>),
            Arc::new(|| Arc::new(Pill) as Arc<dyn ScreenIndicatorPort>),
            None,
            pixels,
            Arc::new(Sink(events)),
            Arc::new(|_| {}),
        );
        (sources, received)
    }

    fn sources() -> (ScreenSources, UnboundedReceiver<Told>) {
        sources_with(Backend::new(true, true), None)
    }

    async fn next_event(received: &mut UnboundedReceiver<Told>) -> Told {
        mixdog_rt::time::timeout(Duration::from_secs(10), received.recv()).await.expect("the sink was told in time").expect("the sink is open")
    }

    fn session_access(book: &Arc<AccessBook>, client: &str, connection: &str) -> SessionAccess {
        SessionAccess { book: book.clone(), client: client.to_string(), connection: connection.to_string(), ended: Arc::new(Mutex::new(ScreenAccessEnd::Revoked)) }
    }

    // ---- access

    #[test]
    fn a_session_is_paired_only_for_the_connection_its_access_was_decided_for() {
        let book = Arc::new(AccessBook::default());
        book.grant("phone", "conn-1", "Phone").unwrap();
        let first = session_access(&book, "phone", "conn-1");
        assert!(first.paired());
        // Another connection under the same client id: the first one's session is no longer paired, and it did not leave.
        let told = Arc::new(Mutex::new(0));
        let count = told.clone();
        drop(first.on_change(Arc::new(move |_: &()| *lock(&count) += 1)));
        book.grant("phone", "conn-2", "Phone").unwrap();
        assert!(!first.paired());
        assert!(session_access(&book, "phone", "conn-2").paired());
        assert_eq!(*lock(&told), 1);
        assert_eq!(first.lost(), "revoked");
    }

    #[test]
    fn a_withdrawal_stops_the_session_with_its_cause_and_is_told_once() {
        let book = Arc::new(AccessBook::default());
        book.grant("phone", "conn-1", "Phone").unwrap();
        let session = session_access(&book, "phone", "conn-1");
        let told = Arc::new(Mutex::new(0));
        let count = told.clone();
        let off = session.on_change(Arc::new(move |_: &()| *lock(&count) += 1));
        book.withdraw("phone", ScreenAccessEnd::ViewerLeft);
        assert!(!session.paired());
        assert_eq!(session.lost(), "viewer-left");
        // Nothing to withdraw: nobody is told again, and the cause stands.
        book.withdraw("phone", ScreenAccessEnd::Revoked);
        assert_eq!(*lock(&told), 1);
        assert_eq!(session.lost(), "viewer-left");
        off();
        book.grant("phone", "conn-3", "Phone").unwrap();
        assert_eq!(*lock(&told), 1, "a listener that was removed hears nothing");
    }

    #[test]
    fn an_unpair_is_a_revocation() {
        let book = Arc::new(AccessBook::default());
        book.grant("phone", "conn-1", "Phone").unwrap();
        let session = session_access(&book, "phone", "conn-1");
        drop(session.on_change(Arc::new(|_: &()| {})));
        book.withdraw("phone", ScreenAccessEnd::Revoked);
        assert_eq!(session.lost(), "revoked");
    }

    #[test]
    fn access_needs_an_id_of_up_to_64_units_and_the_label_is_cut_to_120() {
        let book = AccessBook::default();
        assert!(book.grant("", "conn", "Phone").is_err());
        assert!(book.grant("phone", "", "Phone").is_err());
        assert!(book.grant(&"x".repeat(65), "conn", "Phone").is_err());
        assert!(book.grant(&"x".repeat(64), "conn", "Phone").is_ok());
        // 119 units, then a pair of two: the pair is not cut in half.
        let label = format!("{}{}", "a".repeat(119), "\u{1F600}");
        book.grant("phone", "conn", &label).unwrap();
        assert_eq!(book.label_of("phone").unwrap().1, "a".repeat(119));
        book.grant("phone", "conn", &"b".repeat(300)).unwrap();
        assert_eq!(book.label_of("phone").unwrap().1.len(), 120);
    }

    // ---- displays

    #[test]
    fn a_display_carries_its_dip_bounds_scale_and_physical_pixels() {
        let infos = [
            DisplayInfo { id: DisplayId(2), x: 1920, y: 0, width: 3840, height: 2160, scale_percent: 200 },
            DisplayInfo { id: DisplayId(1), x: 0, y: 0, width: 1920, height: 1080, scale_percent: 100 },
        ];
        let displays = screen_displays(&infos);
        assert_eq!(displays.len(), 2);
        assert!(!displays[0].primary && displays[1].primary, "the display at the origin is the primary one");
        let second = &displays[0];
        assert_eq!((second.screen_id.as_str(), second.label.as_str(), second.capture_source_id.as_str()), ("2", "Display 1", "screen:2"));
        assert_eq!(second.scale_factor, 2.0);
        assert_eq!(second.bounds, DipRect { x: 960.0, y: 0.0, width: 1920.0, height: 1080.0 });
        assert_eq!(second.physical, PixelRect { x: 1920, y: 0, width: 3840, height: 2160 });
        assert_eq!(summarize_display(second), json!({"screenId": "2", "label": "Display 1", "primary": false, "pixelWidth": 3840, "pixelHeight": 2160, "scaleFactor": 2}));
    }

    #[test]
    fn a_failed_display_read_keeps_the_list_as_it_was() {
        let set = DisplaySet::new(Backend::new(true, true));
        assert_eq!(set.list().len(), 1);
        let unreadable = DisplaySet { backend: Backend::new(true, false), current: Mutex::new(set.list()), changes: ListenerSet::new() };
        unreadable.refresh();
        assert_eq!(unreadable.list(), set.list());
    }

    #[test]
    fn a_display_change_re_reads_the_list_and_tells_the_sessions() {
        let set = DisplaySet::new(Backend::new(true, true));
        let told = Arc::new(Mutex::new(0));
        let count = told.clone();
        drop(set.on_change(Arc::new(move |_: &()| *lock(&count) += 1)));
        set.changed();
        assert_eq!(*lock(&told), 1);
    }

    #[tokio::test]
    async fn the_phone_lists_the_displays_with_their_size_and_scale() {
        let (sources, _) = sources();
        assert_eq!(sources.displays(), vec![json!({"screenId": "0", "label": "Display 1", "primary": true, "pixelWidth": 1920, "pixelHeight": 1080, "scaleFactor": 1})]);
    }

    // ---- frames

    #[tokio::test]
    async fn the_in_process_capture_serves_the_frames_when_it_can_capture() {
        let (sources, _) = sources_with(Backend::new(true, true), Some(Arc::new(Pixels)));
        let source = sources.capture("0").expect("a source");
        assert_eq!(source.kind(), FrameSourceKind::Screen { display: 0 });
        assert!(matches!(sources.capture("9"), Err(ComputerError::InvalidInput { .. })), "a display the PC does not have");
        assert!(matches!(sources.capture("left"), Err(ComputerError::InvalidInput { .. })));
    }

    #[tokio::test]
    async fn the_desktops_pixels_serve_the_frames_where_the_capture_cannot() {
        let (sources, _) = sources_with(Backend::new(false, true), Some(Arc::new(Pixels)));
        let mut source = sources.capture("0").expect("the pixels stand in");
        assert_eq!(source.kind(), FrameSourceKind::Screen { display: 0 });
        let frame = source.next_frame().await.unwrap().expect("a frame");
        assert_eq!((frame.seq, frame.format), (0, PixelFormat::Jpeg));
    }

    #[tokio::test]
    async fn without_pixels_a_display_the_capture_cannot_read_reports_why() {
        let (sources, _) = sources_with(Backend::new(false, true), None);
        assert!(matches!(sources.capture("0"), Err(ComputerError::Unavailable { .. })));
    }

    // ---- sessions

    #[tokio::test]
    async fn a_screen_is_resolved_for_its_owner_only_and_created_only_by_a_ready_with_access() {
        let (sources, mut received) = sources();
        assert!(sources.resolve("0", "phone-a", true).is_none(), "no access yet");
        sources.grant("phone-a", "conn-a", "Phone A").unwrap();
        sources.grant("phone-b", "conn-b", "Phone B").unwrap();
        assert!(sources.resolve("0", "phone-a", false).is_none(), "only a ready creates a session");
        let viewer = sources.resolve("0", "phone-a", true).expect("a session for the ready");
        assert!(Arc::ptr_eq(&viewer, &sources.resolve("0", "phone-a", false).expect("its later signals")));
        assert!(sources.resolve("0", "phone-b", true).is_none(), "another client's are refused while it lives");
        // Started at once: the geometry it locked reaches the sink.
        let (key, geometry) = next_event(&mut received).await;
        assert_eq!(key, "screen:0");
        assert_eq!(geometry.expect("a locked geometry")["generation"], 1);
        assert_eq!(viewer.geometry_generation(), Some(1));
        assert_eq!(viewer.page().1.expect("the page shows it")["generation"], 1);
    }

    #[tokio::test]
    async fn a_withdrawn_access_stops_its_session_and_frees_the_display() {
        let (sources, mut received) = sources();
        sources.grant("phone-a", "conn-a", "Phone A").unwrap();
        sources.grant("phone-b", "conn-b", "Phone B").unwrap();
        sources.resolve("0", "phone-a", true).expect("a session");
        assert!(next_event(&mut received).await.1.is_some());
        sources.withdraw("phone-a", ScreenAccessEnd::ViewerLeft);
        // The session ended: the sink is told no geometry, and the display is nobody's.
        assert!(next_event(&mut received).await.1.is_none());
        assert!(sources.resolve("0", "phone-b", true).is_some());
    }

    #[tokio::test]
    async fn a_grant_for_another_connection_under_the_same_client_stops_the_old_session() {
        let (sources, mut received) = sources();
        sources.grant("phone-a", "conn-1", "Phone A").unwrap();
        sources.resolve("0", "phone-a", true).expect("a session");
        assert!(next_event(&mut received).await.1.is_some());
        sources.grant("phone-a", "conn-2", "Phone A").unwrap();
        assert!(next_event(&mut received).await.1.is_none());
        // The new connection opens its own.
        assert!(sources.resolve("0", "phone-a", true).is_some());
    }

    #[tokio::test]
    async fn a_closed_source_takes_no_access_and_resolves_nothing() {
        let (sources, mut received) = sources();
        sources.grant("phone-a", "conn-a", "Phone A").unwrap();
        sources.resolve("0", "phone-a", true).expect("a session");
        assert!(next_event(&mut received).await.1.is_some());
        let closing = sources.stop_for_quit();
        // Latched at once: before the stop has completed.
        assert!(sources.grant("phone-b", "conn-b", "Phone B").is_err());
        assert!(sources.resolve("0", "phone-a", true).is_none());
        mixdog_rt::time::timeout(Duration::from_secs(10), closing).await.expect("closed within the budget");
        // A second call shares the first one's completion.
        mixdog_rt::time::timeout(Duration::from_secs(10), sources.dispose()).await.expect("already closed");
        assert!(sources.resolve("0", "phone-a", true).is_none());
    }
}
