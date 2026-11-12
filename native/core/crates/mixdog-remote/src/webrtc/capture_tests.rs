//! What `source-capture.test.mjs` (Node `b6f10295a`, apps/desktop/src/renderer/remote-webrtc-sender) shows of a source's
//! capture, replayed from `fixtures/source-capture-cases` (`record-source-capture-cases.mjs`) on the core's shared capture
//! (D-remote-2 moved the sender into mixdogd): each recorded scenario is played as the core receives it, and the whole
//! outcome Node recorded (which captures were stopped, which one is the source) is compared with the core's. Releasing a
//! capture here is dropping it (the screen capture's end); every wait is an event (a release, a picture shown) under one
//! deadline that names it.
//!
//! The renderer acquires a capture asynchronously and settles who owns the source by the order the captures *started*
//! (`source-capture.ts:55-60`); the core's source receives captures already acquired and the newest arrival owns it. A
//! scenario's captures are therefore played by role: the one Node ends up stopping is the one the core has been given
//! before the capture that supersedes it, or, for a close, the one that arrives after it.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering::SeqCst;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::media::FrameSourceKind;
use mixdog_core_api::domain::media::MediaError;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::media::PixelFormat;
use mixdog_core_api::domain::media::VideoFrame;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use super::SharedSource;
use crate::webrtc::sources::FeedSource;
use crate::webrtc::sources::FrameSink;
use crate::webrtc::sources::frame_feed;

/// A capture's release, which a waiter is woken by.
#[derive(Default)]
struct Released {
    flag: AtomicBool,
    moved: Notify,
}

impl Released {
    async fn wait(&self, what: &str) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let moved = self.moved.notified();
                tokio::pin!(moved);
                moved.as_mut().enable();
                if self.flag.load(SeqCst) {
                    return;
                }
                moved.await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("waited 10 s for {what} to be released"));
    }
}

/// A capture whose release is seen.
struct Probe {
    feed: FeedSource,
    released: Arc<Released>,
}

impl Drop for Probe {
    fn drop(&mut self) {
        self.released.flag.store(true, SeqCst);
        self.released.moved.notify_waiters();
    }
}

#[async_trait]
impl MediaFrameSource for Probe {
    fn kind(&self) -> FrameSourceKind {
        self.feed.kind()
    }
    async fn next_frame(&mut self) -> Result<Option<VideoFrame>, MediaError> {
        self.feed.next_frame().await
    }
}

/// A named capture: its picture is as wide as its number, so the picture shown says whose it is.
struct Capture {
    name: &'static str,
    width: u32,
    sink: FrameSink,
    released: Arc<Released>,
}

fn capture(name: &'static str, width: u32) -> (Capture, Box<Probe>) {
    let (sink, feed) = frame_feed(FrameSourceKind::SecureDesktop);
    let released = Arc::new(Released::default());
    (Capture { name, width, sink, released: released.clone() }, Box::new(Probe { feed, released }))
}

impl Capture {
    fn picture(&mut self) {
        let width = self.width;
        self.sink.push(PixelFormat::Bgrx, width, 1, width * 4, Bytes::from(vec![0; (width * 4) as usize])).unwrap();
    }
}

fn shown(shots: &tokio::sync::watch::Receiver<Option<super::Shot>>, names: &[&Capture]) -> Value {
    let width = shots.borrow().as_ref().map(|shot| shot.frame.width);
    names.iter().find(|capture| Some(capture.width) == width).map_or(Value::Null, |capture| json!(capture.name))
}

async fn shows(shots: &mut tokio::sync::watch::Receiver<Option<super::Shot>>, capture: &Capture) {
    let width = capture.width;
    tokio::time::timeout(Duration::from_secs(10), shots.wait_for(|shot| shot.as_ref().is_some_and(|shot| shot.frame.width == width)))
        .await
        .unwrap_or_else(|_| panic!("waited 10 s for {}'s picture to be shown", capture.name))
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_recorded_capture_scenario_ends_as_in_node() {
    mixdog_rt::testing::tokens();
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/source-capture-cases/golden.json")).expect("json");
    let excluded = ["senders", "reports"];
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        // The source's first capture: Node's scenarios start with none, the core's source always has one.
        let (mut base, source) = capture("(first)", 100);
        let shared = SharedSource::start(source);
        let mut shots = shared.subscribe();
        base.picture();
        shows(&mut shots, &base).await;
        let mut all: Vec<Capture> = match name {
            "a source closed while its capture opens" => {
                // The source closes, then its capture arrives.
                shared.stop();
                let (late, arriving) = capture("late", 101);
                shared.set_source(arriving);
                vec![late]
            }
            "a source closed while its capture swaps tracks" => {
                // The capture has arrived and is waiting to be taken when the source closes.
                let (late, arriving) = capture("late", 101);
                shared.set_source(arriving);
                shared.stop();
                vec![late]
            }
            "overlapping captures" => {
                let (late, older) = capture("late", 101);
                let (mut newest, newer) = capture("newest", 102);
                shared.set_source(older);
                shared.set_source(newer);
                newest.picture();
                shows(&mut shots, &newest).await;
                vec![newest, late]
            }
            "a draw abandons a capture still opening" => {
                // The capture the draw supersedes is the one shown; the drawn source takes over.
                let (mut late, shown_capture) = capture("late", 101);
                shared.set_source(shown_capture);
                late.picture();
                shows(&mut shots, &late).await;
                let (mut drawn, source) = capture("drawn", 102);
                shared.set_source(source);
                drawn.picture();
                shows(&mut shots, &drawn).await;
                vec![late, drawn]
            }
            "a newer capture that starts while the older one swaps tracks" => {
                let (mut first, older) = capture("first", 101);
                shared.set_source(older);
                first.picture();
                shows(&mut shots, &first).await;
                let (mut second, newer) = capture("second", 102);
                shared.set_source(newer);
                second.picture();
                shows(&mut shots, &second).await;
                vec![second, first]
            }
            other => panic!("{other}: no replay and no exclusion"),
        };
        // Each capture Node stopped is released here (an event); then the flags are read.
        let want = case["recorded"]["stopped"].as_object().expect("stopped");
        for capture in all.iter().filter(|capture| want.get(capture.name) == Some(&json!(true))) {
            capture.released.wait(capture.name).await;
        }
        // The pictures a stopped or superseded capture still pushes show nothing more.
        for capture in all.iter_mut().filter(|capture| want.get(capture.name) == Some(&json!(true))) {
            capture.picture();
        }
        let refs: Vec<&Capture> = all.iter().collect();
        let got = json!({
            "stopped": all.iter().filter(|capture| want.contains_key(capture.name)).map(|capture| (capture.name.to_owned(), json!(capture.released.flag.load(SeqCst)))).collect::<serde_json::Map<_, _>>(),
            "source": shown(&shots, &refs),
        });
        let mut recorded = case["recorded"].clone();
        for key in excluded.iter().chain(&["drawnIsSource", "sendersWhenTheOlderEnded"]) {
            recorded.as_object_mut().expect("outcome").remove(*key);
        }
        assert_eq!(got, recorded, "{name}");
        shared.stop();
    }
}
