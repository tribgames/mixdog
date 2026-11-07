//! The code-graph prewarm timer (`session-runtime/prewarm/code-graph-prewarm.mjs`, with the
//! `warmup/timer-arm.mjs` discipline): one pending warm per cwd, upgraded by the first visible
//! provider token, parked while a turn or a session create is busy and woken when that settles, and
//! started for a cwd queued mid-flight when the running warm ends. The warm itself is
//! `CodeGraphTool::prewarm_if_project`; nothing here polls.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use tokio::task::JoinHandle;

/// What the timer reads of the runtime and the one thing it starts.
#[async_trait]
pub trait PrewarmWorld: Send + Sync {
    /// `codeGraphPrewarmEnabled` (`MIXDOG_DISABLE_CODE_GRAPH_PREWARM` unset).
    fn enabled(&self) -> bool;
    /// `codeGraphPrewarmDelayMs` (`MIXDOG_CODE_GRAPH_PREWARM_DELAY_MS`, 250 by default).
    fn delay(&self) -> Duration;
    fn close_requested(&self) -> bool;
    /// `busyReason()`: `turn-active` while a turn runs, `session-create` while one is being created.
    fn busy(&self) -> Option<&'static str>;
    /// `getCurrentCwd()`.
    fn current_cwd(&self) -> String;
    /// `prewarmCodeGraphIfProject(cwd)`; `Err` is a build that failed to start.
    async fn prewarm(&self, cwd: &str) -> Result<bool, String>;
    /// `bootProfile(event, detail)`.
    fn profile(&self, event: &str, detail: &str);
}

#[derive(Default)]
struct State {
    /// The cwd a warm is wanted for (`codeGraphPrewarmQueuedCwd`).
    queued_cwd: String,
    in_flight: bool,
    timer: Option<JoinHandle<()>>,
    /// The reason of a warm held until the runtime is idle (`parked`).
    parked: Option<&'static str>,
}

pub struct CodeGraphPrewarm {
    world: Arc<dyn PrewarmWorld>,
    state: Mutex<State>,
}

impl CodeGraphPrewarm {
    pub fn new(world: Arc<dyn PrewarmWorld>) -> Arc<Self> {
        Arc::new(Self { world, state: Mutex::default() })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `arm(key, delay, run)`: the timer unless one is pending or the runtime is closing.
    fn arm(self: &Arc<Self>, delay: Duration, reason: &'static str) {
        if self.world.close_requested() {
            return;
        }
        let mut state = self.state();
        if state.timer.as_ref().is_some_and(|timer| !timer.is_finished()) {
            return;
        }
        let this = Arc::clone(self);
        state.timer = Some(tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            this.state().timer = None;
            if !this.world.close_requested() {
                this.on_timer(reason);
            }
        }));
    }

    /// `scheduleCodeGraphPrewarm(delayMs, reason)`.
    pub fn schedule(self: &Arc<Self>, delay: Option<Duration>, reason: &'static str) {
        if !self.world.enabled() {
            self.world.profile("code-graph:prewarm-skipped", "disabled");
            return;
        }
        if self.world.close_requested() {
            return;
        }
        let cwd = self.world.current_cwd();
        {
            let mut state = self.state();
            state.queued_cwd = cwd;
            if state.timer.as_ref().is_some_and(|timer| !timer.is_finished()) {
                // Upgrade a pending idle/cwd warm when the first visible provider token arrives: the
                // older timer would keep its non-overlap reason and defer the graph past the turn.
                if reason != "first-visible" {
                    return;
                }
                if let Some(timer) = state.timer.take() {
                    timer.abort();
                }
            }
        }
        self.arm(delay.unwrap_or_else(|| self.world.delay()), reason);
    }

    /// The busy state changed (a turn ended, a session create settled): a parked warm re-checks once.
    pub fn wake(self: &Arc<Self>) {
        let parked = self.state().parked.take();
        if let Some(reason) = parked {
            self.arm(Duration::ZERO, reason);
        }
    }

    fn on_timer(self: &Arc<Self>, reason: &'static str) {
        let busy = self.world.busy();
        // `first-visible` is armed after the first token: that warm may overlap the turn's remaining
        // generation instead of waiting until it ends.
        let overlaps = reason == "first-visible";
        if (busy == Some("turn-active") && !overlaps) || busy == Some("session-create") {
            self.world.profile("code-graph:prewarm-deferred", busy.unwrap_or_default());
            self.state().parked = Some(reason);
            return;
        }
        // The running warm's end starts the cwd queued meanwhile.
        if self.state().in_flight {
            self.world.profile("code-graph:prewarm-deferred", "in-flight");
            return;
        }
        self.run(reason);
    }

    fn run(self: &Arc<Self>, reason: &'static str) {
        let cwd = {
            let mut state = self.state();
            let queued = std::mem::take(&mut state.queued_cwd);
            state.in_flight = true;
            if queued.is_empty() { self.world.current_cwd() } else { queued }
        };
        self.world.profile("code-graph:prewarm:start", &format!("{cwd} ({reason})"));
        let this = Arc::clone(self);
        drop(tokio::spawn(async move {
            match this.world.prewarm(&cwd).await {
                Ok(true) => this.world.profile("code-graph:prewarm:scheduled", &cwd),
                Ok(false) => this.world.profile("code-graph:prewarm:no-project", &cwd),
                Err(error) => this.world.profile("code-graph:prewarm:failed", &format!("{cwd}: {error}")),
            }
            let queued = {
                let mut state = this.state();
                state.in_flight = false;
                !state.queued_cwd.is_empty()
            };
            if queued && !this.world.close_requested() {
                this.schedule(Some(Duration::ZERO), "queued");
            }
        }));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use super::*;

    #[derive(Default)]
    struct World {
        busy: Mutex<Option<&'static str>>,
        cwd: Mutex<String>,
        warmed: Mutex<Vec<String>>,
        closing: AtomicBool,
        disabled: AtomicBool,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl PrewarmWorld for World {
        fn enabled(&self) -> bool {
            !self.disabled.load(Ordering::SeqCst)
        }
        fn delay(&self) -> Duration {
            Duration::from_millis(250)
        }
        fn close_requested(&self) -> bool {
            self.closing.load(Ordering::SeqCst)
        }
        fn busy(&self) -> Option<&'static str> {
            *self.busy.lock().unwrap()
        }
        fn current_cwd(&self) -> String {
            self.cwd.lock().unwrap().clone()
        }
        async fn prewarm(&self, cwd: &str) -> Result<bool, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.warmed.lock().unwrap().push(cwd.to_owned());
            Ok(true)
        }
        fn profile(&self, _: &str, _: &str) {}
    }

    fn rig(cwd: &str) -> (Arc<World>, Arc<CodeGraphPrewarm>) {
        let world = Arc::new(World::default());
        *world.cwd.lock().unwrap() = cwd.to_owned();
        (world.clone(), CodeGraphPrewarm::new(world))
    }

    async fn settle() {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn one_warm_per_cwd_runs_after_the_delay() {
        let (world, prewarm) = rig("/a");
        prewarm.schedule(None, "cwd");
        prewarm.schedule(None, "cwd");
        tokio::time::sleep(Duration::from_millis(249)).await;
        assert_eq!(world.calls.load(Ordering::SeqCst), 0);
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert_eq!(*world.warmed.lock().unwrap(), ["/a"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_busy_turn_parks_the_warm_until_it_is_woken() {
        let (world, prewarm) = rig("/a");
        *world.busy.lock().unwrap() = Some("turn-active");
        prewarm.schedule(Some(Duration::ZERO), "cwd");
        settle().await;
        assert_eq!(world.calls.load(Ordering::SeqCst), 0, "parked, not retried by polling");
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(world.calls.load(Ordering::SeqCst), 0);
        *world.busy.lock().unwrap() = None;
        prewarm.wake();
        settle().await;
        assert_eq!(world.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn the_first_visible_token_upgrades_a_pending_warm_and_may_overlap_the_turn() {
        let (world, prewarm) = rig("/a");
        *world.busy.lock().unwrap() = Some("turn-active");
        prewarm.schedule(None, "cwd");
        prewarm.schedule(Some(Duration::ZERO), "first-visible");
        settle().await;
        assert_eq!(world.calls.load(Ordering::SeqCst), 1, "overlaps the active turn");
    }

    #[tokio::test(start_paused = true)]
    async fn the_latest_cwd_wins_while_a_warm_is_pending() {
        let (world, prewarm) = rig("/a");
        prewarm.schedule(None, "cwd");
        *world.cwd.lock().unwrap() = "/b".to_owned();
        prewarm.schedule(None, "cwd");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(*world.warmed.lock().unwrap(), ["/b"], "one warm, for the cwd queued last");
    }

    #[tokio::test(start_paused = true)]
    async fn a_disabled_or_closing_runtime_warms_nothing() {
        let (world, prewarm) = rig("/a");
        world.disabled.store(true, Ordering::SeqCst);
        prewarm.schedule(Some(Duration::ZERO), "cwd");
        world.disabled.store(false, Ordering::SeqCst);
        world.closing.store(true, Ordering::SeqCst);
        prewarm.schedule(Some(Duration::ZERO), "cwd");
        settle().await;
        assert_eq!(world.calls.load(Ordering::SeqCst), 0);
    }
}
