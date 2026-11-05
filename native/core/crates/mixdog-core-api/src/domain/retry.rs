//! The one retry policy (PW §4, SPEC §4.9). Per-provider attempt counts and
//! delays are data rows of [`RetryPolicy`]; one [`RetryDecider`] turns a typed
//! [`ProviderError`] plus the attempt state into a [`Verdict`]. There is no
//! second retry loop and no stall budget.

use std::time::Duration;

use super::provider::{DeliveryState, ErrorKind, ProviderError};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum JitterMode {
    Symmetric,
    Positive,
    Negative,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Jitter {
    /// In `0.0..=1.0`.
    pub ratio: f64,
    pub mode: JitterMode,
}

impl Jitter {
    pub const NONE: Self = Self {
        ratio: 0.0,
        mode: JitterMode::Symmetric,
    };
    pub const fn symmetric(ratio: f64) -> Self {
        Self {
            ratio,
            mode: JitterMode::Symmetric,
        }
    }

    /// `wait` jittered by one draw `sample` in `0.0..=1.0`, exactly as
    /// `jitterDelayMs`: offset `(2·sample − 1)·r·wait` (symmetric),
    /// `sample·r·wait` (positive) or `−sample·r·wait` (negative), rounded to
    /// whole milliseconds and never negative.
    pub fn apply(&self, wait: Duration, sample: f64) -> Duration {
        let ratio = self.ratio.clamp(0.0, 1.0);
        if ratio == 0.0 || wait.is_zero() {
            return wait;
        }
        let factor = match self.mode {
            JitterMode::Symmetric => sample * 2.0 - 1.0,
            JitterMode::Positive => sample,
            JitterMode::Negative => -sample,
        };
        let base_ms = wait.as_secs_f64() * 1000.0;
        Duration::from_millis((base_ms + factor * ratio * base_ms).round().max(0.0) as u64)
    }
}

/// One independent draw per jitter the verdict may apply, each in
/// `0.0..=1.0` (a `Math.random()` value), supplied by the caller so the
/// verdict is a pure function.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct JitterSamples {
    /// For the row's backoff step.
    pub step: f64,
    /// For the advice rule's jitter, at either [`JitterStage`].
    pub advice: f64,
}

#[derive(Clone, PartialEq, Debug)]
pub enum Backoff {
    /// Step `n` (1-based) waits `steps[min(n, len) - 1]`.
    Ladder(Vec<Duration>),
    /// `base · 2^(n−1)`.
    Exponential { base: Duration },
}

/// One retry budget: count, step ladder, step jitter and advice handling.
#[derive(Clone, PartialEq, Debug)]
pub struct RetrySchedule {
    /// Retries after the first failure counted against this schedule.
    pub max_retries: u32,
    pub backoff: Backoff,
    pub jitter: Jitter,
    /// How server advice combines with this schedule's step.
    pub advice: AdviceRule,
}

/// A second schedule for one typed [`ErrorKind`], with its own count and
/// waited total (e.g. Antigravity capacity and RPM). It takes a failure of
/// its kind that the row's schedule does not retry: a status the policy
/// keeps from the row (a 429 with `retry_429` off) or a spent row count, a
/// ceiling or a budget.
#[derive(Clone, PartialEq, Debug)]
pub struct KindSchedule {
    /// Set by the adapter's classification from the wire (status, provider
    /// error code field), never from error text.
    pub kind: ErrorKind,
    pub schedule: RetrySchedule,
    /// A retry under this schedule starts the row's schedule afresh (its
    /// count and waited total return to zero).
    pub resets_base: bool,
}

#[derive(Clone, PartialEq, Debug)]
pub struct RetryRow {
    /// Governs every failure first.
    pub schedule: RetrySchedule,
    /// At most one entry per kind.
    pub by_kind: Vec<KindSchedule>,
}

impl RetryRow {
    /// A row with one schedule for every kind.
    pub fn single(schedule: RetrySchedule) -> Self {
        Self {
            schedule,
            by_kind: Vec::new(),
        }
    }

    pub fn kind_schedule(&self, kind: ErrorKind) -> Option<&KindSchedule> {
        self.by_kind.iter().find(|entry| entry.kind == kind)
    }
}

/// Which row governs the current failure.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum RetryClass {
    /// Before a response status arrived.
    Request,
    /// After the stream started.
    Midstream,
    /// Session-level replay after a transport failure.
    Transport,
    /// Session-level replay after a connect failure.
    Connection,
    /// Session-level replay after provider recovery is exhausted while the
    /// server is unavailable.
    Recovery,
}

/// How server advice (Retry-After, `RetryInfo`, reset deadlines) combines
/// with the row's jittered backoff step.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AdviceCombine {
    /// Wait `max(advice, step)`.
    Floor,
    /// The advice replaces the step.
    Replace,
}

/// Where an [`AdviceRule`]'s jitter applies.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JitterStage {
    /// On the clamped advice, before `combine`.
    Advice,
    /// On the combined wait, after `combine` (a floor that wins is jittered
    /// again).
    Wait,
}

/// Advice handling of one [`RetrySchedule`], applied in this order:
/// `ceiling` on the raw advice; `budget` on the raw advice plus the
/// schedule's waited total; `clamp`; `jitter` at [`JitterStage::Advice`];
/// `combine` with the jittered step; `jitter` at [`JitterStage::Wait`].
/// Statuses in `raw_statuses` skip `clamp` and `jitter`.
///
/// PW §4.2 rows as data, per row ("in full" = [`AdviceRule::honored_in_full`]):
/// - Antigravity request (`antigravity-retry-policy.mjs`, `retry_429` off):
///   the row schedule is 3 retries at 1/2/4 s ±10 %, in full; `Overloaded`
///   (capacity) has its own 3 retries at 1/2/4 s ±10 %, `Floor`, 60 s
///   `budget`; `RateLimited` (RPM) has 1 retry at an unjittered 1 s, in full
///   with a 60 s ceiling; both kind schedules reset the row's schedule;
/// - request: the shared `withRetry` default (Anthropic, OpenAI/Codex HTTP)
///   is in full; Gemini is `Floor` with `Positive` 0.2 jitter at `Wait` and
///   a 300 s ceiling; xai is `Replace` with a 30 s clamp, symmetric 0.2
///   jitter at `Advice` and `raw_statuses = [429]`; deepseek,
///   muse-code-oauth, mimo-oauth and unprofiled compat providers are in full
///   with ceilings of 10 s, 60 s, 300 s and 60 s; command-code-oauth is
///   `Floor` with a 60 s ceiling;
/// - midstream (`midstreamRetryDelayMs`): in full; Gemini adds the 300 s
///   ceiling;
/// - transport, connection and recovery (session-level replay): in full.
#[derive(Clone, PartialEq, Debug)]
pub struct AdviceRule {
    pub combine: AdviceCombine,
    /// Raw advice beyond this is not waited: the verdict is `Exhausted`.
    pub ceiling: Option<Duration>,
    /// Cap on the schedule's waited total ([`ScheduleCount::waited`]) plus
    /// the raw advice; exceeding it is `Exhausted`.
    pub budget: Option<Duration>,
    /// Advice above this is waited as this value.
    pub clamp: Option<Duration>,
    /// `Positive` never shortens the advice.
    pub jitter: Jitter,
    pub jitter_stage: JitterStage,
    /// Statuses whose advice skips `clamp` and `jitter`.
    pub raw_statuses: Vec<u16>,
}

impl AdviceRule {
    /// Advice replaces the step and is waited in full: no ceiling, clamp or
    /// jitter.
    pub fn honored_in_full() -> Self {
        Self {
            combine: AdviceCombine::Replace,
            ceiling: None,
            budget: None,
            clamp: None,
            jitter: Jitter::NONE,
            jitter_stage: JitterStage::Advice,
            raw_statuses: Vec::new(),
        }
    }
}

#[derive(Clone, PartialEq, Debug, Default)]
pub struct StatusRules {
    /// Statuses that always surface.
    pub terminal: Vec<u16>,
    /// When set, only these statuses retry.
    pub retry_only: Option<Vec<u16>>,
    /// Per-status retry caps.
    pub caps: Vec<(u16, u32)>,
    pub retry_429: bool,
    pub retry_529: bool,
    pub retry_499: bool,
}

#[derive(Clone, PartialEq, Debug, Default)]
pub struct OverloadRule {
    /// Consecutive overloads before falling back.
    pub fallback_after: Option<u32>,
    pub fallback_model: Option<String>,
    pub stop_after_repeated: bool,
}

#[derive(Clone, PartialEq, Debug)]
pub struct RetryPolicy {
    pub request: RetryRow,
    pub midstream: RetryRow,
    pub transport: RetryRow,
    pub connection: RetryRow,
    /// `None` where the provider disables recovery cycles.
    pub recovery: Option<RetryRow>,
    pub status: StatusRules,
    pub overload: OverloadRule,
    /// `x-should-retry: true` forces a retry.
    pub honor_should_retry_true: bool,
    pub final_on_exhaust: bool,
    /// How many times an attempt that completed with no text, no reasoning
    /// and no tool call is asked again before the empty response is
    /// final; `None` (the default) never re-asks. Set per provider row.
    pub empty_response_reasks: Option<u32>,
}

const fn secs(s: u64) -> Duration {
    Duration::from_secs(s)
}

impl RetryPolicy {
    /// Defaults for a provider without a profile: Codex request/stream rows
    /// (4 and 5 retries, exponential 200 ms, ±10 %) and today's session
    /// ladders (PW §4.2) as the transport, connection and recovery rows;
    /// every row waits advice in full.
    pub fn codex_default() -> Self {
        let exp = |max_retries| {
            RetryRow::single(RetrySchedule {
                max_retries,
                backoff: Backoff::Exponential {
                    base: Duration::from_millis(200),
                },
                jitter: Jitter::symmetric(0.1),
                advice: AdviceRule::honored_in_full(),
            })
        };
        let ladder = |steps: Vec<Duration>| {
            RetryRow::single(RetrySchedule {
                max_retries: steps.len() as u32,
                backoff: Backoff::Ladder(steps),
                jitter: Jitter::symmetric(0.1),
                advice: AdviceRule::honored_in_full(),
            })
        };
        let mut connection = vec![secs(5), secs(10), secs(20), secs(40)];
        connection.extend(std::iter::repeat_n(secs(60), 9));
        Self {
            request: exp(4),
            midstream: exp(5),
            transport: ladder(vec![secs(5), secs(15), secs(30)]),
            connection: ladder(connection),
            recovery: Some(ladder(vec![
                secs(15),
                secs(30),
                secs(60),
                secs(60),
                secs(60),
            ])),
            status: StatusRules {
                retry_429: true,
                retry_529: true,
                ..StatusRules::default()
            },
            overload: OverloadRule::default(),
            honor_should_retry_true: false,
            final_on_exhaust: false,
            empty_response_reasks: None,
        }
    }

    pub fn row(&self, class: RetryClass) -> Option<&RetryRow> {
        match class {
            RetryClass::Request => Some(&self.request),
            RetryClass::Midstream => Some(&self.midstream),
            RetryClass::Transport => Some(&self.transport),
            RetryClass::Connection => Some(&self.connection),
            RetryClass::Recovery => self.recovery.as_ref(),
        }
    }
}

/// What one schedule has used so far.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct ScheduleCount {
    /// Retries already scheduled under it.
    pub retries: u32,
    /// Total of their delays.
    pub waited: Duration,
}

/// The retry state of one row's loop. Only a [`RetryDecider`] advances it:
/// callers start from [`RetryState::new`] and store each
/// [`Decision::next`]; the fields are private so no caller edits counts.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RetryState {
    class: RetryClass,
    model: String,
    base: ScheduleCount,
    by_kind: Vec<(ErrorKind, ScheduleCount)>,
    consecutive_overloads: u32,
}

impl RetryState {
    pub fn new(class: RetryClass, model: impl Into<String>) -> Self {
        Self {
            class,
            model: model.into(),
            base: ScheduleCount::default(),
            by_kind: Vec::new(),
            consecutive_overloads: 0,
        }
    }

    pub fn class(&self) -> RetryClass {
        self.class
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn consecutive_overloads(&self) -> u32 {
        self.consecutive_overloads
    }

    /// Counts of the row's schedule (`None`) or of a kind's schedule.
    pub fn count(&self, kind_schedule: Option<ErrorKind>) -> ScheduleCount {
        match kind_schedule {
            None => self.base,
            Some(kind) => self
                .by_kind
                .iter()
                .find(|(k, _)| *k == kind)
                .map(|(_, count)| *count)
                .unwrap_or_default(),
        }
    }

    /// The state after a failure of `kind` that is not retried.
    pub fn after_failure(&self, kind: ErrorKind) -> Self {
        let mut next = self.clone();
        if kind == ErrorKind::Overloaded {
            next.consecutive_overloads += 1;
        }
        next
    }

    /// The state after a failure of `kind` retried after `delay`, under the
    /// row's schedule (`under = None`) or under a kind's schedule.
    pub fn after_retry(
        &self,
        kind: ErrorKind,
        under: Option<&KindSchedule>,
        delay: Duration,
    ) -> Self {
        let mut next = self.after_failure(kind);
        let bump = |count: &mut ScheduleCount| {
            count.retries += 1;
            count.waited += delay;
        };
        match under {
            None => bump(&mut next.base),
            Some(entry) => {
                match next.by_kind.iter_mut().find(|(k, _)| *k == entry.kind) {
                    Some((_, count)) => bump(count),
                    None => next.by_kind.push((
                        entry.kind,
                        ScheduleCount {
                            retries: 1,
                            waited: delay,
                        },
                    )),
                }
                if entry.resets_base {
                    next.base = ScheduleCount::default();
                }
            }
        }
        next
    }
}

/// A verdict and the state to keep for the next failure.
#[derive(Clone, PartialEq, Debug)]
pub struct Decision {
    pub verdict: Verdict,
    pub next: RetryState,
}

/// UI/trace reason for a `reconnecting` stage; fixed phrases, no error text.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RetryReason {
    RateLimited,
    Overloaded,
    ServerError,
    Auth,
    Transport,
    Other,
}

#[derive(Clone, PartialEq, Debug)]
pub enum Verdict {
    Retry {
        delay: Duration,
        reason: RetryReason,
        /// For the retry trace and logs; no user-visible text.
        delivery: DeliveryState,
    },
    Surface,
    Exhausted,
    Fallback {
        model: String,
    },
}

/// The single verdict function (PW §4.1 order, typed fields only).
pub trait RetryDecider: Send + Sync {
    /// Jitter is applied with [`Jitter::apply`] on the draws in `samples`.
    /// The returned state is built with [`RetryState::after_retry`] or
    /// [`RetryState::after_failure`]; the caller stores it as is.
    fn verdict(
        &self,
        error: &ProviderError,
        state: &RetryState,
        policy: &RetryPolicy,
        samples: JitterSamples,
    ) -> Decision;
}
