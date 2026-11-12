//! The effort judge: Node's `judgeTurn` for a turn and for a tool-result step (Node's step path
//! calls `judgeTurn` too), with Node's waits ([`JudgeTiming`]). Every answer comes within those
//! waits: a model that is not installed or being installed, a load failure, a run error, a busy
//! queue, a missed deadline and a worker that dies or panics all answer a skip, which leaves the
//! turn at its default effort and the step at the effort in force.
//!
//! The model load, its warm-up and every inference run on the judge's own thread
//! ([`JudgeWorker`], Node's judge worker): normal priority, one judgment at a time
//! per model instance, never behind the shared CPU lanes. Whether the model is
//! installed and trained on steps is read as a byte-bounded job on the interactive
//! read lane; only installs and their hash checks use the CPU bulk lane, which Node
//! also runs off its worker. The model lives in a host process of its own ([`host`](crate::effort_judge::host)):
//! a native fault in inference ends that process, not the core, and the next request starts a fresh one.
//! It loads at a prewarm or the first judgment and is unloaded after [`KEEP_WARM`] without a judgment
//! (never under a request, a load or a turn's lease: [`EffortJudgeModel::hold_warm`]); the first turn after
//! such an unload waits for the reload ([`RELOAD_WAIT`]). A failed load is remembered until the model
//! is installed or repaired, so a broken model cannot add a load to every step.
//!
//! Install triggers, as Node has them: the first judged step of the instance
//! refreshes a model that is not the current release (in the background, the
//! step does not wait); a load failure verifies the files against the manifest
//! once and fetches only the damaged ones; `prewarm` loads the model ahead of
//! the first judged step.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use tokio::sync::oneshot;

use async_trait::async_trait;
use mixdog_agent::step_effort::{StepEffortJudge, StepInput, StepResult};
use mixdog_rt::{CpuBulk, Gate, InteractiveIo, JudgeThread, LaneTokens, TaskClass};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::effort_judge::error::JudgeError;
use crate::effort_judge::host::{HostClient, HostLaunch};
use crate::effort_judge::install::{self, Manifest};
use crate::effort_judge::input::{TurnInput, clip_turn};
use crate::effort_judge::ladder::StepLadder;
use crate::effort_judge::model::{JudgeModel, ModelConfig, available, available_on, steps_in};
use crate::effort_judge::worker::{Alarm, JudgeWorker, Seat, Stopper, TickerAlarm, deadline};
use crate::model_install::{InstallError, ProgressSink};
use crate::tool_state::{JudgeStatus, StateTick};

/// The loaded model as the judge's thread runs it: the ONNX model; tests load a scripted stand-in.
pub(crate) trait Resident: Send + Sync {
    fn probs(&self, input: &StepInput) -> Result<Vec<f64>, JudgeError>;
    fn turn_probs(&self, input: &TurnInput) -> Result<Vec<f64>, JudgeError>;
    /// Ends the inference running on the judge's thread, from another thread.
    fn stopper(&self) -> Stopper;
}

impl Resident for JudgeModel {
    fn probs(&self, input: &StepInput) -> Result<Vec<f64>, JudgeError> {
        JudgeModel::probs(self, input)
    }

    fn turn_probs(&self, input: &TurnInput) -> Result<Vec<f64>, JudgeError> {
        JudgeModel::turn_probs(self, input)
    }

    fn stopper(&self) -> Stopper {
        JudgeModel::stopper(self)
    }
}

/// What is judged: `judgeTurn({ request, prev, prevRequest })` or `judgeTurn({ step })`.
enum Ask {
    Turn(TurnInput),
    Step(StepInput),
}

/// `EMBED_KEEP_WARM_MS` (`embedding-idle-lease.mjs`): how long the model stays loaded without a
/// judgment, and how long a turn's lease holds it.
pub const KEEP_WARM: Duration = Duration::from_secs(6 * 60);

/// `RELOAD_WAIT_MS` (`judge-client.mjs`): a turn waits this long (at least the cold wait) for a model
/// that has loaded before and was unloaded, so a session with a turn every few minutes is judged.
pub const RELOAD_WAIT: Duration = Duration::from_secs(10);

/// What the idle unload goes by.
#[derive(Default)]
struct Idle {
    /// Bumped by every use: a ring acts only if it holds the latest value (Node's `touchIdle`).
    epoch: AtomicU64,
    /// Leases held ([`EffortJudgeModel::hold_warm`]) that have not run out.
    leases: AtomicUsize,
    /// The newest thread unloaded for being idle: a request that finds it so retries on a fresh load.
    retired: AtomicU64,
    /// The model has loaded in this process (Node's `loadedDirs`): its next load is a reload.
    loaded_before: AtomicBool,
}

/// How an attempt to judge ended without an answer.
enum Stop {
    /// The thread was unloaded for being idle while the request waited for it.
    Retry,
    Fail(JudgeError),
}

impl From<JudgeError> for Stop {
    fn from(error: JudgeError) -> Self {
        Self::Fail(error)
    }
}

/// The model's host process, started and loaded.
fn start_host(config: &ModelConfig, launch: Option<&HostLaunch>, runtime: &tokio::runtime::Handle, alarm: &dyn Alarm) -> Result<Arc<dyn Resident>, JudgeError> {
    let launch = match launch {
        Some(launch) => launch.clone(),
        None => HostLaunch::of(config)?,
    };
    HostClient::start(&launch, runtime, alarm).map(|client| Arc::new(client) as Arc<dyn Resident>)
}

/// The model's load: the generation of the judge thread holding it, or the remembered failure.
type Loaded = Option<Result<u64, JudgeError>>;

/// The model a judge thread holds.
fn resident(seat: &Seat) -> Result<&Arc<dyn Resident>, JudgeError> {
    seat.model.as_ref().ok_or_else(|| JudgeError::Worker("no model on the effort judge thread".to_owned()))
}

/// A load that tests run on the judge's thread instead of the ONNX model's.
#[cfg(test)]
pub(crate) type Script = Arc<dyn Fn() -> Result<Arc<dyn Resident>, JudgeError> + Send + Sync>;

/// The executors a judge uses.
#[derive(Clone, Copy, Debug)]
pub struct JudgeLanes {
    /// Installs, repairs and their hash checks: Node runs these off its judge worker too.
    pub bulk: CpuBulk,
    /// Whether the model is installed and trained on steps: byte-bounded reads a judgment answers
    /// from before it waits for the model (Node reads them inline).
    pub read: InteractiveIo,
    /// The judge's own thread: the model load, its warm-up and every judgment.
    pub thread: JudgeThread,
}

impl JudgeLanes {
    pub fn of(tokens: &LaneTokens) -> Self {
        Self { bulk: tokens.cpu_bulk, read: tokens.interactive_io, thread: tokens.judge_thread }
    }
}

const EXITED: &str = "effort judge exited";
const FAILURE_PREFIX: &str = "effort judge load failed: ";

/// Node's judge-client waits (`judge-client.mjs` at `bb8c5e3b7`), the same for a turn and a step:
///
/// | wait | Node | when it runs out |
/// |---|---|---|
/// | queue: behind the judgment the worker runs | `QUEUE_WAIT_MS` 1 s (`:40`, raced at `:365`) | `busy` (`:371`); the judgment leaves the queue unsent. Any number wait. |
/// | answer: from when the judgment is sent | `WARM_TIMEOUT_MS` 500 ms (`:38`, armed at `:181`) | `timeout`; the judgment keeps the queue until the worker answers |
/// | watchdog: the sent judgment's worker | `STUCK_MS` 10 s (`:43`, armed at `:182`; [`worker::STUCK`](crate::effort_judge::worker::STUCK)) | the worker is ended; its waiters answer `effort judge exited` (`:161`) |
/// | cold: a model still loading | `COLD_WAIT_MS` 3 s (`:49`, waited at `:351`) | `warming`, or `load-error: …` after a failed load (`:352`) |
///
/// Every skip leaves the effort as it was: the turn records `skipped` and applies nothing
/// (`ask-turn-auto-effort.mjs:143-145`; the core's `auto_effort.rs` `JudgeAnswer::Skipped`), and a
/// step stays at the effort in force (`step-auto-effort.mjs:160-162`).
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

impl Default for JudgeTiming {
    /// Node's values with neither variable set.
    fn default() -> Self {
        Self::from_env(&|_| None)
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
        JudgeError::Busy => "busy".to_owned(),
        JudgeError::Warming => "warming".to_owned(),
        JudgeError::Timeout => "timeout".to_owned(),
        JudgeError::Run(message) => message.clone(),
        JudgeError::StepsUnsupported => "step-unsupported".to_owned(),
    }
}

/// What the host chooses about a judge model.
#[derive(Clone)]
pub struct JudgeOptions {
    /// How long the model stays loaded without a judgment, and how long a turn's lease holds it:
    /// the one setting of the idle unload, [`KEEP_WARM`] unless a host chooses otherwise. It runs on
    /// the judge's clock.
    pub keep_warm: Duration,
    /// Bumped whenever `status()` changes.
    pub tick: StateTick,
    /// The release to install; the bundled manifest when absent.
    pub manifest: Option<Manifest>,
    /// Byte progress of installs the judge starts itself.
    pub progress: Option<ProgressSink>,
    /// The waits of a step's judgment ([`EffortJudgeModel::probs`]); a turn passes its own.
    pub timing: JudgeTiming,
    /// The host process the model loads in, for tests that start a real one.
    #[cfg(test)]
    pub(crate) host: Option<HostLaunch>,
}

impl Default for JudgeOptions {
    fn default() -> Self {
        Self {
            keep_warm: KEEP_WARM,
            tick: StateTick::default(),
            manifest: None,
            progress: None,
            timing: JudgeTiming::default(),
            #[cfg(test)]
            host: None,
        }
    }
}

/// The resident model and its serialised access. Shared by every run.
pub struct EffortJudgeModel {
    config: ModelConfig,
    lanes: JudgeLanes,
    worker: JudgeWorker,
    manifest: Manifest,
    progress: Option<ProgressSink>,
    /// One load or judgment at a time, in arrival order (Node's `queueTail`): waiting happens here,
    /// not on a lane thread or in the thread's queue. A judgment holds it until its thread answers or
    /// is let go, whether or not its caller still waits.
    turn: Gate,
    /// Where the model is loaded (or its remembered load failure). Held for a few instructions only,
    /// never across an await; the `turn` gate orders the loads and judgments that change it. A model
    /// on a thread no longer taking jobs is no model. Readable without the turn gate.
    model: std::sync::Mutex<Loaded>,
    /// The waits of a step's judgment.
    timing: JudgeTiming,
    /// The clock of every wait: cold, queue, answer and the watchdog's.
    alarm: Arc<dyn Alarm>,
    /// An install or repair is replacing the files: judgments answer at once.
    installing: AtomicBool,
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
    idle: Idle,
    /// [`JudgeOptions::keep_warm`].
    keep_warm: Duration,
    #[cfg(test)]
    script: Option<Script>,
    #[cfg(test)]
    host: Option<HostLaunch>,
}

impl EffortJudgeModel {
    pub fn new(config: ModelConfig, lanes: JudgeLanes) -> Result<Arc<Self>, InstallError> {
        Self::with_options(config, lanes, JudgeOptions::default())
    }

    pub fn with_options(config: ModelConfig, lanes: JudgeLanes, options: JudgeOptions) -> Result<Arc<Self>, InstallError> {
        Self::create(config, lanes, options, Arc::new(TickerAlarm)).map(Arc::new)
    }

    /// A judge whose loads run `script` on its thread instead of loading the ONNX model, its steps
    /// given waits no healthy judgment comes near.
    #[cfg(test)]
    pub(crate) fn scripted(config: ModelConfig, lanes: JudgeLanes, script: Script) -> Arc<Self> {
        let patient = Duration::from_secs(60);
        let timing = JudgeTiming { warm: patient, queue: patient, cold: patient, retry: patient };
        Self::scripted_on(config, lanes, script, Arc::new(TickerAlarm), JudgeOptions { timing, ..JudgeOptions::default() })
    }

    /// [`Self::scripted`] with every wait on `alarm`.
    #[cfg(test)]
    pub(crate) fn scripted_on(config: ModelConfig, lanes: JudgeLanes, script: Script, alarm: Arc<dyn Alarm>, options: JudgeOptions) -> Arc<Self> {
        let mut judge = Self::create(config, lanes, options, alarm).expect("the bundled manifest");
        judge.script = Some(script);
        Arc::new(judge)
    }

    /// A judge whose model loads in a real host process started as `launch`.
    #[cfg(test)]
    pub(crate) fn hosted(config: ModelConfig, lanes: JudgeLanes, launch: HostLaunch) -> Arc<Self> {
        Self::hosted_on(config, lanes, launch, Arc::new(TickerAlarm))
    }

    /// [`Self::hosted`] with every wait on `alarm`.
    #[cfg(test)]
    pub(crate) fn hosted_on(config: ModelConfig, lanes: JudgeLanes, launch: HostLaunch, alarm: Arc<dyn Alarm>) -> Arc<Self> {
        Self::hosted_for(config, lanes, launch, alarm, KEEP_WARM)
    }

    /// [`Self::hosted_on`] with the idle period `keep_warm`.
    #[cfg(test)]
    pub(crate) fn hosted_for(config: ModelConfig, lanes: JudgeLanes, launch: HostLaunch, alarm: Arc<dyn Alarm>, keep_warm: Duration) -> Arc<Self> {
        let options = JudgeOptions { host: Some(launch), keep_warm, ..JudgeOptions::default() };
        Arc::new(Self::create(config, lanes, options, alarm).expect("the bundled manifest"))
    }

    /// The latest use the idle ring goes by, for tests.
    #[cfg(test)]
    pub(crate) fn idle_epoch(&self) -> u64 {
        self.idle.epoch.load(Ordering::Acquire)
    }

    /// Holds the turn gate as a judgment does, for tests.
    #[cfg(test)]
    pub(crate) async fn hold_turn(&self) -> mixdog_rt::GateGuard {
        self.turn.enter(&self.cancel).await.expect("the gate is free to enter")
    }

    /// The judge's threads, for tests.
    #[cfg(test)]
    pub(crate) fn worker(&self) -> &JudgeWorker {
        &self.worker
    }

    fn create(config: ModelConfig, lanes: JudgeLanes, options: JudgeOptions, alarm: Arc<dyn Alarm>) -> Result<Self, InstallError> {
        let manifest = match options.manifest {
            Some(manifest) => manifest,
            None => Manifest::bundled()?,
        };
        Ok(Self {
            config,
            lanes,
            worker: JudgeWorker::new(lanes.thread, options.tick.clone(), alarm.clone()),
            manifest,
            progress: options.progress,
            turn: Gate::new(),
            model: std::sync::Mutex::new(None),
            timing: options.timing,
            alarm,
            installing: AtomicBool::new(false),
            last_error: std::sync::Mutex::new(String::new()),
            failed_at: std::sync::Mutex::new(None),
            tick: options.tick,
            refresh_checked: AtomicBool::new(false),
            repair_started: AtomicBool::new(false),
            steps: std::sync::OnceLock::new(),
            cancel: CancellationToken::new(),
            idle: Idle::default(),
            keep_warm: options.keep_warm,
            #[cfg(test)]
            script: None,
            #[cfg(test)]
            host: options.host,
        })
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
        self.config.runtime_supported() && available(&self.config)
    }

    /// `effortJudgeReady()`: the model is loaded on the thread taking jobs.
    pub fn is_ready(&self) -> bool {
        matches!(self.loaded(), Some(Ok(_)))
    }

    /// The load as it stands for the thread taking jobs: a model on a thread given up (stuck,
    /// panicked, shut down) or stalled is none, as Node's `ready` falls with its worker.
    fn loaded(&self) -> Loaded {
        let state = self.model_state().clone();
        match state {
            Some(Ok(generation)) if self.worker.generation() != Some(generation) => None,
            other => other,
        }
    }

    /// `effortJudgeLastError()`: empty when the model loaded or never failed.
    pub fn last_error(&self) -> String {
        self.last_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    fn set_load_state(&self, error: String) {
        *self.failed_at.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = (!error.is_empty()).then(std::time::Instant::now);
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
        let Ok(steps) = steps_in(self.lanes.read, &self.config.dir).await else { return false };
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

    fn model_state(&self) -> std::sync::MutexGuard<'_, Loaded> {
        self.model.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Node's `shutdownEffortJudge`: the thread taking jobs is let go and the model with it. Nothing
    /// waits for the thread: its waiters answer "effort judge exited" now, its running inference is
    /// stopped, and it drops its model on itself (the session's drop joins its intra-op threads,
    /// which no async worker may wait for) once its job returns.
    fn let_go(&self) {
        // In this order: a load that answers in between sees the leave and stores nothing.
        self.worker.leave();
        self.model_state().take();
    }

    /// Lets thread `generation` go and forgets its model, if it is still the one taking jobs.
    fn let_go_thread(&self, generation: u64) {
        self.worker.retire(generation);
        let mut state = self.model_state();
        if matches!(*state, Some(Ok(g)) if g == generation) {
            *state = None;
        }
    }

    /// Renews the keep-warm lease for [`KEEP_WARM`]: the turn is about to judge, and the model is
    /// not unloaded under it (Node's `holdEffortJudgeWarm`).
    pub fn hold_warm(self: &Arc<Self>) {
        self.idle.leases.fetch_add(1, Ordering::AcqRel);
        let this = Arc::downgrade(self);
        self.alarm.after(
            self.keep_warm,
            Box::new(move || {
                if let Some(this) = this.upgrade() {
                    this.idle.leases.fetch_sub(1, Ordering::AcqRel);
                }
            }),
        );
    }

    /// Whether a lease still holds the model loaded.
    pub fn is_held_warm(&self) -> bool {
        self.idle.leases.load(Ordering::Acquire) > 0
    }

    /// The model was used: it is looked at again after [`KEEP_WARM`] (Node's `touchIdle`).
    fn touch_idle(self: &Arc<Self>) {
        let epoch = self.idle.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        let this = Arc::downgrade(self);
        self.alarm.after(
            self.keep_warm,
            Box::new(move || {
                if let Some(this) = this.upgrade() {
                    this.idle_rang(epoch);
                }
            }),
        );
    }

    /// The idle ring of use `epoch`. A lease, a load in progress or a request (the turn gate is held
    /// or waited for) keeps the model: it is looked at again later, never unloaded under work.
    pub(crate) fn idle_rang(self: &Arc<Self>, epoch: u64) {
        if self.idle.epoch.load(Ordering::Acquire) != epoch {
            return;
        }
        let Some(generation) = self.worker.generation() else { return };
        if self.is_held_warm() || self.turn.is_busy() {
            self.touch_idle();
            return;
        }
        self.unload_idle(generation);
    }

    /// Unloads thread `generation` for being idle. Noted before the thread goes, so a request that
    /// finds it gone knows why and asks again, on a fresh load.
    pub(crate) fn unload_idle(&self, generation: u64) {
        self.idle.retired.fetch_max(generation, Ordering::AcqRel);
        self.let_go_thread(generation);
        self.tick.bump();
    }

    /// The load job: the host process with the model in it, started and waited for on the judge's
    /// thread, which keeps the client. Answers that thread's generation.
    fn load_job(&self) -> impl FnOnce(&mut Seat) -> Result<u64, JudgeError> + Send + 'static {
        let config = self.config.clone();
        let runtime = tokio::runtime::Handle::current();
        let alarm = self.alarm.clone();
        #[cfg(test)]
        let (script, host) = (self.script.clone(), self.host.clone());
        move |seat| {
            #[cfg(test)]
            let loaded = match script {
                Some(script) => script(),
                None => start_host(&config, host.as_ref(), &runtime, &*alarm),
            };
            #[cfg(not(test))]
            let loaded = start_host(&config, None, &runtime, &*alarm);
            seat.model = Some(loaded?);
            Ok(seat.generation)
        }
    }

    /// Loads the model unless the thread taking jobs has it (or it failed); callers hold the `turn`
    /// gate. Answers the generation of the thread holding it. A model that is not installed is not
    /// remembered: an install can follow. A thread that cannot take the job is not remembered
    /// either; a load failure is, a panicking load included. A load answered after the judge let
    /// its thread go (shutdown, new files) stores nothing.
    async fn ensure_loaded(self: &Arc<Self>) -> Result<u64, JudgeError> {
        if let Some(outcome) = self.loaded() {
            return outcome;
        }
        let left = self.worker.left();
        let outcome = match self.worker.load(self.load_job()).await {
            Ok((_, outcome)) => outcome,
            Err(error @ JudgeError::Load(_)) => Err(error),
            Err(error) => return Err(error),
        };
        // A host that never became ready was killed at its limit: no failure to back off from, the
        // next judgment starts a new one.
        if matches!(outcome, Err(JudgeError::NotInstalled(_) | JudgeError::Worker(_))) {
            return outcome;
        }
        let mut state = self.model_state();
        if self.worker.left() != left {
            return Err(JudgeError::Worker(EXITED.to_owned()));
        }
        match &outcome {
            Ok(_) => self.set_load_state(String::new()),
            Err(error) => self.set_load_state(error.to_string()),
        }
        self.idle.loaded_before.store(outcome.is_ok(), Ordering::Release);
        *state = Some(outcome.clone());
        drop(state);
        if outcome.is_ok() {
            self.touch_idle();
        }
        outcome
    }

    /// Calibrated probabilities over the four levels for one step: Node's `judgeTurn({ step })`,
    /// with this judge's waits.
    pub async fn probs(self: &Arc<Self>, input: StepInput) -> Result<Vec<f64>, JudgeError> {
        self.ask(Ask::Step(input), self.timing).await.map(|(probs, _)| probs)
    }

    /// `judgeTurn`: the turn's calibrated probabilities, or why the judge cannot answer in time.
    pub async fn judge_turn(self: &Arc<Self>, input: TurnInput, timing: JudgeTiming) -> TurnVerdict {
        match self.ask(Ask::Turn(input), timing).await {
            Ok((probs, ms)) => TurnVerdict::Probs { probs, ms },
            Err(error) => TurnVerdict::skipped(skip_reason(&error)),
        }
    }

    /// Node's `judgeTurn` (`judge-client.mjs:336-379` at `bb8c5e3b7`): the probabilities and the
    /// milliseconds from sending, or why the judge cannot answer in time. Same order of checks as
    /// Node's: a platform without a binding, an install in progress, a missing model, a recent load
    /// failure, a load that outlasts the cold wait, a queue that outlasts the queue wait, an answer
    /// that outlasts the deadline. Every wait is on the judge's alarm, armed before what it waits for.
    ///
    /// A request that finds its thread unloaded for being idle (Node's `retiredIdle`) is asked again
    /// from the start, and so answered by a fresh load.
    async fn ask(self: &Arc<Self>, ask: Ask, timing: JudgeTiming) -> Result<(Vec<f64>, u64), JudgeError> {
        let ask = Arc::new(ask);
        loop {
            match self.ask_once(&ask, timing).await {
                Ok(answer) => return Ok(answer),
                Err(Stop::Fail(error)) => return Err(error),
                Err(Stop::Retry) => {}
            }
        }
    }

    async fn ask_once(self: &Arc<Self>, ask: &Arc<Ask>, timing: JudgeTiming) -> Result<(Vec<f64>, u64), Stop> {
        if !self.config.runtime_supported() {
            return Err(JudgeError::Unsupported.into());
        }
        self.refresh_once();
        if self.is_installing() {
            return Err(JudgeError::Installing.into());
        }
        match available_on(self.lanes.read, &self.config).await {
            Ok(true) => {}
            Ok(false) => return Err(JudgeError::NotInstalled(self.config.dir.display().to_string()).into()),
            Err(error) => return Err(JudgeError::Run(error.to_string()).into()),
        }
        let unloaded_before = self.idle.retired.load(Ordering::Acquire);
        if !self.is_ready() {
            if let Some(why) = self.recent_load_failure(timing.retry) {
                return Err(JudgeError::Load(why).into());
            }
            // A model that has loaded before and was unloaded for being idle is waited for longer.
            let wait = if self.idle.loaded_before.load(Ordering::Acquire) { timing.cold.max(RELOAD_WAIT) } else { timing.cold };
            self.touch_idle();
            let cold = deadline(&*self.alarm, wait);
            let (done_tx, done_rx) = oneshot::channel();
            let this = self.clone();
            // A load outlives the cold wait that gave up on it (a big model takes longer than that);
            // only the judge's own shutdown ends it.
            let load_cancel = self.cancel.clone();
            mixdog_rt::spawn("services.effort-judge.turn-load", TaskClass::Work, async move {
                drop(done_tx.send(this.load_for_turn(timing.retry, &load_cancel).await));
            });
            let loaded = tokio::select! {
                biased;
                loaded = done_rx => Some(loaded),
                () = cold => None,
            };
            match loaded {
                Some(Ok(Ok(()))) => {}
                Some(Ok(Err(error @ (JudgeError::NotInstalled(_) | JudgeError::Installing | JudgeError::Unsupported)))) => return Err(error.into()),
                // Node's `waitReady` answered false: the wait ran out, the load failed or the worker
                // was ended (`:351-352`).
                _ => {
                    let why = self.last_error();
                    return Err(if why.is_empty() { JudgeError::Warming } else { JudgeError::Load(raw_load_message(&why).to_owned()) }.into());
                }
            }
        } else {
            self.touch_idle();
        }
        let exited = || {
            if self.idle.retired.load(Ordering::Acquire) > unloaded_before { Stop::Retry } else { Stop::Fail(JudgeError::Worker(EXITED.to_owned())) }
        };
        // Node's `target`: the thread whose model is ready as the judgment arrives.
        let Some(Ok(target)) = self.loaded() else { return Err(exited()) };
        let queue = deadline(&*self.alarm, timing.queue);
        // The place in the queue is taken on the first poll, in arrival order; a judgment that is
        // still waiting when the queue wait runs out leaves the queue unsent (Node's `abandoned`).
        let entered = tokio::select! {
            biased;
            entered = self.turn.enter(&self.cancel) => entered,
            () = queue => return Err(JudgeError::Busy.into()),
        };
        let Ok(turn) = entered else { return Err(JudgeError::Worker(EXITED.to_owned()).into()) };
        // A thread let go while the judgment waited: Node's `worker !== target || !ready`.
        if !matches!(self.loaded(), Some(Ok(generation)) if generation == target) {
            return Err(exited());
        }
        let warm = deadline(&*self.alarm, timing.warm);
        let began = std::time::Instant::now();
        let (result_tx, result_rx) = oneshot::channel();
        let this = self.clone();
        let asked = ask.clone();
        let job = move |seat: &mut Seat| match &*asked {
            Ask::Turn(input) => resident(seat)?.turn_probs(&clip_turn(input)),
            Ask::Step(input) => resident(seat)?.probs(input),
        };
        // Sent, the judgment holds the queue until its thread answers or is let go, whether or not
        // its caller still waits: Node sends the next request only then (`queueTail`, `:360`).
        mixdog_rt::spawn("services.effort-judge.judgment", TaskClass::Work, async move {
            let answer = this.worker.judge(target, job).await.and_then(|probs| probs);
            // A host that died under the request is gone: the next request starts a fresh one, now,
            // not when its exit is noticed.
            if matches!(answer, Err(JudgeError::Worker(_))) {
                this.let_go_thread(target);
            }
            // The queue is free before the caller has its answer: whoever sees the answer sees a judge
            // with nothing in flight (the idle period reads the queue).
            drop(turn);
            drop(result_tx.send(answer));
        });
        let answer = tokio::select! {
            biased;
            answer = result_rx => answer,
            () = warm => return Err(JudgeError::Timeout.into()),
        };
        match answer.map_err(|_| JudgeError::Worker(EXITED.to_owned())).and_then(|answer| answer) {
            Ok(probs) => Ok((probs, u64::try_from(began.elapsed().as_millis()).unwrap_or(u64::MAX))),
            Err(JudgeError::Worker(_)) => Err(exited()),
            Err(error) => Err(error.into()),
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
    async fn load_for_turn(self: &Arc<Self>, retry: Duration, cancel: &CancellationToken) -> Result<(), JudgeError> {
        let mut load_failure = None;
        let loaded = self
            .turn
            .run(cancel, async {
                if self.is_installing() {
                    return Err(JudgeError::Installing);
                }
                let failed = *self.failed_at.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                {
                    let mut state = self.model_state();
                    if matches!(*state, Some(Err(_))) && failed.is_none_or(|at| at.elapsed() >= retry) {
                        *state = None;
                    }
                }
                match self.ensure_loaded().await {
                    Ok(_) => Ok(()),
                    Err(error) => {
                        load_failure = Some(error.clone());
                        Err(error)
                    }
                }
            })
            .await
            .map_err(|_| JudgeError::Cancelled)?;
        if let Some(error) = &load_failure {
            self.repair_after_load_failure(error);
        }
        loaded
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
                    available_on(this.lanes.bulk, &this.config).await? && install::install_current_on(this.lanes.bulk, &this.config.dir, &this.manifest).await?,
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
        if !self.config.runtime_supported() || self.is_installing() {
            return false;
        }
        if !available_on(self.lanes.read, &self.config).await.unwrap_or(false) {
            // A lane that could not read it answers "not now"; the next prewarm asks again.
            return false;
        }
        self.touch_idle();
        // A judgment or a load holds the gate: it is loaded or loading.
        if self.turn.is_busy() {
            return true;
        }
        let resident = self.loaded().as_ref().map(Result::is_ok);
        match resident {
            Some(ok) => ok,
            None => {
                let this = self.clone();
                mixdog_rt::spawn("services.effort-judge.prewarm", TaskClass::Work, async move {
                    // A cancelled gate means the instance's background work was ended: no model is
                    // wanted, and nothing awaits this task's result.
                    let _ = this
                        .turn
                        .run(&this.cancel, async {
                            if !this.is_installing() {
                                let _ = this.ensure_loaded().await;
                            }
                        })
                        .await;
                });
                true
            }
        }
    }

    /// `shutdownEffortJudge()`: unloads the model; the next judgment loads it again.
    pub async fn shutdown(&self) {
        // Not behind the gate, and nothing waits for the thread: a running judgment or load must
        // not hold the exit. The running judgment answers "effort judge exited" as Node's terminated
        // worker's does; judgments queued behind it find no target and answer the same.
        self.let_go();
        self.tick.bump();
    }

    /// Runs `work` with no model loaded and judgments answering `Installing`,
    /// then lets the next judgment load whatever the files now hold.
    async fn replacing_files<T, F>(&self, cancel: &CancellationToken, work: F) -> Result<T, InstallError>
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
        // The loaded session maps the file the install is about to replace: wait out the judgment
        // that uses it (judgments now answer `Installing`), but only as long as `cancel` allows.
        {
            let _idle = self.turn.enter(cancel).await.map_err(|_| InstallError::Cancelled)?;
            // Node's `runInstall` shuts the worker down (`if (worker) await shutdownEffortJudge()`).
            self.let_go();
        }
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
        self.replacing_files(cancel, install::ensure_installed(&self.config, manifest, self.lanes.bulk, progress, cancel)).await
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
        let bad = install::invalidate_damaged(&self.config.dir, manifest, self.lanes.bulk).await?;
        if !bad.is_empty() {
            self.replacing_files(cancel, install::install_model(&self.config.dir, manifest, self.lanes.bulk, progress, cancel)).await?;
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
