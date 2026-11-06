//! The step effort judge as the agent loop sees it. The loop awaits the
//! judgment before its next request, so this future always completes: a
//! model that is not installed or being installed, a load failure, a run
//! error, a lane that refuses the job and a worker that dies or panics all
//! answer `None`, which leaves the step at the effort in force. There are no
//! timers: a judgment ends when the inference ends.
//!
//! Inference runs on the CPU bulk lane, one judgment at a time per model
//! instance. The model loads on first use and stays resident; a failed load is
//! remembered until the model is installed or repaired, so a broken model
//! cannot add a load to every step.
//!
//! Install triggers, as Node has them: the first judged step of the instance
//! refreshes a model that is not the current release (in the background, the
//! step does not wait); a load failure verifies the files against the manifest
//! once and fetches only the damaged ones; `prewarm` loads the model ahead of
//! the first judged step.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::oneshot;

use async_trait::async_trait;
use mixdog_agent::step_effort::{StepEffortJudge, StepInput, StepResult};
use mixdog_rt::{CpuBulk, TaskClass};
use serde_json::{Value, json};
#[allow(clippy::disallowed_types, reason = "the turn lock is held across the awaited judgment on purpose: judgments run one at a time")]
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::effort_judge::error::JudgeError;
use crate::effort_judge::install::{self, Manifest};
use crate::effort_judge::input::{TurnInput, clip_turn};
use crate::effort_judge::ladder::StepLadder;
use crate::effort_judge::model::{JudgeModel, ModelConfig, available, available_on, steps_in};
use crate::model_install::{InstallError, ProgressSink, run_on_lane};
use crate::tool_state::{JudgeStatus, StateTick, onnx_runtime_supported};

type Loaded = Option<Result<Arc<JudgeModel>, JudgeError>>;

const EXITED: &str = "effort judge exited";
const FAILURE_PREFIX: &str = "effort judge load failed: ";

/// Node's judge-client waits (`judge-client.mjs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JudgeTiming {
    /// `WARM_TIMEOUT_MS`: an answer's deadline, from when it is sent to the model.
    pub warm: Duration,
    /// `QUEUE_WAIT_MS`: how long a turn waits for its place behind earlier judgments.
    pub queue: Duration,
    /// `COLD_WAIT_MS`: how long a turn waits for a model that is still loading.
    pub cold: Duration,
    /// `LOAD_RETRY_MS`: after a failed load the model is not retried for this long.
    pub retry: Duration,
}

impl JudgeTiming {
    /// Node's values, with `MIXDOG_EFFORT_JUDGE_TIMEOUT_MS` and `MIXDOG_EFFORT_JUDGE_COLD_WAIT_MS`
    /// taken when `Number(value) > 0`.
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>) -> Self {
        let positive = |name: &str, default: u64| {
            let n = env(name).map_or(f64::NAN, |v| mixdog_js::string_to_number(&v));
            if n > 0.0 { Duration::try_from_secs_f64(n / 1000.0).unwrap_or(Duration::from_millis(default)) } else { Duration::from_millis(default) }
        };
        Self {
            warm: positive("MIXDOG_EFFORT_JUDGE_TIMEOUT_MS", 500),
            queue: Duration::from_millis(1000),
            cold: positive("MIXDOG_EFFORT_JUDGE_COLD_WAIT_MS", 3000),
            retry: Duration::from_secs(60),
        }
    }
}

/// `judgeTurn`'s answer.
#[derive(Clone, Debug, PartialEq)]
pub enum TurnVerdict {
    Probs { probs: Vec<f64>, ms: u64 },
    Skipped(String),
}

impl TurnVerdict {
    fn skipped(why: impl Into<String>) -> Self {
        Self::Skipped(why.into())
    }
}

fn raw_load_message(error: &str) -> &str {
    error.strip_prefix(FAILURE_PREFIX).unwrap_or(error)
}

/// The `skipped` text for a failure: a load error carries the loader's own message.
fn skip_reason(error: &JudgeError) -> String {
    match error {
        JudgeError::Load(message) => format!("load-error: {message}"),
        JudgeError::NotInstalled(_) => "model-missing".to_owned(),
        JudgeError::Installing => "installing".to_owned(),
        JudgeError::Unsupported => "unsupported".to_owned(),
        JudgeError::Worker(_) | JudgeError::Cancelled => EXITED.to_owned(),
        JudgeError::Run(message) => message.clone(),
        JudgeError::StepsUnsupported => "step-unsupported".to_owned(),
    }
}

/// What the host chooses about a judge model.
#[derive(Clone, Default)]
pub struct JudgeOptions {
    /// Bumped whenever `status()` changes.
    pub tick: StateTick,
    /// The release to install; the bundled manifest when absent.
    pub manifest: Option<Manifest>,
    /// Byte progress of installs the judge starts itself.
    pub progress: Option<ProgressSink>,
}

/// The resident model and its serialised access. Shared by every run.
pub struct EffortJudgeModel {
    config: ModelConfig,
    lane: CpuBulk,
    manifest: Manifest,
    progress: Option<ProgressSink>,
    /// One judgment at a time: waiting happens here, not on a lane thread. The
    /// loaded model (or its remembered load failure) lives under the same lock.
    #[allow(clippy::disallowed_types, reason = "held across the awaited judgment on purpose: judgments run one at a time")]
    turn: Mutex<Loaded>,
    /// An install or repair is replacing the files: judgments answer at once.
    installing: AtomicBool,
    /// Readable without the turn lock, which a running judgment holds.
    ready: AtomicBool,
    last_error: std::sync::Mutex<String>,
    /// When the remembered load failure happened (`lastLoadErrorAt`).
    failed_at: std::sync::Mutex<Option<std::time::Instant>>,
    tick: StateTick,
    refresh_checked: AtomicBool,
    repair_started: AtomicBool,
    /// `calibration.json`'s `steps`, read on first ask.
    steps: std::sync::OnceLock<bool>,
    /// Ends installs this instance started in the background.
    cancel: CancellationToken,
}

impl EffortJudgeModel {
    pub fn new(config: ModelConfig, lane: CpuBulk) -> Result<Arc<Self>, InstallError> {
        Self::with_options(config, lane, JudgeOptions::default())
    }

    pub fn with_options(config: ModelConfig, lane: CpuBulk, options: JudgeOptions) -> Result<Arc<Self>, InstallError> {
        let manifest = match options.manifest {
            Some(manifest) => manifest,
            None => Manifest::bundled()?,
        };
        #[allow(clippy::disallowed_types, reason = "builds the turn lock")]
        let turn = Mutex::new(None);
        Ok(Arc::new(Self {
            config,
            lane,
            manifest,
            progress: options.progress,
            turn,
            installing: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            last_error: std::sync::Mutex::new(String::new()),
            failed_at: std::sync::Mutex::new(None),
            tick: options.tick,
            refresh_checked: AtomicBool::new(false),
            repair_started: AtomicBool::new(false),
            steps: std::sync::OnceLock::new(),
            cancel: CancellationToken::new(),
        }))
    }

    pub fn config(&self) -> &ModelConfig {
        &self.config
    }

    /// `effortJudgeInstalling()`.
    pub fn is_installing(&self) -> bool {
        self.installing.load(Ordering::Acquire)
    }

    /// `effortJudgeAvailable()`: the platform has a binding, the files hold
    /// data and, for a release install, it is stamped.
    pub fn is_available(&self) -> bool {
        onnx_runtime_supported() && available(&self.config)
    }

    /// `effortJudgeReady()`.
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    /// `effortJudgeLastError()`: empty when the model loaded or never failed.
    pub fn last_error(&self) -> String {
        self.last_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    fn set_load_state(&self, ready: bool, error: String) {
        *self.failed_at.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = (!error.is_empty()).then(std::time::Instant::now);
        self.ready.store(ready, Ordering::Release);
        *self.last_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = error;
        self.tick.bump();
    }

    /// `effortJudgeInfo()`: what the settings card shows. The installed model
    /// names its backbone in `calibration.json`; older packs predate the field.
    #[allow(clippy::disallowed_methods, reason = "a lane-job body: the host's info reader runs `status` as a read-lane job")]
    pub fn info(&self) -> Value {
        let model_bytes = std::fs::metadata(self.config.dir.join("model.onnx")).map_or(0, |m| m.len());
        let backbone = std::fs::read(self.config.dir.join("calibration.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|json| json["backbone"].as_str().filter(|s| !s.is_empty()).map(str::to_owned))
            .unwrap_or_else(|| "EmbeddingGemma 2 (18 layers)".to_owned());
        json!({
            "model": backbone,
            "quantization": "4-bit",
            "engine": "ONNX Runtime",
            "device": "CPU",
            "modelBytes": model_bytes,
            "ready": self.is_ready(),
        })
    }

    /// `effortJudgeSupportsSteps()`: whether the installed model was trained on
    /// tool-result steps (`steps: 1` in `calibration.json`). Like Node, it is
    /// read once per instance; a lane refusal is not remembered.
    pub async fn supports_steps(&self) -> bool {
        if let Some(steps) = self.steps.get() {
            return *steps;
        }
        let Ok(steps) = steps_in(self.lane, &self.config.dir).await else { return false };
        *self.steps.get_or_init(|| steps)
    }

    pub fn status(&self) -> JudgeStatus {
        JudgeStatus {
            available: self.is_available(),
            installing: self.is_installing(),
            ready: self.is_ready(),
            last_error: self.last_error(),
            info: self.info(),
        }
    }

    async fn lane_job<R, F>(&self, job: F) -> Result<R, JudgeError>
    where
        R: Send + 'static,
        F: FnOnce() -> R + Send + 'static,
    {
        run_on_lane(self.lane, job).await.map_err(JudgeError::Worker)
    }

    /// Loads the model into `state` unless it is already there (or failed).
    /// A model that is not installed is not remembered: an install can follow.
    /// A lane refusal is transient and not remembered either; a load failure is.
    async fn ensure_loaded(&self, state: &mut Loaded) -> Result<Arc<JudgeModel>, JudgeError> {
        if state.is_none() {
            if !available_on(self.lane, &self.config).await.map_err(|e| JudgeError::Worker(e.to_string()))? {
                return Err(JudgeError::NotInstalled(self.config.dir.display().to_string()));
            }
            let config = self.config.clone();
            let outcome = self.lane_job(move || JudgeModel::load(&config).map(Arc::new)).await?;
            match &outcome {
                Ok(_) => self.set_load_state(true, String::new()),
                Err(error) => self.set_load_state(false, error.to_string()),
            }
            *state = Some(outcome);
        }
        match state {
            Some(outcome) => outcome.clone(),
            None => Err(JudgeError::Worker("model state missing".into())),
        }
    }

    /// Calibrated probabilities over the four levels for one step.
    pub async fn probs(self: &Arc<Self>, input: StepInput) -> Result<Vec<f64>, JudgeError> {
        if !onnx_runtime_supported() {
            return Err(JudgeError::Unsupported);
        }
        self.refresh_once();
        if self.is_installing() {
            return Err(JudgeError::Installing);
        }
        let mut state = self.turn.lock().await;
        // Checked again under the lock: an install that began while this call
        // waited must find the files unused.
        if self.is_installing() {
            return Err(JudgeError::Installing);
        }
        let model = match self.ensure_loaded(&mut state).await {
            Ok(model) => model,
            Err(error) => {
                drop(state);
                self.repair_after_load_failure(&error);
                return Err(error);
            }
        };
        self.lane_job(move || model.probs(&input)).await?
    }

    /// `judgeTurn`: the turn's calibrated probabilities, or why the judge cannot answer in time.
    /// Same order of checks and the same reasons as Node's judge client: a platform without a
    /// binding, an install in progress, a missing model, a recent load failure, a load that outlasts
    /// the cold wait, a queue that outlasts the queue wait, an inference that outlasts the deadline.
    pub async fn judge_turn(self: &Arc<Self>, input: TurnInput, timing: JudgeTiming) -> TurnVerdict {
        if !onnx_runtime_supported() {
            return TurnVerdict::skipped("unsupported");
        }
        self.refresh_once();
        if self.is_installing() {
            return TurnVerdict::skipped("installing");
        }
        match available_on(self.lane, &self.config).await {
            Ok(true) => {}
            Ok(false) => return TurnVerdict::skipped("model-missing"),
            Err(error) => return TurnVerdict::skipped(error.to_string()),
        }
        if !self.is_ready() {
            if let Some(why) = self.recent_load_failure(timing.retry) {
                return TurnVerdict::skipped(format!("load-error: {why}"));
            }
            let (done_tx, done_rx) = oneshot::channel();
            let this = self.clone();
            mixdog_rt::spawn("services.effort-judge.turn-load", TaskClass::Work, async move {
                drop(done_tx.send(this.load_for_turn(timing.retry).await));
            });
            match tokio::time::timeout(timing.cold, done_rx).await {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(error))) => return TurnVerdict::skipped(skip_reason(&error)),
                Ok(Err(_)) => return TurnVerdict::skipped(EXITED),
                Err(_) => {
                    let why = self.last_error();
                    return TurnVerdict::skipped(if why.is_empty() { "warming".to_owned() } else { format!("load-error: {}", raw_load_message(&why)) });
                }
            }
        }
        // The task takes its place in the queue and keeps it until the inference ends, even for a
        // caller whose deadline has passed: an answer that missed its deadline still occupies the model.
        let (started_tx, started_rx) = oneshot::channel();
        let (result_tx, result_rx) = oneshot::channel();
        let this = self.clone();
        let clipped = clip_turn(&input);
        mixdog_rt::spawn("services.effort-judge.turn", TaskClass::Work, async move {
            let mut state = this.turn.lock().await;
            if started_tx.send(()).is_err() {
                return;
            }
            let outcome = async {
                let model = this.ensure_loaded(&mut state).await?;
                let began = std::time::Instant::now();
                let probs = this.lane_job(move || model.turn_probs(&clipped)).await??;
                Ok::<_, JudgeError>((probs, u64::try_from(began.elapsed().as_millis()).unwrap_or(u64::MAX)))
            }
            .await;
            drop(result_tx.send(outcome));
        });
        match tokio::time::timeout(timing.queue, started_rx).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return TurnVerdict::skipped(EXITED),
            Err(_) => return TurnVerdict::skipped("busy"),
        }
        match tokio::time::timeout(timing.warm, result_rx).await {
            Ok(Ok(Ok((probs, ms)))) => TurnVerdict::Probs { probs, ms },
            Ok(Ok(Err(error))) => TurnVerdict::skipped(skip_reason(&error)),
            Ok(Err(_)) => TurnVerdict::skipped(EXITED),
            Err(_) => TurnVerdict::skipped("timeout"),
        }
    }

    /// A load that failed less than `retry` ago and has not been replaced: Node does not start a
    /// worker (and turns do not wait on one) inside this back-off.
    fn recent_load_failure(&self, retry: Duration) -> Option<String> {
        let why = self.last_error();
        let failed = *self.failed_at.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        (!self.is_ready() && !why.is_empty() && failed.is_some_and(|at| at.elapsed() < retry)).then(|| raw_load_message(&why).to_owned())
    }

    /// Loads the model for a turn that found none resident. A failure older than the back-off is
    /// forgotten first, as Node starts a fresh worker then.
    async fn load_for_turn(self: &Arc<Self>, retry: Duration) -> Result<(), JudgeError> {
        let mut state = self.turn.lock().await;
        if self.is_installing() {
            return Err(JudgeError::Installing);
        }
        let failed = *self.failed_at.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(*state, Some(Err(_))) && failed.is_none_or(|at| at.elapsed() >= retry) {
            *state = None;
        }
        match self.ensure_loaded(&mut state).await {
            Ok(_) => Ok(()),
            Err(error) => {
                drop(state);
                self.repair_after_load_failure(&error);
                Err(error)
            }
        }
    }

    /// The first judged step of this instance: a model that is not the current
    /// release is fetched in the background. The step does not wait for it; a
    /// failed refresh only leaves an older complete install in use.
    fn refresh_once(self: &Arc<Self>) {
        if self.refresh_checked.swap(true, Ordering::AcqRel) {
            return;
        }
        if self.config.explicit {
            return;
        }
        let this = self.clone();
        mixdog_rt::spawn("services.effort-judge.refresh", TaskClass::Work, async move {
            // Read on the lane, off the step's path.
            let current = async {
                Ok::<_, InstallError>(
                    available_on(this.lane, &this.config).await? && install::install_current_on(this.lane, &this.config.dir, &this.manifest).await?,
                )
            };
            match current.await {
                Ok(true) => return,
                Ok(false) => {}
                Err(error) => {
                    tracing::warn!(%error, "effort judge: model state could not be read");
                    return;
                }
            }
            if let Err(error) = this.install(&this.manifest, this.progress.as_ref(), &this.cancel).await {
                tracing::warn!(%error, "effort judge: model update failed");
            }
        });
    }

    /// A model that fails to load may be damaged on disk (a crash can leave a
    /// stamped file with a zeroed tail). The files are verified once per failure,
    /// off the step's path; only damaged ones are fetched again.
    fn repair_after_load_failure(self: &Arc<Self>, error: &JudgeError) {
        if !matches!(error, JudgeError::Load(_)) || self.config.explicit || self.repair_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = self.clone();
        mixdog_rt::spawn("services.effort-judge.repair", TaskClass::Work, async move {
            match this.repair(&this.manifest, this.progress.as_ref(), &this.cancel).await {
                Ok(bad) if !bad.is_empty() => {
                    tracing::warn!(files = ?bad, "effort judge: reinstalled damaged model files");
                    // The files are replaced: the next failure may be repaired again.
                    this.repair_started.store(false, Ordering::Release);
                }
                Ok(_) => {}
                Err(error) => tracing::warn!(%error, "effort judge: model repair failed"),
            }
        });
    }

    /// Starts loading the model ahead of the first judged step. True when it is
    /// loaded or loading; false when it cannot be: unsupported platform, an
    /// install in progress, not installed, or a remembered load failure.
    pub async fn prewarm(self: &Arc<Self>) -> bool {
        if !onnx_runtime_supported() || self.is_installing() {
            return false;
        }
        if !available_on(self.lane, &self.config).await.unwrap_or(false) {
            // A lane that could not read it answers "not now"; the next prewarm asks again.
            return false;
        }
        match self.turn.try_lock() {
            // A judgment or a load holds the lock: it is loaded or loading.
            Err(_) => true,
            Ok(state) => match &*state {
                Some(Ok(_)) => true,
                Some(Err(_)) => false,
                None => {
                    drop(state);
                    let this = self.clone();
                    mixdog_rt::spawn("services.effort-judge.prewarm", TaskClass::Work, async move {
                        let mut state = this.turn.lock().await;
                        if !this.is_installing() {
                            let _ = this.ensure_loaded(&mut state).await;
                        }
                    });
                    true
                }
            },
        }
    }

    /// `shutdownEffortJudge()`: unloads the model; the next judgment loads it again.
    pub async fn shutdown(&self) {
        *self.turn.lock().await = None;
        self.ready.store(false, Ordering::Release);
        self.tick.bump();
    }

    /// Runs `work` with no model loaded and judgments answering `Installing`,
    /// then lets the next judgment load whatever the files now hold.
    async fn replacing_files<T, F>(&self, work: F) -> Result<T, InstallError>
    where
        F: std::future::Future<Output = Result<T, InstallError>>,
    {
        if self.installing.swap(true, Ordering::AcqRel) {
            return Err(InstallError::Busy);
        }
        struct Done<'a>(&'a AtomicBool);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _done = Done(&self.installing);
        // The loaded session maps the file the install is about to replace.
        *self.turn.lock().await = None;
        self.ready.store(false, Ordering::Release);
        self.tick.bump();
        let outcome = work.await;
        if outcome.is_ok() {
            // The files were replaced: an earlier load failure no longer describes them.
            self.last_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
        }
        self.installing.store(false, Ordering::Release);
        self.tick.bump();
        outcome
    }

    /// Installs or updates the model unless it is already the current release.
    pub async fn install(
        &self,
        manifest: &Manifest,
        progress: Option<&ProgressSink>,
        cancel: &CancellationToken,
    ) -> Result<(), InstallError> {
        self.replacing_files(install::ensure_installed(&self.config, manifest, self.lane, progress, cancel)).await
    }

    /// Re-verifies the files against the manifest and fetches only the damaged
    /// ones. Returns their names; nothing is unloaded when none is damaged.
    pub async fn repair(
        &self,
        manifest: &Manifest,
        progress: Option<&ProgressSink>,
        cancel: &CancellationToken,
    ) -> Result<Vec<String>, InstallError> {
        if self.config.explicit {
            return Ok(Vec::new());
        }
        let bad = install::invalidate_damaged(&self.config.dir, manifest, self.lane).await?;
        if !bad.is_empty() {
            self.replacing_files(install::install_model(&self.config.dir, manifest, self.lane, progress, cancel)).await?;
        }
        Ok(bad)
    }
}

/// A run's judge: the shared model plus the ladder of the turn.
pub struct EffortJudge {
    model: Arc<EffortJudgeModel>,
    ladder: Arc<dyn StepLadder>,
}

impl EffortJudge {
    pub fn new(model: Arc<EffortJudgeModel>, ladder: Arc<dyn StepLadder>) -> Self {
        Self { model, ladder }
    }
}

#[async_trait]
impl StepEffortJudge for EffortJudge {
    async fn judge(&self, input: StepInput) -> Option<StepResult> {
        match self.model.probs(input).await {
            Ok(probs) => self.ladder.resolve(&probs),
            Err(error) => {
                tracing::debug!(%error, "effort judge: step left at the effort in force");
                None
            }
        }
    }
}
