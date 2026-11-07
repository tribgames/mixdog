//! Voice status and the on/off toggle. Turning voice on installs only the missing runtime
//! components, then persists `voice.enabled`; turning it off never waits for an install.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::time::Instant;

use super::pipeline::VoicePipeline;
use crate::model_install::{Progress, ProgressSink};

/// Which managed components an install must fetch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Missing {
    pub whisper: bool,
    pub model: bool,
    pub ffmpeg: bool,
}

/// Fetches and verifies runtime components. Installing nothing that is already present.
#[async_trait]
pub trait VoiceInstaller: Send + Sync {
    /// `progress` is the byte progress of each download (`label`: `runtime`, `extra`, `model`,
    /// `ffmpeg`); `None` when the caller shows none.
    async fn install(&self, missing: Missing, progress: Option<ProgressSink>) -> Result<(), String>;
}

/// The input hint line of the client that asked (Node's `setProgressHint`).
#[async_trait]
pub trait ProgressHint: Send + Sync {
    /// `setProgressHint(text, 'info', percent)`: a sticky hint that replaces the one before.
    fn show(&self, text: String, percent: Option<u8>);
    /// `setProgressHint('')`: removes the hint; resolves once the removal is published.
    async fn clear(&self);
}

const HINT_INTERVAL: Duration = Duration::from_millis(500);
const BAR_CELLS: usize = 6;

fn phase_label(phase: &str) -> &'static str {
    match phase {
        "model" => "model",
        "ffmpeg" => "ffmpeg",
        "extra" => "extra data",
        _ => "whisper runtime",
    }
}

/// `renderProgressBarText` and the percent `setProgressHint` gets (`voice-setup.mjs`).
fn render_hint(progress: &Progress) -> (String, Option<u8>) {
    let label = phase_label(&progress.label);
    if progress.total == 0 {
        return (format!("⬇ Voice {label} …"), None);
    }
    let ratio = (progress.downloaded as f64 / progress.total as f64).clamp(0.0, 1.0);
    let filled = (ratio * BAR_CELLS as f64).round() as usize;
    let percent = (ratio * 100.0).round() as u8;
    (format!("⬇ Voice {label} {}{} {percent}%", "▓".repeat(filled), "░".repeat(BAR_CELLS - filled)), Some(percent))
}

/// `makeThrottledProgressNotice`: at most one hint per 500 ms, the first one at once.
pub(super) fn throttled_hint(hint: Arc<dyn ProgressHint>) -> ProgressSink {
    let last: Mutex<Option<Instant>> = Mutex::new(None);
    Arc::new(move |progress: Progress| {
        let now = Instant::now();
        let mut last = last.lock().unwrap_or_else(PoisonError::into_inner);
        if last.is_some_and(|at| now.duration_since(at) < HINT_INTERVAL) {
            return;
        }
        *last = Some(now);
        let (text, percent) = render_hint(&progress);
        hint.show(text, percent);
    })
}

/// Persists `voice.enabled` under the config lock.
#[async_trait]
pub trait VoiceEnabledStore: Send + Sync {
    /// Writes `enabled` unless `proceed` (evaluated inside the lock) says the write was
    /// superseded. Returns whether it wrote.
    async fn write_enabled(&self, enabled: bool, proceed: &(dyn Fn() -> bool + Send + Sync)) -> Result<bool, String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToggleResult {
    Enabled(bool),
    Failed(String),
    /// Persisting `enabled: false` failed; the reply carries the bare message, the notice adds a lead-in.
    OffFailed(String),
    /// An install is already running.
    Busy,
}

impl ToggleResult {
    /// The `result` member of the toggle reply.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Enabled(enabled) => json!({"ok": true, "enabled": enabled}),
            Self::Failed(error) | Self::OffFailed(error) => json!({"ok": false, "error": error}),
            Self::Busy => json!({"ok": false}),
        }
    }

    /// The last `warn`/`error` notice the toggle pushed (what `setVoiceEnabled` reports as `error`).
    pub fn notice_error(&self) -> Option<String> {
        match self {
            Self::Enabled(_) => None,
            Self::Failed(error) => Some(error.clone()),
            Self::OffFailed(error) => Some(format!("Voice OFF failed: {error}")),
            Self::Busy => Some("Voice install is already running".to_owned()),
        }
    }
}

pub struct VoiceSetup {
    pipeline: Arc<VoicePipeline>,
    store: Arc<dyn VoiceEnabledStore>,
    installer: Arc<dyn VoiceInstaller>,
    busy: AtomicBool,
    /// Bumped by every accepted OFF; an install that started earlier must not enable voice once
    /// a later OFF superseded it.
    off_generation: Arc<AtomicU64>,
}

struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl VoiceSetup {
    pub fn new(pipeline: Arc<VoicePipeline>, store: Arc<dyn VoiceEnabledStore>, installer: Arc<dyn VoiceInstaller>) -> Self {
        Self {
            pipeline,
            store,
            installer,
            busy: AtomicBool::new(false),
            off_generation: Arc::default(),
        }
    }

    /// Reads the managed runtime state without installing or cleaning up anything.
    pub async fn status(&self) -> Value {
        let runtime = self.pipeline.runtime_for_display().await;
        let settings = self.pipeline.settings();
        json!({
            "enabled": settings.enabled,
            "busy": self.busy.load(Ordering::SeqCst),
            "installed": runtime.installed,
            "modelId": runtime.model_id,
            "info": self.pipeline.runtime_info(&runtime).await,
            "components": {
                "whisper": runtime.binary && runtime.server_cmd.is_some(),
                "model": runtime.model,
                "ffmpeg": runtime.ffmpeg,
            },
        })
    }

    /// `enabled: None` flips the current state. Shows no install progress (the setup path).
    pub async fn toggle(&self, enabled: Option<bool>) -> ToggleResult {
        self.run_toggle(enabled, None).await
    }

    /// The toggle of a client that shows the install's progress on its hint line, cleared when the
    /// install ends, whatever its outcome.
    pub async fn toggle_with_hint(&self, enabled: Option<bool>, hint: Arc<dyn ProgressHint>) -> ToggleResult {
        self.run_toggle(enabled, Some(hint)).await
    }

    async fn run_toggle(&self, enabled: Option<bool>, hint: Option<Arc<dyn ProgressHint>>) -> ToggleResult {
        let requested_at = self.off_generation.load(Ordering::SeqCst);
        let current = self.pipeline.settings().enabled;
        let target = enabled.unwrap_or(!current);
        if !target {
            self.off_generation.fetch_add(1, Ordering::SeqCst);
            return match self.store.write_enabled(false, &|| true).await {
                Ok(_) => ToggleResult::Enabled(false),
                Err(error) => ToggleResult::OffFailed(error),
            };
        }
        // A state read that never ran must not look like "nothing installed": that downloads it all.
        let runtime = match self.pipeline.runtime().await {
            Ok(runtime) => runtime,
            Err(error) => return ToggleResult::Failed(format!("Voice setup failed: {error}")),
        };
        if current && runtime.installed {
            return ToggleResult::Enabled(true);
        }
        if self.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return ToggleResult::Busy;
        }
        let _busy = BusyGuard(&self.busy);
        let missing = Missing {
            whisper: !runtime.binary || runtime.server_cmd.is_none() || runtime.stale,
            model: !runtime.model,
            ffmpeg: !runtime.ffmpeg,
        };
        let progress = hint.clone().map(throttled_hint);
        let result = async {
            if !runtime.installed || runtime.stale {
                if let Err(error) = self.installer.install(missing, progress).await {
                    return ToggleResult::Failed(format!("Voice setup failed: {error}"));
                }
                if !self.pipeline.runtime().await.is_ok_and(|runtime| runtime.installed) {
                    return ToggleResult::Failed(
                        "Voice setup failed: voice runtime install did not complete (still missing a required component)".into(),
                    );
                }
            }
            let generation = self.off_generation.clone();
            let proceed = move || generation.load(Ordering::SeqCst) == requested_at;
            match self.store.write_enabled(true, &proceed).await {
                Ok(wrote) => ToggleResult::Enabled(wrote),
                Err(error) => ToggleResult::Failed(format!("Voice setup failed: {error}")),
            }
        }
        .await;
        if let Some(hint) = &hint {
            hint.clear().await;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::super::pipeline::tests::{FakeEngine, FakeTools, Fixed, install, manifest};
    use super::*;

    struct Store(Mutex<Vec<bool>>);
    #[async_trait]
    impl VoiceEnabledStore for Store {
        async fn write_enabled(&self, enabled: bool, proceed: &(dyn Fn() -> bool + Send + Sync)) -> Result<bool, String> {
            if !proceed() {
                return Ok(false);
            }
            self.0.lock().unwrap().push(enabled);
            Ok(true)
        }
    }

    struct Installer {
        dir: std::path::PathBuf,
        seen: Mutex<Vec<Missing>>,
        off_during: Option<Arc<VoiceSetupSlot>>,
    }
    type VoiceSetupSlot = Mutex<Option<Arc<VoiceSetup>>>;

    #[async_trait]
    impl VoiceInstaller for Installer {
        async fn install(&self, missing: Missing, _: Option<ProgressSink>) -> Result<(), String> {
            self.seen.lock().unwrap().push(missing);
            install(&self.dir);
            if let Some(slot) = &self.off_during {
                let setup = slot.lock().unwrap().clone().unwrap();
                setup.toggle(Some(false)).await;
            }
            Ok(())
        }
    }

    fn setup(dir: &std::path::Path, off_during: Option<Arc<VoiceSetupSlot>>) -> (Arc<VoiceSetup>, Arc<Store>, Arc<Installer>) {
        let pipeline = Arc::new(VoicePipeline::new(
            dir.to_owned(),
            manifest(),
            Arc::new(Fixed(json!({}))),
            Arc::new(FakeEngine::default()),
            Arc::new(FakeTools::default()),
            mixdog_rt::testing::tokens().durability_io,
        ));
        let store = Arc::new(Store(Mutex::default()));
        let installer = Arc::new(Installer { dir: dir.to_owned(), seen: Mutex::default(), off_during });
        (Arc::new(VoiceSetup::new(pipeline, store.clone(), installer.clone())), store, installer)
    }

    #[tokio::test]
    async fn turning_on_installs_only_what_is_missing_then_persists() {
        let dir = tempfile::tempdir().unwrap();
        let (setup, store, installer) = setup(dir.path(), None);
        assert_eq!(setup.status().await["installed"], false);
        assert_eq!(setup.toggle(Some(true)).await, ToggleResult::Enabled(true));
        assert_eq!(*installer.seen.lock().unwrap(), vec![Missing { whisper: true, model: true, ffmpeg: true }]);
        assert_eq!(*store.0.lock().unwrap(), vec![true]);
        assert_eq!(setup.status().await["components"], json!({"whisper": true, "model": true, "ffmpeg": true}));
    }

    #[tokio::test]
    async fn an_off_accepted_during_install_wins() {
        let dir = tempfile::tempdir().unwrap();
        let slot: Arc<VoiceSetupSlot> = Arc::default();
        let (setup, store, _) = setup(dir.path(), Some(slot.clone()));
        *slot.lock().unwrap() = Some(setup.clone());
        // The nested OFF runs inside the install; the ON write must then be skipped.
        assert_eq!(setup.toggle(Some(true)).await, ToggleResult::Enabled(false));
        assert_eq!(*store.0.lock().unwrap(), vec![false]);
        assert_eq!(setup.status().await["busy"], false);
    }

    #[tokio::test]
    async fn a_runtime_read_that_never_ran_installs_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (setup, store, installer) = setup(dir.path(), None);
        let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
        assert!(matches!(setup.toggle(Some(true)).await, ToggleResult::Failed(_)));
        assert!(installer.seen.lock().unwrap().is_empty());
        assert!(store.0.lock().unwrap().is_empty());
    }
}
