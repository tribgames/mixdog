//! What a manual compaction reports and records once its summary is made
//! (`session/manager/compaction-runner.mjs`: `commitSessionCompaction`, `afterCompactionNumbers`,
//! `compactionOutcome`, `compactionRecord`, `recordCompactionTiming`, `recordFailedCompaction`,
//! `addCompactUsageToSession`), over the plan of [`super::compaction_plan`].
//!
//! The pass itself (the summary, the transcript the engine returns, the archive's dropped
//! identities) and the clock arrive as inputs; this module is the arithmetic and the records.

use super::*;

/// `compact: the conversation changed while compacting; compaction not applied, run it again`.
pub const TRANSCRIPT_MOVED_ERROR: &str = "compact: the conversation changed while compacting; compaction not applied, run it again";

/// Fields of `session.compaction` the saved configuration owns (`COMPACTION_CONFIG_KEYS`): a commit
/// writes them back from the live record, never from the plan it started with.
pub const CONFIG_KEYS: [&str; 38] = [
    "auto", "onModelChange", "summaryMode", "type", "compactType", "compact_type", "semantic", "semanticModel", "prune", "tailTurns", "recallMemoryTimeoutMs", "recallIngestLimit",
    "recallChunkLimit", "recallLimit", "recallCycle1BatchSize", "recallRowsPerSession", "recallWindowSize", "recallConcurrency", "recallCycle1DeadlineMs", "enabled", "useMaintainer",
    "model", "summaryModel", "timeoutMs", "memoryTimeoutMs", "buffer", "bufferTokens", "reservedTokens", "bufferPercent", "bufferPct", "bufferRatio", "bufferFraction",
    "mainBufferTokens", "mainBuffer", "mainBufferPercent", "mainBufferPct", "mainBufferRatio", "mainBufferFraction",
];

/// `withoutLegacyCompactFields`.
const LEGACY_FIELDS: [&str; 13] = [
    "type", "compactType", "semantic", "semanticModel", "semanticTimeoutMs", "tailTurns", "lastCompactType", "lastSemantic", "lastSemanticError", "lastRecallFastTrack",
    "lastRecallFastTrackError", "lastRecallFastTrackQuerySha", "lastSemanticUsage",
];

/// The summary pass as the commit reads it (`freshContextResult`).
#[derive(Clone, Debug, Default)]
pub struct SummaryFacts {
    /// `{ inputTokens, outputTokens, cachedTokens, cacheWriteTokens }` as the pass reported them.
    pub usage: Option<Value>,
    pub fresh_context: bool,
    pub handoff_source: Option<String>,
    pub summary_provider: Option<String>,
    pub summary_model: Option<String>,
    /// `diagnostics.pipeline.mode`.
    pub pipeline_mode: Option<String>,
    /// `pipeline.summaryRoute`, and whether the summary was a fork of the cached request
    /// (`pipeline.generated.mode === 'shared-prefix'`).
    pub summary_route: Option<String>,
    pub forked: bool,
    pub generated_ms: Option<f64>,
    pub total_ms: Option<f64>,
}

/// What the archive took out of the context (`prepareCompactionArchive`): the count of rows and
/// the `{ messageIds, callIds }` identities.
#[derive(Clone, Debug)]
pub struct Archived {
    pub dropped: u64,
    pub identities: Option<Value>,
}

/// Everything a commit reads besides the plan.
pub struct CommitInput<'a> {
    /// The plan's input: the session header (its `compaction` record) and its tools.
    pub status: &'a StatusInput<'a>,
    pub plan: &'a CompactionPlan,
    pub auto_mode: bool,
    pub now: f64,
    pub started_at: f64,
    pub commit_started_at: f64,
    pub committed_at: f64,
    pub fresh: &'a SummaryFacts,
    /// The rows of the transcript snapshot the plan priced, and of the compacted transcript the pass returned.
    pub before_rows: &'a [Value],
    pub compacted_rows: &'a [Value],
    pub compacted: &'a [AgentMessage],
    /// The messages a finished turn appended meanwhile, kept after the compacted ones.
    pub appended: &'a [AgentMessage],
    /// The request tools of the final transcript (`resolveSessionCompactionPolicy(session, transcript)`).
    pub after_tools: RequestTools<'a>,
    /// `archived` is read only for a transcript that changed.
    pub archived: Option<Archived>,
}

/// A committed compaction.
pub struct Committed {
    /// `commitSessionCompaction`'s answer.
    pub result: Value,
    /// `session.compaction` after the commit (the record with its timing).
    pub compaction: Map<String, Value>,
    pub changed: bool,
}

/// A compaction that did not apply.
pub struct Failed {
    pub result: Value,
    pub compaction: Map<String, Value>,
}

fn string_or_null(value: &Option<String>) -> Value {
    value.as_ref().map_or(Value::Null, |s| json!(s))
}

/// `summaryUsageRecord`.
fn usage_record(usage: Option<&Value>) -> Value {
    let Some(usage) = usage.filter(|u| truthy(Some(u))) else { return Value::Null };
    let count = |key: &str| num(number_or_zero(usage.get(key)));
    json!({
        "inputTokens": count("inputTokens"),
        "outputTokens": count("outputTokens"),
        "cachedTokens": count("cachedTokens"),
        "cacheWriteTokens": count("cacheWriteTokens"),
    })
}

/// `addCompactUsageToSession`: the session totals after the summary's usage is added. Provider
/// families that report input without the cache reads count the cache writes beside it.
pub fn usage_totals(session: &Header, usage: &Value, input_excludes_cache: bool) -> Map<String, Value> {
    let count = |key: &str| number_or_zero(usage.get(key));
    let (input, output, cached, cache_write) = (count("inputTokens"), count("outputTokens"), count("cachedTokens"), count("cacheWriteTokens"));
    let uncached = if input <= 0.0 {
        0.0
    } else if input_excludes_cache {
        input + cache_write
    } else {
        (input - cached - cache_write).max(0.0)
    };
    let total = |key: &str| number_or_zero(get(session, key));
    let mut out = Map::new();
    out.insert("totalInputTokens".into(), num(total("totalInputTokens") + input));
    out.insert("totalOutputTokens".into(), num(total("totalOutputTokens") + output));
    out.insert("totalCachedReadTokens".into(), num(total("totalCachedReadTokens") + cached));
    out.insert("totalCacheWriteTokens".into(), num(total("totalCacheWriteTokens") + cache_write));
    out.insert("totalUncachedInputTokens".into(), num(total("totalUncachedInputTokens") + uncached));
    out.insert("tokensCumulative".into(), num(total("tokensCumulative") + input + output));
    out
}

/// `withLiveCompactionConfig(withoutLegacyCompactFields(live), telemetry)`.
fn record_of(session: &Header, telemetry: Vec<(&str, Value)>) -> Map<String, Value> {
    let mut live = get(session, "compaction").and_then(Value::as_object).cloned().unwrap_or_default();
    for key in LEGACY_FIELDS {
        live.shift_remove(key);
    }
    let live_auto = live.get("auto") != Some(&Value::Bool(false));
    let mut record = live.clone();
    record.insert("auto".into(), Value::Bool(live_auto));
    for (key, value) in telemetry {
        record.insert(key.to_owned(), value);
    }
    for key in CONFIG_KEYS {
        if key == "auto" || key == "bufferTokens" || key == "bufferRatio" {
            continue;
        }
        match live.get(key) {
            Some(value) => {
                record.insert(key.to_owned(), value.clone());
            }
            None => {
                record.shift_remove(key);
            }
        }
    }
    record.insert("auto".into(), Value::Bool(live_auto));
    record
}

/// The plan's own telemetry, then the pass's.
fn telemetry(plan: &CompactionPlan, stage: &str, after: &After, now: f64, reserve: Vec<(&'static str, Value)>, outcome: Vec<(&'static str, Value)>) -> Vec<(&'static str, Value)> {
    let mut out = vec![
        ("boundaryTokens", num(plan.boundary)),
        ("triggerTokens", num(plan.trigger_tokens)),
        ("bufferTokens", num(plan.buffer_tokens)),
        ("bufferRatio", num(plan.buffer_ratio)),
    ];
    out.extend(reserve);
    out.extend([
        ("lastStage", json!(stage)),
        ("lastBeforeTokens", num(plan.before_tokens)),
        ("lastAfterTokens", num(after.tokens)),
        ("lastBeforeMessageTokens", num(plan.before_message_tokens)),
        ("lastAfterMessageTokens", num(after.message_tokens)),
        ("lastPressureTokens", num(plan.pressure_tokens)),
        ("currentEstimatedTokens", num(after.tokens)),
        ("lastCheckedAt", num(now)),
    ]);
    out.extend(outcome);
    out
}

/// `recordFailedCompaction`: the record and answer of a pass that did not apply (a failed summary,
/// or a conversation that moved meanwhile).
pub fn failed_compaction(status: &StatusInput<'_>, plan: &CompactionPlan, auto_mode: bool, now: f64, compact_error: &str, fresh_error: Option<&str>) -> Failed {
    let stage = if auto_mode { "post_turn_failed" } else { "manual_failed" };
    let after = plan.unchanged_after();
    let fresh_error_value = fresh_error.map_or(Value::Null, |e| json!(e));
    let outcome = vec![
        ("lastChanged", json!(false)),
        ("lastFreshContext", json!(false)),
        ("lastFreshContextError", fresh_error_value.clone()),
        ("lastError", json!(compact_error)),
    ];
    let compaction = record_of(status.session, telemetry(plan, stage, &after, now, vec![("reserveTokens", num(plan.reserve_tokens))], outcome));
    let outcome_map = Map::from_iter([("changed".to_owned(), json!(false)), ("error".to_owned(), json!(compact_error))]);
    let tail = Map::from_iter([("freshContext".to_owned(), json!(false)), ("freshContextError".to_owned(), fresh_error_value)]);
    Failed { result: plan.result(outcome_map, &after, tail), compaction }
}

/// `commitSessionCompaction` once the transcript reconciles: the result and the record.
pub fn commit_compaction(input: &CommitInput<'_>) -> Committed {
    let (status, plan, fresh) = (input.status, input.plan, input.fresh);
    let session = status.session;
    // `afterCompactionNumbers` and `withAppendedMessages`: the changed rule compares the encodings
    // of the snapshot and of the compacted transcript, element by element.
    let encodes = |rows: &[Value]| rows.iter().map(mixdog_js::json_stringify).collect::<Vec<_>>();
    let changed = input.before_rows.len() != input.compacted_rows.len() || encodes(input.before_rows) != encodes(input.compacted_rows);
    let mut message_tokens = status.meter.messages(input.compacted) as f64;
    if !input.appended.is_empty() {
        message_tokens += status.meter.messages(input.appended) as f64;
    }
    let transcript_len = input.compacted.len() + input.appended.len();
    // `afterTranscriptTokens`: the calibrated estimate plus the request reserve of the final transcript.
    let (tokens, request_reserve, reserve) = match worker_policy(session, &input.after_tools, true) {
        Some(Worker::Policy(policy)) => (current_estimate_tokens(message_tokens, &policy), policy.request_reserve_tokens, policy.reserve_tokens),
        Some(Worker::Off) => (current_estimate_tokens(message_tokens, &Policy::default()), None, None),
        None => (message_tokens + plan.reserve_tokens, None, None),
    };
    let after = After { messages: transcript_len, tokens, message_tokens };
    let prior = get(session, "compaction").and_then(Value::as_object);
    let prior_number = |key: &str| prior.map(|c| number_or_zero(get(c, key))).filter(|n| *n != 0.0);
    let stamped = |key: &str| if changed { num(input.now) } else { prior_number(key).map_or(Value::Null, num) };
    let outcome = vec![
        ("lastChanged", json!(changed)),
        ("lastChangedAt", stamped("lastChangedAt")),
        ("lastCompactAt", stamped("lastCompactAt")),
        ("lastFreshContext", json!(fresh.fresh_context)),
        ("lastFreshContextError", Value::Null),
        ("lastError", Value::Null),
        ("lastHandoffSource", json!(fresh.handoff_source.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "session-local".into()))),
        ("lastSummaryProvider", string_or_null(&fresh.summary_provider)),
        ("lastSummaryModel", string_or_null(&fresh.summary_model)),
        ("lastSummaryUsage", usage_record(fresh.usage.as_ref())),
        ("compactCount", num(prior_number("compactCount").unwrap_or(0.0) + if changed { 1.0 } else { 0.0 })),
    ];
    let stage = if input.auto_mode { "post_turn" } else { "manual" };
    let reserve_fields = vec![
        ("requestReserveTokens", num(request_reserve.unwrap_or(0.0))),
        ("reserveTokens", num(reserve.unwrap_or(plan.reserve_tokens))),
    ];
    let mut compaction = record_of(session, telemetry(plan, stage, &after, input.now, reserve_fields, outcome));
    // `recordCompactionTiming`.
    let summary_run = fresh.summary_route.as_ref().filter(|r| !r.is_empty()).map(|route| format!("{}:{route}", if fresh.forked { "fork" } else { "isolated" }));
    let mode = match (&summary_run, &fresh.pipeline_mode) {
        (Some(run), Some(mode)) => json!(format!("{mode}:{run}")),
        (_, mode) => mode.clone().filter(|m| !m.is_empty()).map_or(Value::Null, |m| json!(m)),
    };
    for (key, value) in [
        ("lastStartedAt", num(input.started_at)),
        ("lastCommittedAt", num(input.committed_at)),
        ("lastDurationMs", num(input.committed_at - input.started_at)),
        ("lastPipelineMs", fresh.total_ms.map_or(Value::Null, num)),
        ("lastSummaryMs", fresh.generated_ms.map_or(Value::Null, num)),
        ("lastCommitMs", num(input.committed_at - input.commit_started_at)),
        ("lastCompactMode", mode),
    ] {
        compaction.insert(key.to_owned(), value);
    }
    let archived = input.archived.as_ref().filter(|_| changed);
    let reason = if changed { Value::Null } else if plan.force { json!("nothing to compact") } else { json!("below threshold") };
    let outcome_map = Map::from_iter([("changed".to_owned(), json!(changed)), ("reason".to_owned(), reason)]);
    let tail = Map::from_iter([
        ("freshContext".to_owned(), json!(fresh.fresh_context)),
        ("freshContextError".to_owned(), Value::Null),
        ("handoffSource".to_owned(), json!(fresh.handoff_source.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "session-local".into()))),
        ("usage".to_owned(), fresh.usage.clone().filter(|u| truthy(Some(u))).unwrap_or(Value::Null)),
        ("droppedMessages".to_owned(), json!(archived.map_or(0, |a| a.dropped))),
        ("droppedIdentities".to_owned(), archived.and_then(|a| a.identities.clone()).unwrap_or(Value::Null)),
    ]);
    Committed { result: plan.result(outcome_map, &after, tail), compaction, changed }
}
