//! What the user did, as the heartbeat's idle check reads it (mixy-heartbeat.mjs `noteUserTurn`,
//! `noteUserInput`): a due check waits for quiet. Kept in memory and in the state file
//! (`lastUserInputAt`, `lastAppInputAt`) so a restart still sees it. Routine, heartbeat and
//! delivered turns never move it.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use mixdog_rt::TaskClass;

use super::state::{Change, HeartbeatStore};
use crate::scheduler::Clock;

/// The app-input time is written at most this often.
const APP_INPUT_WRITE_MS: i64 = 60_000;

/// Per state file: the app input time last written, when it was written and whether the
/// trailing write waits for the end of the window.
#[derive(Default)]
struct AppWrites {
    at: i64,
    wrote_at: i64,
    timer: bool,
}

pub struct UserActivity {
    store: Arc<HeartbeatStore>,
    clock: Arc<dyn Clock>,
    last_user_turn_at: AtomicI64,
    last_app_input_at: AtomicI64,
    writes: Mutex<AppWrites>,
}

impl UserActivity {
    pub fn new(store: Arc<HeartbeatStore>, clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new(Self {
            store,
            clock,
            last_user_turn_at: AtomicI64::new(0),
            last_app_input_at: AtomicI64::new(0),
            writes: Mutex::new(AppWrites::default()),
        })
    }

    /// The latest turn the user sent, in this process.
    pub fn user_turn_at(&self) -> i64 {
        self.last_user_turn_at.load(Ordering::SeqCst)
    }

    /// The latest time the user operated the desktop app, in this process.
    pub fn app_input_at(&self) -> i64 {
        self.last_app_input_at.load(Ordering::SeqCst)
    }

    /// A turn the user sent (the session service's submit): not awaited, a submit never waits
    /// for the file. A write that fails is logged here and written again with the next one.
    pub fn note_user_turn(&self, at: i64) {
        self.last_user_turn_at.fetch_max(at, Ordering::SeqCst);
        let store = Arc::clone(&self.store);
        mixdog_rt::spawn("services.heartbeat.user-turn", TaskClass::Work, async move {
            if let Err(error) = store.update(Change::UserTurn { time: at }).await {
                tracing::warn!("mixdog heartbeat: user turn note not saved yet: {error}");
            }
        });
    }

    /// The latest time the user operated the desktop app (keyboard, mouse buttons, wheel or
    /// mouse movement over its windows), as the app reports it (session action `noteUserInput`).
    /// Memory always takes the max (a time in the future counts as now). The state file is
    /// written only when the value advanced and at most once a minute, whoever calls. A note
    /// inside the window schedules one trailing write of the newest value at the window's end,
    /// so after input stops the file is at most a minute behind. The first note of a process
    /// writes at once.
    pub fn note_user_input(self: &Arc<Self>, at: i64) {
        let current = self.clock.now().timestamp_millis();
        self.last_app_input_at.fetch_max(at.min(current), Ordering::SeqCst);
        let mut writes = self.writes.lock().unwrap_or_else(PoisonError::into_inner);
        if self.app_input_at() <= writes.at {
            return;
        }
        let waited = current - writes.wrote_at;
        if writes.wrote_at != 0 && waited < APP_INPUT_WRITE_MS {
            if writes.timer {
                return;
            }
            writes.timer = true;
            let this = Arc::clone(self);
            let wait = APP_INPUT_WRITE_MS.min(APP_INPUT_WRITE_MS - waited) as u64;
            mixdog_rt::spawn("services.heartbeat.app-input", TaskClass::Work, async move {
                tokio::time::sleep(Duration::from_millis(wait)).await;
                let mut writes = this.writes.lock().unwrap_or_else(PoisonError::into_inner);
                writes.timer = false;
                if this.app_input_at() > writes.at {
                    let now = this.clock.now().timestamp_millis();
                    this.write_app_input(&mut writes, now);
                }
            });
            return;
        }
        self.write_app_input(&mut writes, current);
    }

    fn write_app_input(&self, writes: &mut AppWrites, current: i64) {
        let value = self.app_input_at();
        let store = Arc::clone(&self.store);
        mixdog_rt::spawn("services.heartbeat.app-input-write", TaskClass::Work, async move {
            if let Err(error) = store.update(Change::AppInput { value }).await {
                tracing::warn!("mixdog heartbeat: app input note not saved yet: {error}");
            }
        });
        writes.at = value;
        writes.wrote_at = current;
    }
}
