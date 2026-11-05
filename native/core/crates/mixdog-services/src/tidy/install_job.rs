//! Progress of the core install. One in-memory job per process, never persisted; a fresh
//! process starts with none. A running job never claims 100%: the card flips on completion.

use std::sync::Mutex;

use serde_json::{Value, json};

use crate::media::store::now_ms;

/// The engines the built-in install provisions. ast-grep/structural is not here: it ships
/// inside the mixdog-graph binary.
pub const TIDY_CORE_ENGINE_IDS: [&str; 5] = ["biome", "ruff", "shfmt", "shellcheck", "psscriptanalyzer"];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct EngineProgress {
    pub id: String,
    /// `pending | downloading | installed | present | skipped | failed`
    pub status: String,
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub version: String,
    pub bytes: u64,
    pub error: Option<String>,
    pub install_hint: Option<String>,
}

#[derive(Clone, Debug)]
struct Job {
    active: bool,
    percent: u8,
    started_at: i64,
    updated_at: i64,
    engines: Vec<EngineProgress>,
}

impl Job {
    fn recompute(&mut self) {
        let share = if self.engines.is_empty() { 100.0 } else { 100.0 / self.engines.len() as f64 };
        let mut percent = 0.0;
        for e in &self.engines {
            match e.status.as_str() {
                "pending" => {}
                "downloading" => {
                    if e.total_bytes > 0 {
                        percent += share * (e.received_bytes as f64 / e.total_bytes as f64).min(1.0);
                    }
                }
                _ => percent += share,
            }
        }
        let rounded = percent.round().clamp(0.0, 100.0) as u8;
        self.percent = if self.active { rounded.min(99) } else { rounded };
        self.updated_at = now_ms();
    }
}

#[derive(Default)]
pub struct InstallJob {
    job: Mutex<Option<Job>>,
    /// Bumped on every mutation, so a status cache can tell it is stale.
    stamp: std::sync::atomic::AtomicU64,
}

impl InstallJob {
    pub fn stamp(&self) -> u64 {
        self.stamp.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn change<T>(&self, f: impl FnOnce(&mut Option<Job>) -> T) -> T {
        let out = f(&mut self.job.lock().unwrap());
        self.stamp.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        out
    }

    /// Starts a job over `ids`; `None` while one is running (overlapping presses share it).
    pub fn begin(&self, ids: &[&str]) -> bool {
        self.change(|slot| {
            if slot.as_ref().is_some_and(|j| j.active) {
                return false;
            }
            let now = now_ms();
            *slot = Some(Job {
                active: true,
                percent: 0,
                started_at: now,
                updated_at: now,
                engines: ids.iter().map(|id| EngineProgress { id: (*id).to_owned(), status: "pending".into(), ..Default::default() }).collect(),
            });
            true
        })
    }

    /// Byte progress; ignored once the engine has settled.
    pub fn track_download(&self, id: &str, received: u64, total: u64) {
        self.change(|slot| {
            let Some(job) = slot else { return };
            let Some(e) = job.engines.iter_mut().find(|e| e.id == id) else { return };
            if matches!(e.status.as_str(), "installed" | "failed") {
                return;
            }
            e.status = "downloading".into();
            e.received_bytes = received;
            e.total_bytes = total;
            job.recompute();
        });
    }

    pub fn settle(&self, id: &str, update: impl FnOnce(&mut EngineProgress)) {
        self.change(|slot| {
            let Some(job) = slot else { return };
            if let Some(e) = job.engines.iter_mut().find(|e| e.id == id) {
                update(e);
                job.recompute();
            }
        });
    }

    /// Ends the job: an engine the installer never reported on fails.
    pub fn finish(&self) {
        self.change(|slot| {
            let Some(job) = slot else { return };
            for e in &mut job.engines {
                if matches!(e.status.as_str(), "pending" | "downloading") {
                    e.status = "failed".into();
                    e.error = Some("the installer reported no result for this engine".into());
                }
            }
            job.active = false;
            job.recompute();
        });
    }

    pub fn snapshot_results(&self) -> Vec<EngineProgress> {
        self.job.lock().unwrap().as_ref().map_or_else(Vec::new, |j| j.engines.clone())
    }

    pub fn pending_ids(&self) -> Vec<String> {
        self.job.lock().unwrap().as_ref().map_or_else(Vec::new, |j| j.engines.iter().filter(|e| e.status == "pending").map(|e| e.id.clone()).collect())
    }

    /// The live (or last) job, or `null` when this process never installed.
    pub fn status(&self) -> Value {
        let guard = self.job.lock().unwrap();
        let Some(job) = guard.as_ref() else { return Value::Null };
        json!({
            "active": job.active,
            "percent": job.percent,
            "startedAt": job.started_at,
            "updatedAt": job.updated_at,
            "engines": job.engines.iter().map(|e| json!({
                "id": e.id, "status": e.status, "receivedBytes": e.received_bytes, "totalBytes": e.total_bytes,
                "version": e.version, "bytes": e.bytes,
            })).collect::<Vec<_>>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_follows_settled_engines_and_a_running_job_stops_at_99() {
        let job = InstallJob::default();
        assert_eq!(job.status(), Value::Null);
        assert!(job.begin(&["a", "b"]));
        assert!(!job.begin(&["c"]));
        job.track_download("a", 50, 100);
        assert_eq!(job.status()["percent"], 25);
        job.settle("a", |e| e.status = "installed".into());
        job.settle("b", |e| e.status = "present".into());
        assert_eq!(job.status()["percent"], 99);
        job.finish();
        let done = job.status();
        assert_eq!((done["active"].clone(), done["percent"].clone()), (json!(false), json!(100)));
    }

    #[test]
    fn settled_engines_ignore_late_progress_and_unreported_ones_fail() {
        let job = InstallJob::default();
        job.begin(&["a", "b"]);
        job.settle("a", |e| e.status = "failed".into());
        job.track_download("a", 10, 10);
        assert_eq!(job.status()["engines"][0]["status"], "failed");
        assert_eq!(job.pending_ids(), vec!["b".to_owned()]);
        job.finish();
        assert_eq!(job.status()["engines"][1]["status"], "failed");
        let before = job.stamp();
        job.finish();
        assert!(job.stamp() > before);
        assert!(job.begin(&["x"]));
    }
}
