//! The loop's [`Compactor`]: the rule-only rebuild, with a model-written
//! handoff replacing the conversation when the conversation is large enough to
//! need one.

use std::sync::Arc;

use super::blob_reads::{BlobReads, with_blobs};
use async_trait::async_trait;
use mixdog_core_api::domain::provider::Usage;
use mixdog_protocol::ProviderId;
use mixdog_protocol::message_class::user_text::UserText;

use super::conversation::conversation_compaction_input;
use super::dropped::Redactor;
use super::dropped::dropped_summary;
use super::estimate::MediaMeter;
use super::estimate::MessageMeter;
use super::execution_tail::MessageRows;
use super::execution_tail::TailContext;
use super::fresh::AttachmentSeam;
use super::fresh::FreshContext;
use super::fresh::FreshError;
use super::fresh::FreshOptions;
use super::fresh::fresh_context_compact_messages_with_skills;
use super::skills::CurrentSkills;
use super::summary_run::ForkSource;
use super::summary_run::Generated;
use super::summary_run::RouteResolver;
use super::summary_run::RouteStep;
use super::summary_run::SummarizeContext;
use super::summary_run::SummaryMode;
use super::summary_run::elapsed_ms;
use super::summary_run::plan;
use super::summary_run::summarize_on_plan;
use super::triggers::ToolMediaMeter;
use super::triggers::should_compact_for_request_media;
use crate::boundary::CompactPolicy;
use crate::boundary::CompactSettings;
use crate::env::CompactError;
use crate::env::CompactOutput;
use crate::env::CompactRequest;
use crate::env::Compactor;
use crate::env::SeatedRoute;
use crate::env::SummaryRouteUsed;
use crate::message::AgentMessage;
use crate::offload::ArtifactStore;

pub use super::summary_run::SUMMARY_OUTPUT_TOKENS;

/// Floor of the post-compact target (`COMPACT_TARGET_MIN_TOKENS`).
const COMPACT_TARGET_MIN_TOKENS: u64 = 4_000;
/// Conversation summarization triggers independently of the post-compact
/// target: at 5% of the window, capped so a large window does not carry tens
/// of thousands of tokens of verbatim dialogue through every compaction.
const CONVERSATION_COMPACT_TRIGGER_RATIO: f64 = 0.05;
const CONVERSATION_COMPACT_TRIGGER_MAX_TOKENS: u64 = 20_000;

pub struct Handoff {
    pub text: String,
    /// Summary-model usage, billed to the turn.
    pub usage: Option<Usage>,
    /// The usage convention of the adapter that sent the summary.
    pub input_excludes_cache: bool,
    /// Whole milliseconds the summary request took (`generated.diagnostics.durationMs`).
    pub summary_ms: f64,
    /// The route that wrote it; `None` for a source that does not say.
    pub route: Option<SummaryRouteUsed>,
}

/// The conversation summary: whether the conversation is large enough to
/// need one, and the summary itself.
#[async_trait]
pub trait HandoffSource: Send + Sync {
    /// Whether the conversation reaches the summary threshold.
    async fn triggered(&self, messages: &[AgentMessage]) -> bool;

    /// Cancel-safe. Called only when [`triggered`](Self::triggered).
    async fn handoff(&self, messages: &[AgentMessage], budget_tokens: u64) -> Result<Handoff, CompactError>;

    /// This source for the route the run moved to: its window-derived budgets from the route's compaction settings, and
    /// whatever it resolves from the session's route following the seated provider; `None` when it follows nothing.
    fn resized(&self, seated: &SeatedRoute) -> Option<Arc<dyn HandoffSource>> {
        let _ = seated;
        None
    }
}

/// Session facts the rebuild is sized by.
#[derive(Clone, Debug, Default)]
pub struct CompactorConfig {
    pub reserve_tokens: u64,
    /// The hard budget the soft target may widen toward.
    pub max_budget_tokens: u64,
    pub context_window: u64,
    pub handoff_token_cap: Option<u64>,
}

impl CompactorConfig {
    /// The policy `settings` resolve to with `auto` forced on, and the sizing a compactor takes from it: a manual or
    /// auto-clear compaction needs the same numbers while automatic compaction is off. `None` when no boundary is known.
    fn sized_by(settings: &CompactSettings) -> Option<(CompactPolicy, Self)> {
        let policy = CompactPolicy::resolve(&CompactSettings { auto: true, ..settings.clone() })?;
        let context_window = policy.context_window.unwrap_or(policy.boundary_tokens);
        let max_budget_tokens = 1.max((context_window as f64 / policy.token_calibration).floor() as u64);
        let config = Self { reserve_tokens: policy.reserve_tokens, max_budget_tokens, context_window, handoff_token_cap: None };
        Some((policy, config))
    }
}

/// Everything a pass reads the transcript through.
pub struct FreshParts {
    pub media: Arc<dyn MediaMeter>,
    pub replay_owner: ProviderId,
    pub rows: Arc<dyn MessageRows>,
    /// Where the dropped execution is stored; a preview only computes the reference.
    pub archive: Arc<dyn ArtifactStore>,
    pub attachments: Arc<dyn AttachmentSeam>,
    /// The session's sensitive-value redaction, applied before a dropped row's visibility is judged.
    pub redactor: Arc<dyn Redactor>,
    /// The attachment store the transcript reads user text from.
    pub blobs: Arc<dyn BlobReads>,
    pub skills: Option<Arc<dyn CurrentSkills>>,
}

impl FreshParts {
    fn meter(&self) -> MessageMeter<'_> {
        MessageMeter { media: &*self.media, replay_owner: &self.replay_owner }
    }

    fn context<'a>(&'a self, meter: &'a MessageMeter<'a>, preview: bool) -> FreshContext<'a> {
        FreshContext {
            tail: TailContext { meter, rows: &*self.rows, archive: &*self.archive, redactor: &*self.redactor, preview },
            attachments: &*self.attachments,
        }
    }
}

/// The values the always-arming media trigger is judged from.
pub struct TriggerSeams {
    pub tool_media: Arc<dyn ToolMediaMeter>,
    /// The provider takes PDFs natively (false: they lower to text).
    pub native_pdf: bool,
}

pub struct FreshCompactor {
    pub parts: Arc<FreshParts>,
    pub triggers: Option<TriggerSeams>,
    pub summary: Option<Arc<dyn HandoffSource>>,
    pub config: CompactorConfig,
}

/// What a session's compactor is wired from: the route's compaction settings, the transcript
/// seams, and the summary's fork source and route resolver.
pub struct SessionCompactor {
    /// The settings the loop's policy is resolved from; `auto` is not read (see
    /// [`FreshCompactor::for_session`]).
    pub settings: CompactSettings,
    pub parts: Arc<FreshParts>,
    pub triggers: TriggerSeams,
    pub fork: Arc<dyn ForkSource>,
    pub resolver: Arc<dyn RouteResolver>,
    /// `normalizeCompactionSummaryMode(config.compaction)`.
    pub summary_mode: SummaryMode,
    /// `session.compaction.conversationThresholdTokens`.
    pub conversation_threshold_tokens: Option<u64>,
}

fn failure(error: FreshError) -> CompactError {
    CompactError::Failed(error.message().to_owned())
}

impl FreshCompactor {
    /// A session's compactor, sized by the policy the settings resolve to with `auto` forced
    /// on, because a manual or auto-clear compaction needs the same numbers while automatic
    /// compaction is off. The reserve is the policy's, the window is the session's (else the
    /// boundary), and the hard budget is the window in the provider's calibrated tokens.
    /// `None` when the session knows no boundary: a forced compaction then fails with
    /// "no context window is available".
    pub fn for_session(session: SessionCompactor) -> Option<Arc<Self>> {
        let (summary, config) = PlannedHandoff::for_session(&session)?;
        Some(Arc::new(Self { parts: session.parts, triggers: Some(session.triggers), summary: Some(Arc::new(summary)), config }))
    }

    async fn dropped_by(&self, before: &[AgentMessage], after: &[AgentMessage]) -> Result<(u64, Option<crate::env::Dropped>), CompactError> {
        if after == before {
            return Ok((0, None));
        }
        let (before, after) = (before.to_vec(), after.to_vec());
        let (rows, redactor) = (Arc::clone(&self.parts.rows), Arc::clone(&self.parts.redactor));
        with_blobs(&*self.parts.blobs, move |blobs| dropped_summary(&before, &after, &*rows, &*redactor, &mut UserText::new(blobs)))
            .await
            .map_err(|unavailable| CompactError::Failed(unavailable.to_string()))
    }

    fn options(&self, request: &CompactRequest<'_>, handoff_text: String, preview: bool, preview_summary: bool) -> FreshOptions {
        FreshOptions {
            reserve_tokens: self.config.reserve_tokens,
            max_budget_tokens: self.config.max_budget_tokens,
            context_window: self.config.context_window,
            handoff_token_cap: self.config.handoff_token_cap,
            handoff_text,
            active_turn: request.active_turn,
            reference_latest_attachments: request.reference_latest_attachments,
            force: true,
            preview,
            preview_summary,
            latest_user_prefix: request.latest_user_prefix.to_owned(),
        }
    }
}

#[async_trait]
impl Compactor for FreshCompactor {
    fn resized(&self, seated: &SeatedRoute) -> Option<Arc<dyn Compactor>> {
        let (_, config) = CompactorConfig::sized_by(&seated.settings)?;
        Some(Arc::new(Self {
            parts: self.parts.clone(),
            triggers: self.triggers.as_ref().map(|t| TriggerSeams { tool_media: t.tool_media.clone(), native_pdf: t.native_pdf }),
            summary: self.summary.as_ref().map(|summary| summary.resized(seated).unwrap_or_else(|| summary.clone())),
            config: CompactorConfig { handoff_token_cap: self.config.handoff_token_cap, ..config },
        }))
    }

    fn estimate_tokens(&self, messages: &[AgentMessage]) -> u64 {
        let meter = self.parts.meter();
        let tokens = meter.compact_messages(messages);
        // The transcript estimate prices every PDF as a native document; a provider that takes PDFs as text sends at most the extraction budget.
        match &self.triggers {
            Some(triggers) if !triggers.native_pdf => tokens.saturating_sub(meter.text_pdf_discount(messages)),
            _ => tokens,
        }
    }

    async fn prepare(&self, messages: &[AgentMessage]) {
        let _ = self.parts.media.prepare(messages).await;
    }

    /// Compares like-for-like local estimates using the actual rules; no
    /// model call and no archive write. A summary reserves its output ceiling
    /// instead of assuming a compression ratio.
    async fn reduces(&self, request: &CompactRequest<'_>) -> bool {
        self.prepare(request.messages).await;
        let meter = self.parts.meter();
        let summary_triggered = match self.summary.as_ref() {
            Some(summary) => summary.triggered(request.messages).await,
            None => false,
        };
        let ctx = self.parts.context(&meter, true);
        let options = self.options(request, String::new(), true, summary_triggered);
        match fresh_context_compact_messages_with_skills(&ctx, request.messages, request.budget_tokens, &options, self.parts.skills.as_deref()).await {
            Ok(result) => {
                let after = meter.compact_messages(&result.messages) + if summary_triggered { SUMMARY_OUTPUT_TOKENS } else { 0 };
                after < meter.compact_messages(request.messages)
            }
            Err(_) => false,
        }
    }

    async fn preflight_attachments(&self, messages: &[AgentMessage]) -> Option<crate::compact::fresh::Preflight> {
        self.prepare(messages).await;
        let native_pdf = self.triggers.as_ref().is_none_or(|t| t.native_pdf);
        self.parts.attachments.preflight(messages, self.config.context_window, native_pdf).await
    }

    fn request_media(&self, messages: &[AgentMessage]) -> bool {
        self.triggers.as_ref().is_some_and(|t| should_compact_for_request_media(messages, t.native_pdf, &*t.tool_media))
    }

    async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError> {
        self.prepare(request.messages).await;
        let started = tokio::time::Instant::now();
        let mut usage = None;
        let mut input_excludes_cache = false;
        let mut summary_ms = None;
        let mut summary_route = None;
        let mut handoff_text = String::new();
        if let Some(summary) = self.summary.as_ref()
            && summary.triggered(request.messages).await
        {
            let handoff = summary.handoff(request.messages, request.budget_tokens).await?;
            handoff_text = handoff.text;
            usage = handoff.usage;
            input_excludes_cache = handoff.input_excludes_cache;
            summary_ms = Some(handoff.summary_ms);
            summary_route = handoff.route;
        }
        let meter = self.parts.meter();
        let ctx = self.parts.context(&meter, false);
        let options = self.options(&request, handoff_text, false, false);
        let result = fresh_context_compact_messages_with_skills(&ctx, request.messages, request.budget_tokens, &options, self.parts.skills.as_deref())
            .await
            .map_err(failure)?;
        // A generated summary can differ from its prediction: an automatic
        // result is never equal-sized or larger than the original.
        let reduces = !request.require_reduction || meter.compact_messages(&result.messages) < meter.compact_messages(request.messages);
        let pipeline_ms = elapsed_ms(started);
        if !reduces {
            return Ok(CompactOutput {
                messages: request.messages.to_vec(),
                usage,
                input_excludes_cache,
                dropped_count: 0,
                dropped: None,
                skipped: true,
                pipeline_ms,
                summary_ms,
                summary_route,
            });
        }
        let (dropped_count, dropped) = self.dropped_by(request.messages, &result.messages).await?;
        Ok(CompactOutput {
            messages: result.messages,
            usage,
            input_excludes_cache,
            dropped_count,
            dropped,
            skipped: false,
            pipeline_ms,
            summary_ms,
            summary_route,
        })
    }

    async fn adopted(&self, messages: &[AgentMessage]) {
        let Some(skills) = &self.parts.skills else { return };
        for body in crate::skill_update::latest_skill_bodies(messages) {
            if let Err(error) = skills.activate(&body.name, &body.body).await {
                tracing::warn!(skill = %body.name, %error, "could not activate compacted skill dependencies");
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct SummaryConfig {
    pub mode: SummaryMode,
    pub reserve_tokens: u64,
    pub context_window: u64,
    /// Provider token-count calibration (1.0 when the estimate is exact).
    pub token_calibration: f64,
    /// `compaction.conversationThresholdTokens`, when the operator set one.
    pub conversation_threshold_tokens: Option<u64>,
    /// `handoffTimeoutMs`: the deadline of the summary on each route.
    pub timeout_ms: Option<u64>,
}

/// The conversation summary through the route plan: a fork of the cached
/// request while it is warm, else the Maintainer, a lighter model, and the
/// conversation's own model last.
pub struct PlannedHandoff {
    pub parts: Arc<FreshParts>,
    pub fork: Arc<dyn ForkSource>,
    pub resolver: Arc<dyn RouteResolver>,
    pub config: SummaryConfig,
}

impl PlannedHandoff {
    /// The session's summary and the compactor's sizing, as [`FreshCompactor::for_session`] wires them.
    pub fn for_session(session: &SessionCompactor) -> Option<(Self, CompactorConfig)> {
        let (policy, config) = CompactorConfig::sized_by(&session.settings)?;
        let summary = PlannedHandoff {
            parts: session.parts.clone(),
            fork: session.fork.clone(),
            resolver: session.resolver.clone(),
            config: SummaryConfig {
                mode: session.summary_mode,
                reserve_tokens: policy.reserve_tokens,
                context_window: config.context_window,
                token_calibration: policy.token_calibration,
                conversation_threshold_tokens: session.conversation_threshold_tokens,
                timeout_ms: session.settings.handoff_timeout_ms,
            },
        };
        Some((summary, config))
    }

    /// This plan with the summary's budgets taken from `settings`, the compaction settings of the route the run moved to.
    /// The fork source and the route resolver are the caller's to replace.
    pub fn sized(&self, settings: &CompactSettings) -> Option<Self> {
        let (policy, config) = CompactorConfig::sized_by(settings)?;
        Some(Self {
            parts: self.parts.clone(),
            fork: self.fork.clone(),
            resolver: self.resolver.clone(),
            config: SummaryConfig {
                reserve_tokens: policy.reserve_tokens,
                context_window: config.context_window,
                token_calibration: policy.token_calibration,
                timeout_ms: settings.handoff_timeout_ms,
                ..self.config.clone()
            },
        })
    }

    fn calibration(&self) -> f64 {
        if self.config.token_calibration > 0.0 { self.config.token_calibration } else { 1.0 }
    }

    fn threshold(&self) -> u64 {
        let window = self.config.context_window;
        self.config.conversation_threshold_tokens.filter(|t| *t > 0).unwrap_or_else(|| {
            window
                .min(COMPACT_TARGET_MIN_TOKENS)
                .max(((window as f64 * CONVERSATION_COMPACT_TRIGGER_RATIO).ceil() as u64).min(CONVERSATION_COMPACT_TRIGGER_MAX_TOKENS))
        })
    }
}

#[async_trait]
impl HandoffSource for PlannedHandoff {
    fn resized(&self, seated: &SeatedRoute) -> Option<Arc<dyn HandoffSource>> {
        Some(Arc::new(self.sized(&seated.settings)?))
    }

    async fn triggered(&self, messages: &[AgentMessage]) -> bool {
        let meter = self.parts.meter();
        let ctx = self.parts.context(&meter, true);
        // A store that cannot be read now leaves the summary to decide: its own read fails the pass.
        let Ok(input) = conversation_compaction_input(&ctx, messages, false).await else { return true };
        let tokens = (meter.messages(&input) as f64 * self.calibration()).ceil() as u64;
        tokens >= self.threshold()
    }

    async fn handoff(&self, messages: &[AgentMessage], budget_tokens: u64) -> Result<Handoff, CompactError> {
        let (step, generated) = self.summarize(messages, budget_tokens).await?;
        let route = SummaryRouteUsed {
            step: step.name(),
            forked: generated.mode == "shared-prefix",
            provider: generated.provider_name,
            model: generated.model,
            stop: generated.stop.as_ref().map(crate::response::stop_text),
        };
        Ok(Handoff {
            text: generated.summary,
            usage: generated.usage,
            input_excludes_cache: generated.input_excludes_cache,
            summary_ms: generated.duration_ms,
            route: Some(route),
        })
    }
}

impl PlannedHandoff {
    /// The summary on the route plan of the session's mode and cache warmth: the step whose route
    /// wrote it, and the run (fork or isolated request, and why a fork fell back).
    pub async fn summarize(&self, messages: &[AgentMessage], budget_tokens: u64) -> Result<(RouteStep, Generated), CompactError> {
        let meter = self.parts.meter();
        let ctx = self.parts.context(&meter, false);
        let input = conversation_compaction_input(&ctx, messages, true).await?;
        let hard = 1.max((self.config.context_window as f64 / self.calibration()).floor() as u64);
        let mode = self.config.mode;
        let warm = self.fork.warm();
        let cx = SummarizeContext {
            fresh: &ctx,
            fork: &*self.fork,
            resolver: &*self.resolver,
            reserve_tokens: self.config.reserve_tokens,
            compact_budget_tokens: budget_tokens,
            hard_budget_tokens: hard,
            context_window: self.config.context_window,
            conversation_input: &input,
            timeout_ms: self.config.timeout_ms,
        };
        summarize_on_plan(&cx, &plan(mode, warm)).await
    }
}
