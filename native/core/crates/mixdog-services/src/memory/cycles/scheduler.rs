//! `cycle-scheduler.mjs` and `cycle-scheduler/`: the cycle1 outer coalesce layer (one in-flight
//! run shared by every caller, caller deadlines), the scheduled enqueue, the backlog probe and the
//! 60-second self-rescheduling tick.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use mixdog_rt::MaintenanceIo;
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::ledger::Ledger;
use super::requests::{RetryRunner, claim_and_mark_scheduled_cycle, resolve_coalesce_max_retries, spawn_work};
use super::rows::{cycle1_row_due_sql, cycle1_unchunked_sql};
use super::run::{Cycle1Options, Cycle1Result, Cycle1Runner};
use super::signature::{number_or_zero, parse_interval, periodic_cycle_due, scheduled_cycle1_signature};
use super::{Cycle1Llm, CycleConfig, CycleEmbeddings, log};
use crate::memory::error::{MemoryError, Result};
use crate::memory::ingest::NowMs;
use crate::memory::pg::db::Db;
use crate::memory::schema::get_meta;

const TICK: Duration = Duration::from_secs(60);
const CYCLE_LAST_RUN_KEY: &str = "state.cycle_last_run";
const BACKLOG_WARN_PENDING: i64 = 500;

type Shared1 = Shared<BoxFuture<'static, std::result::Result<Cycle1Result, String>>>;

/// `getCycleLastRun`'s answer.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CycleLastRun {
    pub cycle1: f64,
    pub cycle1_heartbeat: f64,
}

struct Tick {
    active: bool,
    started_at: i64,
    stop: Option<CancellationToken>,
    task: Option<JoinHandle<()>>,
}

struct Inner {
    db: Db,
    runner: Arc<Cycle1Runner>,
    ledger: Arc<Ledger>,
    config: Arc<dyn CycleConfig>,
    embeddings: Arc<dyn CycleEmbeddings>,
    now: NowMs,
    tick_every: Duration,
    /// `mainConfig`: the memory section as the last tick read it.
    main_config: Mutex<Value>,
    in_flight: Mutex<Option<(u64, Shared1)>>,
    next_run: Mutex<u64>,
    tick: Mutex<Tick>,
    checking: AtomicBool,
    flushing: AtomicBool,
    /// Cancelled on shutdown: stops runs this scheduler started.
    shutdown: CancellationToken,
}

#[derive(Clone)]
pub struct CycleScheduler(Arc<Inner>);

/// Where the scheduler's pieces come from.
pub struct SchedulerDeps {
    pub db: Db,
    pub llm: Arc<dyn Cycle1Llm>,
    pub embeddings: Arc<dyn CycleEmbeddings>,
    pub config: Arc<dyn CycleConfig>,
    /// `memory-cycle-state.json`.
    pub state_file: PathBuf,
    pub lane: MaintenanceIo,
    pub now: NowMs,
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

impl CycleScheduler {
    pub fn new(deps: SchedulerDeps) -> Self {
        let SchedulerDeps { db, llm, embeddings, config, state_file, lane, now } = deps;
        let runner = Cycle1Runner::new(db.clone(), llm, Arc::clone(&embeddings), Arc::clone(&config), Arc::clone(&now));
        let ledger = Arc::new(Ledger::new(state_file, lane, Arc::clone(&now)));
        Self(Arc::new(Inner {
            db,
            runner,
            ledger,
            config,
            embeddings,
            now,
            tick_every: TICK,
            main_config: Mutex::new(Value::Null),
            in_flight: Mutex::new(None),
            next_run: Mutex::new(0),
            tick: Mutex::new(Tick { active: false, started_at: 0, stop: None, task: None }),
            checking: AtomicBool::new(false),
            flushing: AtomicBool::new(false),
            shutdown: CancellationToken::new(),
        }))
    }

    /// A scheduler whose tick runs every `every` instead of every minute.
    pub fn with_tick(self, every: Duration) -> Self {
        let inner = Arc::try_unwrap(self.0).unwrap_or_else(|_| panic!("with_tick runs before the scheduler is shared"));
        Self(Arc::new(Inner { tick_every: every, ..inner }))
    }

    pub fn ledger(&self) -> &Arc<Ledger> {
        &self.0.ledger
    }

    pub fn runner(&self) -> &Arc<Cycle1Runner> {
        &self.0.runner
    }

    /// `getCycle1InFlight`.
    pub fn is_cycle1_running(&self) -> bool {
        self.0.in_flight.lock().expect("in flight").is_some()
    }

    /// `startCycles`: the first tick comes a minute from now.
    pub async fn start_cycles(&self) {
        let inner = &self.0;
        let stop = {
            let mut tick = inner.tick.lock().expect("tick");
            if tick.active {
                return;
            }
            tick.active = true;
            tick.started_at = (inner.now)();
            let stop = CancellationToken::new();
            tick.stop = Some(stop.clone());
            stop
        };
        // A daemon that crashed mid-run leaves the marker set; no cycle can be running now.
        inner.ledger.reset_running();
        inner.ledger.write().await;
        let hydrate = Arc::clone(inner);
        spawn_work("memory-cycle-hydrate", async move {
            let last = hydrate.last_run().await;
            hydrate.ledger.hydrate_success(last.cycle1).await;
        });
        let looped = Arc::clone(inner);
        let task = spawn_work("memory-cycle-tick", async move {
            loop {
                tokio::select! {
                    () = stop.cancelled() => break,
                    () = tokio::time::sleep(looped.tick_every) => {}
                }
                looped.run_check_guarded().await;
                if !looped.tick.lock().expect("tick").active {
                    break;
                }
            }
        });
        inner.tick.lock().expect("tick").task = Some(task);
    }

    /// `stopCycles`: the tick stops and waiting retries are cancelled; a run in progress finishes.
    pub fn stop_cycles(&self) {
        let mut tick = self.0.tick.lock().expect("tick");
        tick.active = false;
        if let Some(stop) = tick.stop.take() {
            stop.cancel();
        }
        drop(tick);
        self.0.runner.retries().cancel_all();
    }

    /// Daemon shutdown: [`Self::stop_cycles`], then the run in progress is cancelled and awaited.
    pub async fn shutdown(&self) {
        self.stop_cycles();
        self.0.shutdown.cancel();
        let task = self.0.tick.lock().expect("tick").task.take();
        if let Some(task) = task {
            let _ = task.await;
        }
        let running = self.0.in_flight.lock().expect("in flight").as_ref().map(|(_, run)| run.clone());
        if let Some(run) = running {
            let _ = run.await;
        }
    }

    /// `resetInFlight`: a later start begins from a clean slate.
    pub fn reset_in_flight(&self) {
        *self.0.in_flight.lock().expect("in flight") = None;
        self.0.flushing.store(false, Ordering::SeqCst);
        self.0.checking.store(false, Ordering::SeqCst);
        self.0.tick.lock().expect("tick").started_at = 0;
        self.0.ledger.reset_running();
    }

    /// `checkCycles`.
    pub async fn check_cycles(&self) -> Result<()> {
        self.0.check_cycles().await
    }

    /// `periodicCycle1Config`.
    pub fn periodic_cycle1_config(&self) -> Value {
        self.0.periodic_cycle1_config()
    }

    /// `startCycle1Run`.
    pub fn start_cycle1_run(&self, config: Value, options: Cycle1Options) -> Shared1 {
        Arc::clone(&self.0).start_run(config, options)
    }

    /// `awaitCycle1Run`: the run in flight or a new one; a caller deadline hands back the
    /// skipped marker instead of waiting out a long run.
    pub async fn await_cycle1_run(&self, config: Value, options: Cycle1Options) -> Result<Cycle1Result> {
        Arc::clone(&self.0).await_run(config, options).await
    }
}

fn run_failure(message: String) -> MemoryError {
    MemoryError::Runtime(message)
}

impl Inner {
    async fn last_run(&self) -> CycleLastRun {
        match get_meta(&self.db, CYCLE_LAST_RUN_KEY).await {
            Ok(value) => {
                let obj = value.unwrap_or_else(|| json!({}));
                CycleLastRun { cycle1: number_or_zero(obj.get("cycle1")), cycle1_heartbeat: number_or_zero(obj.get("cycle1_heartbeat")) }
            }
            Err(_) => CycleLastRun::default(),
        }
    }

    /// `setCycleLastRun`: a shallow merge into the run-times row.
    async fn set_last_run(&self, kind: &str, ts: i64) -> Result<()> {
        let patch = Value::Object(Map::from_iter([(kind.to_owned(), json!(ts))]));
        self.db
            .execute(
                "INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value = COALESCE(meta.value, '{}'::jsonb) || EXCLUDED.value",
                &[&CYCLE_LAST_RUN_KEY, &patch],
            )
            .await?;
        Ok(())
    }

    fn periodic_cycle1_config(&self) -> Value {
        let mut config = json!({"min_batch": 20, "session_cap": 4, "batch_size": 50, "max_packets": 4, "concurrency": 4});
        let current = self.main_config.lock().expect("main config").get("cycle1").cloned();
        if let (Some(Value::Object(extra)), Value::Object(base)) = (current, &mut config) {
            base.extend(extra);
        }
        config
    }

    /// `recordCycle1Result`.
    async fn record_result(&self, result: &Cycle1Result) -> Result<()> {
        let now = (self.now)();
        self.set_last_run("cycle1_heartbeat", now).await?;
        let skipped = result.skipped_in_flight;
        let all_failed = !skipped && result.chunks == 0 && result.processed == 0 && result.skipped > 0;
        if !skipped && !result.coalesced_retry_noop && !all_failed {
            self.set_last_run("cycle1", now).await?;
        }
        if !skipped && !result.coalesced_retry_noop {
            self.ledger.mark_done("cycle1", !all_failed, all_failed.then_some("all rows skipped")).await;
        }
        Ok(())
    }

    fn start_run(self: Arc<Self>, config: Value, mut options: Cycle1Options) -> Shared1 {
        let id = {
            let mut next = self.next_run.lock().expect("run ids");
            *next += 1;
            *next
        };
        // A run ends with the scheduler.
        options.cancel = self.shutdown.child_token();
        let this = Arc::clone(&self);
        let scheduled_record = options.on_coalesced_success.is_some();
        // The run waits to be registered, so it never clears a slot before it holds it.
        let (registered, wait_registered) = tokio::sync::oneshot::channel::<()>();
        let task = spawn_work_value("memory-cycle1-run", async move {
            let _ = wait_registered.await;
            this.ledger.mark_running("cycle1").await;
            let ran = this.runner.clone().run_cycle1(config, options).await;
            let outcome = match ran {
                Ok(result) => {
                    // A coalesced (scheduled) run records its own result through its callback.
                    let recorded = if scheduled_record { Ok(()) } else { this.record_result(&result).await };
                    recorded.map(|()| result)
                }
                Err(error) => Err(error),
            };
            let outcome = match outcome {
                Ok(result) => Ok(result),
                Err(error) => {
                    this.ledger.mark_done("cycle1", false, Some(&error.message())).await;
                    Err(error.message())
                }
            };
            this.ledger.clear_running("cycle1").await;
            let mut slot = this.in_flight.lock().expect("in flight");
            if slot.as_ref().is_some_and(|(held, _)| *held == id) {
                *slot = None;
            }
            outcome
        });
        let shared: Shared1 = async move { task.await.unwrap_or_else(|e| Err(e.to_string())) }.boxed().shared();
        *self.in_flight.lock().expect("in flight") = Some((id, shared.clone()));
        let _ = registered.send(());
        shared
    }

    async fn await_run(self: Arc<Self>, config: Value, options: Cycle1Options) -> Result<Cycle1Result> {
        let in_flight = self.in_flight.lock().expect("in flight").as_ref().map(|(_, run)| run.clone());
        let deadline = options.plan.caller_deadline_ms.map_or(0.0, |n| if n.is_nan() { 0.0 } else { n });
        let target = in_flight.unwrap_or_else(|| Arc::clone(&self).start_run(config, options));
        if deadline <= 0.0 {
            return target.await.map_err(run_failure);
        }
        tokio::select! {
            outcome = target => outcome.map_err(run_failure),
            () = tokio::time::sleep(Duration::from_millis(deadline as u64)) => Ok(Cycle1Result::timed_out(deadline)),
        }
    }

    /// `scheduleScheduledCycle1`: the retry that re-arms while a run is still in flight.
    fn schedule_scheduled(self: &Arc<Self>, config: &Value, signature: &str, attempt: f64) {
        let max_retries = resolve_coalesce_max_retries(config, 3.0);
        if attempt > max_retries {
            log("[cycle1] scheduled queue retry cap reached\n");
            return;
        }
        let (this, retry_config, retry_signature) = (Arc::clone(self), config.clone(), signature.to_owned());
        let job: RetryRunner = Box::new(move || {
            Box::pin(async move {
                if !this.config.cycles_enabled() {
                    return Ok(());
                }
                if this.in_flight.lock().expect("in flight").is_some() {
                    this.schedule_scheduled(&retry_config, &retry_signature, attempt + 1.0);
                    return Ok(());
                }
                let recorder = Arc::clone(&this);
                let options = Cycle1Options {
                    coalesced_retry: true,
                    on_coalesced_success: Some(Arc::new(move |result: Cycle1Result| {
                        let recorder = Arc::clone(&recorder);
                        Box::pin(async move { recorder.record_result(&result).await.map_err(|e| e.message()) })
                    })),
                    ..Cycle1Options::default()
                };
                let result = Arc::clone(&this).await_run(retry_config.clone(), options).await.map_err(|e| e.message())?;
                if result.skipped_in_flight {
                    this.schedule_scheduled(&retry_config, &retry_signature, attempt + 1.0);
                }
                Ok(())
            })
        });
        if let Err(error) = self.runner.retries().schedule("cycle1", signature, config, job) {
            log(&format!("[cycle1] retry not scheduled: {}\n", error.message()));
        }
    }

    /// `enqueueScheduledCycle1`.
    async fn enqueue_scheduled(self: &Arc<Self>, interval_ms: f64) {
        let config = self.periodic_cycle1_config();
        let signature = scheduled_cycle1_signature(&config);
        let timeout = number_or_zero(config.get("timeout"));
        let timeout = if timeout > 0.0 { timeout } else { 600_000.0 };
        let lease = interval_ms.min(60_000f64.max(timeout + 60_000.0));
        let claim = claim_and_mark_scheduled_cycle(&self.db, "cycle1", interval_ms, &signature, "scheduled", Some(lease), (self.now)()).await;
        if claim.claimed {
            self.schedule_scheduled(&config, &signature, 0.0);
        }
    }

    /// `backlog-probe`: the unchunked counts for the state file and the warning, and the raw
    /// embedding flush while rows are unchunked. Never fails the tick.
    async fn probe_backlog(self: &Arc<Self>, now: i64) {
        let unchunked_sql = cycle1_unchunked_sql("");
        let counted = async {
            let unchunked: i64 = self.db.query(format!("SELECT COUNT(*) c FROM entries WHERE {unchunked_sql}").as_str(), &[]).await?[0].get(0);
            let eligible_sql = format!("SELECT COUNT(*) c FROM entries\n         WHERE {unchunked_sql}\n           AND {}", cycle1_row_due_sql("$1", ""));
            let eligible: i64 = self.db.query(eligible_sql.as_str(), &[&now]).await?[0].get(0);
            Ok::<_, MemoryError>((unchunked, eligible))
        };
        let Ok((unchunked, eligible)) = counted.await else { return };
        self.ledger.set_backlog(json!({"unchunked": unchunked, "unchunked_eligible": eligible, "at": now})).await;
        if unchunked > BACKLOG_WARN_PENDING {
            self.ledger.warn(&format!("backlog unchunked={unchunked} eligible={eligible}"));
        }
        if unchunked > 0 {
            self.flush_raw_once();
        }
    }

    fn flush_raw_once(self: &Arc<Self>) {
        if self.flushing.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = Arc::clone(self);
        spawn_work("memory-cycle-raw-flush", async move {
            match this.embeddings.flush_raw(200).await {
                Ok((attempted, embedded)) if attempted > 0 => log(&format!("[embed] raw fallback flush attempted={attempted} embedded={embedded}\n")),
                Ok(_) => {}
                Err(error) => log(&format!("[embed] raw fallback flush failed: {error}\n")),
            }
            this.flushing.store(false, Ordering::SeqCst);
        });
    }

    async fn check_cycles(self: &Arc<Self>) -> Result<()> {
        let main = self.config.memory_section();
        *self.main_config.lock().expect("main config") = main.clone();
        let cycles_on = self.config.cycles_enabled();
        let interval = main.get("cycle1").and_then(|c| c.get("interval")).filter(|v| truthy(Some(v))).cloned().unwrap_or_else(|| json!("10m"));
        let cycle1_ms = parse_interval(&interval)?;
        let now = (self.now)();
        let last = self.last_run().await;
        let started_at = self.tick.lock().expect("tick").started_at;
        if cycles_on && periodic_cycle_due(last.cycle1, started_at as f64, cycle1_ms, now as f64) {
            self.enqueue_scheduled(cycle1_ms).await;
        }
        self.probe_backlog(now).await;
        Ok(())
    }

    async fn run_check_guarded(self: &Arc<Self>) {
        if self.checking.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Err(error) = self.check_cycles().await {
            log(&format!("[cycle-tick] error: {}\n", error.message()));
        }
        self.checking.store(false, Ordering::SeqCst);
    }
}

fn spawn_work_value<T: Send + 'static>(name: &'static str, fut: impl std::future::Future<Output = T> + Send + 'static) -> JoinHandle<T> {
    mixdog_rt::spawn(name, mixdog_rt::TaskClass::Work, fut)
}
