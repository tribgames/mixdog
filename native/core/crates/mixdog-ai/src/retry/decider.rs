//! The production verdict, PW §4.1 over typed fields only.

use std::time::Duration;

use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::retry::AdviceCombine;
use mixdog_core_api::domain::retry::Backoff;
use mixdog_core_api::domain::retry::Decision;
use mixdog_core_api::domain::retry::JitterSamples;
use mixdog_core_api::domain::retry::JitterStage;
use mixdog_core_api::domain::retry::KindSchedule;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::retry::RetryReason;
use mixdog_core_api::domain::retry::RetrySchedule;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::ScheduleCount;
use mixdog_core_api::domain::retry::Verdict;
use rand::Rng;

/// Cloudflare edge statuses that no retry can change.
const TERMINAL_EDGE_STATUSES: [u16; 2] = [525, 526];

/// One draw per jitter, as a caller of the verdict supplies them.
pub fn random_samples() -> JitterSamples {
    let mut rng = rand::rng();
    JitterSamples {
        step: rng.random(),
        advice: rng.random(),
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct StandardRetryDecider;

impl RetryDecider for StandardRetryDecider {
    fn verdict(
        &self,
        error: &ProviderError,
        state: &RetryState,
        policy: &RetryPolicy,
        samples: JitterSamples,
    ) -> Decision {
        let stop = |verdict| Decision {
            verdict,
            next: state.after_failure(error.kind),
        };
        let status = error.status;
        let rules = &policy.status;

        // Replay boundary: output the caller already saw or dispatched can
        // not be taken back; a cut tool input is replayed by the agent loop.
        let exposure = error.exposure;
        if exposure.text_emitted || exposure.tool_dispatched || exposure.tool_input_cut {
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
                || rules
                    .retry_only
                    .as_ref()
                    .is_some_and(|only| !only.contains(&status));
            if refused || (status == 529 && !rules.retry_529) {
                return stop(Verdict::Surface);
            }
        }
        // Overload: repeated capacity refusals fall back to another model or
        // end the send.
        if error.kind == ErrorKind::Overloaded || status == Some(529) {
            let seen = state.consecutive_overloads() + 1;
            let overload = &policy.overload;
            if overload.fallback_after.is_some_and(|after| seen >= after) {
                match &overload.fallback_model {
                    Some(model) if model != state.model() => {
                        return Decision {
                            verdict: Verdict::Fallback {
                                model: model.clone(),
                            },
                            next: state.after_failure(error.kind),
                        };
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
        let retry = |delay, under| Decision {
            verdict: Verdict::Retry {
                delay,
                reason: reason_of(error),
                delivery: error.delivery,
            },
            next: state.after_retry(error.kind, under, delay),
        };
        // A per-status cap bounds the retries of that status. The state
        // counts retries per kind, so a capped status is counted under its
        // kind (a kind without its own schedule): cap 1 on 429 means one
        // retry of the rate limit, then the error stands. Overload counts
        // consecutive failures itself and takes no cap.
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
            if let Some(delay) = wait_under(error, &row.schedule, state.count(None), samples) {
                let counted = KindSchedule {
                    kind: error.kind,
                    schedule: row.schedule.clone(),
                    resets_base: false,
                };
                let next = state
                    .after_retry(error.kind, None, delay)
                    .after_retry(error.kind, Some(&counted), Duration::ZERO);
                return Decision {
                    verdict: Verdict::Retry {
                        delay,
                        reason: reason_of(error),
                        delivery: error.delivery,
                    },
                    next,
                };
            }
        }
        // The row's own schedule governs first; a kind schedule takes what
        // it leaves (a status kept from the row, a spent count or budget).
        if row_retries
            && let Some(delay) = wait_under(error, &row.schedule, state.count(None), samples)
        {
            return retry(delay, None);
        }
        if let Some(entry) = row.kind_schedule(error.kind) {
            return match wait_under(error, &entry.schedule, state.count(Some(entry.kind)), samples)
            {
                Some(delay) => retry(delay, Some(entry)),
                None => stop(Verdict::Exhausted),
            };
        }
        stop(if row_retries {
            Verdict::Exhausted
        } else {
            Verdict::Surface
        })
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
fn wait_under(
    error: &ProviderError,
    schedule: &RetrySchedule,
    used: ScheduleCount,
    samples: JitterSamples,
) -> Option<Duration> {
    if used.retries >= schedule.max_retries {
        return None;
    }
    let attempt = used.retries + 1;
    let step = match &schedule.backoff {
        Backoff::Ladder(steps) => steps
            .get((attempt as usize).min(steps.len()).wrapping_sub(1))
            .copied()
            .unwrap_or_default(),
        Backoff::Exponential { base } => {
            base.saturating_mul(2u32.saturating_pow(attempt - 1))
        }
    };
    let step = schedule.jitter.apply(step, samples.step);
    let Some(advice) = error.retry_after else {
        return Some(step);
    };
    let rule = &schedule.advice;
    if rule.ceiling.is_some_and(|ceiling| advice > ceiling) {
        return None;
    }
    if rule
        .budget
        .is_some_and(|budget| used.waited + advice > budget)
    {
        return None;
    }
    let raw = error
        .status
        .is_some_and(|status| rule.raw_statuses.contains(&status));
    let jittered = |stage, wait: Duration| {
        if raw || rule.jitter_stage != stage {
            wait
        } else {
            rule.jitter.apply(wait, samples.advice)
        }
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