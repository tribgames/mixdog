//! Who holds a screen capture, as the live view's shared source behaves: every viewer reads the one newest picture, a
//! replacement source starts a new generation without leaking the old picture, an ended or failed source is reported, and
//! stopping releases both the running and the waiting source at once.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::media::{FrameSourceKind, MediaError, MediaFrameSource, PixelFormat, VideoFrame};
use mixdog_remote::webrtc::capture::{SharedSource, SourceState};
use tokio::sync::mpsc;
use tokio::sync::watch;

const BOUND: Duration = Duration::from_secs(20);

/// A source whose pictures the test hands over one at a time; `released` turns true once it is dropped.
struct Scripted {
    frames: mpsc::UnboundedReceiver<Result<Option<VideoFrame>, MediaError>>,
    released: Arc<AtomicBool>,
}

impl Drop for Scripted {
    fn drop(&mut self) {
        self.released.store(true, Ordering::SeqCst);
    }
}

#[async_trait]
impl MediaFrameSource for Scripted {
    fn kind(&self) -> FrameSourceKind {
        FrameSourceKind::Screen { display: 0 }
    }

    async fn next_frame(&mut self) -> Result<Option<VideoFrame>, MediaError> {
        self.frames.recv().await.unwrap_or(Ok(None))
    }
}

struct Handle {
    feed: mpsc::UnboundedSender<Result<Option<VideoFrame>, MediaError>>,
    released: Arc<AtomicBool>,
}

fn scripted() -> (Scripted, Handle) {
    let (feed, frames) = mpsc::unbounded_channel();
    let released = Arc::new(AtomicBool::new(false));
    (Scripted { frames, released: released.clone() }, Handle { feed, released })
}

fn picture(seq: u64) -> VideoFrame {
    VideoFrame { width: 2, height: 2, stride: 8, format: PixelFormat::Bgra, data: Bytes::from(vec![seq as u8; 16]), seq, captured_at: Duration::from_millis(seq) }
}

async fn next_shot(shots: &mut watch::Receiver<Option<mixdog_remote::webrtc::capture::Shot>>) -> Option<mixdog_remote::webrtc::capture::Shot> {
    mixdog_rt::time::timeout(BOUND, shots.changed()).await.expect("a change within the bound").expect("the source lives");
    shots.borrow_and_update().clone()
}

async fn until(what: &str, mut done: impl FnMut() -> bool) {
    mixdog_rt::time::timeout(BOUND, async {
        while !done() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what} within the bound"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_viewer_of_the_source_sees_the_same_newest_picture_of_generation_zero() {
    mixdog_rt::testing::tokens();
    let (source, handle) = scripted();
    let shared = SharedSource::start(Box::new(source));
    let (mut first, mut second) = (shared.subscribe(), shared.subscribe());
    handle.feed.send(Ok(Some(picture(1)))).unwrap();
    let (a, b) = (next_shot(&mut first).await.expect("a picture"), next_shot(&mut second).await.expect("a picture"));
    assert_eq!((a.generation, a.frame.seq), (0, 1));
    assert_eq!((b.generation, b.frame.seq), (0, 1));
    assert_eq!(shared.state(), SourceState::Live);
    shared.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replacement_source_clears_the_old_picture_and_starts_generation_one() {
    mixdog_rt::testing::tokens();
    let (old, old_handle) = scripted();
    let shared = SharedSource::start(Box::new(old));
    let mut shots = shared.subscribe();
    old_handle.feed.send(Ok(Some(picture(1)))).unwrap();
    assert_eq!(next_shot(&mut shots).await.expect("a picture").generation, 0);

    let (new, new_handle) = scripted();
    shared.set_source(Box::new(new));
    assert!(next_shot(&mut shots).await.is_none(), "the old source's picture is not shown for the new one");
    until("the old source is let go", || old_handle.released.load(Ordering::SeqCst)).await;
    new_handle.feed.send(Ok(Some(picture(1)))).unwrap();
    let shot = next_shot(&mut shots).await.expect("a picture");
    assert_eq!((shot.generation, shot.frame.seq), (1, 1));
    assert!(!new_handle.released.load(Ordering::SeqCst), "the new source is held");
    shared.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_source_that_ends_or_fails_is_reported_and_a_replacement_makes_it_live_again() {
    mixdog_rt::testing::tokens();
    let (ending, ending_handle) = scripted();
    let shared = SharedSource::start(Box::new(ending));
    ending_handle.feed.send(Ok(None)).unwrap();
    until("the end is seen", || shared.state() == SourceState::Ended).await;

    let (failing, failing_handle) = scripted();
    shared.set_source(Box::new(failing));
    failing_handle.feed.send(Err(MediaError::Unavailable { reason: "the desktop is locked".into() })).unwrap();
    until("the failure is seen", || shared.state() == SourceState::Failed(MediaError::Unavailable { reason: "the desktop is locked".into() })).await;

    let (live, live_handle) = scripted();
    shared.set_source(Box::new(live));
    let mut shots = shared.subscribe();
    live_handle.feed.send(Ok(Some(picture(1)))).unwrap();
    assert_eq!(next_shot(&mut shots).await.expect("a picture").generation, 2);
    assert_eq!(shared.state(), SourceState::Live);
    shared.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_releases_the_running_source_and_one_that_arrives_afterwards_at_once() {
    mixdog_rt::testing::tokens();
    let (running, running_handle) = scripted();
    let shared = SharedSource::start(Box::new(running));
    shared.stop();
    until("the running source is released", || running_handle.released.load(Ordering::SeqCst)).await;

    let (late, late_handle) = scripted();
    shared.set_source(Box::new(late));
    assert!(late_handle.released.load(Ordering::SeqCst), "a source that arrives after stop is released before set_source returns");
}
