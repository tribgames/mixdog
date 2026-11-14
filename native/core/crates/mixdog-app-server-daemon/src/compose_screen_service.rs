//! The Windows half of `compose_screen`: the adapters between the screen sources and the ports of this core.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::time::Instant;

use async_trait::async_trait;
use bytes::Bytes;
use futures::future::BoxFuture;
use mixdog_app_protocol::v2::screen_indicator::ScreenIndicatorParams;
use mixdog_app_protocol::v2::screen_indicator::ScreenIndicatorState;
use mixdog_core::run_host::native_tools::ComputerSessionPool;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::computer::ComputerSessions;
use mixdog_core_api::domain::computer::DisplayId;
use mixdog_core_api::domain::computer::ScreenInput as InputOp;
use mixdog_core_api::domain::media::MediaError;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::media::PixelFormat;
use mixdog_core_api::domain::media::VideoFrame;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_domains::domains::host::ScreenEvents;
use mixdog_core_domains::domains::pc_access::CredentialAnswer;
use mixdog_core_domains::domains::pc_access::CredentialOutcome;
use mixdog_core_domains::domains::pc_access::CredentialRequest;
use mixdog_core_domains::domains::pc_access::HelperState;
use mixdog_core_domains::domains::pc_access::PcAccessService;
use mixdog_core_domains::domains::pc_access::PcCredential;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_remote::registry::DeviceRegistry;
use mixdog_rt::TaskClass;
use mixdog_tools::desktop::computer_pixels::ComputerBlobs;
use mixdog_tools::desktop::computer_screen_input::ScreenInput;
use mixdog_tools::desktop::computer_screen_input::ScreenInputConfig;
use mixdog_tools::desktop::pc_access_helper::Credential;
use mixdog_tools::desktop::pc_access_helper::InstallState;
use mixdog_tools::desktop::screen_source::AccountAdmin;
use mixdog_tools::desktop::screen_source::DisplayPixels;
use mixdog_tools::desktop::screen_source::HostDisplays;
use mixdog_tools::desktop::screen_source::IndicatorState;
use mixdog_tools::desktop::screen_source::InputDesktop;
use mixdog_tools::desktop::screen_source::PcAccessAnswer;
use mixdog_tools::desktop::screen_source::ScreenAccessEnd;
use mixdog_tools::desktop::screen_source::ScreenFrame;
use mixdog_tools::desktop::screen_source::ScreenIndicatorPort;
use mixdog_tools::desktop::screen_source::ScreenInputHost;
use mixdog_tools::desktop::screen_source::ScreenPcAccessPort;
use mixdog_tools::desktop::screen_source::ScreenSink;
use mixdog_tools::desktop::screen_source::ScreenSources;
use mixdog_tools::desktop::screen_source::ScreenSourcesDeps;
use mixdog_tools::desktop::screen_source::ScreenViewer;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;

use super::PcHelper;
use crate::live_view::PhoneScreens;
use crate::live_view::ScreenEnd;

/// The widest picture asked of the desktop for the phone's screen, and its JPEG quality.
const PIXELS_MAX_WIDTH: u32 = 1_920;
const PIXELS_QUALITY: u32 = 70;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(super) struct Parts {
    pub host: Arc<dyn HostChannel>,
    pub registry: Arc<DeviceRegistry>,
    pub pool: Arc<ComputerSessionPool>,
    pub binary: PathBuf,
    pub cwd: AbsPath,
    pub manager: Arc<dyn ProcessManager>,
    pub pc_access: Arc<PcAccessService>,
    pub helper: PcHelper,
    pub blobs: Arc<dyn ComputerBlobs>,
}

/// The phone's screen sources with what the live view and the desktop's reports ask of them.
pub(super) struct ScreenService {
    sources: Arc<ScreenSources>,
    registry: Arc<DeviceRegistry>,
    /// The connections granted now: a grant is made once however many screen signals the connection sends.
    granted: Mutex<HashSet<u64>>,
    stops: Arc<IndicatorStops>,
    /// Where the sessions report to the live view, once it binds them.
    sink: Arc<SinkCell>,
}

impl ScreenService {
    pub(super) fn new(parts: Parts) -> Arc<Self> {
        let Parts { host, registry, pool, binary, cwd, manager, pc_access, helper, blobs } = parts;
        let stops = Arc::new(IndicatorStops::default());
        let sink = Arc::new(SinkCell::default());
        let sources = Arc::new(ScreenSources::new(ScreenSourcesDeps {
            backend: pool.backend(""),
            displays: Some(Arc::new(HostDisplays::new(host.clone()))),
            installer: helper,
            input_host: Arc::new(move || {
                Arc::new(InputHost { input: Arc::new(ScreenInput::new(manager.clone(), ScreenInputConfig::new(binary.clone(), cwd.clone()))) }) as Arc<dyn ScreenInputHost>
            }),
            indicator: {
                let (host, stops) = (host.clone(), stops.clone());
                Arc::new(move || Arc::new(DesktopIndicator::new(host.clone(), stops.clone())) as Arc<dyn ScreenIndicatorPort>)
            },
            pc_access: Some(Arc::new(CorePcAccess { service: pc_access, admin: Arc::new(AccountAdmin::default()) })),
            pixels: Some(Arc::new(HostPixels { desktop: host, blobs, origin: Instant::now() })),
            sink: sink.clone(),
            log: Arc::new(|event: Value| match event["type"].as_str() {
                Some("start-failed") => tracing::warn!(%event, "a phone screen session did not start"),
                _ => tracing::debug!(%event, "phone screen"),
            }),
        }));
        Arc::new(Self { sources, registry, granted: Mutex::default(), stops, sink })
    }

    pub(super) async fn stop_for_quit(&self) {
        self.sources.stop_for_quit().await;
    }
}

#[async_trait]
impl PhoneScreens for ScreenService {
    async fn displays(&self) -> Result<Value, String> {
        Ok(Value::Array(self.sources.displays().await))
    }

    async fn grant(&self, connection: ConnectionId) -> Result<(), String> {
        {
            let mut granted = lock(&self.granted);
            if granted.contains(&connection.0) {
                return Ok(());
            }
            let label = self.registry.describe(connection.0).map(|described| described.device).unwrap_or_default();
            let id = connection.0.to_string();
            self.sources.grant(&id, &id, &label)?;
            granted.insert(connection.0);
        }
        // The monitors are listed before the phone's `ready` is forwarded: the sources take them from the desktop (a list is not
        // read by the grant), and a session needs its display listed to start.
        self.sources.displays().await;
        Ok(())
    }

    fn withdraw(&self, connection: ConnectionId, ended: ScreenEnd) {
        if lock(&self.granted).remove(&connection.0) {
            self.sources.withdraw(
                &connection.0.to_string(),
                match ended {
                    ScreenEnd::ViewerLeft => ScreenAccessEnd::ViewerLeft,
                    ScreenEnd::Revoked => ScreenAccessEnd::Revoked,
                },
            );
        }
    }

    fn resolve(&self, screen_id: &str, connection: ConnectionId, ready: bool) -> Option<Arc<ScreenViewer>> {
        self.sources.resolve(screen_id, &connection.0.to_string(), ready)
    }

    fn capture(&self, screen_id: &str) -> Result<Box<dyn MediaFrameSource>, String> {
        self.sources.capture(screen_id).map_err(|error| format!("{error:?}"))
    }

    fn attach(&self, sink: Arc<dyn ScreenSink>) {
        if self.sink.target.set(sink).is_err() {
            tracing::error!("the screen sessions were bound to the live view twice");
        }
    }
}

impl ScreenEvents for ScreenService {
    fn displays_changed(&self) {
        // Re-reads the monitors and renews every session's geometry.
        let sources = self.sources.clone();
        mixdog_rt::spawn("screen-displays-changed", TaskClass::Work, async move { sources.displays_changed().await });
    }

    fn indicator_stopped(&self, screen_id: &str) {
        self.stops.stopped(screen_id);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The pill

/// The Stop of each session's place on the pill, by the display it shows (one session per display).
#[derive(Default)]
pub(super) struct IndicatorStops {
    stops: Mutex<HashMap<String, Arc<dyn Fn() + Send + Sync>>>,
}

impl IndicatorStops {
    fn set(&self, screen_id: &str, stop: Arc<dyn Fn() + Send + Sync>) {
        lock(&self.stops).insert(screen_id.to_owned(), stop);
    }

    /// Forgets `stop` of `screen_id`, unless a newer session took the display since.
    fn clear(&self, screen_id: &str, stop: &Arc<dyn Fn() + Send + Sync>) {
        let mut stops = lock(&self.stops);
        if stops.get(screen_id).is_some_and(|held| Arc::ptr_eq(held, stop)) {
            stops.remove(screen_id);
        }
    }

    /// The pill's Stop for `screen_id`: its session ends. None shown: nothing to end.
    pub(super) fn stopped(&self, screen_id: &str) {
        let stop = lock(&self.stops).get(screen_id).cloned();
        if let Some(stop) = stop {
            stop();
        }
    }
}

struct Shown {
    screen_id: String,
    label: String,
    on_stop: Arc<dyn Fn() + Send + Sync>,
}

/// One session's place on the desktop's pill: `host/screen/indicator` requests in the order the session made them, one at a time.
pub(super) struct DesktopIndicator {
    host: Arc<dyn HostChannel>,
    stops: Arc<IndicatorStops>,
    shown: Mutex<Option<Shown>>,
    queue: Mutex<Option<mpsc::UnboundedSender<ScreenIndicatorParams>>>,
}

impl DesktopIndicator {
    pub(super) fn new(host: Arc<dyn HostChannel>, stops: Arc<IndicatorStops>) -> Self {
        Self { host, stops, shown: Mutex::new(None), queue: Mutex::new(None) }
    }

    fn send(&self, params: ScreenIndicatorParams) {
        let mut queue = lock(&self.queue);
        let sender = queue.get_or_insert_with(|| {
            let (sender, mut requests) = mpsc::unbounded_channel::<ScreenIndicatorParams>();
            let host = self.host.clone();
            mixdog_rt::spawn("screen-indicator", TaskClass::Work, async move {
                while let Some(params) = requests.recv().await {
                    let Ok(params) = serde_json::to_value(&params) else { continue };
                    // A desktop that serves no pill (not connected, an older one) shows none: the session goes on.
                    if let Err(error) = host.request(HostCapability::Browser, Method("host/screen/indicator"), params).await {
                        tracing::debug!(?error, "the desktop did not take the screen indicator");
                    }
                }
            });
            sender
        });
        let _ = sender.send(params);
    }
}

impl ScreenIndicatorPort for DesktopIndicator {
    fn show(&self, state: IndicatorState) {
        let IndicatorState { client_label, controlling, screen_id, on_stop } = state;
        self.stops.set(&screen_id, on_stop.clone());
        *lock(&self.shown) = Some(Shown { screen_id: screen_id.clone(), label: client_label.clone(), on_stop });
        self.send(ScreenIndicatorParams { state: ScreenIndicatorState::Show, screen_id, client_label: Some(client_label), controlling: Some(controlling) });
    }

    fn update(&self, controlling: bool) {
        let shown = lock(&self.shown);
        if let Some(shown) = shown.as_ref() {
            self.send(ScreenIndicatorParams {
                state: ScreenIndicatorState::Update,
                screen_id: shown.screen_id.clone(),
                client_label: Some(shown.label.clone()),
                controlling: Some(controlling),
            });
        }
    }

    fn hide(&self) {
        let Some(shown) = lock(&self.shown).take() else { return };
        self.stops.clear(&shown.screen_id, &shown.on_stop);
        self.send(ScreenIndicatorParams { state: ScreenIndicatorState::Hide, screen_id: shown.screen_id, client_label: None, controlling: None });
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Input

/// One session's input host: its own `mixdog-computer --screen-input` process.
struct InputHost {
    input: Arc<ScreenInput>,
}

impl ScreenInputHost for InputHost {
    fn start(&self) -> BoxFuture<'static, Result<(), String>> {
        let input = self.input.clone();
        Box::pin(async move { input.start().await.map_err(|error| error.code) })
    }

    fn input(&self, op: InputOp) -> BoxFuture<'static, Result<Vec<String>, String>> {
        let input = self.input.clone();
        Box::pin(async move { input.apply(&op).await.map(|()| Vec::new()).map_err(|error| error.code) })
    }

    fn cursor(&self) -> BoxFuture<'static, Result<Vec<String>, String>> {
        let input = self.input.clone();
        Box::pin(async move { input.cursor().await.map(|(x, y)| vec![x.to_string(), y.to_string()]).map_err(|error| error.code) })
    }

    fn desktop(&self) -> Option<InputDesktop> {
        self.input.desktop_watch().borrow().clone()
    }

    fn session(&self) -> Option<u32> {
        self.input.session()
    }

    fn on_desktop(&self, listener: Arc<dyn Fn(&InputDesktop) + Send + Sync>) -> Box<dyn FnOnce() + Send> {
        let mut watch = self.input.desktop_watch();
        let task = mixdog_rt::spawn("screen-input-desktop", TaskClass::Work, async move {
            while watch.changed().await.is_ok() {
                let current = watch.borrow_and_update().clone();
                if let Some(current) = current {
                    listener(&current);
                }
            }
        });
        Box::new(move || task.abort())
    }

    fn on_exit(&self, listener: Arc<dyn Fn(&()) + Send + Sync>) -> Box<dyn FnOnce() + Send> {
        let mut watch = self.input.exit_watch();
        let task = mixdog_rt::spawn("screen-input-exit", TaskClass::Work, async move {
            while watch.changed().await.is_ok() {
                listener(&());
            }
        });
        Box::new(move || task.abort())
    }

    fn stop(&self) -> BoxFuture<'static, ()> {
        let input = self.input.clone();
        Box::pin(async move { input.stop().await })
    }

    fn kill(&self) {
        let input = self.input.clone();
        mixdog_rt::spawn("screen-input-kill", TaskClass::Work, async move { input.kill().await });
    }
}

// ---------------------------------------------------------------------------------------------------------------
// PC access

/// The install state of PC access as the phone's screen control names it.
fn install_state(state: HelperState) -> InstallState {
    match state {
        HelperState::Installed => InstallState::Installed,
        HelperState::Outdated => InstallState::Outdated,
        HelperState::NotInstalled => InstallState::NotInstalled,
        HelperState::NotEnrolled => InstallState::NotEnrolled,
        HelperState::OtherUser => InstallState::OtherUser,
        HelperState::Unavailable => InstallState::Unavailable,
    }
}

/// How a password request ended as the phone is told: `busy`, or the installer's outcome name.
fn answered(answer: CredentialAnswer) -> PcAccessAnswer {
    let outcome = match answer.outcome {
        CredentialOutcome::Busy => "busy".to_owned(),
        CredentialOutcome::Ran(kind) => kind.name().to_owned(),
    };
    PcAccessAnswer { outcome, state: install_state(answer.state), detail: answer.detail }
}

struct CorePcAccess {
    service: Arc<PcAccessService>,
    admin: Arc<AccountAdmin>,
}

impl ScreenPcAccessPort for CorePcAccess {
    fn account_is_admin(&self) -> BoxFuture<'static, Result<Option<bool>, String>> {
        let admin = self.admin.clone();
        Box::pin(async move { Ok(admin.is_admin().await) })
    }

    fn approve_with_credential(
        &self,
        client_id: String,
        public_key: String,
        credential: Credential,
        cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> BoxFuture<'static, Result<PcAccessAnswer, String>> {
        let service = self.service.clone();
        Box::pin(async move {
            let credential = PcCredential { user: credential.user, password: credential.password };
            service.approve_with_credential(CredentialRequest { client_id, public_key, credential, cancelled }).await.map(answered)
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Pictures

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PixelsReply {
    blob: BlobRef,
    capture_width: u32,
    capture_height: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobRef {
    digest: String,
    byte_length: u64,
    mime_type: String,
}

/// The desktop's capture of one display (`host/computer/pixels`): the JPEG it uploaded to the core's blob store, read back as a
/// frame whose size is the capture's.
struct HostPixels {
    desktop: Arc<dyn HostChannel>,
    blobs: Arc<dyn ComputerBlobs>,
    origin: Instant,
}

impl DisplayPixels for HostPixels {
    fn frame(&self, display: DisplayId) -> BoxFuture<'static, Result<VideoFrame, MediaError>> {
        let (desktop, blobs, origin) = (self.desktop.clone(), self.blobs.clone(), self.origin);
        let unavailable = |reason: String| MediaError::Unavailable { reason };
        Box::pin(async move {
            let request = json!({
                "target": { "kind": "display", "displayId": display.0.to_string(), "index": display.0 },
                "backend": "screen",
                "maxWidth": PIXELS_MAX_WIDTH,
                "format": "jpeg",
                "quality": PIXELS_QUALITY,
            });
            let reply = desktop.request(HostCapability::Computer, Method("host/computer/pixels"), request).await.map_err(|error| unavailable(format!("{error:?}")))?;
            let reply: PixelsReply = serde_json::from_value(reply).map_err(|_| unavailable("the desktop's capture reply is malformed".to_owned()))?;
            if reply.capture_width == 0 || reply.capture_height == 0 || reply.blob.mime_type != "image/jpeg" {
                return Err(unavailable("the desktop's capture is not a JPEG with a size".to_owned()));
            }
            let bytes = blobs.read(&reply.blob.digest).await.map_err(|error| unavailable(format!("{error:?}")))?;
            if bytes.is_empty() || bytes.len() as u64 != reply.blob.byte_length {
                return Err(unavailable("the desktop's capture is not the length it stored".to_owned()));
            }
            Ok(VideoFrame {
                width: reply.capture_width,
                height: reply.capture_height,
                stride: 0,
                format: PixelFormat::Jpeg,
                data: Bytes::from(bytes),
                seq: 0,
                captured_at: origin.elapsed(),
            })
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The viewer's side

/// The live view's side of every session, handed to the sources before the live view binds them: what a session reports goes on to
/// it. No session exists before the live view resolved one, so nothing is reported before it is bound.
#[derive(Default)]
struct SinkCell {
    target: OnceLock<Arc<dyn ScreenSink>>,
}

impl ScreenSink for SinkCell {
    fn geometry_changed(&self, key: &str, geometry: Option<Value>) {
        if let Some(target) = self.target.get() {
            target.geometry_changed(key, geometry);
        }
    }

    fn capture_changed(&self, key: &str) {
        if let Some(target) = self.target.get() {
            target.capture_changed(key);
        }
    }

    fn channel_push(&self, key: &str, message: Value) {
        if let Some(target) = self.target.get() {
            target.channel_push(key, message);
        }
    }

    fn drawn_track(&self, key: &str, drawn: bool) {
        if let Some(target) = self.target.get() {
            target.drawn_track(key, drawn);
        }
    }

    fn frame(&self, key: &str, frame: ScreenFrame) {
        if let Some(target) = self.target.get() {
            target.frame(key, frame);
        }
    }
}

#[cfg(test)]
#[path = "compose_screen_service_tests.rs"]
mod tests;
