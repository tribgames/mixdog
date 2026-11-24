//! What an agent's turn reports to: the run's port, by the calls every other run makes on it, so
//! the timeline, the session list, the approval cards and a phone show an agent's turn as any other.

use std::sync::Arc;

use async_trait::async_trait;
pub use mixdog_agent::env::CompactEvent;
use mixdog_agent::env::Tone;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_session::session::ItemCommit;
use mixdog_core_session::session::RunPort;
pub use mixdog_core_session::session::run::CallMark;
use mixdog_core_session::session::run::RunError;
use mixdog_core_session::session::run::UsageReport;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ItemId;
use mixdog_protocol::ThreadItem;
use mixdog_store::schema::record::HeaderChange;

use crate::session::ContextUse;

/// The tokens a prompt's answer reports for the turn.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_read_tokens: u64,
    pub thought_tokens: Option<u64>,
    /// The answer's own total, where it gives one: what tells whether its input counts the cache reads.
    pub total_tokens: Option<u64>,
    /// The agent's report of its context when the turn ended; `None` for an agent that reports none.
    pub context: Option<ContextUse>,
    /// The model the agent ran on, as the route names it.
    pub model: String,
    pub tool_calls: u64,
    pub started_at_ms: i64,
    /// The time the agent's model worked in the turn: the turn's time less the time its calls ran and waited on the
    /// user, which a provider's request time leaves out too.
    pub request_ms: u64,
}

/// What a turn's usage says of the context, as the session's reading takes it: the counts are the whole turn's, summed
/// over every model call the agent made in it, so they are the size of no prompt; the agent's own report is the
/// context's occupancy.
fn context_evidence(context: Option<ContextUse>) -> serde_json::Value {
    let mut raw = serde_json::json!({ "input_tokens_scope": "turn" });
    if let Some(context) = context {
        raw["context_tokens"] = serde_json::json!(context.used);
    }
    raw
}

/// The answer's input leaves its cache reads out: its total is the input, the cache reads and the output together.
pub fn input_excludes_cache(usage: &TurnUsage) -> bool {
    usage.cached_read_tokens > 0 && usage.total_tokens == Some(usage.input_tokens + usage.cached_read_tokens + usage.output_tokens)
}

/// A turn's usage as a provider's call reports its own: the counts, and the agent's report of its context as the evidence
/// the session's reading takes.
pub fn provider_usage(usage: &TurnUsage) -> Usage {
    Usage {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cached_read_tokens,
        reasoning_tokens: usage.thought_tokens,
        raw: Some(context_evidence(usage.context)),
        ..Usage::default()
    }
}

#[async_trait]
pub trait TurnSurface: Send + Sync {
    async fn item_started(&self, item: ThreadItem) -> Result<(), RunError>;
    async fn delta(&self, item: ItemId, text: String) -> Result<(), RunError>;
    async fn text_settled(&self, item: ItemId) -> Result<(), RunError>;
    async fn reasoning_delta(&self, item: ItemId, text: String) -> Result<(), RunError>;
    async fn reasoning_completed(&self, item: ItemId, text: String) -> Result<(), RunError>;
    async fn commit(&self, item: ItemCommit) -> Result<(), RunError>;
    async fn notice(&self, text: String, warn: bool) -> Result<(), RunError>;
    async fn usage(&self, usage: TurnUsage) -> Result<(), RunError>;
    /// What the turn streamed since its last progress record that no row holds yet (`text`, `reasoning`): the record the
    /// loop's run writes, which a restart restores as the turn's partial reply. Handed on in order with the rows.
    async fn draft(&self, body: serde_json::Value) -> Result<(), RunError>;
    async fn save_header(&self, change: HeaderChange) -> Result<(), RunError>;
    /// The window the agent says it holds its context in: the session's window from here on, in every field the
    /// session keeps a window in (the compaction boundary is the whole of it, as it is for a model's own window).
    async fn window(&self, size: u64) -> Result<(), RunError> {
        let set = ["contextWindow", "rawContextWindow", "compactBoundaryTokens", mixdog_core_session::session::turn_ops::AGENT_WINDOW]
            .into_iter()
            .map(|key| (key.to_owned(), serde_json::json!(size)))
            .collect();
        self.save_header(HeaderChange { set, unset: Vec::new(), patch: Default::default() }).await
    }
    async fn approve(&self, ask: ApprovalAsk) -> ApprovalResolution;
    /// A stage the spinner shows as the loop's own stages show (`compacting`, then `requesting` once it is over).
    async fn stage(&self, stage: &str) -> Result<(), RunError>;
    /// A compaction pass's marker, as the loop's own pass shows it.
    async fn compact_event(&self, event: CompactEvent) -> Result<(), RunError>;
    /// A step of the turn the spinner follows, as the loop marks its own: the agent writes, a call runs, a call waits
    /// on the user's approval, the calls are over.
    async fn call_mark(&self, mark: CallMark) -> Result<(), RunError>;
    /// How many times calls have left the session's model context: what the ids of the calls that enter it carry.
    fn call_epoch(&self) -> u64;
    /// The surface a stopped turn is closed on: its waits outlive the turn's token.
    fn closing(&self) -> Arc<dyn TurnSurface>;
}

#[async_trait]
impl TurnSurface for RunPort {
    async fn item_started(&self, item: ThreadItem) -> Result<(), RunError> {
        RunPort::item_started(self, item).await
    }

    async fn delta(&self, item: ItemId, text: String) -> Result<(), RunError> {
        RunPort::delta(self, item, text).await
    }

    async fn text_settled(&self, item: ItemId) -> Result<(), RunError> {
        RunPort::text_settled(self, item).await
    }

    async fn reasoning_delta(&self, item: ItemId, text: String) -> Result<(), RunError> {
        RunPort::reasoning_delta(self, item, text).await
    }

    async fn reasoning_completed(&self, item: ItemId, text: String) -> Result<(), RunError> {
        RunPort::reasoning_completed(self, item, text).await
    }

    async fn commit(&self, item: ItemCommit) -> Result<(), RunError> {
        self.commit_item(item).await
    }

    async fn notice(&self, text: String, warn: bool) -> Result<(), RunError> {
        RunPort::notice(self, text, if warn { Tone::Warn } else { Tone::Info }).await
    }

    async fn usage(&self, usage: TurnUsage) -> Result<(), RunError> {
        let input_excludes_cache = input_excludes_cache(&usage);
        let report = UsageReport {
            iteration: 1,
            usage: provider_usage(&usage),
            model: usage.model.clone(),
            requested_model: usage.model,
            delta_tool_calls: usage.tool_calls,
            request_ms: usage.request_ms,
            delta_prompt: 0,
            send_tools: Arc::from(Vec::new()),
            reasoning_tokens: usage.thought_tokens,
            reasoning_tokens_complete: true,
            outgoing: Arc::from(Vec::new()),
            sent_at_ms: usage.started_at_ms,
            input_excludes_cache,
            tail_book: None,
        };
        RunPort::usage(self, report).await
    }

    /// The record is handed on and the turn goes on: its write is told apart, as the loop's run tells it.
    async fn draft(&self, body: serde_json::Value) -> Result<(), RunError> {
        let queued = self.queue_draft(body).await?;
        let port = self.clone();
        drop(mixdog_rt::spawn("acp.draft", mixdog_rt::TaskClass::Work, async move {
            if let Err(error) = port.saved(queued).await {
                tracing::warn!("[turn-checkpoint] write failed: {error:?}");
            }
        }));
        Ok(())
    }

    async fn save_header(&self, change: HeaderChange) -> Result<(), RunError> {
        RunPort::save_header(self, change).await
    }

    async fn approve(&self, ask: ApprovalAsk) -> ApprovalResolution {
        self.request(ask).await
    }

    async fn stage(&self, stage: &str) -> Result<(), RunError> {
        RunPort::stage(self, stage.to_owned(), None).await
    }

    async fn compact_event(&self, event: CompactEvent) -> Result<(), RunError> {
        RunPort::compact_event(self, event).await
    }

    async fn call_mark(&self, mark: CallMark) -> Result<(), RunError> {
        RunPort::call_mark(self, mark).await
    }

    fn call_epoch(&self) -> u64 {
        RunPort::call_epoch(self)
    }

    fn closing(&self) -> Arc<dyn TurnSurface> {
        Arc::new(RunPort::closing(self))
    }
}

#[cfg(test)]
mod tests {
    use mixdog_agent::compact::pressure::ContextSize;
    use mixdog_agent::compact::pressure::context_size;

    use super::*;

    /// The session's reading of an agent's turn is what the agent says its context holds, never the turn's tokens: the
    /// answer's usage sums every model call the agent made in the turn (the figures are the real CLI's, a turn of two
    /// calls), and an agent that reports no context leaves no reading at all.
    #[test]
    fn a_turns_reading_is_the_agents_report_of_its_context_and_never_the_turns_token_sum() {
        let turn = TurnUsage { input_tokens: 4_437, output_tokens: 144, cached_read_tokens: 14_487, total_tokens: Some(19_068), ..TurnUsage::default() };
        let usage = |context| Usage {
            input_tokens: turn.input_tokens,
            output_tokens: turn.output_tokens,
            cache_read_tokens: turn.cached_read_tokens,
            raw: Some(context_evidence(context)),
            ..Usage::default()
        };
        let excludes = input_excludes_cache(&turn);
        assert!(excludes, "the answer's total is its input, cache reads and output together");
        assert_eq!(context_size(&usage(Some(ContextUse { used: 9_606, size: 1_048_576 })), excludes), ContextSize::Occupancy(9_606));
        assert_eq!(context_size(&usage(None), excludes), ContextSize::Unknown);
        // An answer whose input already holds the cache reads is read as it is.
        assert!(!input_excludes_cache(&TurnUsage {
            input_tokens: 12,
            output_tokens: 5,
            cached_read_tokens: 2,
            total_tokens: Some(17),
            ..TurnUsage::default()
        }));
        assert!(!input_excludes_cache(&TurnUsage { input_tokens: 10, output_tokens: 5, cached_read_tokens: 2, ..TurnUsage::default() }));
    }
}
