//! Tracked local-model installations. Work is shared, not just a promise: every interested
//! caller observes the same installation, and the status survives the settings dialog closing
//! and reopening. A cancel pauses (the partial download is kept for resume), it does not fail.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::change::ChangeSignal;
use crate::media::store::now_ms;

pub type Progress = Arc<dyn Fn(Map<String, Value>) + Send + Sync>;
/// `None` while running, then the operation's result.
pub type Completion = watch::Receiver<Option<Result<Value, String>>>;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum InstallError {
    #[error("jobId is required.")]
    JobIdRequired,
    #[error("[local-provider] installation job not found; refresh status before cancelling")]
    NotFound,
    #[error("[local-provider] stop the installation before discarding it")]
    StillRunning,
    #[error("[local-provider] cannot forget an active model job")]
    ActiveModelJob,
}

struct Entry {
    status: Map<String, Value>,
    running: bool,
    cancel: CancellationToken,
}

#[derive(Default)]
pub struct Installations {
    signal: ChangeSignal,
    entries: Mutex<HashMap<String, Entry>>,
    /// Waiters per installation key, resolved with the operation's outcome.
    joiners: Mutex<HashMap<String, Vec<watch::Sender<Option<Result<Value, String>>>>>>,
}

fn key(phase: &str, model_id: Option<&str>) -> String {
    format!("{phase}:{}", model_id.unwrap_or(""))
}

impl Installations {
    pub fn status(&self) -> Vec<Value> {
        self.entries.lock().unwrap().values().map(|e| Value::Object(e.status.clone())).collect()
    }

    /// An installation tracker that ticks `signal` on every status change.
    pub fn with_signal(signal: ChangeSignal) -> Self {
        Self { signal, ..Self::default() }
    }

    fn publish(&self, key: &str, update: Map<String, Value>) {
        self.signal.notify();
        if let Some(entry) = self.entries.lock().unwrap().get_mut(key) {
            entry.status.extend(update);
            entry.status.insert("updatedAt".into(), json!(now_ms()));
        }
    }

    /// Starts the installation, or joins the running one for `(phase, model_id)`. Returns the
    /// current status and the completion to await.
    pub fn track<F, Fut>(self: &Arc<Self>, phase: &str, model_id: Option<&str>, operation: F) -> (Value, Completion)
    where
        F: FnOnce(Progress, CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Value, String>> + Send + 'static,
    {
        let key = key(phase, model_id);
        let (tx, rx) = watch::channel(None);
        let cancel = {
            let mut entries = self.entries.lock().unwrap();
            if let Some(existing) = entries.get(&key).filter(|e| e.running) {
                // Share the running work: a joiner waits for the same outcome through its own channel.
                let status = Value::Object(existing.status.clone());
                drop(entries);
                return (status, self.join(&key));
            }
            let cancel = CancellationToken::new();
            let status = Map::from_iter([
                ("jobId".to_owned(), json!(uuid::Uuid::new_v4().to_string())),
                ("phase".into(), json!(phase)),
                ("modelId".into(), json!(model_id)),
                ("state".into(), json!("running")),
                ("stage".into(), json!("preparing")),
                ("percent".into(), Value::Null),
            ]);
            entries.insert(key.clone(), Entry { status, running: true, cancel: cancel.clone() });
            cancel
        };
        self.signal.notify();
        self.joiners.lock().unwrap().entry(key.clone()).or_default().push(tx);
        let snapshot = self.entries.lock().unwrap().get(&key).map(|e| Value::Object(e.status.clone())).unwrap_or(Value::Null);
        let this = self.clone();
        let progress: Progress = {
            let (this, key) = (this.clone(), key.clone());
            Arc::new(move |mut update| {
                let percent = update.get("percent").and_then(Value::as_f64).filter(|p| p.is_finite()).map(|p| p.min(99.0));
                update.insert("percent".into(), json!(percent));
                this.publish(&key, update);
            })
        };
        tokio::spawn(async move {
            let result = operation(progress, cancel.clone()).await;
            let update = match &result {
                Ok(_) => Map::from_iter([("state".into(), json!("complete")), ("stage".into(), json!("complete")), ("percent".into(), json!(100))]),
                Err(_) if cancel.is_cancelled() => Map::from_iter([("state".into(), json!("paused")), ("stage".into(), json!("paused")), ("error".into(), Value::Null)]),
                Err(message) => Map::from_iter([("state".into(), json!("failed")), ("error".into(), json!(message))]),
            };
            this.publish(&key, update);
            if let Some(entry) = this.entries.lock().unwrap().get_mut(&key) {
                entry.running = false;
            }
            let senders = this.joiners.lock().unwrap().remove(&key).unwrap_or_default();
            for sender in senders {
                let _ = sender.send(Some(result.clone()));
            }
        });
        (snapshot, rx)
    }

    fn join(&self, key: &str) -> Completion {
        let (tx, rx) = watch::channel(None);
        self.joiners.lock().unwrap().entry(key.to_owned()).or_default().push(tx);
        rx
    }

    /// Pauses a running installation; the status then reads `cancelling` until it settles.
    pub fn cancel(&self, job_id: &str) -> Result<Value, InstallError> {
        if mixdog_js::js_trim(job_id).is_empty() {
            return Err(InstallError::JobIdRequired);
        }
        let mut entries = self.entries.lock().unwrap();
        let entry = entries.values_mut().find(|e| e.status.get("jobId").and_then(Value::as_str) == Some(job_id)).ok_or(InstallError::NotFound)?;
        if entry.running && !entry.cancel.is_cancelled() {
            entry.status.insert("state".into(), json!("cancelling"));
            entry.status.insert("updatedAt".into(), json!(now_ms()));
            entry.cancel.cancel();
            self.signal.notify();
        }
        Ok(Value::Object(entry.status.clone()))
    }

    pub fn forget(&self, phase: &str, model_id: Option<&str>) -> Result<(), InstallError> {
        let key = key(phase, model_id);
        let mut entries = self.entries.lock().unwrap();
        if entries.get(&key).is_some_and(|e| e.running) {
            return Err(InstallError::StillRunning);
        }
        entries.remove(&key);
        self.signal.notify();
        Ok(())
    }

    pub fn forget_model(&self, model_id: &str) -> Result<(), InstallError> {
        let mut entries = self.entries.lock().unwrap();
        let of_model = |e: &Entry| e.status.get("modelId").and_then(Value::as_str) == Some(model_id);
        if entries.values().any(|e| of_model(e) && e.running) {
            return Err(InstallError::ActiveModelJob);
        }
        entries.retain(|_, e| !of_model(e));
        self.signal.notify();
        Ok(())
    }
}

/// Waits for the installation's outcome.
pub async fn wait(mut completion: Completion) -> Result<Value, String> {
    loop {
        if let Some(result) = completion.borrow_and_update().clone() {
            return result;
        }
        if completion.changed().await.is_err() {
            return Err("installation ended without a result".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn callers_share_one_running_installation_and_see_progress_capped_below_100() {
        let installs = Arc::new(Installations::default());
        let release = CancellationToken::new();
        let (first, rx1) = installs.track("model", Some("m"), {
            let release = release.clone();
            move |progress, _| async move {
                progress(Map::from_iter([("stage".into(), json!("downloading")), ("percent".into(), json!(150))]));
                release.cancelled().await;
                Ok(json!("done"))
            }
        });
        let (second, rx2) = installs.track("model", Some("m"), |_, _| async { Err("must not start".to_owned()) });
        assert_eq!(first["jobId"], second["jobId"]);
        tokio::task::yield_now().await;
        assert_eq!(installs.status()[0]["percent"], 99.0);
        release.cancel();
        assert_eq!(wait(rx1).await, Ok(json!("done")));
        assert_eq!(wait(rx2).await, Ok(json!("done")));
        let status = installs.status();
        assert_eq!((status[0]["state"].clone(), status[0]["percent"].clone()), (json!("complete"), json!(100)));
    }

    #[tokio::test]
    async fn cancel_pauses_instead_of_failing_and_discard_needs_it_stopped() {
        let installs = Arc::new(Installations::default());
        let (status, rx) = installs.track("model", Some("m"), |_, cancel| async move {
            cancel.cancelled().await;
            Err("aborted".to_owned())
        });
        let job = status["jobId"].as_str().unwrap().to_owned();
        assert_eq!(installs.forget("model", Some("m")), Err(InstallError::StillRunning));
        assert_eq!(installs.forget_model("m"), Err(InstallError::ActiveModelJob));
        assert_eq!(installs.cancel(&job).unwrap()["state"], "cancelling");
        assert!(wait(rx).await.is_err());
        let status = installs.status();
        assert_eq!((status[0]["state"].clone(), status[0]["error"].clone()), (json!("paused"), Value::Null));
        assert_eq!(installs.cancel("").unwrap_err(), InstallError::JobIdRequired);
        assert_eq!(installs.cancel("nope").unwrap_err(), InstallError::NotFound);
        installs.forget("model", Some("m")).unwrap();
        assert!(installs.status().is_empty());
    }

    #[tokio::test]
    async fn a_failure_is_reported_and_a_new_attempt_starts_a_new_job() {
        let installs = Arc::new(Installations::default());
        let (first, rx) = installs.track("model", Some("m"), |_, _| async { Err("disk full".to_owned()) });
        assert_eq!(wait(rx).await, Err("disk full".to_owned()));
        assert_eq!(installs.status()[0]["state"], "failed");
        let (second, rx) = installs.track("model", Some("m"), |_, _| async { Ok(json!(1)) });
        assert_ne!(first["jobId"], second["jobId"]);
        assert_eq!(wait(rx).await, Ok(json!(1)));
    }
}
