//! The production [`ManualCompaction`]: a manual `/compact` of a thread (`session-ops.mjs` `compact`
//! over `session-crud.mjs` `compactSessionMessages` and `compaction-runner.mjs`
//! `runSessionCompaction`).
//!
//! The pieces are the existing ones: the thread's own snapshot ([`ContextWorld`]) for the plan
//! ([`compaction_plan`]), the run host's compactor for the summary, the session actor for the commit
//! ([`SessionDirectory::commit_compaction`], which reconciles with the live transcript and writes
//! the header this module computes), the hook bus for PreCompact / PostCompact, and the thread's
//! header port for the writes that have no commit (a failed pass, the re-armed reminders).
//!
//! Not carried over from Node (see `decisions.md`, "manual compaction"): the staged working-folder
//! re-root (`applyPendingWorkspaceReroot`) a changed pass applies, the write-ahead archive segment,
//! the trace line.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::pressure::{
    Archived, CommitInput, CompactionPlan, Route, StatusInput, SummaryFacts, TRANSCRIPT_MOVED_ERROR, TranscriptSigner, UsageSnapshotArgs, commit_compaction, compaction_plan,
    failed_compaction, invalidate_provider_context_baseline, record_context_usage_snapshot, usage_totals,
};
use mixdog_agent::cancel::Cancel;
use mixdog_agent::compact::tool_schema::RequestTools;
use mixdog_agent::env::{Clock, CompactError, CompactRequest, CompactTrigger};
use mixdog_agent::message::AgentMessage;
use mixdog_ai::registry::accounted::input_excludes_cache;
use mixdog_core_api::CoreError;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::ids::{ItemId, ThreadId};
use mixdog_core_base::support::failed;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_run::run_host::artifact::ToolResultArtifacts;
use mixdog_core_session::session::StoredRows;
use mixdog_core_session::session::route_session::ContextStatusCache;
use mixdog_core_session::session::run::{Compaction, Dropped};
use mixdog_core_session::session::thread_context::{ContextSnapshot, ContextWorld};
use mixdog_core_session::session::turn_ops::{Books, CompactionCommit, CompactionHeader, ManualCompaction, OffloadCopies};
use mixdog_agent::compact::blob_reads::BlobReads;
use mixdog_store::schema::record::{Header, HeaderChange};
use serde_json::{Value, json};

use super::assemble::CompactorInput;
use super::compact_hooks::CompactHooks;
use super::context_world::request_definitions;
use super::factory::new_item_id;
use super::host_seams::{CompactorSource, ConfigSeams};
use super::message_row::{message_of, row_of};
use super::rearm::{rearm_late_deferred_tools, rearm_prompt_settings_notice};
use super::tool_exposure::native_request_tools;

const DOMAIN: &str = "manual compaction";

/// What the host supplies besides the thread's ports.
pub struct ManualParts {
    pub world: Arc<dyn ContextWorld>,
    pub threads: Arc<dyn ThreadState>,
    pub config: Arc<dyn ConfigSeams>,
    pub compactors: Arc<dyn CompactorSource>,
    /// The session directory the commit goes through, bound once it is built, as the other directory-side parts are.
    pub directory: Arc<super::compose_parts::LateDirectory>,
    pub hooks: Arc<dyn CompactHooks>,
    pub gauge: Arc<dyn ContextStatusCache>,
    pub clock: Arc<dyn Clock>,
    /// `recoverAgentWorkers()`.
    pub recover: Arc<dyn Fn(&ThreadId) + Send + Sync>,
    /// Where a dropped execution is archived: the tool-result store of the thread.
    pub io: ToolIo,
    pub data_dir: PathBuf,
    pub blobs: Arc<dyn BlobReads>,
    /// The sessions' result caches: a compaction that replaced the transcript starts the session a new read epoch.
    pub reuses: Arc<super::result_reuse::LiveReuses>,
}

/// The meters of a thread's pressure on one provider, as the latest `prepare_books` left them.
type Meters = (Arc<dyn mixdog_agent::compact::estimate::MediaMeter>, Arc<dyn mixdog_agent::compact::pressure::ImageIdentities>);

pub struct HostManualCompaction {
    parts: ManualParts,
    /// Per thread and provider: the lowering whose store facts were read for the pressure being recorded.
    prepared: Mutex<HashMap<(String, String), Meters>>,
    /// The cache warmer's record of when each thread's prompt cache was last used: the idle auto-clear measures idleness from it.
    warm_uses: Option<Arc<mixdog_ai::warmer::stores::TouchStore>>,
}

impl HostManualCompaction {
    pub fn new(parts: ManualParts) -> Self {
        Self { parts, prepared: Mutex::new(HashMap::new()), warm_uses: None }
    }

    /// The warmer's touch store, for [`ManualCompaction::cache_warm_use_at`].
    pub fn with_warm_uses(mut self, touches: Arc<mixdog_ai::warmer::stores::TouchStore>) -> Self {
        self.warm_uses = Some(touches);
        self
    }
}

/// The stored bodies a compactor serializes for an execution archive: each conversation message's own row, as Node's
/// `session.messages` hold them (an unregistered message would archive as `null`).
fn registered(messages: &[AgentMessage], rows: &[Value]) -> Arc<StoredRows> {
    let stored = Arc::new(StoredRows::new());
    for (message, row) in messages.iter().zip(rows) {
        stored.record(message, row.clone());
    }
    stored
}

fn number(value: f64) -> Value {
    mixdog_js::json_number(value)
}

/// `usage` in the shape Node's pass reports it.
fn usage_value(usage: &mixdog_core_api::domain::provider::Usage) -> Value {
    json!({
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "cachedTokens": usage.cache_read_tokens,
        "cacheWriteTokens": usage.cache_write_tokens,
    })
}

/// What changed between two headers, as a header change.
pub(crate) fn header_change(before: &Header, after: &Header) -> HeaderChange {
    let mut change = HeaderChange { set: Header::new(), unset: Vec::new() };
    for (key, value) in after {
        if before.get(key) != Some(value) {
            change.set.insert(key.clone(), value.clone());
        }
    }
    change.unset = before.keys().filter(|key| !after.contains_key(*key)).cloned().collect();
    change
}

/// Runs `f` over the status input of `snapshot`'s thread with `session` as its header and `messages`
/// as its transcript.
fn with_status<R>(snapshot: &ContextSnapshot, session: &Header, messages: &[AgentMessage], f: impl FnOnce(&StatusInput<'_>) -> R) -> R {
    let meter = MessageMeter { media: &*snapshot.media, replay_owner: &snapshot.replay_owner };
    let signer = TranscriptSigner { meter: &meter, images: &*snapshot.images, rows: &*snapshot.rows };
    let input = StatusInput {
        session,
        route: Route { provider: &snapshot.provider, model: &snapshot.model, context_window: snapshot.context_window.clone() },
        cwd: Value::Null,
        mode: Value::Null,
        messages,
        active: true,
        request_tools: RequestTools { native: &snapshot.request_native, defined: &snapshot.request_defined },
        session_tools: RequestTools { native: &[], defined: &snapshot.session_defined },
        tool_breakdown: &Value::Null,
        agent_mode: snapshot.agent_mode,
        meter: &meter,
        signer: &signer,
    };
    f(&input)
}

/// `handoffSummaryTimeoutMs(session)` (`compaction-runner.mjs`): a pass between turns bounds its summary by
/// `compaction.timeoutMs` alone, without the environment the pre-send policy also reads.
fn handoff_summary_timeout_ms(header: &Header) -> Option<u64> {
    mixdog_agent::agent_tool::scope::positive_int(header.get("compaction").and_then(|compaction| compaction.get("timeoutMs")))
}

/// Node's `session.messages`, which the pass prices: the request's system blocks, then the transcript.
/// The compactor works on the transcript alone.
fn priced(header: &Header, transcript: &[AgentMessage]) -> Vec<AgentMessage> {
    let mut messages = super::factory::system_messages(header);
    messages.extend(transcript.iter().cloned());
    messages
}

/// The forced plan over `priced` messages of `snapshot`'s thread (`compactionPlanNumbers`).
fn forced_plan(snapshot: &ContextSnapshot, session_messages: &[AgentMessage]) -> Result<Option<CompactionPlan>, &'static str> {
    with_status(snapshot, &snapshot.header, session_messages, |status| compaction_plan(status, false, true))
}

/// Everything a commit's header is computed from besides the thread's header and the rows appended
/// since the snapshot.
pub(crate) struct CommitFacts {
    pub snapshot: Arc<ContextSnapshot>,
    /// The transcript the plan priced (with the request's system blocks), and its rows.
    pub messages: Vec<AgentMessage>,
    pub before_rows: Vec<Value>,
    pub plan: CompactionPlan,
    pub compacted: Vec<AgentMessage>,
    pub compacted_rows: Vec<Value>,
    pub fresh: SummaryFacts,
    pub archived: Option<Archived>,
    pub now: f64,
    /// `compactStartedAt`: the pass began (before the stage hook and the summary).
    pub started_at: f64,
    /// The start of `commitSessionCompaction`, once the summary pass returned.
    pub commit_started_at: f64,
    /// `recordCompactionTiming`'s `Date.now()`: sampled once the header is built, as Node samples after the record, the fallback title,
    /// the usage snapshot, the cache-break intent and the reminder re-arming.
    pub committed_at: Arc<dyn Fn() -> f64 + Send + Sync>,
}

/// The header of `runSessionCompaction`'s commit (`commitSessionCompaction`): the summary's usage
/// totals, the `compaction` record, and for a changed transcript the invalidated baseline, the
/// post-compaction usage snapshot, the cache-break intent and the re-armed reminders; with the
/// answer. `appended` are the rows a finished turn added since the snapshot.
pub(crate) fn committed_header(facts: &CommitFacts, header: &Header, appended: &[(ItemId, Value)]) -> (Header, Value) {
    let snapshot = &facts.snapshot;
    let mut working = header.clone();
    if let Some(usage) = &facts.fresh.usage {
        for (key, value) in usage_totals(&working, usage, input_excludes_cache(&snapshot.provider)) {
            working.insert(key, value);
        }
    }
    let appended_rows: Vec<Value> = appended.iter().map(|(_, row)| row.clone()).collect();
    // The rows were stored by the run host through `message_of`; one it cannot read cannot have been appended.
    let appended_messages: Vec<AgentMessage> = appended_rows.iter().filter_map(|row| message_of(row).ok()).collect();
    let final_rows: Vec<Value> = facts.compacted_rows.iter().chain(&appended_rows).cloned().collect();
    let docs: Vec<Value> = working.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
    let after_defined = request_definitions(&working, &docs, &final_rows, &snapshot.provider);
    let after_native = native_request_tools(&Value::Object(working.clone()));
    let compacted = priced(&snapshot.header, &facts.compacted);
    let committed = with_status(snapshot, &working, &facts.messages, |status| {
        commit_compaction(&CommitInput {
            status,
            plan: &facts.plan,
            auto_mode: false,
            now: facts.now,
            started_at: facts.started_at,
            commit_started_at: facts.commit_started_at,
            committed_at: facts.commit_started_at,
            fresh: &facts.fresh,
            before_rows: &facts.before_rows,
            compacted_rows: &facts.compacted_rows,
            compacted: &compacted,
            appended: &appended_messages,
            after_tools: RequestTools { native: &after_native, defined: &after_defined },
            archived: facts.archived.clone(),
        })
    });
    working.insert("compaction".into(), Value::Object(committed.compaction));
    if committed.changed {
        // `backfillFallbackSessionTitle(session, messages)`: a titleless session keeps a name before the transcript that carries
        // its first prompt is replaced.
        if let Some(change) = mixdog_core_session::session::session_title::fallback_title_change(&working, &facts.before_rows, None, facts.now as i64) {
            working.extend(change.set);
        }
        let transcript: Vec<AgentMessage> = compacted.iter().chain(&appended_messages).cloned().collect();
        invalidate_provider_context_baseline().apply(&mut working);
        if let Some(policy) = &committed.policy {
            let args = UsageSnapshotArgs { used_tokens: committed.after.tokens, message_tokens_est: Some(committed.after.message_tokens), source: "post_compact", updated_at: Some(facts.now), now: facts.now };
            let patch = with_status(snapshot, &working, &transcript, |status| record_context_usage_snapshot(&working, policy, &transcript, status.signer, &args));
            if let Some(patch) = patch {
                patch.apply(&mut working);
            }
        }
        // The next turn's first send tags its cache break.
        working.insert("pendingCacheBreakIntent".into(), json!("manual_compaction"));
        // The compacted history no longer holds the late-tool announcements nor the settings notices.
        let _ = rearm_late_deferred_tools(&mut working, facts.now as i64);
        rearm_prompt_settings_notice(&mut working);
    }
    // `recordCompactionTiming` runs last, changed or not; the record above took a provisional end that this replaces.
    let committed_at = (facts.committed_at)();
    if let Some(Value::Object(record)) = working.get_mut("compaction") {
        record.insert("lastCommittedAt".into(), number(committed_at));
        record.insert("lastDurationMs".into(), number(committed_at - facts.started_at));
        record.insert("lastCommitMs".into(), number(committed_at - facts.commit_started_at));
    }
    (working, committed.result)
}

/// `pruneOffloadSession`'s listing over the thread's tool-result store under `data_dir`.
pub(crate) async fn offload_candidates(io: &ToolIo, data_dir: &std::path::Path, thread: &ThreadId) -> Vec<std::path::PathBuf> {
    ToolResultArtifacts::new(io.clone(), data_dir, thread.as_str()).prune_candidates().await
}

/// The rest of `pruneOffloadSession` over the thread's tool-result store under `data_dir`, aged at `clock`'s now.
pub(crate) async fn prune_offloads(io: &ToolIo, data_dir: &std::path::Path, clock: &dyn Clock, thread: &ThreadId, candidates: Vec<std::path::PathBuf>, transcripts: String, copies: OffloadCopies) {
    let now = u64::try_from(clock.now_ms()).unwrap_or(0);
    ToolResultArtifacts::new(io.clone(), data_dir, thread.as_str()).prune(candidates, transcripts, copies, now).await;
}

/// `compactSessionMessages` after a pass that did not fail: the reading of the last request is reset.
fn manual_tail(working: &mut Header, now: f64) {
    for key in ["lastInputTokens", "lastOutputTokens", "lastCachedReadTokens", "lastCacheWriteTokens", "lastContextTokens"] {
        working.insert(key.into(), json!(0));
    }
    working.insert("lastContextTokensUpdatedAt".into(), number(now));
    working.insert("lastContextTokensStaleAfterCompact".into(), json!(false));
    working.insert("updatedAt".into(), number(now));
}

impl HostManualCompaction {
    fn now(&self) -> f64 {
        self.parts.clock.now_ms() as f64
    }

    /// `recordFailedCompaction` and the save after it: the thread keeps its conversation; its
    /// `compaction` record says what happened.
    async fn record_failure(&self, thread: &ThreadId, snapshot: &ContextSnapshot, messages: &[AgentMessage], plan: &CompactionPlan, usage: Option<&Value>, error: &str, fresh_error: Option<&str>) -> Result<Value, CoreError> {
        // A session that closed, was deleted or shut down under the compaction (its abort is why this records a failure) is gone
        // from the directory: Node holds the session it loaded, its save is dropped by the close's generation, and the result
        // is returned all the same. So the pass's own snapshot of the header stands in, and nothing is stored.
        let header = match self.parts.threads.header(thread).await {
            Ok(header) => header,
            Err(_) if self.session_ended(thread) => snapshot.header.clone(),
            Err(e) => return Err(failed(DOMAIN, format!("{e:?}"))),
        };
        let now = self.now();
        let mut working = header.clone();
        if let Some(usage) = usage {
            for (key, value) in usage_totals(&working, usage, input_excludes_cache(&snapshot.provider)) {
                working.insert(key, value);
            }
        }
        let outcome = with_status(snapshot, &working, messages, |status| failed_compaction(status, plan, false, now, error, fresh_error));
        working.insert("compaction".into(), Value::Object(outcome.compaction));
        working.insert("updatedAt".into(), number(now));
        let change = header_change(&header, &working);
        match self.parts.threads.patch_header(thread, change.set, change.unset).await {
            Ok(()) => {}
            Err(_) if self.session_ended(thread) => {}
            Err(e) => return Err(failed(DOMAIN, format!("{e:?}"))),
        }
        Ok(outcome.result)
    }

    /// The thread was closed, deleted or shut down (it is no longer loaded, or is closed): the directory refuses it work.
    fn session_ended(&self, thread: &ThreadId) -> bool {
        !self.parts.directory.directory().is_some_and(|directory| directory.is_open(thread))
    }
}

/// Where a pass reads the thread's model context and commits its result: the session directory.
#[async_trait]
pub(crate) trait PassTranscript: Send + Sync {
    async fn context(&self, thread: &ThreadId) -> Result<Vec<(ItemId, Value)>, CoreError>;
    async fn commit(&self, thread: &ThreadId, snapshot: Vec<ItemId>, compaction: Compaction, header: CompactionHeader) -> Result<CompactionCommit, CoreError>;
}

#[async_trait]
impl PassTranscript for mixdog_core_session::session::SessionDirectory {
    async fn context(&self, thread: &ThreadId) -> Result<Vec<(ItemId, Value)>, CoreError> {
        self.model_context(thread).read().await
    }
    async fn commit(&self, thread: &ThreadId, snapshot: Vec<ItemId>, compaction: Compaction, header: CompactionHeader) -> Result<CompactionCommit, CoreError> {
        self.commit_compaction(thread, snapshot, compaction, Some(header)).await
    }
}

impl HostManualCompaction {
    /// The manual pass over `snapshot`'s thread (`runSessionCompaction` with `force`), reading and committing through
    /// `transcript`.
    pub(crate) async fn pass(&self, thread: &ThreadId, trigger: &str, require_reduction: bool, snapshot: ContextSnapshot, transcript: &dyn PassTranscript, cancel: &Cancel) -> Result<Option<Value>, CoreError> {
        let parts = &self.parts;
        let context = transcript.context(thread).await?;
        let rows: Vec<Value> = context.iter().map(|(_, row)| row.clone()).collect();
        let messages = rows.iter().map(|row| message_of(row).map_err(|e| failed(DOMAIN, e))).collect::<Result<Vec<_>, _>>()?;
        let snapshot = Arc::new(snapshot);
        let session_messages = priced(&snapshot.header, &messages);
        // Node prices the plan with synchronous blob reads: a stored text attachment counts its text, and a read that
        // fails for now throws out of `runSessionCompaction` before anything is recorded.
        snapshot.media.prepare(&messages).await.map_err(|message| failed(DOMAIN, message))?;
        let plan = forced_plan(&snapshot, &session_messages).map_err(|message| failed(DOMAIN, message))?;
        let Some(plan) = plan else { return Ok(None) };

        // The compactor of the thread's route: `runSessionHandoff`.
        let Some(mut settings) = parts.config.run_settings(thread, &snapshot.header).compact else { return Err(failed(DOMAIN, "no compaction policy for this session")) };
        settings.handoff_timeout_ms = handoff_summary_timeout_ms(&snapshot.header);
        // What left is reported only when its stored row shows (`prepareCompactionArchive`): the pass reads them here.
        let input = CompactorInput {
            settings,
            rows: registered(&messages, &rows),
            archive: Arc::new(ToolResultArtifacts::new(parts.io.clone(), &parts.data_dir, thread.as_str())),
            blobs: parts.blobs.clone(),
        };
        let Some(compactor) = parts.compactors.compactor(thread, &snapshot.header, &rows, input).await else { return Err(failed(DOMAIN, "no compactor for this session")) };
        // `plan.requireReduction`: an explicit request (a manual pass is not automatic) unless the
        // request's media alone would need the compaction.
        compactor.prepare(&messages).await;
        let require = require_reduction && !compactor.request_media(&messages);
        // `runHandoffCompaction` passes no Goal reminder: a compaction outside a turn marks it for the next turn instead.
        let request = |require_reduction: bool| CompactRequest { messages: &messages, budget_tokens: plan.budget as u64, trigger: CompactTrigger::Auto, require_reduction, reference_latest_attachments: false, active_turn: false, latest_user_prefix: "" };
        if require && !compactor.reduces(&request(true)).await {
            return Ok(Some(plan.no_token_reduction()));
        }
        // The manager's savings gate passed: `compactStartedAt`, then PreCompact (`onStageChange('compacting')`).
        let started_at = self.now();
        parts.hooks.pre(thread, trigger).await;
        // `runFreshContextCompact`'s `signal.throwIfAborted()` and the summary send's signal: the session's abort ends the pass,
        // and dropping the pass's future (cancel-safe) ends the summary request in flight.
        let compacted = tokio::select! {
            biased;
            () = cancel.cancelled() => Err(CompactError::Aborted),
            compacted = compactor.compact(request(require)) => compacted,
        };
        let output = match compacted {
            Ok(output) => output,
            Err(CompactError::Overflow(message) | CompactError::Failed(message) | CompactError::RouteFailed(message, _)) => {
                return self.record_failure(thread, &snapshot, &session_messages, &plan, None, &message, Some(&message)).await.map(Some);
            }
            Err(CompactError::Aborted) => {
                // Node records the abort signal's own text (`error.message` of the reason it threw).
                let message = if cancel.is_aborted() { cancel.reason() } else { "compact aborted".to_owned() };
                return self.record_failure(thread, &snapshot, &session_messages, &plan, None, &message, Some(&message)).await.map(Some);
            }
        };
        if output.skipped {
            return Ok(Some(plan.no_token_reduction()));
        }
        let commit_started_at = self.now();

        let usage = output.usage.as_ref().map(usage_value);
        let summarized = output.summarized();
        let fresh = SummaryFacts {
            usage: usage.clone(),
            fresh_context: true,
            handoff_source: Some(if summarized { "session-local" } else { "rules" }.to_owned()),
            summary_provider: output.summary_route.as_ref().map(|route| route.provider.clone()),
            summary_model: output.summary_route.as_ref().map(|route| route.model.clone()),
            pipeline_mode: Some(if summarized { "conversation-summary" } else { "rules" }.to_owned()),
            summary_route: output.summary_route.as_ref().map(|route| route.step.to_owned()),
            forked: output.summary_route.as_ref().is_some_and(|route| route.forked),
            generated_ms: output.summary_ms,
            total_ms: Some(output.pipeline_ms),
        };
        let item_of: HashMap<String, ItemId> = context.iter().filter_map(|(iid, row)| Some((message_of(row).ok()?.message_id?, iid.clone()))).collect();
        let compacted_rows: Vec<Value> = output.messages.iter().map(row_of).collect();
        let replacement = output
            .messages
            .iter()
            .zip(&compacted_rows)
            .map(|(message, row)| (message.message_id.as_ref().and_then(|id| item_of.get(id)).cloned().unwrap_or_else(new_item_id), row.clone()))
            .collect();
        let dropped = output.dropped.as_ref().map(|d| Dropped { message_ids: d.message_ids.clone(), call_ids: d.call_ids.clone() });
        let archived = Archived { dropped: output.dropped_count, identities: output.dropped.as_ref().map(|d| json!({ "messageIds": d.message_ids, "callIds": d.call_ids })) };
        let now = self.now();
        let compaction = Compaction { replacement, at: now as i64, dropped_count: output.dropped_count, dropped };
        let clock = parts.clock.clone();
        let facts = CommitFacts {
            snapshot: snapshot.clone(),
            messages: session_messages.clone(),
            before_rows: rows.clone(),
            plan: plan.clone(),
            compacted: output.messages,
            compacted_rows,
            fresh,
            archived: Some(archived),
            now,
            started_at,
            commit_started_at,
            committed_at: Arc::new(move || clock.now_ms() as f64),
        };
        // `!changed` (`compaction-runner.mjs:690-731`): Node keeps the transcript, the provider
        // continuation and the display as they are and writes only the header's compaction record.
        let (mut working, result) = committed_header(&facts, &snapshot.header, &[]);
        if result.get("changed") == Some(&Value::Bool(false)) {
            manual_tail(&mut working, facts.now);
            let change = header_change(&snapshot.header, &working);
            self.parts.threads.patch_header(thread, change.set, change.unset).await.map_err(|e| failed(DOMAIN, format!("{e:?}")))?;
            return Ok(Some(result));
        }
        let answer = Arc::new(Mutex::new(None));
        let slot = answer.clone();
        let header: CompactionHeader = Box::new(move |header, appended| {
            let (mut working, result) = committed_header(&facts, header, appended);
            manual_tail(&mut working, facts.now);
            *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(result);
            header_change(header, &working)
        });
        let snapshot_ids: Vec<ItemId> = context.iter().map(|(iid, _)| iid.clone()).collect();
        match transcript.commit(thread, snapshot_ids, compaction, header).await? {
            CompactionCommit::Applied => {
                // `compaction-runner.mjs:699`: `resetReadStateAfterCompaction` once the changed transcript is adopted.
                self.parts.reuses.compacted(thread.as_str());
                let result = answer.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
                result.map(Some).ok_or_else(|| failed(DOMAIN, "the commit answered without a result"))
            }
            // The conversation moved: nothing was applied, the summary's usage still counts.
            CompactionCommit::Moved => self.record_failure(thread, &snapshot, &session_messages, &plan, usage.as_ref(), TRANSCRIPT_MOVED_ERROR, None).await.map(Some),
        }
    }
}

#[async_trait]
impl ManualCompaction for HostManualCompaction {
    /// `lastCacheWarmUseAt(sessionId)`: the last successful warm that used the thread's prompt cache.
    fn cache_warm_use_at(&self, thread: &ThreadId) -> f64 {
        self.warm_uses.as_ref().and_then(|touches| touches.warm_use(thread.as_str())).map_or(0.0, |warm| warm.at as f64)
    }

    async fn compact(&self, thread: &ThreadId, trigger: &str, require_reduction: bool, cancel: &Cancel) -> Result<Option<Value>, CoreError> {
        let Some(snapshot) = self.parts.world.snapshot(Some(thread)).await? else { return Ok(None) };
        let Some(directory) = self.parts.directory.directory() else { return Ok(None) };
        self.pass(thread, trigger, require_reduction, snapshot, &*directory, cancel).await
    }

    /// `compactConversationForHeir`: the source's whole transcript through the source's own compactor, sized by the heir's
    /// budget. The compactor sees the system blocks the source's requests lead with (`source.messages` holds them), so
    /// its protected head and its budget count them; only the conversation half of the result travels. Nothing is
    /// committed: the source keeps every message. A pass that is asked to `summarize` runs on a copy of the source's
    /// header whose conversation threshold is the floor (1).
    async fn compact_for_heir(&self, source: &ThreadId, budget_tokens: u64, summarize: bool) -> Result<Option<Vec<Value>>, CoreError> {
        let parts = &self.parts;
        let Ok(stored) = parts.threads.header(source).await else { return Ok(None) };
        let Some(directory) = parts.directory.directory() else { return Ok(None) };
        let context = directory.model_context(source).read().await?;
        let rows: Vec<Value> = context.iter().map(|(_, row)| row.clone()).collect();
        let messages = super::factory::session_messages(&stored, &rows).map_err(|e| failed(DOMAIN, e))?;
        let mut header = stored;
        if summarize {
            let mut compaction = header.get("compaction").and_then(Value::as_object).cloned().unwrap_or_default();
            compaction.insert("conversationThresholdTokens".into(), json!(1));
            header.insert("compaction".into(), Value::Object(compaction));
        }
        let Some(mut settings) = parts.config.run_settings(source, &header).compact else { return Ok(None) };
        settings.handoff_timeout_ms = handoff_summary_timeout_ms(&header);
        let input = CompactorInput {
            settings,
            rows: registered(&messages[messages.len() - rows.len()..], &rows),
            archive: Arc::new(ToolResultArtifacts::new(parts.io.clone(), &parts.data_dir, source.as_str())),
            blobs: parts.blobs.clone(),
        };
        let Some(compactor) = parts.compactors.compactor(source, &header, &rows, input).await else { return Ok(None) };
        compactor.prepare(&messages).await;
        let request = CompactRequest { messages: &messages, budget_tokens, trigger: CompactTrigger::Auto, require_reduction: false, reference_latest_attachments: false, active_turn: false, latest_user_prefix: "" };
        let output = compactor.compact(request).await.map_err(|error| match error {
            CompactError::Overflow(message) | CompactError::Failed(message) | CompactError::RouteFailed(message, _) => failed(DOMAIN, message),
            CompactError::Aborted => failed(DOMAIN, "compact aborted"),
        })?;
        Ok(Some(output.messages.iter().map(row_of).collect()))
    }

    async fn post_compact(&self, thread: &ThreadId, trigger: &str) {
        self.parts.hooks.post(thread, trigger).await;
    }

    async fn offload_candidates(&self, thread: &ThreadId) -> Vec<std::path::PathBuf> {
        offload_candidates(&self.parts.io, &self.parts.data_dir, thread).await
    }

    async fn prune_offloads(&self, thread: &ThreadId, candidates: Vec<std::path::PathBuf>, transcripts: String, copies: OffloadCopies) {
        prune_offloads(&self.parts.io, &self.parts.data_dir, &*self.parts.clock, thread, candidates, transcripts, copies).await;
    }

    /// `rearmLateDeferredTools(session)` and `rearmPromptSettingsNotice(session)` of the session ops,
    /// best-effort: a tool reminder never breaks a compaction.
    async fn rearm(&self, thread: &ThreadId) {
        let Ok(header) = self.parts.threads.header(thread).await else { return };
        let mut working = header.clone();
        let _ = rearm_late_deferred_tools(&mut working, self.parts.clock.now_ms());
        rearm_prompt_settings_notice(&mut working);
        let change = header_change(&header, &working);
        if !change.set.is_empty() || !change.unset.is_empty() {
            // Node changes the in-memory session (`compaction-runner.mjs:742-747`) and a later save logs its failure.
            if let Err(error) = self.parts.threads.patch_header(thread, change.set, change.unset).await {
                tracing::warn!(thread = %thread, "[session] re-armed tool notice save failed: {error:?}");
            }
        }
    }

    fn recover_workers(&self, thread: &ThreadId) {
        (self.parts.recover)(thread);
    }

    fn invalidate_context_status(&self, thread: &ThreadId) {
        self.parts.gauge.invalidate(thread);
    }

    fn synced_compaction(&self, header: &Header, install: bool) -> Option<Value> {
        self.parts.config.synced_compaction(header, install)
    }

    fn route_config(&self, header: &Header) -> mixdog_app_protocol::v2::thread::ThreadRoute {
        self.parts.config.route_config(header)
    }

    fn settings_changes(&self, thread: &mixdog_core_api::ids::ThreadId) -> Option<mixdog_core_session::session::turn_ops::SettingsFeed> {
        self.parts.config.settings_changes(thread)
    }

    async fn prepare_books(&self, thread: &ThreadId, provider: &str, messages: &[AgentMessage]) {
        let meters = self.parts.world.lowering(thread, provider);
        // A read that fails for now leaves the gauge pricing the part as unread until the next read.
        let _ = meters.0.prepare(messages).await;
        self.prepared.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert((thread.as_str().to_owned(), provider.to_owned()), meters);
    }

    fn books(&self, thread: &ThreadId, header: &Header) -> Option<Books> {
        let provider = header.get("provider").and_then(Value::as_str).unwrap_or_default();
        // Only the meters whose facts were read: an unprepared lowering would price stored media cold.
        let (media, images) = self.prepared.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&(thread.as_str().to_owned(), provider.to_owned())).cloned()?;
        Some(Books { media, images, native: native_request_tools(&Value::Object(header.clone())), agent_mode: super::session_cache_opts::is_agent_mode_session(header) })
    }
}

#[cfg(test)]
mod tests;
