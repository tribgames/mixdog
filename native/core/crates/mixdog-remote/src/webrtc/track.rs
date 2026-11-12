//! One viewer's outgoing VP8 video: its own encoder thread (the `webrtc-media` executor, below RT
//! priority) fed with the newest picture of a shared [`SharedSource`]. Frame-rate and bitrate
//! limits, congestion estimates and keyframe requests belong to this viewer alone.
//!
//! The thread never waits on the viewer. Encoded pictures go through a small bounded ring; a
//! viewer that falls behind loses pictures, asks for a keyframe and skips deltas until it gets
//! one. A source that outpaces the encoder is coalesced to its newest frame, and
//! `max_framerate` holds only the newest frame of a burst until its slot, so a still screen's
//! last picture is never lost.

use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;
use std::time::Instant;

use bytes::Bytes;
use mixdog_core_api::domain::media::EncodingParams;
use mixdog_core_api::domain::media::MediaError;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::media::VideoCodec;
use mixdog_core_api::domain::media::VideoFrame;
use mixdog_core_api::domain::media::VideoTrack;
use mixdog_rt::MediaThread;
use mixdog_rt::ThreadToken;
use tokio::sync::Notify;
use tokio::sync::broadcast;
use tokio::sync::watch;

use super::capture::SharedSource;
use super::capture::Shot;
pub use super::capture::SourceState;

use super::convert::I420Buf;
use super::encoder::DEFAULT_BITRATE_BPS;
use super::encoder::Vp8Encoder;

/// Pictures a viewer may fall behind before it loses some.
const RING: usize = 4;
/// Duration of the first picture, before there is a cadence to measure.
const FIRST_DURATION: Duration = Duration::from_millis(33);
const MAX_DURATION: Duration = Duration::from_secs(1);

/// One encoded picture of one viewer.
#[derive(Debug)]
pub struct EncodedSample {
    pub data: Bytes,
    pub keyframe: bool,
    /// Time since the previous picture on the source's clock (RTP timestamp step).
    pub duration: Duration,
    pub width: u32,
    pub height: u32,
}

/// Counters of one track (the sender side of the live view's measurement line).
#[derive(Clone, Debug, Default)]
pub struct TrackStats {
    pub frames_captured: u64,
    /// Frames replaced by a newer one before they were encoded.
    pub frames_superseded: u64,
    pub frames_encoded: u64,
    pub keyframes: u64,
    /// Frames the converter or encoder refused.
    pub frames_failed: u64,
    pub total_encode_time: Duration,
    pub width: u32,
    pub height: u32,
    pub bitrate_bps: u32,
    pub source: SourceState,
}

struct Control {
    params: EncodingParams,
    keyframe: bool,
    stopped: bool,
    /// Estimates of what this viewer's path carries; the encoder follows the lowest.
    estimates: HashMap<u64, u32>,
    next_subscription: u64,
}

struct Shared {
    control: Mutex<Control>,
    wake: Notify,
    out: broadcast::Sender<Arc<EncodedSample>>,
    stats: Mutex<TrackStats>,
    source: Arc<SharedSource>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shared {
    fn request_keyframe(&self) {
        lock(&self.control).keyframe = true;
        self.wake.notify_one();
    }
}

pub struct Vp8Track {
    shared: Arc<Shared>,
}

impl Vp8Track {
    /// Starts this viewer's encoder thread on the shared `source`. The first subscription gets a
    /// keyframe.
    pub fn start(token: MediaThread, source: Arc<SharedSource>) -> io::Result<Arc<Self>> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()?;
        let (out, _) = broadcast::channel(RING);
        let shared = Arc::new(Shared {
            control: Mutex::new(Control {
                params: EncodingParams::SCREEN_DEFAULT,
                keyframe: false,
                stopped: false,
                estimates: HashMap::new(),
                next_subscription: 0,
            }),
            wake: Notify::new(),
            out,
            stats: Mutex::new(TrackStats::default()),
            source: Arc::clone(&source),
        });
        let frames = source.subscribe();
        let thread_shared = Arc::clone(&shared);
        token.spawn_thread("webrtc-media", move |_| {
            runtime.block_on(media_loop(thread_shared, frames));
        })?;
        Ok(Arc::new(Self { shared }))
    }

    /// A viewer's feed. It starts at the next keyframe, which this requests.
    pub fn subscribe(&self) -> Subscription {
        let id = {
            let mut control = lock(&self.shared.control);
            let id = control.next_subscription;
            control.next_subscription += 1;
            control.keyframe = true;
            id
        };
        self.shared.wake.notify_one();
        Subscription {
            id,
            rx: self.shared.out.subscribe(),
            shared: Arc::clone(&self.shared),
            need_keyframe: true,
        }
    }

    pub fn stats(&self) -> TrackStats {
        let mut stats = lock(&self.shared.stats).clone();
        stats.source = self.shared.source.state();
        stats
    }
}

impl Drop for Vp8Track {
    fn drop(&mut self) {
        self.stop();
    }
}

impl VideoTrack for Vp8Track {
    fn codec(&self) -> VideoCodec {
        VideoCodec::Vp8
    }

    fn set_source(&self, source: Box<dyn MediaFrameSource>) {
        // The source is shared: replacing it replaces it for every viewer of it.
        self.shared.source.set_source(source);
    }

    fn set_encoding(&self, params: EncodingParams) -> Result<(), MediaError> {
        if params.max_bitrate_bps == Some(0) || params.max_framerate == Some(0) {
            return Err(MediaError::Encoder {
                detail: "zero bitrate or framerate".into(),
            });
        }
        lock(&self.shared.control).params = params;
        self.shared.wake.notify_one();
        Ok(())
    }

    fn encoding(&self) -> EncodingParams {
        lock(&self.shared.control).params
    }

    fn request_keyframe(&self) {
        self.shared.request_keyframe();
    }

    fn stop(&self) {
        lock(&self.shared.control).stopped = true;
        self.shared.wake.notify_one();
    }
}

/// One viewer's feed of encoded pictures.
pub struct Subscription {
    id: u64,
    rx: broadcast::Receiver<Arc<EncodedSample>>,
    shared: Arc<Shared>,
    need_keyframe: bool,
}

impl Subscription {
    /// The next picture this viewer can decode; `None` once the track stopped. After the
    /// viewer fell behind, deltas are skipped until the keyframe it asked for arrives.
    pub async fn next(&mut self) -> Option<Arc<EncodedSample>> {
        loop {
            match self.rx.recv().await {
                Ok(sample) => {
                    if self.need_keyframe && !sample.keyframe {
                        continue;
                    }
                    self.need_keyframe = false;
                    return Some(sample);
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    self.need_keyframe = true;
                    self.shared.request_keyframe();
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }

    /// The viewer's own picture loss (PLI/FIR) or any other need for a decodable start.
    pub fn need_keyframe(&mut self) {
        self.need_keyframe = true;
        self.shared.request_keyframe();
    }

    /// What this viewer's path is estimated to carry; the encoder follows the lowest estimate
    /// of all viewers, capped by the phone's `maxBitrate`.
    pub fn report_bitrate(&self, bitrate_bps: u32) {
        lock(&self.shared.control).estimates.insert(self.id, bitrate_bps);
        self.shared.wake.notify_one();
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        lock(&self.shared.control).estimates.remove(&self.id);
    }
}

/// What the loop reads from the control state each round.
struct Round {
    stopped: bool,
    params: EncodingParams,
    /// A keyframe is requested and not yet encoded (the encode takes the request).
    keyframe_pending: bool,
    target_bps: u32,
}

fn read_control(shared: &Shared) -> Round {
    let control = lock(&shared.control);
    let ceiling = control.params.max_bitrate_bps.unwrap_or(DEFAULT_BITRATE_BPS);
    let target_bps = control
        .estimates
        .values()
        .copied()
        .min()
        .map_or(ceiling, |estimate| estimate.min(ceiling));
    Round {
        stopped: control.stopped,
        params: control.params,
        keyframe_pending: control.keyframe,
        target_bps,
    }
}

struct Pipeline {
    shared: Arc<Shared>,
    picture: I420Buf,
    encoder: Option<Vp8Encoder>,
    /// `captured_at` of the last picture that was encoded and of the one before.
    last_encoded: Option<Duration>,
    /// When the last picture was encoded, on this thread's clock (the frame-rate cap's reference).
    last_encode_at: Option<Instant>,
    /// Whether `picture` holds the current source's newest picture (for keyframe re-encodes).
    picture_captured_at: Option<Duration>,
}

impl Pipeline {
    /// Encodes `frame`, or the newest picture again when `frame` is `None`. Takes a pending
    /// keyframe request.
    fn encode(&mut self, frame: Option<&VideoFrame>, target_bps: u32) {
        let mut force_keyframe = std::mem::take(&mut lock(&self.shared.control).keyframe);
        let captured_at = match frame {
            Some(frame) => {
                if let Err(error) = self.picture.fill(frame) {
                    tracing::warn!(?error, "webrtc live view: frame refused");
                    lock(&self.shared.stats).frames_failed += 1;
                    return;
                }
                frame.captured_at
            }
            None => match self.picture_captured_at {
                Some(at) => at,
                None => return,
            },
        };
        let (width, height) = (self.picture.width, self.picture.height);
        if !self.encoder.as_ref().is_some_and(|e| e.fits(width, height)) {
            // A new size starts a new stream: a keyframe at the new geometry.
            match Vp8Encoder::new(width, height, target_bps) {
                Ok(encoder) => self.encoder = Some(encoder),
                Err(error) => return self.encoder_failed(error),
            }
            force_keyframe = true;
        }
        let Some(encoder) = self.encoder.as_mut() else {
            return;
        };
        if let Err(error) = encoder.set_bitrate(target_bps) {
            return self.encoder_failed(error);
        }
        let started = Instant::now();
        self.last_encode_at = Some(started);
        let encoded = match encoder.encode(&self.picture, force_keyframe) {
            Ok(Some(encoded)) => encoded,
            Ok(None) => return,
            Err(error) => return self.encoder_failed(error),
        };
        let elapsed = started.elapsed();
        let duration = match (frame, self.last_encoded) {
            (Some(_), Some(previous)) => captured_at
                .saturating_sub(previous)
                .clamp(Duration::from_millis(1), MAX_DURATION),
            _ => FIRST_DURATION,
        };
        if frame.is_some() {
            self.last_encoded = Some(captured_at);
        }
        self.picture_captured_at = Some(captured_at);
        {
            let mut stats = lock(&self.shared.stats);
            stats.frames_encoded += 1;
            stats.keyframes += u64::from(encoded.keyframe);
            stats.total_encode_time += elapsed;
            stats.width = width as u32;
            stats.height = height as u32;
            stats.bitrate_bps = encoder.bitrate_bps();
        }
        // No receiver is normal (no viewer yet); the next subscriber asks for a keyframe.
        let _ = self.shared.out.send(Arc::new(EncodedSample {
            data: encoded.data,
            keyframe: encoded.keyframe,
            duration,
            width: width as u32,
            height: height as u32,
        }));
    }

    fn encoder_failed(&mut self, error: MediaError) {
        tracing::warn!(?error, "webrtc live view: encoder failed");
        lock(&self.shared.stats).frames_failed += 1;
        // The next picture builds a fresh encoder and starts with a keyframe.
        self.encoder = None;
    }

    fn reset_for_new_source(&mut self) {
        self.last_encoded = None;
        self.last_encode_at = None;
        self.picture_captured_at = None;
    }
}

fn min_interval(params: &EncodingParams) -> Option<Duration> {
    params
        .max_framerate
        .map(|fps| Duration::from_secs(1) / fps.max(1))
}

async fn media_loop(shared: Arc<Shared>, mut frames: watch::Receiver<Option<Shot>>) {
    let mut pipeline = Pipeline {
        shared: Arc::clone(&shared),
        picture: I420Buf::new(),
        encoder: None,
        last_encoded: None,
        last_encode_at: None,
        picture_captured_at: None,
    };
    // The picture already on the source when this viewer joined is its first.
    frames.mark_changed();
    let mut source_open = true;
    let mut generation = None;
    let mut last_seq = 0u64;
    // The newest frame that arrived inside its predecessor's slot, and when its slot opens.
    let mut held: Option<Arc<VideoFrame>> = None;
    let mut held_until: Option<tokio::time::Instant> = None;
    loop {
        let round = read_control(&shared);
        if round.stopped {
            break;
        }
        if round.keyframe_pending {
            // The newest picture again: a still screen sends no new frame to carry it.
            held_until = None;
            let frame = held.take();
            pipeline.encode(frame.as_deref(), round.target_bps);
        }
        tokio::select! {
            biased;
            _ = shared.wake.notified() => {}
            _ = mixdog_rt::time::sleep_until(held_until.unwrap_or_else(tokio::time::Instant::now)), if held_until.is_some() => {
                held_until = None;
                if let Some(frame) = held.take() {
                    pipeline.encode(Some(&frame), round.target_bps);
                }
            }
            changed = frames.changed(), if source_open => {
                if changed.is_err() {
                    source_open = false;
                    continue;
                }
                let shot = frames.borrow_and_update().clone();
                let Some(shot) = shot else {
                    // The source was replaced and has no picture yet.
                    held = None;
                    held_until = None;
                    pipeline.reset_for_new_source();
                    continue;
                };
                if generation != Some(shot.generation) {
                    generation = Some(shot.generation);
                    held = None;
                    held_until = None;
                    pipeline.reset_for_new_source();
                    last_seq = shot.frame.seq.saturating_sub(1);
                }
                // Frames the source made while this viewer was busy were replaced by this one.
                let skipped = shot.frame.seq.saturating_sub(last_seq).max(1);
                last_seq = shot.frame.seq;
                {
                    let mut stats = lock(&shared.stats);
                    stats.frames_captured += skipped;
                    stats.frames_superseded += skipped - 1;
                }
                let newest = shot.frame;
                // The cap is on the encoder's own clock: encodes are at least one interval apart
                // however late frames arrive, so load can delay pictures but never exceed the cap.
                let slot = min_interval(&round.params)
                    .zip(pipeline.last_encode_at)
                    .map(|(interval, last)| last + interval)
                    .filter(|slot| *slot > Instant::now());
                match slot {
                    Some(slot) => {
                        // Too soon after the last picture: only the newest of a burst is kept.
                        if held.replace(newest).is_some() {
                            lock(&shared.stats).frames_superseded += 1;
                        }
                        // The slot opens once; later frames of the burst replace the held picture
                        // without pushing the slot back.
                        held_until.get_or_insert_with(|| tokio::time::Instant::from_std(slot));
                    }
                    None => {
                        if held.take().is_some() {
                            lock(&shared.stats).frames_superseded += 1;
                        }
                        held_until = None;
                        pipeline.encode(Some(&newest), round.target_bps);
                    }
                }
            }
        }
    }
}