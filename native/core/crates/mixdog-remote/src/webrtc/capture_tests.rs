//! What `source-capture.test.mjs` (Node `b6f10295a`, apps/desktop/src/renderer/remote-webrtc-sender) shows a user of a
//! source's capture, on the core's shared capture (D-remote-2 moved the sender into mixdogd): a capture that is closed or
//! superseded before it is installed is released and never shown, only the newest of overlapping captures is shown, and
//! a closed source shows nothing more. Releasing a source here is dropping it (the screen capture's end).

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

use super::SharedSource;
use crate::webrtc::sources::FeedSource;
use crate::webrtc::sources::FrameSink;
use crate::webrtc::sources::frame_feed;

/// A capture whose release is seen.
struct Probe {
    feed: FeedSource,
    released: Arc<AtomicBool>,
}

impl Drop for Probe {
    fn drop(&mut self) {
        self.released.store(true, SeqCst);
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

fn capture() -> (FrameSink, Box<Probe>, Arc<AtomicBool>) {
    let (sink, feed) = frame_feed(FrameSourceKind::SecureDesktop);
    let released = Arc::new(AtomicBool::new(false));
    (sink, Box::new(Probe { feed, released: released.clone() }), released)
}

fn picture(sink: &mut FrameSink, width: u32) {
    sink.push(PixelFormat::Bgrx, width, 1, width * 4, Bytes::from(vec![0; (width * 4) as usize])).unwrap();
}

async fn until(what: &str, done: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what} within 10 s"));
}

/// "closed while opening" and "closed while swapping" (`source-capture.test.mjs:43`, `:63`), "draw abandons an opening
/// capture" (`:141`): the capture that arrives as the source closes is released, and nothing is shown after the close.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_capture_arriving_as_the_source_closes_is_released_and_never_shown() {
    mixdog_rt::testing::tokens();
    let (mut first, source, first_released) = capture();
    let shared = SharedSource::start(source);
    let mut shots = shared.subscribe();
    picture(&mut first, 1);
    shots.changed().await.unwrap();
    let (mut late, replacement, late_released) = capture();
    picture(&mut late, 2);
    shared.set_source(replacement);
    shared.stop();
    until("both captures released", || first_released.load(SeqCst) && late_released.load(SeqCst)).await;
    let at_close = shots.borrow().as_ref().map(|shot| (shot.generation, shot.frame.seq, shot.frame.width));
    picture(&mut first, 3);
    picture(&mut late, 4);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let now = shots.borrow().as_ref().map(|shot| (shot.generation, shot.frame.seq, shot.frame.width));
    assert_eq!(now, at_close, "nothing is shown after the close");
    let (_after, after_close, after_released) = capture();
    shared.set_source(after_close);
    assert!(after_released.load(SeqCst), "a capture arriving after the close is released at once");
}

/// "overlapping captures" and "a newer capture during an older swap" (`:83`, `:166`): only the newest capture is shown;
/// the older ones are released.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_the_newest_of_overlapping_captures_is_shown() {
    mixdog_rt::testing::tokens();
    let (mut first, source, first_released) = capture();
    let shared = SharedSource::start(source);
    let mut shots = shared.subscribe();
    picture(&mut first, 1);
    shots.changed().await.unwrap();
    let (mut older, older_source, older_released) = capture();
    let (mut newer, newer_source, newer_released) = capture();
    picture(&mut older, 2);
    picture(&mut newer, 3);
    shared.set_source(older_source);
    shared.set_source(newer_source);
    until("the newest capture shown", || shots.borrow().as_ref().is_some_and(|shot| shot.frame.width == 3)).await;
    until("the older captures released", || first_released.load(SeqCst) && older_released.load(SeqCst)).await;
    assert!(!newer_released.load(SeqCst), "the shown capture stays open");
    picture(&mut older, 4);
    picture(&mut newer, 5);
    until("the newest capture's next picture", || shots.borrow().as_ref().is_some_and(|shot| shot.frame.width == 5)).await;
    shared.stop();
    until("the shown capture released at the close", || newer_released.load(SeqCst)).await;
}
