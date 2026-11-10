//! The controls a replay of Node's download recording (`benchmarks/rust-core/recorders/record-file-downloads.mjs --replay`) needs of a
//! SPAWNED core: the clock it moves by explicit steps, the points a call is held at while something else happens, and the count of
//! files the downloads hold open. They exist only in a build made with the `replay-controls` feature (an explicit opt-in, like the
//! `kill-points` feature of `killpoint.rs:1-13`: no ordinary build, debug or release, has them) and act only when the environment
//! names the folder they talk through (`MIXDOG_DOWNLOAD_REPLAY_DIR`). Files of that folder:
//!   `clock`          the instant, in epoch milliseconds, the replay has moved the core's download clock to (written by the replay)
//!   `anchor`         the instant the 15 s sweeper counts its ticks from, or `none` while nothing is held (written by the core)
//!   `swept`          the instant of the last sweeper tick that has run (written by the core)
//!   `held`           how many files the downloads hold open now (written by the core, at the end of every call that changes it)
//!   `hold-<point>`   a call that reaches `<point>` waits there while this file exists (written by the replay)
//!   `reached-<point>` written by the core when a call is waiting at `<point>`
//! Waiting is polling of these files every 2 ms of real time: a replay's wait, with its own deadline, never the core's decision.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;

use crate::transfer::IdleClock;
use crate::transfer::IdleTimer;

const POLL: Duration = Duration::from_millis(2);
/// A call never waits at a point longer than this, whatever the replay does: a replay that died must not hold a lane thread for good.
const HOLD_AT_MOST: Duration = Duration::from_secs(60);

fn dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| std::env::var_os("MIXDOG_DOWNLOAD_REPLAY_DIR").filter(|value| !value.is_empty()).map(PathBuf::from)).as_deref()
}

/// Tells the replay something: the content of `<dir>/<name>`, replaced whole.
pub fn publish(name: &str, text: &str) {
    if let Some(dir) = dir() {
        let temp = dir.join(format!(".{name}.tmp"));
        if std::fs::write(&temp, text).is_ok() {
            let _ = std::fs::rename(&temp, dir.join(name));
        }
    }
}

/// Holds the calling thread while the replay has asked for `point` to be held (a call is a lane job, so a blocked thread is a held call).
pub fn gate(point: &str) {
    let Some(dir) = dir() else { return };
    let hold = dir.join(format!("hold-{point}"));
    if !hold.exists() {
        return;
    }
    publish(&format!("reached-{point}"), "1");
    let until = Instant::now() + HOLD_AT_MOST;
    while hold.exists() && Instant::now() < until {
        std::thread::sleep(POLL);
    }
    let _ = std::fs::remove_file(dir.join(format!("reached-{point}")));
}

/// The clock the replay moves: Node's `now` of the recording. Its monotonic reading is the epoch reading since the first, so the sweeper's
/// deadlines are the instants the recording's are.
pub struct FileClock {
    file: PathBuf,
    origin: Instant,
    start: i64,
}

impl FileClock {
    fn read(&self) -> i64 {
        std::fs::read_to_string(&self.file).ok().and_then(|text| text.trim().parse().ok()).unwrap_or(self.start)
    }
}

impl IdleClock for FileClock {
    fn now(&self) -> Instant {
        self.origin + Duration::from_millis(u64::try_from(self.read() - self.start).unwrap_or(0))
    }

    fn epoch_ms(&self) -> i64 {
        self.read()
    }
}

impl IdleTimer for FileClock {
    fn sleep_until(&self, deadline: Instant) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            while self.now() < deadline {
                tokio::time::sleep(POLL).await;
            }
        })
    }
}

/// The replay's clock, when the environment names a folder holding one.
pub fn clock() -> Option<Arc<FileClock>> {
    static CLOCK: OnceLock<Option<Arc<FileClock>>> = OnceLock::new();
    CLOCK
        .get_or_init(|| {
            let file = dir()?.join("clock");
            let start = std::fs::read_to_string(&file).ok()?.trim().parse().ok()?;
            Some(Arc::new(FileClock { file, origin: Instant::now(), start }))
        })
        .clone()
}
