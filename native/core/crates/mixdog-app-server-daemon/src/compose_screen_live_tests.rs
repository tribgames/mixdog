use std::collections::VecDeque;
use std::time::Duration;

use bytes::Bytes;
use futures::future::BoxFuture;
use mixdog_core_api::domain::media::FrameSourceKind;
use mixdog_core_api::domain::media::MediaError;
use mixdog_core_api::domain::media::PixelFormat;
use mixdog_core_api::domain::media::VideoFrame;
use mixdog_remote::webrtc::capture::Shot;
use mixdog_remote::webrtc::config::Candidate;
use mixdog_remote::webrtc::config::IceServer;
use mixdog_remote::webrtc::host::HostEnv;
use mixdog_remote::webrtc::host::Picture;
use mixdog_remote::webrtc::signal::DesktopSignal;
use mixdog_remote::webrtc::signal::Source;
use mixdog_tools::desktop::screen_source::HelperPictureFrame;
use mixdog_tools::desktop::screen_source::PixelArea;
use mixdog_tools::desktop::screen_source::VideoArea;
use serde_json::json;

use super::*;
use crate::live_view::ScreenEnd;

const KEY: &str = "screen:0";

#[derive(Default)]
struct Env {
    closed: Mutex<Vec<String>>,
}

impl HostEnv for Env {
    fn spawn(&self, _work: BoxFuture<'static, ()>) {}

    fn send_signal(&self, _client: &str, _signal: &DesktopSignal) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn source(&self, _source: &Source, _client: &str, _signal: &str) -> Option<Arc<dyn VideoSource>> {
        None
    }

    fn open(&self, _connection_id: &str, _source_key: &str, _ice_servers: &[IceServer], _receive_codecs: &[String]) {}

    fn answer(&self, _connection_id: &str, _sdp: &str) {}

    fn candidate(&self, _connection_id: &str, _candidate: &Option<Candidate>) {}

    fn channel_send(&self, _connection_id: &str, _text: &str) {}

    fn close(&self, _connection_id: &str) {}

    fn push_picture(&self, _source_key: &str, _frame_id: u64, _picture: &Picture) {}

    fn source_closed(&self, source_key: &str) {
        lock(&self.closed).push(source_key.to_owned());
    }

    fn report(&self, _event: &str, _data: Value) {}

    fn new_connection_id(&self) -> String {
        String::new()
    }

    fn now(&self) -> f64 {
        0.0
    }

    fn set_timer(&self, _ms: u64, _run: Arc<dyn Fn(u64) + Send + Sync>) -> u64 {
        0
    }

    fn clear_timer(&self, _handle: u64) {}
}

/// Pictures that are handed over once, and then none comes.
struct Pictures(VecDeque<VideoFrame>);

#[async_trait]
impl MediaFrameSource for Pictures {
    fn kind(&self) -> FrameSourceKind {
        FrameSourceKind::Screen { display: 0 }
    }

    async fn next_frame(&mut self) -> Result<Option<VideoFrame>, MediaError> {
        match self.0.pop_front() {
            Some(frame) => Ok(Some(frame)),
            None => std::future::pending().await,
        }
    }
}

struct Screens {
    capture: Mutex<Option<Result<Box<dyn MediaFrameSource>, String>>>,
}

impl Screens {
    fn capturing(frames: Vec<VideoFrame>) -> Arc<Self> {
        Arc::new(Self { capture: Mutex::new(Some(Ok(Box::new(Pictures(frames.into()))))) })
    }

    fn refusing() -> Arc<Self> {
        Arc::new(Self { capture: Mutex::new(Some(Err("the display cannot be captured".to_owned()))) })
    }
}

#[async_trait]
impl PhoneScreens for Screens {
    async fn displays(&self) -> Result<Value, String> {
        Ok(json!([]))
    }

    async fn grant(&self, _connection: ConnectionId) -> Result<(), String> {
        Ok(())
    }

    fn withdraw(&self, _connection: ConnectionId, _ended: ScreenEnd) {}

    fn resolve(&self, _screen_id: &str, _connection: ConnectionId, _ready: bool) -> Option<Arc<ScreenViewer>> {
        None
    }

    fn capture(&self, _screen_id: &str) -> Result<Box<dyn MediaFrameSource>, String> {
        lock(&self.capture).take().unwrap_or_else(|| Err("no capture".to_owned()))
    }

    fn attach(&self, _sink: Arc<dyn ScreenSink>) {}
}

fn picture(width: u32, height: u32, bgr: [u8; 3]) -> VideoFrame {
    let data: Vec<u8> = (0..width * height).flat_map(|_| [bgr[0], bgr[1], bgr[2], 0]).collect();
    VideoFrame { width, height, stride: width * 4, format: PixelFormat::Bgrx, data: Bytes::from(data), seq: 0, captured_at: Duration::ZERO }
}

fn geometry(width: u32, height: u32) -> Value {
    json!({ "generation": 1, "cssWidth": 1920, "cssHeight": 1080, "deviceScaleFactor": 1, "pixelWidth": width, "pixelHeight": height })
}

fn live(screens: Arc<Screens>) -> (Arc<ScreenLive>, Arc<Env>) {
    mixdog_rt::testing::tokens();
    let env = Arc::new(Env::default());
    (ScreenLive::new(LiveHost::new(env.clone()), screens), env)
}

/// The events are applied by a task of their own: waits until `ready` holds.
async fn until<T>(mut ready: impl FnMut() -> Option<T>) -> T {
    for _ in 0..3_000 {
        if let Some(found) = ready() {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("the live view did not apply the screen's events");
}

async fn shot(shared: &SharedSource) -> Shot {
    let shots = shared.subscribe();
    until(|| shots.borrow().clone()).await
}

#[tokio::test]
async fn the_track_of_a_screen_is_its_capture_scaled_onto_the_locked_geometry() {
    let (live, _env) = live(Screens::capturing(vec![picture(16, 8, [10, 20, 30])]));
    assert!(live.track(KEY).is_err(), "a screen with no geometry has no track");
    live.sink().geometry_changed(KEY, Some(geometry(8, 4)));
    let shared = until(|| live.track(KEY).ok()).await;
    let shot = shot(&shared).await;
    assert_eq!((shot.frame.width, shot.frame.height), (8, 4));
    assert_eq!(&shot.frame.data[..4], &[10, 20, 30, 0xff][..]);
    // Every connection of the screen shares the one source.
    assert!(Arc::ptr_eq(&shared, &live.track(KEY).unwrap()));
}

#[tokio::test]
async fn a_screen_that_cannot_be_captured_has_no_track() {
    let (live, _env) = live(Screens::refusing());
    live.sink().geometry_changed(KEY, Some(geometry(8, 4)));
    let detail = until(|| live.track(KEY).err().filter(|detail| detail != "the screen has no locked geometry")).await;
    assert_eq!(detail, "the display cannot be captured");
}

#[tokio::test]
async fn a_geometry_the_contract_refuses_is_no_geometry() {
    let (live, _env) = live(Screens::capturing(vec![]));
    live.sink().geometry_changed(KEY, Some(geometry(7, 4)));
    // The events are applied in order: once this one's geometry has, the refused one has been judged.
    live.sink().geometry_changed("screen:1", Some(geometry(8, 4)));
    until(|| live.track("screen:1").ok()).await;
    assert_eq!(live.track(KEY).err().as_deref(), Some("the screen has no locked geometry"));
}

#[tokio::test]
async fn the_end_of_a_screen_ends_its_track_and_tells_the_host() {
    let (live, env) = live(Screens::capturing(vec![picture(8, 4, [1, 2, 3])]));
    live.sink().geometry_changed(KEY, Some(geometry(8, 4)));
    until(|| live.track(KEY).ok()).await;
    live.sink().geometry_changed(KEY, None);
    until(|| lock(&env.closed).contains(&KEY.to_owned()).then_some(())).await;
    assert!(live.track(KEY).is_err());
}

#[tokio::test]
async fn the_helpers_frames_are_the_track_while_it_serves_and_the_capture_returns_after() {
    let (live, _env) = live(Screens::capturing(vec![picture(8, 4, [1, 2, 3])]));
    let sink = live.sink();
    sink.geometry_changed(KEY, Some(geometry(8, 4)));
    // The helper serves before any connection opened the track: the first one gets the drawn track.
    sink.drawn_track(KEY, true);
    let shared = until(|| live.track(KEY).ok()).await;
    let frame = |bgr: u8| ScreenFrame {
        document_id: None,
        geometry: geometry(8, 4),
        epoch: 5,
        mime_type: "image/x-bgrx",
        picture: HelperPictureFrame {
            pixels: Arc::new((0..4 * 4 * 8).map(|at| if at % 4 == 3 { 0 } else { bgr }).collect()),
            rows: 0..4,
            width: 8,
            height: 4,
            stride: 32,
            source: PixelArea { x: 0, y: 0, width: 8, height: 4 },
            target: VideoArea { x: 0.0, y: 0.0, width: 8.0, height: 4.0 },
        },
    };
    sink.frame(KEY, frame(200));
    let drawn = shot(&shared).await;
    assert_eq!((drawn.frame.width, drawn.frame.height), (8, 4));
    assert_eq!(&drawn.frame.data[..3], &[200, 200, 200][..]);
    // The helper stopped serving: the capture is the track again (a new generation of the shared source).
    sink.drawn_track(KEY, false);
    until(|| lock(&live.core.feeds).get(KEY).is_some_and(|feed| feed.drawn.is_none()).then_some(())).await;
    // A helper frame after that is nobody's.
    sink.frame(KEY, frame(9));
}

#[tokio::test]
async fn a_helper_frame_before_the_helper_serves_is_dropped() {
    let (live, _env) = live(Screens::capturing(vec![]));
    let sink = live.sink();
    sink.geometry_changed(KEY, Some(geometry(8, 4)));
    sink.channel_push(KEY, json!({ "v": 1, "kind": "screen-video" }));
    let mut ignored = ScreenFrame {
        document_id: None,
        geometry: geometry(8, 4),
        epoch: 1,
        mime_type: "image/x-bgrx",
        picture: HelperPictureFrame {
            pixels: Arc::new(vec![0; 128]),
            rows: 0..4,
            width: 8,
            height: 4,
            stride: 32,
            source: PixelArea { x: 0, y: 0, width: 8, height: 4 },
            target: VideoArea { x: 0.0, y: 0.0, width: 8.0, height: 4.0 },
        },
    };
    sink.frame(KEY, ignored.clone());
    ignored.epoch = 2;
    sink.frame(KEY, ignored);
    let shared = until(|| live.track(KEY).ok()).await;
    assert!(shared.subscribe().borrow().is_none(), "nothing was drawn");
}
