//! The loop's [`Compactor`]: the rule-only rebuild, with a model-written
//! handoff replacing the conversation when the conversation is large enough to
//! need one.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::Usage;
use mixdog_protocol::ProviderId;
use super::blob_reads::{with_blobs, BlobReads};
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
use super::fresh::fresh_context_compact_messages;
use super::summary_run::ForkSource;
use super::triggers::CacheExpiryInput;
use super::triggers::CacheTail;
use super::triggers::ToolMediaMeter;
use super::triggers::should_compact_for_expired_agent_cache;
use super::triggers::should_compact_for_request_media;
use super::summary_run::RouteResolver;
use super::summary_run::SummarizeContext;
use super::summary_run::elapsed_ms;
use super::summary_run::SummaryMode;
use super::summary_run::plan_steps;
use super::summary_run::summarize_on_plan;
use crate::boundary::CompactPolicy;
use crate::boundary::CompactSettings;
use crate::env::CompactError;
use crate::env::CompactOutput;
use crate::env::CompactRequest;
use crate::env::Compactor;
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
    /// Whole milliseconds the summary request took (`generated.diagnostics.durationMs`).
    pub summary_ms: f64,
}

/// The conversation summary: whether the conversation is large enough to
/// need one, and the summary itself.
#[async_trait]
pub trait HandoffSource: Send + Sync {
    /// Whether the conversation reaches the summary threshold.
    async fn triggered(&self, messages: &[AgentMessage]) -> bool;

    /// Cancel-safe. Called only when [`triggered`](Self::triggered).
    async fn handoff(&self, messages: &[AgentMessage], budget_tokens: u64) -> Result<Handoff, CompactError>;
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
}

impl FreshParts {
    fn meter(&self) -> MessageMeter<'_> {
        MessageMeter { media: &*self.media, replay_owner: &self.replay_owner }
    }

    fn context<'a>(&'a self, meter: &'a MessageMeter<'a>, preview: bool) -> FreshContext<'a> {
        FreshContext {
            tail: TailContext { meter, rows: &*self.rows, archive: &*self.archive, preview },
            attachments: &*self.attachments,
        }
    }
}

/// The values the two always-arming triggers are judged from.
pub struct TriggerSeams {
    pub tool_media: Arc<dyn ToolMediaMeter>,
    /// The provider takes PDFs natively (false: they lower to text).
    pub native_pdf: bool,
    pub cache: Arc<dyn CacheTail>,
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
    /// A session's compactor as Node wires it (`resolveSessionCompactionPolicy` and
    /// `runFreshContextCompact`): sized by the policy the settings resolve to with `auto` forced
    /// on, because a manual or auto-clear compaction needs the same numbers while automatic
    /// compaction is off. The reserve is the policy's, the window is the session's (else the
    /// boundary), and the hard budget is the window in the provider's calibrated tokens.
    /// `None` when the session knows no boundary: Node has no policy then, and a forced
    /// compaction fails with "no context window is available".
    pub fn for_session(session: SessionCompactor) -> Option<Arc<Self>> {
        let policy = CompactPolicy::resolve(&CompactSettings { auto: true, ..session.settings })?;
        let context_window = policy.context_window.unwrap_or(policy.boundary_tokens);
        let max_budget_tokens = 1.max((context_window as f64 / policy.token_calibration).floor() as u64);
        let summary = PlannedHandoff {
            parts: session.parts.clone(),
            fork: session.fork,
            resolver: session.resolver,
            config: SummaryConfig {
                mode: session.summary_mode,
                reserve_tokens: policy.reserve_tokens,
                context_window,
                token_calibration: policy.token_calibration,
                conversation_threshold_tokens: session.conversation_threshold_tokens,
            },
        };
        Some(Arc::new(Self {
            parts: session.parts,
            triggers: Some(session.triggers),
            summary: Some(Arc::new(summary)),
            config: CompactorConfig { reserve_tokens: policy.reserve_tokens, max_budget_tokens, context_window, handoff_token_cap: None },
        }))
    }

    fn options(&self, request: &CompactRequest<'_>, handoff_text: String, preview: bool, preview_summary: bool) -> FreshOptions {
        FreshOptions {
            reserve_tokens: self.config.reserve_tokens,
            max_budget_tokens: self.config.max_budget_tokens,
            context_window: self.config.context_window,
            handoff_token_cap: self.config.handoff_token_cap,
            handoff_text,
            active_turn: true,
            reference_latest_attachments: request.reference_latest_attachments,
            force: true,
            preview,
            preview_summary,
        }
    }
}

#[async_trait]
impl Compactor for FreshCompactor {
    fn estimate_tokens(&self, messages: &[AgentMessage]) -> u64 {
        self.parts.meter().messages(messages)
    }

    async fn prepare(&self, messages: &[AgentMessage]) {
        self.parts.media.prepare(messages).await;
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
        match fresh_context_compact_messages(&ctx, request.messages, request.budget_tokens, &options).await {
            Ok(result) => {
                let after = meter.messages(&result.messages) + if summary_triggered { SUMMARY_OUTPUT_TOKENS } else { 0 };
                after < meter.messages(request.messages)
            }
            Err(_) => false,
        }
    }

    fn cache_expired(&self) -> bool {
        self.triggers.as_ref().is_some_and(|t| {
            should_compact_for_expired_agent_cache(&CacheExpiryInput {
                agent_owner: t.cache.agent_owner(),
                five_minute_tail: t.cache.five_minute_tail(),
                last_provider_send_at: t.cache.last_provider_send_at(),
                now_ms: t.cache.now_ms(),
                warm: &*t.cache,
            })
        })
    }

    fn request_media(&self, messages: &[AgentMessage]) -> bool {
        self.triggers.as_ref().is_some_and(|t| should_compact_for_request_media(messages, t.native_pdf, &*t.tool_media))
    }

    async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError> {
        self.prepare(request.messages).await;
        // `runFreshContextCompact`'s `startedAt`: from the summary decision to the rebuilt transcript.
        let started = tokio::time::Instant::now();
        let mut usage = None;
        let mut summary_ms = None;
        let mut handoff_text = String::new();
        if let Some(summary) = self.summary.as_ref()
            && summary.triggered(request.messages).await
        {
            let handoff = summary.handoff(request.messages, request.budget_tokens).await?;
            handoff_text = handoff.text;
            usage = handoff.usage;
            summary_ms = Some(handoff.summary_ms);
        }
        let meter = self.parts.meter();
        let ctx = self.parts.context(&meter, false);
        let options = self.options(&request, handoff_text, false, false);
        let result = fresh_context_compact_messages(&ctx, request.messages, request.budget_tokens, &options)
            .await
            .map_err(failure)?;
        // A generated summary can differ from its prediction: an automatic
        // result is never equal-sized or larger than the original.
        let reduces = !request.require_reduction || meter.messages(&result.messages) < meter.messages(request.messages);
        let pipeline_ms = elapsed_ms(started);
        if !reduces {
            return Ok(CompactOutput { messages: request.messages.to_vec(), usage, dropped_count: 0, dropped: None, skipped: true, pipeline_ms, summary_ms });
        }
        let (dropped_count, dropped) = if result.messages == request.messages {
            (0, None)
        } else {
            let (before, after) = (request.messages.to_vec(), result.messages.clone());
            let (rows, redactor) = (Arc::clone(&self.parts.rows), Arc::clone(&self.parts.redactor));
            with_blobs(&*self.parts.blobs, move |blobs| dropped_summary(&before, &after, &*rows, &*redactor, &mut UserText::new(blobs)))
                .await
                .map_err(|unavailable| CompactError::Failed(unavailable.to_string()))?
        };
        Ok(CompactOutput { messages: result.messages, usage, dropped_count, dropped, skipped: false, pipeline_ms, summary_ms })
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
    fn calibration(&self) -> f64 {
        if self.config.token_calibration > 0.0 { self.config.token_calibration } else { 1.0 }
    }

    fn threshold(&self) -> u64 {
        let window = self.config.context_window;
        self.config.conversation_threshold_tokens.filter(|t| *t > 0).unwrap_or_else(|| {
            window.min(COMPACT_TARGET_MIN_TOKENS).max(
                ((window as f64 * CONVERSATION_COMPACT_TRIGGER_RATIO).ceil() as u64).min(CONVERSATION_COMPACT_TRIGGER_MAX_TOKENS),
            )
        })
    }
}

#[async_trait]
impl HandoffSource for PlannedHandoff {
    async fn triggered(&self, messages: &[AgentMessage]) -> bool {
        let meter = self.parts.meter();
        let ctx = self.parts.context(&meter, true);
        let input = conversation_compaction_input(&ctx, messages, false).await;
        let tokens = (meter.messages(&input) as f64 * self.calibration()).ceil() as u64;
        tokens >= self.threshold()
    }

    async fn handoff(&self, messages: &[AgentMessage], budget_tokens: u64) -> Result<Handoff, CompactError> {
        let meter = self.parts.meter();
        let ctx = self.parts.context(&meter, false);
        let input = conversation_compaction_input(&ctx, messages, true).await;
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
        };
        let (_, generated) = summarize_on_plan(&cx, &plan_steps(mode, warm)).await?;
        Ok(Handoff { text: generated.summary, usage: generated.usage, summary_ms: generated.duration_ms })
    }
}
