//! The prompt-cache warm chain of a session: which requests may be warmed, what arms a chain, what a warm re-sends and
//! bills, and every way a chain ends (a miss, a failure, a turn, a new request, the setting, the idle history).
//! Time and timers are a scripted clock; the stores are real files in a temporary directory.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use futures::future::BoxFuture;
use mixdog_ai::warmer::Warmer;
use mixdog_ai::warmer::chain::ArmResponse;
use mixdog_ai::warmer::chain::TimerHandle;
use mixdog_ai::warmer::chain::WarmDeps;
use mixdog_ai::warmer::chain::WarmRequest;
use mixdog_ai::warmer::chain::WarmTarget;
use mixdog_ai::warmer::chain::WarmTimers;
use mixdog_ai::warmer::chain::ineligibility;
use mixdog_ai::warmer::plan::CacheStrategy;
use mixdog_ai::warmer::plan::IDLE_RETURN_LOOKBACK_MS;
use mixdog_ai::warmer::plan::IDLE_RETURN_WINDOW_MS;
use mixdog_ai::warmer::plan::Prices;
use mixdog_ai::warmer::plan::TurnKind;
use mixdog_ai::warmer::plan::warm_delay_ms;
use mixdog_ai::warmer::stores::GapRules;
use mixdog_ai::warmer::stores::GapStore;
use mixdog_ai::warmer::stores::Touch;
use mixdog_ai::warmer::stores::TouchStore;
use mixdog_ai::warmer::stream::WarmFailure;
use mixdog_ai::warmer::stream::WarmUsage;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use tokio_util::sync::CancellationToken;

const T0: f64 = 4_000_000_000_000.0;
const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MINUTE;
/// A warm goes out a minute before a one-hour entry expires.
const REFRESH: f64 = HOUR - MINUTE;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---- the request -------------------------------------------------------------------------------------------------------

#[derive(Clone)]
struct Req {
    provider: &'static str,
    model: &'static str,
    session: &'static str,
    sent_at: f64,
    kind: Option<&'static str>,
    strategy: Option<CacheStrategy>,
    thinking: f64,
    effort: bool,
    levels_empty: bool,
    warm_mode: bool,
}

fn one_hour_strategy() -> Option<CacheStrategy> {
    Some(CacheStrategy { tools: None, system: Some("1h".into()), tier3: Some("1h".into()), messages: Some("1h".into()) })
}

impl Default for Req {
    fn default() -> Self {
        Self {
            provider: "anthropic-oauth",
            model: "claude-opus-4-7",
            session: "s1",
            sent_at: T0,
            kind: None,
            strategy: one_hour_strategy(),
            thinking: 0.0,
            effort: false,
            levels_empty: false,
            warm_mode: true,
        }
    }
}

impl WarmRequest for Req {
    fn provider_name(&self) -> &str {
        self.provider
    }
    fn model(&self) -> &str {
        self.model
    }
    fn session_id(&self) -> &str {
        self.session
    }
    fn sent_at(&self) -> f64 {
        self.sent_at
    }
    fn request_kind(&self) -> Option<&str> {
        self.kind
    }
    fn cache_strategy(&self) -> Option<CacheStrategy> {
        self.strategy.clone()
    }
    fn thinking_budget_tokens(&self) -> f64 {
        self.thinking
    }
    fn has_effort(&self) -> bool {
        self.effort
    }
    fn effort_levels_empty(&self) -> bool {
        self.levels_empty
    }
    fn has_warm_mode(&self) -> bool {
        self.warm_mode
    }
    fn fast(&self) -> bool {
        false
    }
    fn warm_request(&self) -> Result<ModelRequest, String> {
        Ok(ModelRequest { model: self.model.to_owned(), messages: Vec::new(), tools: Vec::new(), options: RequestOptions::default() })
    }
    fn provider_generation(&self) -> Option<u64> {
        None
    }
}

fn arc(req: Req) -> Arc<dyn WarmRequest> {
    Arc::new(req)
}

// ---- eligibility -------------------------------------------------------------------------------------------------------

#[test]
fn only_a_session_request_of_an_explicit_breakpoint_provider_with_an_expiring_tail_may_be_warmed() {
    assert_eq!(ineligibility(&Req::default()), None);
    assert_eq!(ineligibility(&Req { provider: "anthropic", ..Req::default() }), None);
    let reason = |req: Req| ineligibility(&req);
    assert_eq!(reason(Req { provider: "openai-oauth", ..Req::default() }), Some("provider caches without breakpoints"));
    assert_eq!(reason(Req { warm_mode: false, ..Req::default() }), Some("provider has no cache-warm mode"));
    assert_eq!(reason(Req { session: "", ..Req::default() }), Some("no session"));
    assert_eq!(reason(Req { thinking: 8000.0, ..Req::default() }), Some("thinking budget derives from max_tokens"));
    assert_eq!(reason(Req { effort: true, levels_empty: true, ..Req::default() }), Some("thinking budget derives from max_tokens"));
    assert_eq!(reason(Req { effort: true, levels_empty: false, ..Req::default() }), None);
    // The tail of the messages must be a tier that expires: none, or an unknown tier, has nothing to keep warm.
    assert_eq!(reason(Req { strategy: None, ..Req::default() }), Some("no expiring message-tail cache"));
    let tier = |messages: Option<&str>| Req { strategy: Some(CacheStrategy { messages: messages.map(str::to_owned), ..CacheStrategy::default() }), ..Req::default() };
    assert_eq!(reason(tier(Some("5m"))), None);
    assert_eq!(reason(tier(Some("forever"))), Some("no expiring message-tail cache"));
}

// ---- the scripted world -----------------------------------------------------------------------------------------------

struct Pending {
    id: u64,
    at: f64,
    task: Option<BoxFuture<'static, ()>>,
}

struct World {
    clock: Mutex<f64>,
    timers: Mutex<Vec<Pending>>,
    next_id: Mutex<u64>,
    /// `(delay, at)` of every timer set, and a mark for each timer cleared.
    timer_log: Mutex<Vec<String>>,
    log: Mutex<Vec<String>>,
    billed: Mutex<Vec<(f64, String)>>,
    sends: Mutex<Vec<(f64, String)>>,
}

impl World {
    fn now(&self) -> f64 {
        *lock(&self.clock)
    }

    fn set_now(&self, at: f64) {
        *lock(&self.clock) = at;
    }
}

struct Handle {
    id: u64,
    world: Arc<World>,
}

impl TimerHandle for Handle {
    fn cancel(&self) {
        let mut timers = lock(&self.world.timers);
        if let Some(at) = timers.iter().position(|t| t.id == self.id) {
            timers.remove(at);
            lock(&self.world.timer_log).push("cleared".into());
        }
    }
}

struct Timers(Arc<World>);

impl WarmTimers for Timers {
    fn schedule(&self, delay_ms: f64, task: BoxFuture<'static, ()>) -> Box<dyn TimerHandle> {
        let id = {
            let mut next = lock(&self.0.next_id);
            *next += 1;
            *next
        };
        let at = self.0.now() + delay_ms.max(0.0);
        lock(&self.0.timers).push(Pending { id, at, task: Some(task) });
        lock(&self.0.timer_log).push(format!("set +{} @{}", delay_ms.max(0.0) as i64, (at - T0) as i64));
        Box::new(Handle { id, world: self.0.clone() })
    }
}

/// What the next warm send does.
#[derive(Clone)]
enum Outcome {
    Read(f64),
    Usage { cached: f64, write: f64 },
    Fail(&'static str, Option<f64>),
}

struct Deps {
    world: Arc<World>,
    timers: Timers,
    enabled: Mutex<bool>,
    in_flight: Mutex<bool>,
    replaced: Mutex<bool>,
    last_sent: Mutex<Option<Arc<dyn WarmRequest>>>,
    script: Mutex<Vec<Outcome>>,
    prices: Mutex<Prices>,
}

#[async_trait]
impl WarmDeps for Deps {
    fn now(&self) -> f64 {
        self.world.now()
    }
    fn timers(&self) -> &dyn WarmTimers {
        &self.timers
    }
    async fn enabled(&self) -> bool {
        *lock(&self.enabled)
    }
    fn read_config_enabled(&self) -> bool {
        *lock(&self.enabled)
    }
    fn turn_in_flight(&self, _: &str) -> bool {
        *lock(&self.in_flight)
    }
    async fn last_sent_request(&self, _: &str) -> Result<Option<Arc<dyn WarmRequest>>, String> {
        Ok(lock(&self.last_sent).clone())
    }
    async fn providers_ready(&self) {}
    async fn provider_current(&self, _: &dyn WarmRequest) -> bool {
        !*lock(&self.replaced)
    }
    async fn prices(&self, _: &dyn WarmRequest, _: f64, _: f64) -> Result<Prices, String> {
        Ok(*lock(&self.prices))
    }
    async fn send(
        &self,
        request: &dyn WarmRequest,
        target: &WarmTarget,
        _: &CancellationToken,
        _: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure> {
        lock(&self.world.sends).push((self.world.now(), format!("{}:{}:{}", request.provider_name(), request.model(), target.account_id)));
        let step = {
            let mut script = lock(&self.script);
            if script.is_empty() { Outcome::Read(70_000.0) } else { script.remove(0) }
        };
        let usage = |cached: f64, write: f64| WarmUsage { input: 5.0, output: 1.0, output_known: true, cached, cache_write: write, ..WarmUsage::default() };
        match step {
            Outcome::Read(cached) => Ok(usage(cached, 0.0)),
            Outcome::Usage { cached, write } => Ok(usage(cached, write)),
            Outcome::Fail(message, billed) => Err(WarmFailure { message: message.to_owned(), error: None, usage: billed.map(|c| usage(c, 0.0)) }),
        }
    }
    async fn record_usage(&self, _: &dyn WarmRequest, usage: &WarmUsage, started_at: f64, account_id: &str) -> Result<(), String> {
        lock(&self.world.billed).push((started_at, format!("cached={} write={} account={account_id}", usage.cached, usage.cache_write)));
        Ok(())
    }
    fn log(&self, line: &str) {
        lock(&self.world.log).push(line.to_owned());
    }
}

struct Fixture {
    world: Arc<World>,
    deps: Arc<Deps>,
    warmer: Arc<Warmer>,
    touches: Arc<TouchStore>,
    gaps: Arc<GapStore>,
    dir: tempfile::TempDir,
}

/// Twenty returns, each after 2.5 hours idle: a session that comes back long after the first two warms are due.
fn long_returns(gaps: &GapStore) {
    for i in 0..20 {
        let at = T0 - 6.0 * HOUR * f64::from(i + 1);
        gaps.open_gap("s1", at);
        gaps.close("s1", at + 2.5 * HOUR);
    }
}

async fn fixture_with(history: impl FnOnce(&GapStore)) -> Fixture {
    let world = Arc::new(World {
        clock: Mutex::new(T0 + 1000.0),
        timers: Mutex::default(),
        next_id: Mutex::default(),
        timer_log: Mutex::default(),
        log: Mutex::default(),
        billed: Mutex::default(),
        sends: Mutex::default(),
    });
    let dir = tempfile::tempdir().unwrap();
    let io = mixdog_rt::testing::tokens().durability_io;
    let log: Arc<dyn Fn(&str) + Send + Sync> = {
        let world = world.clone();
        Arc::new(move |line| lock(&world.log).push(line.to_owned()))
    };
    // Touches expire against the wall clock of the write; the scripted times lie far ahead of it.
    let touches = Arc::new(TouchStore::open(dir.path().join("touches.json"), io, log.clone(), Arc::new(|| 1_800_000_000_000.0)).await.unwrap());
    let rules = GapRules { lookback_ms: IDLE_RETURN_LOOKBACK_MS, window_ms: IDLE_RETURN_WINDOW_MS, min_ms: warm_delay_ms(5.0 * MINUTE) };
    let gaps = Arc::new({
        let world = world.clone();
        GapStore::open(dir.path().join("gaps.json"), io, rules, log, Arc::new(move || world.now())).await.unwrap()
    });
    history(&gaps);
    let deps = Arc::new(Deps {
        world: world.clone(),
        timers: Timers(world.clone()),
        enabled: Mutex::new(true),
        in_flight: Mutex::new(false),
        replaced: Mutex::new(false),
        last_sent: Mutex::new(None),
        script: Mutex::default(),
        // Reading is cheap, rewriting costly: a warm of a 70k prompt costs 3.5 cents against a 40 cent miss.
        prices: Mutex::new(Prices { read: Some(0.5e-6), write: Some(6.25e-6), output: Some(25e-6) }),
    });
    let warmer = Warmer::new(deps.clone(), touches.clone(), gaps.clone());
    Fixture { world, deps, warmer, touches, gaps, dir }
}

async fn fixture() -> Fixture {
    fixture_with(long_returns).await
}

/// What a real request that wrote a one-hour entry of 70k tokens on `account` settled with.
fn wrote_one_hour(account: Option<&str>) -> ArmResponse {
    ArmResponse { input: 10.0, cached: 0.0, cache_write: 69_990.0, tail_ttl_ms: Some(HOUR), prompt_tokens: None, account_id: account.map(str::to_owned) }
}

impl Fixture {
    fn arm(&self, request: Req, response: &ArmResponse) {
        self.warmer.arm(request.session, Some(arc(request)), response);
    }

    fn arm_default(&self) {
        self.arm(Req::default(), &wrote_one_hour(Some("acct-1")));
    }

    /// Runs every timer due by `to`, in due order, with the clock at each.
    async fn advance(&self, to: f64) {
        loop {
            let due = {
                let mut timers = lock(&self.world.timers);
                let first = timers.iter().enumerate().filter(|(_, t)| t.at <= to).min_by(|a, b| a.1.at.total_cmp(&b.1.at).then(a.1.id.cmp(&b.1.id))).map(|(i, _)| i);
                first.map(|i| timers.remove(i))
            };
            let Some(mut due) = due else { break };
            self.world.set_now(self.world.now().max(due.at));
            if let Some(task) = due.task.take() {
                task.await;
            }
        }
        self.world.set_now(self.world.now().max(to));
    }

    fn script(&self, steps: Vec<Outcome>) {
        *lock(&self.deps.script) = steps;
    }

    fn sends(&self) -> Vec<(i64, String)> {
        lock(&self.world.sends).iter().map(|(at, what)| ((*at - T0) as i64, what.clone())).collect()
    }

    fn billed(&self) -> Vec<String> {
        lock(&self.world.billed).iter().map(|(_, row)| row.clone()).collect()
    }

    fn logged(&self, text: &str) -> bool {
        lock(&self.world.log).iter().any(|line| line.contains(text))
    }

    fn pending_timers(&self) -> usize {
        lock(&self.world.timers).len()
    }

    fn at(&self, offset: f64) -> f64 {
        T0 + offset
    }
}

// ---- arming ------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_real_request_that_wrote_a_one_hour_entry_arms_a_chain_and_records_the_touch() {
    let f = fixture().await;
    f.arm_default();
    let chain = f.warmer.chain_state("s1").expect("a chain is armed");
    assert_eq!((chain.ttl_ms, chain.touch_at, chain.prompt_tokens), (HOUR, T0, 70_000.0));
    assert_eq!((chain.account_id.as_str(), chain.refresh_at), ("acct-1", T0 + REFRESH));
    assert_eq!(*lock(&f.world.timer_log), [format!("set +{} @{}", (REFRESH - 1000.0) as i64, REFRESH as i64)], "one timer, a minute before the entry expires");
    let touch = f.touches.get("s1").expect("the touch is durable");
    assert_eq!((touch.touch_at, touch.ttl_ms, touch.account_id.as_deref()), (T0, HOUR, Some("acct-1")));
    assert_eq!(f.gaps.open_at("s1"), T0, "the session's idle clock runs from the request");
}

#[tokio::test]
async fn the_prompt_size_is_the_responses_own_when_it_reports_one() {
    let f = fixture().await;
    f.arm(Req::default(), &ArmResponse { prompt_tokens: Some(123_456.0), ..wrote_one_hour(Some("a")) });
    assert_eq!(f.warmer.chain_state("s1").unwrap().prompt_tokens, 123_456.0);
}

#[tokio::test]
async fn a_five_minute_write_arms_a_chain_that_warms_after_four_minutes() {
    let f = fixture().await;
    let response = ArmResponse { input: 10.0, cached: 0.0, cache_write: 5000.0, tail_ttl_ms: Some(5.0 * MINUTE), prompt_tokens: None, account_id: Some("a".into()) };
    f.arm(Req { strategy: Some(CacheStrategy { messages: Some("5m".into()), ..CacheStrategy::default() }), ..Req::default() }, &response);
    let chain = f.warmer.chain_state("s1").unwrap();
    assert_eq!((chain.ttl_ms, chain.refresh_at), (5.0 * MINUTE, T0 + 4.0 * MINUTE));
}

#[tokio::test]
async fn nothing_is_armed_when_the_response_does_not_prove_the_tier_or_the_prompt_or_the_request_is_not_eligible() {
    let f = fixture().await;
    let unproven = ArmResponse { tail_ttl_ms: None, ..wrote_one_hour(Some("a")) };
    f.arm(Req::default(), &unproven);
    assert!(f.warmer.chain_state("s1").is_none(), "a tail the session's book did not prove arms nothing, whatever the usage wrote");
    f.arm(Req { sent_at: 0.0, ..Req::default() }, &wrote_one_hour(Some("a")));
    assert!(f.warmer.chain_state("s1").is_none(), "a request without a send time");
    f.arm(Req { provider: "openai-oauth", ..Req::default() }, &wrote_one_hour(Some("a")));
    assert!(f.warmer.chain_state("s1").is_none(), "an ineligible request");
    assert!(f.touches.get("s1").is_none(), "and no touch is kept for any of them");
    assert_eq!(f.pending_timers(), 0);
}

#[tokio::test]
async fn a_new_request_replaces_the_chain_and_its_timer() {
    let f = fixture().await;
    f.arm_default();
    f.world.set_now(T0 + 10.0 * MINUTE);
    f.arm(Req { sent_at: T0 + 10.0 * MINUTE, ..Req::default() }, &wrote_one_hour(Some("acct-1")));
    assert_eq!(f.pending_timers(), 1);
    assert_eq!(f.warmer.chain_state("s1").unwrap().touch_at, T0 + 10.0 * MINUTE);
}

// ---- the setting -------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn nothing_is_armed_while_warming_is_off_and_turning_it_off_cancels_every_chain() {
    let f = fixture().await;
    *lock(&f.deps.enabled) = false;
    f.arm_default();
    assert!(f.warmer.chain_state("s1").is_none());
    assert!(f.touches.get("s1").is_none());

    f.warmer.note_enabled(true);
    f.arm_default();
    assert!(f.warmer.chain_state("s1").is_some());
    f.warmer.note_enabled(false);
    assert!(f.warmer.chain_state("s1").is_none());
    assert_eq!(f.pending_timers(), 0);
}

// ---- warming -----------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn warms_follow_the_sessions_history_of_returns_and_stop_when_none_that_long_is_known() {
    let f = fixture().await;
    f.arm_default();
    f.advance(f.at(10.0 * HOUR)).await;
    // The session came back after 2.5 h each time: a warm at 59 min and one at 118 min bridge the wait; at 177 min no
    // return that long is known, so the chain ends.
    assert_eq!(f.sends(), [(REFRESH as i64, "anthropic-oauth:claude-opus-4-7:acct-1".to_owned()), (2 * REFRESH as i64, "anthropic-oauth:claude-opus-4-7:acct-1".to_owned())]);
    assert_eq!(f.billed().len(), 2);
    assert!(f.warmer.chain_state("s1").is_none());
    assert!(f.logged("s1: stopped (no idle history this long)"), "{:?}", lock(&f.world.log));
    assert_eq!(f.pending_timers(), 0);
}

#[tokio::test]
async fn each_successful_warm_moves_the_touch_and_is_the_sessions_latest_cache_use() {
    let f = fixture().await;
    f.arm_default();
    f.advance(f.at(REFRESH)).await;
    let chain = f.warmer.chain_state("s1").unwrap();
    assert_eq!(chain.touch_at, T0 + REFRESH, "the entry was last used by the warm");
    assert_eq!(chain.refresh_at, T0 + 2.0 * REFRESH);
    assert_eq!(f.touches.get("s1").unwrap().touch_at, T0 + REFRESH);
    let used = f.touches.warm_use("s1").expect("a read without a write is cache use");
    assert_eq!((used.at, used.provider.as_str(), used.model.as_str(), used.account_id.as_str()), ((T0 + REFRESH) as u64, "anthropic-oauth", "claude-opus-4-7", "acct-1"));
}

#[tokio::test]
async fn a_warm_that_found_nothing_to_read_ends_the_chain_and_drops_the_touch() {
    let f = fixture().await;
    f.arm_default();
    f.script(vec![Outcome::Read(0.0)]);
    f.advance(f.at(REFRESH)).await;
    assert!(f.warmer.chain_state("s1").is_none());
    assert!(f.touches.get("s1").is_none());
    assert!(f.logged("warm missed the cache"));
    assert_eq!(f.billed().len(), 1, "the warm is billed all the same");
}

#[tokio::test]
async fn a_warm_that_rewrote_the_prefix_ends_the_chain_and_no_later_request_of_the_session_arms_another() {
    let f = fixture().await;
    f.arm_default();
    f.script(vec![Outcome::Usage { cached: 1000.0, write: 60_000.0 }]);
    f.advance(f.at(REFRESH)).await;
    assert!(f.warmer.chain_state("s1").is_none());
    f.arm(Req { sent_at: T0 + 2.0 * HOUR, ..Req::default() }, &wrote_one_hour(Some("acct-1")));
    assert!(f.warmer.chain_state("s1").is_none(), "warming this session loses money");
}

#[tokio::test]
async fn a_small_write_is_prompt_growth_not_a_rewrite() {
    let f = fixture().await;
    f.arm_default();
    f.script(vec![Outcome::Usage { cached: 70_000.0, write: 1000.0 }]);
    f.advance(f.at(REFRESH)).await;
    assert!(f.warmer.chain_state("s1").is_some());
}

#[tokio::test]
async fn a_failed_warm_ends_the_chain_and_what_it_cost_is_still_billed() {
    let f = fixture().await;
    f.arm_default();
    f.script(vec![Outcome::Fail("overloaded", Some(2000.0))]);
    f.advance(f.at(REFRESH)).await;
    assert!(f.warmer.chain_state("s1").is_none());
    assert!(f.logged("s1: stopped (warm failed: overloaded)"));
    assert_eq!(f.billed(), ["cached=2000 write=0 account=acct-1"]);
    assert!(f.touches.get("s1").is_some(), "a failure says nothing about the cache: the touch stays for a restart");
}

#[tokio::test]
async fn a_failed_warm_without_usage_bills_nothing() {
    let f = fixture().await;
    f.arm_default();
    f.script(vec![Outcome::Fail("refused", None)]);
    f.advance(f.at(REFRESH)).await;
    assert!(f.billed().is_empty());
}

#[tokio::test]
async fn a_warm_is_not_sent_while_a_turn_runs_nor_for_a_replaced_provider_or_an_unknown_account() {
    let f = fixture().await;
    f.arm_default();
    *lock(&f.deps.in_flight) = true;
    f.advance(f.at(REFRESH)).await;
    assert!(f.sends().is_empty());
    assert!(f.logged("s1: stopped (turn in flight)"));

    let f = fixture().await;
    f.arm_default();
    *lock(&f.deps.replaced) = true;
    f.advance(f.at(REFRESH)).await;
    assert!(f.sends().is_empty());
    assert!(f.logged("s1: stopped (provider instance replaced)"));

    // anthropic-oauth keeps a roster: the account that holds the entry must be known to warm it.
    let f = fixture().await;
    f.arm(Req::default(), &wrote_one_hour(None));
    f.advance(f.at(REFRESH)).await;
    assert!(f.sends().is_empty());
    assert!(f.logged("s1: stopped (account holding the cache unknown)"));
}

#[tokio::test]
async fn a_provider_without_a_roster_warms_on_no_account() {
    let f = fixture().await;
    f.arm(Req { provider: "anthropic", ..Req::default() }, &wrote_one_hour(None));
    f.advance(f.at(REFRESH)).await;
    assert_eq!(f.sends(), [(REFRESH as i64, "anthropic:claude-opus-4-7:".to_owned())]);
}

#[tokio::test]
async fn a_timer_that_fires_after_the_entry_expired_sends_nothing() {
    let f = fixture().await;
    f.arm_default();
    // The process slept past the expiry: the timer is due but the entry is gone.
    f.world.set_now(T0 + HOUR + MINUTE);
    f.advance(f.at(HOUR + MINUTE)).await;
    assert!(f.sends().is_empty());
    assert!(f.logged("s1: stopped (late timer)"));
}

#[tokio::test]
async fn a_session_with_no_history_or_unknown_prices_is_not_warmed() {
    let f = fixture_with(|_| {}).await;
    f.arm_default();
    f.advance(f.at(REFRESH)).await;
    assert!(f.sends().is_empty());
    assert!(f.logged("no idle history this long"));

    let f = fixture().await;
    *lock(&f.deps.prices) = Prices { read: Some(0.5e-6), write: None, output: Some(25e-6) };
    f.arm_default();
    f.advance(f.at(REFRESH)).await;
    assert!(f.sends().is_empty());
    assert!(f.logged("prompt size or cache prices unknown"));
}

#[tokio::test]
async fn warming_turned_off_before_the_timer_stops_the_chain_without_a_send() {
    let f = fixture().await;
    f.arm_default();
    *lock(&f.deps.enabled) = false;
    f.advance(f.at(REFRESH)).await;
    assert!(f.sends().is_empty());
    assert!(f.logged("cache warming off"));
}

// ---- turns, activity and the prefix ----------------------------------------------------------------------------------

#[tokio::test]
async fn a_turn_stops_the_chain_and_the_chain_returns_when_the_turn_ends_without_a_request() {
    let f = fixture().await;
    f.arm_default();
    let turn = f.warmer.note_turn("s1", TurnKind::Return).expect("a turn");
    assert!(f.warmer.chain_state("s1").is_none(), "no warm races a turn");
    assert!(f.warmer.turn("s1").unwrap().returning());
    f.world.set_now(T0 + 5.0 * MINUTE);
    f.warmer.end_turn("s1", &turn);
    let chain = f.warmer.chain_state("s1").expect("the entry is still alive, so the chain is restored");
    assert_eq!((chain.touch_at, chain.refresh_at), (T0, T0 + REFRESH), "with its original touch and schedule");
    assert!(f.warmer.turn("s1").is_none());
}

#[tokio::test]
async fn a_turn_that_ends_after_the_entry_expired_does_not_bring_the_chain_back() {
    let f = fixture().await;
    f.arm_default();
    let turn = f.warmer.note_turn("s1", TurnKind::Continuation).unwrap();
    f.world.set_now(T0 + HOUR);
    f.warmer.end_turn("s1", &turn);
    assert!(f.warmer.chain_state("s1").is_none());
}

#[tokio::test]
async fn a_request_of_the_session_ends_the_chain_for_good_and_a_stale_turn_end_is_ignored() {
    let f = fixture().await;
    f.arm_default();
    let first = f.warmer.note_turn("s1", TurnKind::Return).unwrap();
    f.warmer.note_activity("s1", Some(&Req::default()));
    let second = f.warmer.note_turn("s1", TurnKind::Return).unwrap();
    f.warmer.end_turn("s1", &first);
    assert!(f.warmer.turn("s1").is_some(), "an earlier turn's end does not close a later turn");
    f.warmer.end_turn("s1", &second);
    assert!(f.warmer.chain_state("s1").is_none(), "a request went out: nothing is restored");
}

#[tokio::test]
async fn the_first_request_of_a_returning_turn_closes_the_idle_gap_at_the_turns_start() {
    let f = fixture_with(|_| {}).await;
    f.gaps.open_gap("s1", T0 - 3.0 * HOUR);
    f.warmer.note_turn("s1", TurnKind::Return);
    f.world.set_now(T0 + 1000.0);
    f.warmer.note_activity("s1", Some(&Req::default()));
    let kept = f.gaps.gaps("s1");
    assert_eq!(kept.len(), 1);
    assert_eq!((kept[0].at, kept[0].ms, kept[0].censored), (T0 - 3.0 * HOUR, 3.0 * HOUR + 1000.0, false));
}

#[tokio::test]
async fn a_system_turn_is_neither_a_return_nor_activity() {
    let f = fixture_with(|_| {}).await;
    f.gaps.open_gap("s1", T0 - 3.0 * HOUR);
    f.warmer.note_turn("s1", TurnKind::System);
    f.warmer.note_activity("s1", Some(&Req::default()));
    assert!(f.gaps.gaps("s1").is_empty());
    assert_eq!(f.gaps.open_at("s1"), T0 - 3.0 * HOUR, "its idle clock keeps running");
}

#[tokio::test]
async fn purging_a_session_drops_its_chain_touch_warm_use_and_what_it_learned() {
    let f = fixture().await;
    f.arm_default();
    f.advance(f.at(REFRESH)).await;
    assert!(f.touches.warm_use("s1").is_some());
    f.warmer.purge_session("s1");
    assert!(f.warmer.chain_state("s1").is_none());
    assert!(f.touches.get("s1").is_none() && f.touches.warm_use("s1").is_none());
    assert_eq!(f.pending_timers(), 0);
    assert!(f.gaps.gaps("s1").is_empty() && f.gaps.open_at("s1") == 0.0);
}

// ---- after a restart ---------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_restart_rearms_the_sessions_whose_entry_is_still_alive_and_drops_the_expired_touches() {
    let f = fixture().await;
    *lock(&f.deps.last_sent) = Some(arc(Req::default()));
    let alive = Touch { touch_at: T0 + 1000.0, ttl_ms: HOUR, prompt_tokens: 70_000.0, account_id: Some("acct-1".into()) };
    f.touches.record("alive", alive.clone());
    f.touches.record("expired", Touch { touch_at: T0 - 2.0 * HOUR, ttl_ms: HOUR, ..alive });
    assert_eq!(f.warmer.rearm_after_restart().await, 1);
    assert!(f.warmer.chain_state("alive").is_some());
    assert!(f.warmer.chain_state("expired").is_none());
    assert!(f.touches.get("expired").is_none());
    let chain = f.warmer.chain_state("alive").unwrap();
    assert_eq!((chain.touch_at, chain.ttl_ms, chain.account_id.as_str()), (T0 + 1000.0, HOUR, "acct-1"));
}

#[tokio::test]
async fn a_restart_arms_nothing_while_warming_is_off_or_for_a_session_whose_request_is_gone_or_ineligible() {
    let f = fixture().await;
    f.touches.record("s1", Touch { touch_at: T0 + 1000.0, ttl_ms: HOUR, prompt_tokens: 70_000.0, account_id: None });
    assert_eq!(f.warmer.rearm_after_restart().await, 0, "no request to replay");
    *lock(&f.deps.last_sent) = Some(arc(Req { provider: "openai-oauth", ..Req::default() }));
    assert_eq!(f.warmer.rearm_after_restart().await, 0, "an ineligible request");
    *lock(&f.deps.last_sent) = Some(arc(Req::default()));
    f.warmer.note_enabled(false);
    assert_eq!(f.warmer.rearm_after_restart().await, 0);
    f.warmer.note_enabled(true);
    assert_eq!(f.warmer.rearm_after_restart().await, 1);
}

#[tokio::test]
async fn the_durable_files_hold_the_touch_the_gaps_and_the_warm_use() {
    let f = fixture().await;
    f.arm_default();
    f.advance(f.at(REFRESH)).await;
    f.touches.flush().await;
    f.gaps.flush().await;
    let read = |file: &str| -> serde_json::Value {
        let bytes = mixdog_statefile::read_content(&f.dir.path().join(file)).unwrap().expect("the file was written");
        serde_json::from_slice(&bytes).unwrap()
    };
    let touches = read("touches.json");
    assert_eq!(touches["touches"]["s1"]["touchAt"].as_f64(), Some(T0 + REFRESH));
    assert_eq!(touches["touches"]["s1"]["accountId"], "acct-1");
    assert_eq!(touches["warmUses"]["s1"]["model"], "claude-opus-4-7");
    let gaps = read("gaps.json");
    assert_eq!(gaps["sessions"]["s1"]["open"].as_f64(), Some(T0));
    assert_eq!(gaps["sessions"]["s1"]["gaps"].as_array().unwrap().len(), 20);
}

#[tokio::test]
async fn two_sessions_chains_never_share_a_timer() {
    let f = fixture().await;
    f.arm_default();
    f.arm(Req { session: "s2", ..Req::default() }, &wrote_one_hour(Some("acct-2")));
    assert_eq!(f.pending_timers(), 2);
    f.warmer.cancel("s1");
    assert!(f.warmer.chain_state("s1").is_none() && f.warmer.chain_state("s2").is_some());
    assert_eq!(f.pending_timers(), 1);
}
