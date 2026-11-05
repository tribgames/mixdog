//! The shared capture of one frame source. Every viewer of the source has its own encoder
//! pipeline ([`super::track::Vp8Track`]); they all read the newest picture from here, so capture
//! runs once however many phones watch and a slow encoder only ever skips pictures for itself.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use mixdog_core_api::domain::media::MediaError;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::media::VideoFrame;
use mixdog_rt::TaskClass;
use tokio::sync::Notify;
use tokio::sync::watch;

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum SourceState {
    #[default]
    Live,
    /// The source returned `Ok(None)`.
    Ended,
    Failed(MediaError),
}

/// The newest picture of a source. `generation` changes when the source is replaced.
#[derive(Clone, Debug)]
pub struct Shot {
    pub generation: u64,
    pub frame: Arc<VideoFrame>,
}

struct Control {
    replacement: Option<Box<dyn MediaFrameSource>>,
    stopped: bool,
}

pub struct SharedSource {
    control: Mutex<Control>,
    wake: Notify,
    shots: watch::Sender<Option<Shot>>,
    state: Mutex<SourceState>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl SharedSource {
    /// Starts reading `source` (a task on RT-W: it only moves frames).
    pub fn start(source: Box<dyn MediaFrameSource>) -> Arc<Self> {
        let (shots, _) = watch::channel(None);
        let this = Arc::new(Self {
            control: Mutex::new(Control {
                replacement: None,
                stopped: false,
            }),
            wake: Notify::new(),
            shots,
            state: Mutex::new(SourceState::Live),
        });
        mixdog_rt::spawn("webrtc-capture", TaskClass::Work, read_loop(Arc::clone(&this), source));
        this
    }

    /// Replaces the source (screen ↔ secure desktop); viewers see a new generation.
    pub fn set_source(&self, source: Box<dyn MediaFrameSource>) {
        lock(&self.control).replacement = Some(source);
        self.wake.notify_one();
    }

    /// A viewer's feed of the newest picture.
    pub fn subscribe(&self) -> watch::Receiver<Option<Shot>> {
        self.shots.subscribe()
    }

    pub fn state(&self) -> SourceState {
        lock(&self.state).clone()
    }

    pub fn stop(&self) {
        lock(&self.control).stopped = true;
        self.wake.notify_one();
    }
}

impl Drop for SharedSource {
    fn drop(&mut self) {
        self.stop();
    }
}

/// `MediaFrameSource::next_frame` must be cancel-safe: a control change drops the pending call.
async fn read_loop(shared: Arc<SharedSource>, mut source: Box<dyn MediaFrameSource>) {
    let mut live = true;
    let mut generation = 0u64;
    loop {
        let (stopped, replacement) = {
            let mut control = lock(&shared.control);
            (control.stopped, control.replacement.take())
        };
        if stopped {
            break;
        }
        if let Some(replacement) = replacement {
            source = replacement;
            live = true;
            generation += 1;
            // The old source's picture must not be encoded for the new one.
            shared.shots.send_replace(None);
            *lock(&shared.state) = SourceState::Live;
        }
        tokio::select! {
            biased;
            () = shared.wake.notified() => {}
            next = source.next_frame(), if live => match next {
                Ok(Some(frame)) => {
                    shared.shots.send_replace(Some(Shot { generation, frame: Arc::new(frame) }));
                }
                Ok(None) => {
                    live = false;
                    *lock(&shared.state) = SourceState::Ended;
                }
                Err(error) => {
                    live = false;
                    *lock(&shared.state) = SourceState::Failed(error);
                }
            },
        }
    }
}
