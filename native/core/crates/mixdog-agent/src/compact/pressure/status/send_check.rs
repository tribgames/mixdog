//! The telemetry of a pre-send check that compacts nothing (`session/pre-send-compact.mjs`
//! `runPreSendCompactPass` → `compactTelemetry(ctx, 'pre_send_check')`, which is
//! `loop/compact-policy.mjs` `rememberCompactTelemetry`): the decision's numbers on
//! `session.compaction`, the ring of the last eight checks, and the window the policy resolved on the
//! session itself.

use super::*;
use crate::compact::pressure::HeaderPatch;
use crate::compact::pressure::UsageSnapshotArgs;
use crate::compact::pressure::record_context_usage_snapshot;
use crate::compact::summary_run::HANDOFF_TIMEOUT_MAX_MS;

/// `COMPACTION_TRANSIENT_KEYS`: legacy fields that no longer describe the live policy.
const TRANSIENT_KEYS: [&str; 11] = [
    "type", "compactType", "semantic", "recallFastTrack", "semanticModel", "semanticTimeoutMs", "tailTurns", "lastSemantic", "lastSemanticError", "lastRecallFastTrack",
    "lastRecallFastTrackError",
];

/// `recentCompactChecks` keeps `.slice(-8)`.
const RECENT_CHECKS: usize = 8;

/// `a || b` over numbers: the first that is not 0 or NaN.
fn first_nonzero(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    a.filter(|v| *v != 0.0 && !v.is_nan()).or(b.filter(|v| *v != 0.0 && !v.is_nan()))
}

/// What a stage of the pre-send pass states beyond the pressure (`meta` of `rememberCompactTelemetry`,
/// as `compactTelemetry(ctx, stage, extra)` passes it).
#[derive(Default)]
pub struct StageMeta<'a> {
    /// `afterTokens`; the pressure when the stage states none.
    pub after_tokens: Option<f64>,
    /// `trigger`.
    pub trigger: Option<&'a str>,
    /// `compactChanged`.
    pub changed: bool,
    /// `freshContext`.
    pub fresh_context: bool,
    /// `freshContextError` / `compactError`: `Some` when the stage states the key, with its text or null.
    pub fresh_error: Option<Option<&'a str>>,
    pub compact_error: Option<Option<&'a str>>,
    /// `handoffSource`.
    pub handoff_source: Option<&'a str>,
    /// `durationMs`.
    pub duration_ms: Option<f64>,
}

/// `recordContextUsageSnapshot(session, policy, { messages, usedTokens, messageTokensEst, source:
/// 'post_compact' })` of a pass that changed the transcript: `input` carries the compacted
/// transcript, `used_tokens` the gauge's post-compaction figure.
pub fn post_compact_snapshot(input: &StatusInput<'_>, used_tokens: f64, now: f64) -> Option<HeaderPatch> {
    let Some(Worker::Policy(policy)) = worker_policy(input.session, &input.request_tools, input.agent_mode) else { return None };
    let estimate = input.meter.messages(input.messages) as f64;
    let args = UsageSnapshotArgs { used_tokens, message_tokens_est: Some(estimate), source: "post_compact", updated_at: Some(now), now };
    record_context_usage_snapshot(input.session, &super::commit::policy_header(&policy), input.messages, input.signer, &args)
}

/// The header change of the check before a send that compacts nothing:
/// `rememberCompactTelemetry(session, policy, { stage: 'pre_send_check', .. })`.
pub fn pre_send_check(input: &StatusInput<'_>, now: f64, reactive: bool) -> Option<HeaderPatch> {
    compact_telemetry(input, now, reactive, "pre_send_check", &StageMeta::default())
}

/// The pressure of the send about to go out when the provider's reading prices it, the figure its check records
/// (`resolveContextTokensWithSource`): the reading that still describes its prefix plus the growth after it (`provider`),
/// else an unanchored session's last actual reading (`provider_resume`). `None` when the session has no worker policy
/// that compacts or the estimate prices it.
pub fn provider_pressure(input: &StatusInput<'_>) -> Option<f64> {
    let Some(Worker::Policy(policy)) = worker_policy(input.session, &input.request_tools, input.agent_mode) else { return None };
    baseline_pressure_tokens(input.session, input.messages, &policy, input).or_else(|| resume_tokens(input.session))
}

/// The header change of `rememberCompactTelemetry(session, policy, { stage, .. })`
/// for the send about to go out: `input` is the session header with the transcript and the tools of
/// that request. `None` when the session has no worker policy that compacts (Node records nothing
/// then). `reactive`: a context-overflow retry is pending, which floors the pressure at the trigger
/// (`compactionTelemetryPressureTokens`).
pub fn compact_telemetry(input: &StatusInput<'_>, now: f64, reactive: bool, stage: &str, meta: &StageMeta<'_>) -> Option<HeaderPatch> {
    let session = input.session;
    let Some(Worker::Policy(policy)) = worker_policy(session, &input.request_tools, input.agent_mode) else { return None };
    let messages = input.messages;
    let estimate = input.meter.messages(messages) as f64;
    let mut pressure = resolve_tokens(session, estimate, &policy, messages, input).0;
    let trigger = policy.trigger_tokens.unwrap_or(0.0);
    let boundary = policy.boundary_tokens.unwrap_or(0.0);
    if reactive {
        let floor = positive_int(Some(&num(trigger))).or_else(|| positive_int(Some(&num(boundary)))).unwrap_or(0.0);
        if floor != 0.0 {
            pressure = pressure.max(floor);
        }
    }

    let empty = Map::new();
    let cfg = get(session, "compaction").filter(|v| truthy(Some(v))).and_then(Value::as_object).unwrap_or(&empty);
    let mut prev = get(session, "compaction").and_then(Value::as_object).cloned().unwrap_or_default();
    for key in TRANSIENT_KEYS {
        prev.shift_remove(key);
    }
    let context_window = policy.context_window;
    let raw_context_window = positive_int(nullish(get(session, "rawContextWindow"), get(cfg, "rawContextWindow"))).or(context_window);
    let effective_percent = Some(number(nullish(get(session, "effectiveContextWindowPercent"), get(cfg, "effectiveContextWindowPercent")))).filter(|v| finite(*v));
    let auto_limit = session_compact_policy(session, policy.boundary_tokens).auto_compact_token_limit;
    let handoff_timeout = positive_int(get(cfg, "timeoutMs")).or_else(|| env_positive_int("MIXDOG_AGENT_COMPACT_TIMEOUT_MS")).unwrap_or(HANDOFF_TIMEOUT_MAX_MS as f64);
    let last_api = positive_int(get(session, "lastContextTokens")).map_or_else(|| or_null(prev.get("lastApiRequestTokens")), num);
    // The last compaction's wall time is replaced only by a stage that reports a finished one.
    let last_duration = match meta.duration_ms.filter(|ms| ms.is_finite()) {
        Some(ms) => num(round(ms).max(0.0)),
        None => prev.get("lastDurationMs").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null),
    };
    // A terminal success of the pre-send stage clears a carried error; otherwise a key the stage states
    // (even as null) replaces the previous value.
    let terminal_success = stage == "pre_send" || stage == "pre_send_check";
    let carried_error = |stated: Option<Option<&str>>, previous: &str| -> Value {
        if terminal_success {
            return Value::Null;
        }
        match stated {
            Some(text) => text.map_or(Value::Null, |text| json!(text)),
            None => or_null(prev.get(previous)),
        }
    };
    let after_tokens = meta.after_tokens.unwrap_or(pressure);
    let current_estimate = if meta.changed && stage == "pre_send" { after_tokens } else { pressure };
    let trigger_stated = meta.trigger.filter(|text| !text.is_empty());
    let handoff_stated = meta.handoff_source.filter(|text| !text.is_empty());

    let telemetry: Vec<(&str, Value)> = vec![
        ("requestReserveTokens", num(policy.request_reserve_tokens.unwrap_or(0.0))),
        ("reserveTokens", num(policy.reserve_tokens.unwrap_or(0.0))),
        ("boundaryTokens", or_none(boundary)),
        ("triggerTokens", or_none(trigger)),
        ("bufferTokens", num(policy.buffer_tokens.unwrap_or(0.0))),
        ("bufferRatio", finite_or_null(policy.buffer_ratio)),
        ("contextWindow", or_none(context_window.unwrap_or(0.0))),
        ("rawContextWindow", or_none(raw_context_window.unwrap_or(0.0))),
        ("effectiveContextWindowPercent", effective_percent.map_or(Value::Null, num)),
        ("autoCompactTokenLimit", or_none(auto_limit.unwrap_or(0.0))),
        ("handoffTimeoutMs", or_none(handoff_timeout)),
        ("lastCheckedAt", num(now)),
        ("lastBeforeTokens", num(pressure)),
        ("lastAfterTokens", num(after_tokens)),
        ("lastPressureTokens", num(pressure)),
        ("currentEstimatedTokens", num(current_estimate)),
        ("lastApiRequestTokens", last_api),
        ("lastStage", json!(stage)),
        ("lastChanged", json!(meta.changed)),
        ("lastTrigger", trigger_stated.map_or_else(|| or_null(prev.get("lastTrigger")), |text| json!(text))),
        ("lastFreshContext", json!(meta.fresh_context)),
        ("lastFreshContextError", carried_error(meta.fresh_error, "lastFreshContextError")),
        ("lastHandoffSource", handoff_stated.map_or_else(|| or_null(prev.get("lastHandoffSource")), |text| json!(text))),
        ("lastError", carried_error(meta.compact_error, "lastError")),
        ("lastDurationMs", last_duration),
        ("compactCount", num(number_or_zero(prev.get("compactCount")) + if meta.changed { 1.0 } else { 0.0 })),
        ("singleShotConsumed", json!((policy.single_shot && stage == "compacting") || prev.get("singleShotConsumed") == Some(&Value::Bool(true)))),
    ];

    // `recentCompactChecks`: the decision beside the live baseline, for a missed-trigger postmortem.
    let mut recent = prev.get("recentChecks").and_then(Value::as_array).cloned().unwrap_or_default();
    let baseline_at = number_or_zero(get(session, "contextPressureBaselineUpdatedAt"));
    let baseline_at = if baseline_at != 0.0 { num(baseline_at) } else { Value::Null };
    let baseline = positive_int(get(session, "contextPressureBaselineTokens")).map_or(Value::Null, num);
    let check_trigger = or_none(first_nonzero(Some(trigger), Some(boundary)).unwrap_or(0.0));
    recent.push(json!({
        "at": num(now),
        "stage": stage,
        "pressure": num(pressure),
        "est": num(estimate),
        "trigger": check_trigger,
        "baseline": baseline,
        "baselineAt": baseline_at,
    }));
    let excess = recent.len().saturating_sub(RECENT_CHECKS);
    recent.drain(..excess);

    // `withLiveCompactionConfig(prev, telemetry)`: the config-owned fields stay the live ones.
    let live_auto = prev.get("auto") != Some(&Value::Bool(false));
    let mut record = prev.clone();
    record.insert("auto".into(), Value::Bool(live_auto));
    for (key, value) in telemetry {
        record.insert(key.to_owned(), value);
    }
    for key in super::commit::CONFIG_KEYS {
        if key == "auto" || key == "bufferTokens" || key == "bufferRatio" {
            continue;
        }
        match prev.get(key) {
            Some(value) => {
                record.insert(key.to_owned(), value.clone());
            }
            None => {
                record.shift_remove(key);
            }
        }
    }
    record.insert("auto".into(), Value::Bool(live_auto));
    record.insert("recentChecks".into(), Value::Array(recent));
    // A changed transcript stamps the compaction's time (the baseline is voided by the caller).
    if meta.changed {
        record.insert("lastChangedAt".into(), num(now));
        record.insert("lastCompactAt".into(), num(now));
    }

    let mut patch = HeaderPatch::default();
    patch.put("compaction", Value::Object(record));
    // `persistCompactPolicy`: the policy's window and boundary on the session itself. Only a
    // sub-boundary explicit limit is kept, so a stale boundary-sized one is cleared here rather than
    // carried to re-collapse the buffer next turn.
    if let Some(window) = context_window.filter(|w| *w != 0.0) {
        patch.put("contextWindow", num(window));
    }
    if let Some(window) = raw_context_window.filter(|w| *w != 0.0) {
        patch.put("rawContextWindow", num(window));
    }
    if boundary != 0.0 {
        patch.put("compactBoundaryTokens", num(boundary));
    }
    let boundary_now = positive_int(Some(&num(if boundary != 0.0 { boundary } else { number_or_zero(get(session, "compactBoundaryTokens")) })));
    let kept = positive_int(get(session, "autoCompactTokenLimit")).filter(|limit| boundary_now.is_none_or(|b| *limit < b));
    patch.put("autoCompactTokenLimit", first_nonzero(auto_limit, kept).map_or(Value::Null, num));
    if let Some(percent) = effective_percent {
        patch.put("effectiveContextWindowPercent", num(percent));
    }
    Some(patch)
}
