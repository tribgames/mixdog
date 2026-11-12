//! `cycle-scheduler/health-ledger.mjs`: per-cycle success and failure counters, the running marker
//! and the backlog snapshot, mirrored to `memory-cycle-state.json` for the statusline and
//! `/health`.

use std::path::PathBuf;
use std::sync::Mutex;

use mixdog_js::slice_utf16;
use mixdog_rt::{CancellationToken, LaneToken, MaintenanceIo};
use mixdog_statefile::Opts;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use super::log;
use crate::memory::ingest::NowMs;

const BACKLOG_WARN_COOLDOWN_MS: i64 = 10 * 60_000;
const BACKLOG_WARN_FAILURES: u32 = 5;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CycleHealth {
    pub last_success_at: i64,
    pub last_error_at: i64,
    pub last_error: Option<String>,
    pub consecutive_failures: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Running {
    pub cycle: String,
    pub started_at: i64,
    pub pid: u32,
}

struct State {
    cycle1: CycleHealth,
    running: Option<Running>,
    backlog: Value,
    last_warn_at: i64,
}

pub struct Ledger {
    state: Mutex<State>,
    file: PathBuf,
    lane: MaintenanceIo,
    now: NowMs,
    /// Writes of the file go one at a time, each from the state as it is when its turn comes.
    writes: Semaphore,
}

impl Ledger {
    pub fn new(file: PathBuf, lane: MaintenanceIo, now: NowMs) -> Self {
        let state = State { cycle1: CycleHealth::default(), running: None, backlog: json!({"unchunked": 0, "at": 0}), last_warn_at: 0 };
        Self { state: Mutex::new(state), file, lane, now, writes: Semaphore::new(1) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("cycle ledger")
    }

    fn document(&self) -> Value {
        let state = self.lock();
        let running = state.running.as_ref().map_or(Value::Null, |r| json!({"cycle": r.cycle, "started_at": r.started_at, "pid": r.pid}));
        json!({
            "running": running,
            "backlog": state.backlog,
            "cycles": {"cycle1": health_json(&state.cycle1)},
            "updatedAt": (self.now)(),
        })
    }

    /// Rewrites the state file; best effort, the statusline shows nothing for a file it cannot read.
    pub async fn write(&self) {
        let Ok(_turn) = self.writes.acquire().await else { return };
        let (file, document) = (self.file.clone(), self.document());
        let opts = Opts { compact: true, fsync: false, ..Opts::default() };
        let job = self.lane.submit_wait(&CancellationToken::new(), move |lane| mixdog_statefile::write_json(lane, &file, &document, &opts)).await;
        if let Ok(job) = job {
            let _ = job.await;
        }
    }

    pub fn warn(&self, message: &str) {
        let now = (self.now)();
        {
            let mut state = self.lock();
            if now - state.last_warn_at < BACKLOG_WARN_COOLDOWN_MS {
                return;
            }
            state.last_warn_at = now;
        }
        log(&format!("[cycle-health] WARN {message}\n"));
    }

    pub async fn mark_running(&self, cycle: &str) {
        let started_at = (self.now)();
        self.lock().running = Some(Running { cycle: cycle.to_owned(), started_at, pid: std::process::id() });
        self.write().await;
    }

    pub async fn mark_done(&self, cycle: &str, ok: bool, error: Option<&str>) {
        let now = (self.now)();
        let warning = {
            let mut state = self.lock();
            let health = &mut state.cycle1;
            let mut warning = None;
            if ok {
                *health = CycleHealth { last_success_at: now, last_error: None, consecutive_failures: 0, ..health.clone() };
            } else {
                health.last_error_at = now;
                health.consecutive_failures += 1;
                let text = error.filter(|e| !e.is_empty()).unwrap_or("unknown");
                health.last_error = Some(slice_utf16(text, 200));
                if health.consecutive_failures >= BACKLOG_WARN_FAILURES {
                    warning = Some(format!(
                        "{cycle} failing repeatedly (consecutive={}, last=\"{}\")",
                        health.consecutive_failures,
                        health.last_error.as_deref().unwrap_or("null")
                    ));
                }
            }
            if state.running.as_ref().is_some_and(|r| r.cycle == cycle) {
                state.running = None;
            }
            warning
        };
        if let Some(message) = warning {
            self.warn(&message);
        }
        self.write().await;
    }

    /// Drops the running marker only while it still belongs to `cycle`.
    pub async fn clear_running(&self, cycle: &str) {
        {
            let mut state = self.lock();
            if state.running.as_ref().is_none_or(|r| r.cycle != cycle) {
                return;
            }
            state.running = None;
        }
        self.write().await;
    }

    pub async fn set_backlog(&self, snapshot: Value) {
        self.lock().backlog = snapshot;
        self.write().await;
    }

    /// Restart hydration: a restart would otherwise report `last_success_at` 0 until the next run.
    pub async fn hydrate_success(&self, last_cycle1: f64) {
        {
            let mut state = self.lock();
            if last_cycle1 > 0.0 && state.cycle1.last_success_at == 0 {
                state.cycle1.last_success_at = last_cycle1 as i64;
            }
        }
        self.write().await;
    }

    pub fn reset_running(&self) {
        self.lock().running = None;
    }

    pub fn health(&self) -> CycleHealth {
        self.lock().cycle1.clone()
    }

    pub fn running(&self) -> Option<Running> {
        self.lock().running.clone()
    }

    pub fn backlog(&self) -> Value {
        self.lock().backlog.clone()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    /// memory-cycle-status.test.mjs 25: the statusline's `memoryCycleStatus` reads `updatedAt`,
    /// `running.{cycle,started_at,pid}` and `backlog.unchunked` from this file.
    #[tokio::test]
    async fn the_state_file_carries_what_the_statusline_segment_reads() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("memory-cycle-state.json");
        let ledger = Ledger::new(file.clone(), mixdog_rt::testing::tokens().maintenance_io, Arc::new(|| 10_000_000));
        let read = || serde_json::from_slice::<Value>(&std::fs::read(&file).unwrap()).unwrap();
        ledger.set_backlog(json!({ "unchunked": 700, "at": 1 })).await;
        let state = read();
        assert_eq!((state["updatedAt"].clone(), state["running"].clone(), state["backlog"]["unchunked"].clone()), (json!(10_000_000), Value::Null, json!(700)));
        ledger.mark_running("cycle1").await;
        assert_eq!(read()["running"], json!({ "cycle": "cycle1", "started_at": 10_000_000, "pid": std::process::id() }));
        ledger.mark_done("cycle1", true, None).await;
        assert_eq!(read()["running"], Value::Null);
    }
}

fn health_json(health: &CycleHealth) -> Value {
    json!({
        "last_success_at": health.last_success_at,
        "last_error_at": health.last_error_at,
        "last_error": health.last_error,
        "consecutive_failures": health.consecutive_failures,
    })
}
