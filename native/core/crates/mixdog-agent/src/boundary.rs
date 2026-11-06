//! The request boundary: transcript repair, then the pre-send compaction pass
//! until the transcript stops changing. The loop owns when compaction runs and
//! what adopting its result resets; the [`Compactor`](crate::env::Compactor)
//! owns what the new transcript contains.

use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::Usage;

use crate::env::CompactError;
use crate::env::CompactEvent;
use crate::env::Dropped;
use crate::env::CompactRequest;
use crate::env::CompactTrigger;
use crate::env::Compactor;
use crate::env::RunEvent;
use crate::env::Rewrite;
use crate::env::Stage;
use crate::env::or_cancelled;
use crate::message::AgentMessage;
use crate::repair::repair_before_send;
use crate::run::AgentError;
use crate::run::CompactFailure;
use crate::run::ContextOverflow;
use crate::run::Run;
use crate::run::add_usage;

/// Post-compaction target: this share of the boundary.
const CONTEXT_SHARE_RATIO: f64 = 0.25;
const COMPACT_TARGET_MIN_TOKENS: u64 = 4_000;
const MAX_BUFFER_RATIO: f64 = 0.25;

/// Everything the policy is resolved from; the host reads config and the
/// route's catalog row into it.
#[derive(Clone, Debug, Default)]
pub struct CompactSettings {
    pub auto: bool,
    /// A delegated agent: its trigger keeps the established precedence.
    pub agent_owner: bool,
    pub context_window: Option<u64>,
    pub explicit_boundary: Option<u64>,
    /// An explicit limit below the boundary wins as the trigger.
    pub auto_limit: Option<u64>,
    pub buffer_tokens: u64,
    pub buffer_ratio: f64,
    /// Operator headroom (`compaction.reservedTokens`).
    pub configured_reserve_tokens: u64,
    /// Tool-schema share of every request.
    pub request_reserve_tokens: u64,
    pub target_tokens: Option<u64>,
    pub target_ratio: Option<f64>,
    pub target_min_tokens: Option<u64>,
    /// Provider token-count calibration (1.0 when the estimate is exact).
    pub token_calibration: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompactPolicy {
    pub boundary_tokens: u64,
    pub trigger_tokens: u64,
    pub reserve_tokens: u64,
    pub request_reserve_tokens: u64,
    pub configured_reserve_tokens: u64,
    pub target_tokens: u64,
    /// The reserve cannot leave any post-compact headroom: compact once only.
    pub single_shot: bool,
    pub context_window: u64,
    pub token_calibration: f64,
}

fn positive(value: Option<u64>) -> Option<u64> {
    value.filter(|v| *v > 0)
}

impl CompactPolicy {
    /// `None` when automatic compaction is off or no boundary is known.
    pub fn resolve(s: &CompactSettings) -> Option<Self> {
        if !s.auto {
            return None;
        }
        let window = positive(s.context_window);
        let boundary = match (positive(s.explicit_boundary), window) {
            (Some(explicit), Some(window)) => explicit.min(window),
            (Some(explicit), None) => explicit,
            (None, Some(window)) => window,
            (None, None) => positive(s.auto_limit)?,
        };
        let calibration = if s.token_calibration > 0.0 {
            s.token_calibration
        } else {
            1.0
        };
        let cap = (boundary as f64 * MAX_BUFFER_RATIO).floor() as u64;
        let buffer = if s.buffer_tokens > 0 {
            s.buffer_tokens.min(cap)
        } else {
            ((boundary as f64 * s.buffer_ratio.max(0.0)).floor() as u64).min(cap)
        };
        let explicit_limit = positive(s.auto_limit).filter(|limit| *limit < boundary);
        let policy_trigger = explicit_limit.unwrap_or_else(|| boundary.saturating_sub(buffer).max(1));
        let configured = s.configured_reserve_tokens;
        let reserve = s.request_reserve_tokens + configured;
        let target = match positive(s.target_tokens) {
            Some(explicit) => explicit.clamp(1, boundary),
            None => {
                let min_target = boundary.min(positive(s.target_min_tokens).unwrap_or(COMPACT_TARGET_MIN_TOKENS));
                let ratio = s
                    .target_ratio
                    .filter(|r| *r > 0.0)
                    .map(|r| if r > 1.0 { r / 100.0 } else { r })
                    .unwrap_or(CONTEXT_SHARE_RATIO);
                let by_ratio = ((boundary as f64 * ratio).floor() as u64).max(1);
                min_target.max(by_ratio).clamp(1, boundary)
            }
        };
        let legacy_target = (target + reserve).clamp(1, boundary);
        let single_shot = reserve >= policy_trigger;
        // Main sessions must not compact into their own next trigger: keep a
        // 1%-of-boundary (up to 1,024) gap above the post-compact target.
        let margin = ((boundary as f64 * 0.01).floor() as u64).clamp(1, 1_024);
        let base_trigger = if !single_shot && !s.agent_owner && explicit_limit.is_none() {
            policy_trigger.max(boundary.min(legacy_target + margin))
        } else {
            policy_trigger
        };
        let trigger = base_trigger.saturating_sub(configured).max(1);
        Some(Self {
            boundary_tokens: boundary,
            trigger_tokens: trigger,
            reserve_tokens: reserve,
            request_reserve_tokens: s.request_reserve_tokens.min(reserve),
            configured_reserve_tokens: configured,
            target_tokens: target,
            single_shot,
            context_window: window.unwrap_or(boundary),
            token_calibration: calibration,
        })
    }

    fn raw(&self, value: u64) -> u64 {
        ((value as f64 / self.token_calibration).floor() as u64).max(1)
    }

    /// The raw budget handed to the compactor.
    pub fn target_budget(&self) -> u64 {
        let raw_boundary = self.raw(self.boundary_tokens);
        let raw_target = self
            .raw(self.target_tokens)
            .min(raw_boundary)
            .saturating_sub(self.request_reserve_tokens)
            .max(1);
        let raw_trigger = if self.trigger_tokens > 0 {
            raw_boundary.min(self.raw(self.trigger_tokens))
        } else {
            0
        };
        let single = self.single_shot || (raw_trigger > 0 && self.reserve_tokens >= raw_trigger);
        let legacy = (raw_target + self.reserve_tokens).clamp(1, raw_boundary);
        if single || raw_trigger == 0 {
            return legacy;
        }
        legacy.min(raw_trigger - 1).max(1)
    }

    /// Provider-visible estimate: request/schema reserve included, operator
    /// headroom not.
    fn estimate_with_reserve(&self, message_tokens: u64) -> u64 {
        ((message_tokens + self.request_reserve_tokens) as f64 * self.token_calibration).round() as u64
    }
}

/// A provider reading that still describes a prefix of the transcript:
/// actual usage plus an estimate for what was appended after it.
#[derive(Clone, Copy, Debug)]
pub struct Baseline {
    tokens: u64,
    output_tokens: u64,
    /// Messages in the transcript when the request was sent.
    count: usize,
}

impl Baseline {
    /// The reading and the message count it covers. The assistant reply that
    /// followed the request is covered by its output usage; a continuation
    /// that appended no assistant message has its output removed instead.
    fn coverage(&self, messages: &[AgentMessage]) -> Option<(u64, usize)> {
        if self.count > messages.len() {
            return None;
        }
        match messages[self.count..]
            .iter()
            .position(|m| m.role() == Role::Assistant)
        {
            Some(offset) => Some((self.tokens, self.count + offset + 1)),
            None => Some((self.tokens.saturating_sub(self.output_tokens), self.count)),
        }
    }
}

impl Run {
    /// Records the provider's reading of the request just sent.
    pub(crate) fn record_baseline(&mut self, usage: &Usage) {
        let tokens = usage.input_tokens + usage.output_tokens;
        if usage.input_tokens == 0 || tokens == 0 {
            return;
        }
        self.baseline = Some(Baseline {
            tokens,
            output_tokens: usage.output_tokens,
            count: self.messages.len(),
        });
    }

    fn pressure_tokens(&self, policy: &CompactPolicy, compactor: &dyn Compactor, reactive: bool) -> u64 {
        let base = match self.baseline.and_then(|b| b.coverage(&self.messages)) {
            Some((tokens, count)) => {
                let growth = compactor.estimate_tokens(&self.messages[count..]);
                tokens + (growth as f64 * policy.token_calibration).round() as u64
            }
            None => policy.estimate_with_reserve(compactor.estimate_tokens(&self.messages)),
        };
        if reactive {
            base.max(policy.trigger_tokens.max(1))
        } else {
            base
        }
    }

    /// Repairs the transcript, then runs the compaction pass until the
    /// transcript stops changing (a changed transcript ends the request
    /// attempt: repair the new history and take one fresh snapshot).
    pub(crate) async fn prepare_request_boundary(&mut self) -> Result<(), AgentError> {
        // A soft compact target may remain above an explicit trigger: never
        // compact the same input twice before a provider attempt.
        let mut compact_attempted = false;
        loop {
            if repair_before_send(&mut self.messages) {
                // Provider readings belong to the old transcript.
                self.baseline = None;
                self.cross_turn.clear();
                self.env.sink.replace(&self.messages, &Rewrite::default());
            }
            let changed = self.pre_send_compact_pass(compact_attempted).await?;
            compact_attempted |= changed;
            if !changed {
                return Ok(());
            }
        }
    }

    /// The proactive/reactive compaction decision and execution before each
    /// provider request. Returns whether the transcript changed.
    async fn pre_send_compact_pass(&mut self, skip_proactive: bool) -> Result<bool, AgentError> {
        let (Some(compactor), Some(settings)) =
            (self.env.compactor.clone(), self.config.compact.clone())
        else {
            return Ok(false);
        };
        let Some(policy) = CompactPolicy::resolve(&settings) else {
            return Ok(false);
        };
        let reactive = self.reactive_overflow_retry_pending;
        let pressure = self.pressure_tokens(&policy, compactor.as_ref(), reactive);
        let trigger = policy.trigger_tokens.max(1);
        // Cache expiry and tool-result media arm a pass whatever the pressure.
        let cache_expired = compactor.cache_expired();
        let media_pressure = compactor.request_media(&self.messages);
        let mut should = !skip_proactive && (reactive || cache_expired || media_pressure || pressure >= trigger);
        let budget = if should {
            policy.target_budget()
        } else {
            policy.boundary_tokens
        };
        let trigger_kind = if reactive {
            CompactTrigger::Reactive
        } else if cache_expired {
            CompactTrigger::CacheExpired
        } else {
            CompactTrigger::Auto
        };
        // A proactive pass never replaces the transcript with an equal-sized
        // or larger one; media pressure compacts to drop bytes, not tokens.
        let require_reduction = !reactive && !media_pressure;
        if should && require_reduction {
            let request = CompactRequest {
                messages: &self.messages,
                budget_tokens: budget,
                trigger: trigger_kind.clone(),
                require_reduction,
                reference_latest_attachments: false,
            };
            should = compactor.reduces(&request).await;
        }
        self.emit(RunEvent::ContextPressure {
            used_tokens: pressure,
            trigger_tokens: policy.trigger_tokens,
            boundary_tokens: policy.boundary_tokens,
            will_compact: should,
        });
        if !should {
            return Ok(false);
        }
        self.emit(RunEvent::Stage(Stage::Compacting));
        // The one-shot reactive flag is consumed by this pass.
        self.reactive_overflow_retry_pending = false;
        let before = self.messages.len();
        let event = |changed: bool, failed: bool, after: usize, dropped_count: u64, dropped: Option<Dropped>| CompactEvent {
            dropped_count,
            dropped,
            trigger: trigger_kind.clone(),
            changed,
            failed,
            before_messages: before,
            after_messages: after,
            pressure_tokens: pressure,
            trigger_tokens: policy.trigger_tokens,
            boundary_tokens: policy.boundary_tokens,
            target_budget_tokens: budget,
        };
        let request = CompactRequest {
            messages: &self.messages,
            budget_tokens: budget,
            trigger: trigger_kind.clone(),
            require_reduction,
            reference_latest_attachments: reactive,
        };
        let outcome = or_cancelled(&self.cancel, compactor.compact(request))
            .await
            .ok_or(AgentError::Aborted)?;
        let output = match outcome {
            Ok(output) => output,
            Err(CompactError::Aborted) => return Err(AgentError::Aborted),
            Err(error) => {
                self.emit(RunEvent::Compact(event(false, true, before, 0, None)));
                // Agent mode retries a failed compaction quietly once per
                // turn: the context is still under the model's boundary and
                // the next send's pass compacts again.
                if self.config.agent_mode
                    && !self.quiet_compact_retry_used
                    && matches!(error, CompactError::Failed(_))
                {
                    self.quiet_compact_retry_used = true;
                    return Ok(false);
                }
                return Err(self.compact_error(error, &policy, budget, pressure));
            }
        };
        if let Some(usage) = &output.usage {
            self.last_usage = Some(add_usage(self.last_usage.take(), usage));
            if self.first_turn_usage.is_none() {
                self.first_turn_usage = Some(usage.clone());
            }
        }
        let changed = output.messages != self.messages;
        let rewrite = Rewrite { dropped_count: output.dropped_count, dropped: output.dropped };
        if changed {
            self.adopt_compacted(output.messages, &rewrite);
        }
        self.emit(RunEvent::Compact(event(changed, false, self.messages.len(), rewrite.dropped_count, rewrite.dropped)));
        Ok(changed)
    }

    /// Replaces the live transcript and resets everything keyed to the old
    /// transcript shape.
    fn adopt_compacted(&mut self, compacted: Vec<AgentMessage>, rewrite: &Rewrite) {
        self.messages = compacted;
        self.env.sink.replace(&self.messages, rewrite);
        // Provider readings and the request in flight described the old shape.
        self.baseline = None;
        // Receipts point at tool results compaction just removed from context.
        self.cross_turn.clear();
        // Compaction starts a new loop epoch: iteration indices count from the
        // compacted transcript.
        self.iterations = 0;
    }

    fn compact_error(
        &self,
        error: CompactError,
        policy: &CompactPolicy,
        budget: u64,
        pressure: u64,
    ) -> AgentError {
        let provider = self.provider.id().to_string();
        match error {
            CompactError::Aborted => AgentError::Aborted,
            CompactError::Overflow(cause) => {
                AgentError::ContextOverflow(Box::new(ContextOverflow {
                    stage: "pre_send",
                    provider,
                    model: self.model.clone(),
                    context_window: Some(policy.context_window),
                    budget_tokens: Some(budget),
                    reserve_tokens: Some(policy.reserve_tokens),
                    message_tokens_est: Some(pressure),
                    cause: Some(cause),
                }))
            }
            CompactError::Failed(cause) => AgentError::CompactFailed(Box::new(CompactFailure {
                stage: "pre_send",
                provider,
                model: self.model.clone(),
                cause,
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(window: u64) -> CompactSettings {
        CompactSettings {
            auto: true,
            context_window: Some(window),
            token_calibration: 1.0,
            ..CompactSettings::default()
        }
    }

    #[test]
    fn full_window_trigger_and_quarter_target() {
        let policy = CompactPolicy::resolve(&settings(200_000)).unwrap();
        assert_eq!(policy.boundary_tokens, 200_000);
        assert_eq!(policy.trigger_tokens, 200_000);
        assert_eq!(policy.target_tokens, 50_000);
        // below the trigger by the 1% margin (up to 1,024) above the target
        assert!(policy.target_budget() < policy.trigger_tokens);
        assert!(!policy.single_shot);
    }

    #[test]
    fn explicit_limit_below_boundary_is_the_trigger() {
        let mut s = settings(200_000);
        s.auto_limit = Some(120_000);
        let policy = CompactPolicy::resolve(&s).unwrap();
        assert_eq!(policy.trigger_tokens, 120_000);
    }

    #[test]
    fn reserve_at_the_trigger_means_one_shot() {
        let mut s = settings(10_000);
        s.request_reserve_tokens = 10_000;
        let policy = CompactPolicy::resolve(&s).unwrap();
        assert!(policy.single_shot);
    }

    #[test]
    fn no_boundary_or_auto_off_resolves_to_none() {
        assert!(CompactPolicy::resolve(&CompactSettings::default()).is_none());
        let mut s = settings(1_000);
        s.auto = false;
        assert!(CompactPolicy::resolve(&s).is_none());
    }
}
