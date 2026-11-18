//! `<data>/channels/status-snapshot.json` (`status-snapshot.mjs`): written every 10 seconds while
//! the automation runtime is up, so another process can read the cron next fire, the deferred
//! count and the relay hook URL without asking this one. The file is renamed into place, so a
//! reader never sees half of it, and it is removed when the runtime stops.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mixdog_rt::{CancellationToken, DurabilityIo, LaneToken};
use mixdog_statefile::{Opts, write_json};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use super::ports::PublicBase;
use crate::scheduler::{Clock, Schedule, Scheduler};

const INTERVAL: Duration = Duration::from_secs(10);
/// An unchanged snapshot is written again after this long (the heartbeat).
const HEARTBEAT_MS: i64 = 60_000;

/// What the last write held, and when it was made.
#[derive(Default)]
struct Written {
    stable: Option<String>,
    at_ms: i64,
}

pub struct StatusSnapshot {
    scheduler: Scheduler,
    base: Arc<dyn PublicBase>,
    clock: Arc<dyn Clock>,
    path: PathBuf,
    lane: DurabilityIo,
    timer: Mutex<Option<JoinHandle<()>>>,
    written: Mutex<Written>,
}

/// `computeSnapshot`: the armed schedule that fires first, the deferred ones, the hook's public URL.
/// `skipped` is the scheduler's `shouldSkip`; cron entries are looked at before one-shots, and the
/// earlier of two equal instants wins.
fn snapshot(schedules: &[Schedule], skipped: impl Fn(&str) -> bool, now_ms: i64, public_url: Option<String>) -> Value {
    let crons = schedules.iter().filter(|s| s.when_cron.is_some() && !skipped(&s.name)).filter_map(|s| {
        Some((s.name.as_str(), s.next_fire_at?.timestamp_millis(), "cron"))
    });
    let one_shots = schedules.iter().filter(|s| s.when_cron.is_none() && !skipped(&s.name)).filter_map(|s| {
        Some((s.name.as_str(), s.when_at?.timestamp_millis(), "one-shot"))
    });
    let mut next: Option<(&str, i64, &str)> = None;
    for candidate in crons.chain(one_shots) {
        if next.is_none_or(|(_, at, _)| candidate.1 < at) {
            next = Some(candidate);
        }
    }
    let deferred: Vec<Value> = schedules
        .iter()
        .filter_map(|s| s.deferred_until.map(|until| (s, until.timestamp_millis())))
        .filter(|(_, until)| *until > now_ms)
        .map(|(s, until)| json!({ "name": s.name, "until": until }))
        .collect();
    json!({
        "writtenAt": now_ms,
        "schedules": {
            "next": next.map(|(name, fire_at, kind)| json!({ "name": name, "fireAt": fire_at, "kind": kind })),
            "deferredCount": deferred.len(),
            "deferred": deferred,
        },
        "hook": { "publicUrl": public_url },
    })
}

/// The snapshot as compared for change: everything but the time it was written.
fn stable_text(snapshot: &Value) -> String {
    let mut stable = snapshot.clone();
    if let Some(map) = stable.as_object_mut() {
        map.shift_remove("writtenAt");
    }
    serde_json::to_string_pretty(&stable).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;

    fn at(ms: i64) -> Option<chrono::DateTime<Utc>> {
        Utc.timestamp_millis_opt(ms).single()
    }

    fn cron(name: &str, next: i64) -> Schedule {
        Schedule { name: name.into(), when_cron: Some("* * * * *".into()), next_fire_at: at(next), ..Schedule::default() }
    }

    #[test]
    fn the_earliest_armed_fire_is_named_and_a_skipped_schedule_is_not_a_candidate() {
        let one_shot = Schedule { name: "once".into(), when_at: at(1_500), ..Schedule::default() };
        let rows = [cron("later", 3_000), one_shot, cron("sooner", 2_000), cron("skipped", 900)];
        let snap = snapshot(&rows, |name| name == "skipped", 1_000, Some("https://hook.example/x".into()));
        assert_eq!(snap["schedules"]["next"], json!({ "name": "once", "fireAt": 1_500, "kind": "one-shot" }));
        assert_eq!(snap["hook"]["publicUrl"], "https://hook.example/x");
        assert_eq!(snap["writtenAt"], 1_000);
        // Equal instants: the cron entry, which Node looks at first, wins.
        let tie = [Schedule { name: "once".into(), when_at: at(2_000), ..Schedule::default() }, cron("cron", 2_000)];
        assert_eq!(snapshot(&tie, |_| false, 0, None)["schedules"]["next"]["name"], "cron");
        assert_eq!(snapshot(&[], |_| false, 0, None)["schedules"]["next"], Value::Null);
        assert_eq!(snapshot(&[], |_| false, 0, None)["hook"]["publicUrl"], Value::Null);
    }

    #[test]
    fn only_a_deferral_still_in_the_future_counts() {
        let held = Schedule { deferred_until: at(5_000), ..cron("held", 9_000) };
        let lapsed = Schedule { deferred_until: at(500), ..cron("lapsed", 9_000) };
        let snap = snapshot(&[held, lapsed], |_| false, 1_000, None);
        assert_eq!(snap["schedules"]["deferredCount"], 1);
        assert_eq!(snap["schedules"]["deferred"], json!([{ "name": "held", "until": 5_000 }]));
    }

    #[test]
    fn the_time_written_is_not_part_of_what_is_compared() {
        let rows = [cron("a", 2_000)];
        let (first, later) = (snapshot(&rows, |_| false, 1_000, None), snapshot(&rows, |_| false, 7_000, None));
        assert_eq!(stable_text(&first), stable_text(&later));
        assert!(!stable_text(&first).contains("writtenAt"));
        assert_ne!(stable_text(&first), stable_text(&snapshot(&[cron("a", 3_000)], |_| false, 1_000, None)));
    }
}


impl StatusSnapshot {
    pub fn new(scheduler: Scheduler, base: Arc<dyn PublicBase>, clock: Arc<dyn Clock>, path: PathBuf, lane: DurabilityIo) -> Arc<Self> {
        Arc::new(Self { scheduler, base, clock, path, lane, timer: Mutex::new(None), written: Mutex::new(Written::default()) })
    }

    /// `startSnapshotWriter`: writes now, then every 10 seconds; a second call writes again and keeps the one timer.
    pub fn start(self: &Arc<Self>) {
        let mut timer = self.timer.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if timer.as_ref().is_some_and(|task| !task.is_finished()) {
            let this = Arc::clone(self);
            tokio::spawn(async move { this.write_once().await });
            return;
        }
        let this = Arc::clone(self);
        *timer = Some(tokio::spawn(async move {
            loop {
                this.write_once().await;
                mixdog_rt::time::sleep(INTERVAL).await;
            }
        }));
    }

    /// `stopSnapshotWriter`: ends the timer and removes the file.
    pub async fn stop(&self) {
        let task = self.timer.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
        *self.written.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Written::default();
        let path = self.path.clone();
        if let Ok(job) = self.lane.submit_wait(&CancellationToken::new(), move |lane| mixdog_statefile::remove_file(lane, &path)).await {
            let _ = job.await;
        }
    }

    /// `writeSnapshot`: a failure is logged and the next tick tries again; an unchanged snapshot is not
    /// written again within the heartbeat.
    async fn write_once(&self) {
        if let Err(error) = self.try_write().await {
            mixdog_rt::node_stderr!("mixdog status-snapshot: write failed: {error}");
        }
    }

    async fn try_write(&self) -> Result<(), String> {
        let now_ms = self.clock.now().timestamp_millis();
        let rows: Vec<Schedule> = self.scheduler.status().iter().filter_map(|row| self.scheduler.find_schedule(&row.name)).collect();
        let public_url = self.base.hook_public_base().await?;
        let snap = snapshot(&rows, |name| self.scheduler.should_skip(name), now_ms, public_url);
        let stable = stable_text(&snap);
        {
            let mut last = self.written.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if last.stable.as_deref() == Some(stable.as_str()) && now_ms - last.at_ms < HEARTBEAT_MS {
                return Ok(());
            }
            *last = Written { stable: Some(stable), at_ms: now_ms };
        }
        let path = self.path.clone();
        let opts = Opts { lock: false, fsync: false, fsync_dir: false, ..Opts::default() };
        let job = self
            .lane
            .submit_wait(&CancellationToken::new(), move |lane| write_json(lane, &path, &snap, &opts).map(drop).map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())?;
        job.await.map_err(|e| e.to_string())?
    }
}
