//! The production verdict, PW §4.1 over typed fields only.

use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::retry::AdviceCombine;
use mixdog_core_api::domain::retry::AdviceRule;
use mixdog_core_api::domain::retry::Backoff;
use mixdog_core_api::domain::retry::Decision;
use mixdog_core_api::domain::retry::Jitter;
use mixdog_core_api::domain::retry::JitterSamples;
use mixdog_core_api::domain::retry::JitterStage;
use mixdog_core_api::domain::retry::KindSchedule;
use mixdog_core_api::domain::retry::OverloadRule;
use mixdog_core_api::domain::retry::RetryClass;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::retry::RetryReason;
use mixdog_core_api::domain::retry::RetryRow;
use mixdog_core_api::domain::retry::RetrySchedule;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::ScheduleCount;
use mixdog_core_api::domain::retry::StatusRules;
use mixdog_core_api::domain::retry::Verdict;
use rand::Rng;

/// Cloudflare edge statuses that no retry can change.
const TERMINAL_EDGE_STATUSES: [u16; 2] = [525, 526];

/// Safety ceiling preventing any `u32::MAX` or runaway retry schedule from looping indefinitely across an entire
/// request sequence, even when kind schedules reset the base counter.
pub const MAX_RETRIES_HARD_CAP: u32 = 12;

/// Deterministic error kind that is never retried, reused as a collision-free slot in [`RetryState`] to count total
/// retries granted across the entire request sequence without affecting `consecutive_overloads` or base/kind counters.
const SEQUENCE_TOTAL_KIND: ErrorKind = ErrorKind::ToolSchemaRejected;

fn sequence_counter_schedule() -> KindSchedule {
    KindSchedule {
        kind: SEQUENCE_TOTAL_KIND,
        schedule: RetrySchedule {
            max_retries: u32::MAX,
            backoff: Backoff::Ladder(vec![Duration::ZERO]),
            jitter: Jitter::NONE,
            advice: AdviceRule::honored_in_full(),
        },
        resets_base: false,
    }
}

/// Returns the total retries recorded across the current send sequence in `state`.
pub fn sequence_retries(state: &RetryState) -> u32 {
    state.count(Some(SEQUENCE_TOTAL_KIND)).retries.max(state.count(None).retries)
}

/// Carries at least `total` sequence retries onto `state` without altering its row-local
/// `base` count, per-kind counts, waited budget, or `consecutive_overloads`.
pub fn with_sequence_retries(state: &RetryState, total: u32) -> RetryState {
    let mut next = state.clone();
    let counter = sequence_counter_schedule();
    while next.count(Some(SEQUENCE_TOTAL_KIND)).retries < total {
        next = next.after_retry(SEQUENCE_TOTAL_KIND, Some(&counter), Duration::ZERO);
    }
    next
}

/// Creates a `RetryState` for `next_class` carrying over the cumulative sequence retry count
/// from `previous` so escalating across retry classes never resets the fallback budget or hard cap.
pub fn escalate_retry_state(previous: &RetryState, next_class: RetryClass) -> RetryState {
    with_sequence_retries(&RetryState::new(next_class, previous.model()), sequence_retries(previous))
}

fn record_sequence_retry(previous: &RetryState, next: RetryState) -> RetryState {
    let target = sequence_retries(previous).saturating_add(1);
    with_sequence_retries(&next, target)
}

/// Returns the maximum total retries `decider` allows across one send sequence for `model`,
/// bounded by [`MAX_RETRIES_HARD_CAP`].
pub fn effective_sequence_cap(decider: &dyn RetryDecider, model: &str) -> u32 {
    let mut probe_policy = RetryPolicy::codex_default();
    probe_policy.request = RetryRow::single(RetrySchedule {
        max_retries: MAX_RETRIES_HARD_CAP,
        backoff: Backoff::Ladder(vec![Duration::ZERO]),
        jitter: Jitter::NONE,
        advice: AdviceRule::honored_in_full(),
    });
    probe_policy.status = StatusRules::default();
    probe_policy.overload = OverloadRule::default();
    let probe_error = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
    let samples = JitterSamples { step: 0.5, advice: 0.5 };
    let mut state = RetryState::new(RetryClass::Request, model);
    let mut allowed = 0u32;
    while allowed < MAX_RETRIES_HARD_CAP {
        let decision = decider.verdict(&probe_error, &state, &probe_policy, samples);
        if matches!(decision.verdict, Verdict::Retry { .. }) {
            allowed += 1;
            state = decision.next;
        } else {
            break;
        }
    }
    allowed
}

/// Returns the effective maximum retries `decider` allows on `class` under `policy` for `model`,
/// reflecting both [`MAX_RETRIES_HARD_CAP`] and any active tightening (such as [`FallbackRetryBudget`]).
pub fn effective_row_max_retries(decider: &dyn RetryDecider, policy: &RetryPolicy, class: RetryClass, model: &str) -> u32 {
    let Some(row) = policy.row(class) else {
        return 0;
    };
    let configured = row.schedule.max_retries.min(MAX_RETRIES_HARD_CAP);
    if configured == 0 {
        return 0;
    }
    let probe_row = RetryRow::single(RetrySchedule {
        max_retries: configured,
        backoff: Backoff::Ladder(vec![Duration::ZERO]),
        jitter: Jitter::NONE,
        advice: AdviceRule::honored_in_full(),
    });
    let mut probe_policy = policy.clone();
    match class {
        RetryClass::Request => probe_policy.request = probe_row,
        RetryClass::Midstream => probe_policy.midstream = probe_row,
        RetryClass::Transport => probe_policy.transport = probe_row,
        RetryClass::Connection => probe_policy.connection = probe_row,
        RetryClass::Recovery => probe_policy.recovery = Some(probe_row),
    }
    probe_policy.status = StatusRules::default();
    probe_policy.overload = OverloadRule::default();
    let probe_error = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
    let samples = JitterSamples { step: 0.5, advice: 0.5 };
    let mut state = RetryState::new(class, model);
    let mut allowed = 0u32;
    while allowed < configured {
        let decision = decider.verdict(&probe_error, &state, &probe_policy, samples);
        if matches!(decision.verdict, Verdict::Retry { .. }) {
            allowed += 1;
            state = decision.next;
        } else {
            break;
        }
    }
    allowed
}

/// One draw per jitter, as a caller of the verdict supplies them.
pub fn random_samples() -> JitterSamples {
    if let Some((step, advice)) = crate::random::jitter() {
        return JitterSamples { step, advice };
    }
    let mut rng = rand::rng();
    JitterSamples { step: rng.random(), advice: rng.random() }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct StandardRetryDecider;

impl StandardRetryDecider {
    fn verdict_with_limits(
        &self,
        error: &ProviderError,
        state: &RetryState,
        policy: &RetryPolicy,
        samples: JitterSamples,
        sequence_cap: u32,
        max_step: Option<Duration>,
    ) -> Decision {
        let stop = |verdict| Decision { verdict, next: state.after_failure(error.kind) };
        let status = error.status;
        let rules = &policy.status;

        // Replay boundary: output the caller already saw or dispatched can
        // not be taken back; a cut tool input is replayed by the agent loop.
        let exposure = error.exposure;
        if error.unsafe_to_retry || exposure.text_emitted || exposure.tool_dispatched || exposure.tool_input_cut {
            return stop(Verdict::Surface);
        }
        // Refusals that repeating cannot change (quota kinds included), save
        // the one status a provider documents as a retryable client abort.
        let retryable_499 = status == Some(499) && rules.retry_499;
        if error.kind.is_deterministic() && !retryable_499 {
            return stop(Verdict::Surface);
        }
        if let Some(status) = status {
            let refused = TERMINAL_EDGE_STATUSES.contains(&status)
                || rules.terminal.contains(&status)
                || rules.retry_only.as_ref().is_some_and(|only| !only.contains(&status));
            if refused || (status == 529 && !rules.retry_529) {
                return stop(Verdict::Surface);
            }
        }
        if let Some(model) = &error.fallback_model {
            return Decision { verdict: Verdict::Fallback { model: model.to_string() }, next: state.after_failure(error.kind) };
        }
        // Overload: repeated capacity refusals fall back to another model or
        // end the send.
        if error.kind == ErrorKind::Overloaded || status == Some(529) {
            let seen = state.consecutive_overloads() + 1;
            let overload = &policy.overload;
            if overload.fallback_after.is_some_and(|after| seen >= after) {
                match &overload.fallback_model {
                    Some(model) if model != state.model() => {
                        return Decision { verdict: Verdict::Fallback { model: model.clone() }, next: state.after_failure(error.kind) };
                    }
                    _ if overload.stop_after_repeated => return stop(Verdict::Exhausted),
                    _ => {}
                }
            }
        }
        if error.should_retry == Some(false) {
            return stop(Verdict::Surface);
        }
        let forced = error.should_retry == Some(true) && policy.honor_should_retry_true;
        let row_retries = (status != Some(429) || rules.retry_429)
            && match error.kind {
                ErrorKind::RateLimited | ErrorKind::Overloaded | ErrorKind::Transient => true,
                _ => forced || retryable_499,
            };

        let Some(row) = policy.row(state.class()) else {
            return stop(Verdict::Surface);
        };
        let sequence_cap = sequence_cap.min(MAX_RETRIES_HARD_CAP);
        let retry = |delay, under| Decision {
            verdict: Verdict::Retry { delay, reason: reason_of(error), delivery: error.delivery },
            next: record_sequence_retry(state, state.after_retry(error.kind, under, delay)),
        };
        let cap = status
            .and_then(|s| rules.caps.iter().find(|(capped, _)| *capped == s))
            .map(|(_, cap)| *cap)
            .filter(|_| error.kind != ErrorKind::Overloaded && row.kind_schedule(error.kind).is_none());
        if let Some(cap) = cap
            && row_retries
        {
            if state.count(Some(error.kind)).retries >= cap {
                return stop(Verdict::Surface);
            }
            if sequence_retries(state) >= sequence_cap {
                return stop(Verdict::Exhausted);
            }
            if let Some(delay) = wait_under(error, &row.schedule, state.budget_used(None), samples, max_step) {
                let counted = KindSchedule { kind: error.kind, schedule: row.schedule.clone(), resets_base: false };
                let next = record_sequence_retry(state, state.after_retry(error.kind, None, delay).after_retry(error.kind, Some(&counted), Duration::ZERO));
                return Decision { verdict: Verdict::Retry { delay, reason: reason_of(error), delivery: error.delivery }, next };
            }
        }
        let has_kind_schedule = row.kind_schedule(error.kind).is_some();
        if (row_retries || has_kind_schedule) && sequence_retries(state) >= sequence_cap {
            return stop(Verdict::Exhausted);
        }
        // The row's own schedule governs first; a kind schedule takes what
        // it leaves (a status kept from the row, a spent count or budget).
        if row_retries && let Some(delay) = wait_under(error, &row.schedule, state.budget_used(None), samples, max_step) {
            return retry(delay, None);
        }
        if let Some(entry) = row.kind_schedule(error.kind) {
            return match wait_under(error, &entry.schedule, state.budget_used(Some(entry.kind)), samples, max_step) {
                Some(delay) => retry(delay, Some(entry)),
                None => stop(Verdict::Exhausted),
            };
        }
        stop(if row_retries { Verdict::Exhausted } else { Verdict::Surface })
    }
}

impl RetryDecider for StandardRetryDecider {
    fn verdict(&self, error: &ProviderError, state: &RetryState, policy: &RetryPolicy, samples: JitterSamples) -> Decision {
        self.verdict_with_limits(error, state, policy, samples, MAX_RETRIES_HARD_CAP, None)
    }
}

fn reason_of(error: &ProviderError) -> RetryReason {
    match error.kind {
        ErrorKind::RateLimited => RetryReason::RateLimited,
        ErrorKind::Overloaded => RetryReason::Overloaded,
        ErrorKind::Auth => RetryReason::Auth,
        ErrorKind::Transient if error.transport.is_some() => RetryReason::Transport,
        ErrorKind::Transient => RetryReason::ServerError,
        _ => RetryReason::Other,
    }
}

/// The wait before the next retry under `schedule`, or `None` when its count
/// is spent or the server's advice is beyond its ceiling or waited budget.
///
/// The advice rule applies in the order of [`AdviceRule`]'s contract: ceiling
/// and budget on the raw advice, then clamp, jitter at the advice stage,
/// combine with the jittered step, jitter at the wait stage; statuses in
/// `raw_statuses` skip clamp and jitter.
///
/// [`AdviceRule`]: mixdog_core_api::domain::retry::AdviceRule
fn wait_under(error: &ProviderError, schedule: &RetrySchedule, used: ScheduleCount, samples: JitterSamples, max_step: Option<Duration>) -> Option<Duration> {
    let max_retries = schedule.max_retries.min(MAX_RETRIES_HARD_CAP);
    if used.retries >= max_retries {
        return None;
    }
    let attempt = used.retries + 1;
    let step = match &schedule.backoff {
        Backoff::Ladder(steps) => steps.get((attempt as usize).min(steps.len()).wrapping_sub(1)).copied().unwrap_or_default(),
        Backoff::Exponential { base } => base.saturating_mul(2u32.saturating_pow(attempt - 1)),
    };
    let mut step = schedule.jitter.apply(step, samples.step);
    if let Some(ceiling) = max_step {
        step = step.min(ceiling);
    }
    let Some(advice) = error.retry_after else {
        return Some(step);
    };
    let rule = &schedule.advice;
    if rule.ceiling.is_some_and(|ceiling| advice > ceiling) {
        return None;
    }
    if rule.budget.is_some_and(|budget| used.waited + advice > budget) {
        return None;
    }
    let raw = error.status.is_some_and(|status| rule.raw_statuses.contains(&status));
    let jittered = |stage, wait: Duration| {
        if raw || rule.jitter_stage != stage { wait } else { rule.jitter.apply(wait, samples.advice) }
    };
    let advice = match rule.clamp {
        Some(clamp) if !raw => advice.min(clamp),
        _ => advice,
    };
    let advice = jittered(JitterStage::Advice, advice);
    let wait = match rule.combine {
        AdviceCombine::Floor => advice.max(step),
        AdviceCombine::Replace => advice,
    };
    Some(jittered(JitterStage::Wait, wait))
}

/// Tighter retry budget used while fallback routes remain so a failing route hops quickly instead of spending long
/// backoff ladders or `Retry-After` delays.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FallbackRetryBudget {
    pub max_retries: u32,
    pub max_step: Duration,
    pub max_advice_ceiling: Duration,
    pub max_advice_budget: Duration,
    pub skip_recovery: bool,
}

impl Default for FallbackRetryBudget {
    fn default() -> Self {
        Self {
            max_retries: 1,
            max_step: Duration::from_secs(2),
            max_advice_ceiling: Duration::from_secs(5),
            max_advice_budget: Duration::from_secs(5),
            skip_recovery: true,
        }
    }
}

/// [`RetryDecider`] that applies [`FallbackRetryBudget`] while the session has remaining fallback routes, and restores
/// the full provider [`RetryPolicy`] once on the last route.
pub struct FallbackAwareRetryDecider {
    has_fallback: Arc<dyn Fn() -> bool + Send + Sync>,
    budget: FallbackRetryBudget,
}

impl FallbackAwareRetryDecider {
    pub fn new(has_fallback: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        Self { has_fallback, budget: FallbackRetryBudget::default() }
    }

    pub fn with_budget(has_fallback: Arc<dyn Fn() -> bool + Send + Sync>, budget: FallbackRetryBudget) -> Self {
        Self { has_fallback, budget }
    }

    fn tighten_schedule(schedule: &RetrySchedule, budget: FallbackRetryBudget) -> RetrySchedule {
        let mut next = schedule.clone();
        next.max_retries = next.max_retries.min(budget.max_retries);
        next.backoff = match &next.backoff {
            Backoff::Ladder(steps) => Backoff::Ladder(steps.iter().map(|step| (*step).min(budget.max_step)).collect()),
            Backoff::Exponential { base } => Backoff::Exponential { base: (*base).min(budget.max_step) },
        };
        next.advice.ceiling = Some(next.advice.ceiling.map_or(budget.max_advice_ceiling, |c| c.min(budget.max_advice_ceiling)));
        next.advice.budget = Some(next.advice.budget.map_or(budget.max_advice_budget, |b| b.min(budget.max_advice_budget)));
        if let Some(clamp) = next.advice.clamp {
            next.advice.clamp = Some(clamp.min(budget.max_advice_ceiling));
        }
        next
    }

    fn tighten_row(row: &RetryRow, budget: FallbackRetryBudget) -> RetryRow {
        RetryRow {
            schedule: Self::tighten_schedule(&row.schedule, budget),
            by_kind: row
                .by_kind
                .iter()
                .map(|entry| KindSchedule { kind: entry.kind, schedule: Self::tighten_schedule(&entry.schedule, budget), resets_base: false })
                .collect(),
        }
    }

    pub fn tighten_policy(policy: &RetryPolicy, budget: FallbackRetryBudget) -> RetryPolicy {
        let mut next = policy.clone();
        next.request = Self::tighten_row(&policy.request, budget);
        next.midstream = Self::tighten_row(&policy.midstream, budget);
        next.transport = Self::tighten_row(&policy.transport, budget);
        next.connection = Self::tighten_row(&policy.connection, budget);
        next.recovery = if budget.skip_recovery { None } else { policy.recovery.as_ref().map(|row| Self::tighten_row(row, budget)) };
        for (_, cap) in &mut next.status.caps {
            *cap = (*cap).min(budget.max_retries);
        }
        next
    }
}

impl RetryDecider for FallbackAwareRetryDecider {
    fn verdict(&self, error: &ProviderError, state: &RetryState, policy: &RetryPolicy, samples: JitterSamples) -> Decision {
        if (self.has_fallback)() {
            let tightened = Self::tighten_policy(policy, self.budget);
            StandardRetryDecider.verdict_with_limits(error, state, &tightened, samples, self.budget.max_retries, Some(self.budget.max_step))
        } else {
            StandardRetryDecider.verdict(error, state, policy, samples)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::retry::RetryClass;

    use super::*;

    #[test]
    fn fallback_aware_decider_tightens_retries_and_restores_full_budget_on_last_route() {
        let has_fallback = Arc::new(AtomicBool::new(true));
        let flag = has_fallback.clone();
        let decider = FallbackAwareRetryDecider::new(Arc::new(move || flag.load(Ordering::SeqCst)));
        let policy = crate::providers::openai::policy::retry_policy();
        let samples = JitterSamples { step: 0.5, advice: 0.5 };

        // While fallbacks remain, connection retries are tightened to 1 fast attempt <= 2s.
        let transient = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
        let state = RetryState::new(RetryClass::Connection, "gpt-5".to_owned());
        let first = decider.verdict(&transient, &state, &policy, samples);
        match first.verdict {
            Verdict::Retry { delay, .. } => assert!(delay <= Duration::from_secs(2), "delay was {delay:?}"),
            other => panic!("expected one fast retry, got {other:?}"),
        }
        let second = decider.verdict(&transient, &first.next, &policy, samples);
        assert!(matches!(second.verdict, Verdict::Exhausted), "second failure should hop to fallback");

        // Long Retry-After advice exceeds the fast ceiling and exhausts immediately so fallback runs.
        let mut rate_limited = ProviderError::new(ErrorKind::RateLimited, DeliveryState::NotSent);
        rate_limited.status = Some(429);
        rate_limited.retry_after = Some(Duration::from_secs(30));
        let req_state = RetryState::new(RetryClass::Request, "gpt-5".to_owned());
        let advised = decider.verdict(&rate_limited, &req_state, &policy, samples);
        assert!(matches!(advised.verdict, Verdict::Exhausted), "30s Retry-After should hop instead of waiting");

        // Once on the final route (no fallbacks left), the full provider policy applies.
        has_fallback.store(false, Ordering::SeqCst);
        let full = decider.verdict(&rate_limited, &req_state, &policy, samples);
        assert!(matches!(full.verdict, Verdict::Retry { delay, .. } if delay == Duration::from_secs(30)));
    }

    #[test]
    fn u32_max_schedule_is_capped_by_hard_limit() {
        let mut policy = RetryPolicy::codex_default();
        policy.connection = RetryRow::single(RetrySchedule {
            max_retries: u32::MAX,
            backoff: Backoff::Ladder(vec![Duration::from_secs(1)]),
            jitter: Jitter::NONE,
            advice: AdviceRule::honored_in_full(),
        });
        let error = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
        let mut state = RetryState::new(RetryClass::Connection, "m".to_owned());
        let samples = JitterSamples { step: 0.5, advice: 0.5 };
        for _ in 0..MAX_RETRIES_HARD_CAP {
            let decision = StandardRetryDecider.verdict(&error, &state, &policy, samples);
            assert!(matches!(decision.verdict, Verdict::Retry { .. }));
            state = decision.next;
        }
        let capped = StandardRetryDecider.verdict(&error, &state, &policy, samples);
        assert!(matches!(capped.verdict, Verdict::Exhausted));
    }

    #[test]
    fn sequence_cap_bounds_total_retries_across_base_resetting_kind_schedules() {
        let mut policy = crate::providers::google::policy::antigravity();
        // Ensure a worst-case policy where base and kind schedules could otherwise exceed MAX_RETRIES_HARD_CAP via resets.
        policy.request.schedule.max_retries = 8;
        for entry in &mut policy.request.by_kind {
            entry.schedule.max_retries = 8;
            entry.resets_base = true;
        }
        policy.overload.fallback_after = None;

        let samples = JitterSamples { step: 0.5, advice: 0.5 };
        let transient = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
        let mut overloaded = ProviderError::new(ErrorKind::Overloaded, DeliveryState::NotSent);
        overloaded.status = Some(503);
        let mut rate_limited = ProviderError::new(ErrorKind::RateLimited, DeliveryState::NotSent);
        rate_limited.status = Some(429);

        // StandardRetryDecider caps the entire alternating sequence at MAX_RETRIES_HARD_CAP.
        let mut state = RetryState::new(RetryClass::Request, "gemini-3-pro".to_owned());
        let mut granted = 0u32;
        for step in 0..40 {
            let err = match step % 3 {
                0 => &transient,
                1 => &overloaded,
                _ => &rate_limited,
            };
            let decision = StandardRetryDecider.verdict(err, &state, &policy, samples);
            match decision.verdict {
                Verdict::Retry { .. } => {
                    granted += 1;
                    state = decision.next;
                }
                Verdict::Exhausted => break,
                other => panic!("unexpected verdict at step {step}: {other:?}"),
            }
        }
        assert_eq!(granted, MAX_RETRIES_HARD_CAP, "total retries across base + resetting kind schedules must never exceed hard cap");

        // FallbackAwareRetryDecider caps the entire alternating sequence at budget.max_retries (1).
        let decider = FallbackAwareRetryDecider::new(Arc::new(|| true));
        let mut fb_state = RetryState::new(RetryClass::Request, "gemini-3-pro".to_owned());
        let first = decider.verdict(&transient, &fb_state, &policy, samples);
        assert!(matches!(first.verdict, Verdict::Retry { .. }));
        fb_state = first.next;
        let second = decider.verdict(&overloaded, &fb_state, &policy, samples);
        assert!(matches!(second.verdict, Verdict::Exhausted), "resetting kind retry must not exceed tightened fallback budget");
    }

    #[test]
    fn request_to_connection_escalation_enforces_tightened_fallback_budget() {
        let decider = FallbackAwareRetryDecider::new(Arc::new(|| true));
        let policy = RetryPolicy::codex_default();
        let samples = JitterSamples { step: 0.5, advice: 0.5 };
        let connect = ProviderError::transport(mixdog_core_api::domain::provider::TransportFault::Connect { os_code: None }, DeliveryState::NotSent);

        let req0 = RetryState::new(RetryClass::Request, "gpt-5".to_owned());
        let first = decider.verdict(&connect, &req0, &policy, samples);
        assert!(matches!(first.verdict, Verdict::Retry { .. }), "first request retry should be allowed");
        assert_eq!(sequence_retries(&first.next), 1);

        let req_exhausted = decider.verdict(&connect, &first.next, &policy, samples);
        assert_eq!(req_exhausted.verdict, Verdict::Exhausted);

        let escalated = escalate_retry_state(&req_exhausted.next, RetryClass::Connection);
        assert_eq!(escalated.class(), RetryClass::Connection);
        assert_eq!(escalated.count(None).retries, 0);
        assert_eq!(sequence_retries(&escalated), 1);

        let conn_after_req = decider.verdict(&connect, &escalated, &policy, samples);
        assert_eq!(
            conn_after_req.verdict,
            Verdict::Exhausted,
            "escalating Request -> Connection must not grant an extra retry past the tightened fallback budget"
        );
    }

    #[test]
    fn request_to_connection_escalation_never_exceeds_hard_cap() {
        let policy = RetryPolicy::codex_default();
        let samples = JitterSamples { step: 0.5, advice: 0.5 };
        let connect = ProviderError::transport(mixdog_core_api::domain::provider::TransportFault::Connect { os_code: None }, DeliveryState::NotSent);

        let mut req = RetryState::new(RetryClass::Request, "m".to_owned());
        let mut granted = 0u32;
        loop {
            let decision = StandardRetryDecider.verdict(&connect, &req, &policy, samples);
            match decision.verdict {
                Verdict::Retry { .. } => {
                    granted += 1;
                    req = decision.next;
                }
                Verdict::Exhausted => {
                    req = decision.next;
                    break;
                }
                other => panic!("unexpected request verdict: {other:?}"),
            }
        }
        assert_eq!(granted, 4, "codex_default grants 4 request retries before escalating");

        let mut conn = escalate_retry_state(&req, RetryClass::Connection);
        let mut conn_granted = 0u32;
        for _ in 0..20 {
            let decision = StandardRetryDecider.verdict(&connect, &conn, &policy, samples);
            match decision.verdict {
                Verdict::Retry { .. } => {
                    granted += 1;
                    conn_granted += 1;
                    conn = decision.next;
                }
                Verdict::Exhausted => break,
                other => panic!("unexpected connection verdict: {other:?}"),
            }
        }
        assert_eq!(conn_granted, MAX_RETRIES_HARD_CAP - 4);
        assert_eq!(granted, MAX_RETRIES_HARD_CAP, "total Request + Connection retries must never exceed MAX_RETRIES_HARD_CAP");
    }

    #[test]
    fn tightened_backoff_never_exceeds_max_step_after_jitter() {
        let has_fallback = Arc::new(AtomicBool::new(true));
        let flag = has_fallback.clone();
        let budget = FallbackRetryBudget { max_retries: 2, max_step: Duration::from_secs(2), ..FallbackRetryBudget::default() };
        let decider = FallbackAwareRetryDecider::with_budget(Arc::new(move || flag.load(Ordering::SeqCst)), budget);
        let max_upward_jitter = JitterSamples { step: 1.0, advice: 1.0 };

        // xAI has a 2 s initial step with ±20% jitter (2.4 s unclipped at sample 1.0).
        let xai = crate::providers::compat::retry::xai();
        let transient = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
        let req = RetryState::new(RetryClass::Request, "grok-4".to_owned());
        let decision = decider.verdict(&transient, &req, &xai, max_upward_jitter);
        match decision.verdict {
            Verdict::Retry { delay, .. } => assert_eq!(delay, Duration::from_secs(2), "jittered tightened delay must not exceed max_step"),
            other => panic!("expected tightened retry, got {other:?}"),
        }

        // Exponential backoff on attempt 2 must also stay clamped to max_step after jitter.
        let mut exp_policy = RetryPolicy::codex_default();
        exp_policy.request = RetryRow::single(RetrySchedule {
            max_retries: 4,
            backoff: Backoff::Exponential { base: Duration::from_millis(1500) },
            jitter: Jitter::symmetric(0.2),
            advice: AdviceRule::honored_in_full(),
        });
        let first = decider.verdict(&transient, &req, &exp_policy, max_upward_jitter);
        match first.verdict {
            Verdict::Retry { delay, .. } => assert!(delay <= Duration::from_secs(2), "attempt 1 delay {delay:?} exceeded max_step"),
            other => panic!("expected attempt 1 retry, got {other:?}"),
        }
        let second = decider.verdict(&transient, &first.next, &exp_policy, max_upward_jitter);
        match second.verdict {
            Verdict::Retry { delay, .. } => assert_eq!(delay, Duration::from_secs(2), "attempt 2 exponential jittered delay must clamp to max_step"),
            other => panic!("expected attempt 2 retry, got {other:?}"),
        }

        // Retry-After advice within max_advice_ceiling (5 s) preserves Retry-After semantics (> max_step).
        let mut rate_limited = ProviderError::new(ErrorKind::RateLimited, DeliveryState::NotSent);
        rate_limited.status = Some(429);
        rate_limited.retry_after = Some(Duration::from_secs(4));
        let advised = decider.verdict(&rate_limited, &req, &xai, max_upward_jitter);
        assert!(matches!(advised.verdict, Verdict::Retry { delay, .. } if delay == Duration::from_secs(4)));

        // Without remaining fallbacks, full xAI jitter (+20% -> 2.4 s) applies normally.
        has_fallback.store(false, Ordering::SeqCst);
        let full = decider.verdict(&transient, &req, &xai, max_upward_jitter);
        assert!(matches!(full.verdict, Verdict::Retry { delay, .. } if delay == Duration::from_millis(2400)));
    }

    #[test]
    fn effective_caps_reflect_tightened_budget_and_hard_cap() {
        let codex = RetryPolicy::codex_default();
        let xai = crate::providers::compat::retry::xai();
        assert_eq!(effective_sequence_cap(&StandardRetryDecider, "m"), MAX_RETRIES_HARD_CAP);
        assert_eq!(effective_row_max_retries(&StandardRetryDecider, &codex, RetryClass::Request, "m"), 4);
        assert_eq!(effective_row_max_retries(&StandardRetryDecider, &codex, RetryClass::Recovery, "m"), 3);
        assert_eq!(effective_row_max_retries(&StandardRetryDecider, &codex, RetryClass::Connection, "m"), MAX_RETRIES_HARD_CAP);
        assert_eq!(effective_row_max_retries(&StandardRetryDecider, &xai, RetryClass::Request, "m"), MAX_RETRIES_HARD_CAP);

        let has_fallback = Arc::new(AtomicBool::new(true));
        let flag = has_fallback.clone();
        let decider = FallbackAwareRetryDecider::new(Arc::new(move || flag.load(Ordering::SeqCst)));
        assert_eq!(effective_sequence_cap(&decider, "m"), 1);
        assert_eq!(effective_row_max_retries(&decider, &codex, RetryClass::Request, "m"), 1);
        assert_eq!(effective_row_max_retries(&decider, &codex, RetryClass::Connection, "m"), 1);
        assert_eq!(effective_row_max_retries(&decider, &codex, RetryClass::Recovery, "m"), 0);

        has_fallback.store(false, Ordering::SeqCst);
        assert_eq!(effective_sequence_cap(&decider, "m"), MAX_RETRIES_HARD_CAP);
        assert_eq!(effective_row_max_retries(&decider, &codex, RetryClass::Request, "m"), 4);
        assert_eq!(effective_row_max_retries(&decider, &codex, RetryClass::Recovery, "m"), 3);
    }
}
