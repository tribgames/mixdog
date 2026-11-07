//! The telemetry of a pre-send check that compacts nothing (`session/pre-send-compact.mjs`
//! `runPreSendCompactPass` → `compactTelemetry(ctx, 'pre_send_check')`, which is
//! `loop/compact-policy.mjs` `rememberCompactTelemetry`): the decision's numbers on
//! `session.compaction`, the ring of the last eight checks, and the window the policy resolved on the
//! session itself.

use super::*;
use crate::compact::pressure::HeaderPatch;

/// `COMPACTION_TRANSIENT_KEYS`: legacy fields that no longer describe the live policy.
const TRANSIENT_KEYS: [&str; 11] = [
    "type", "compactType", "semantic", "recallFastTrack", "semanticModel", "semanticTimeoutMs", "tailTurns", "lastSemantic", "lastSemanticError", "lastRecallFastTrack",
    "lastRecallFastTrackError",
];

/// `HANDOFF_TIMEOUT_MAX_MS` (`session/compact/constants.mjs`).
const HANDOFF_TIMEOUT_MAX_MS: f64 = 300_000.0;

/// `recentCompactChecks` keeps `.slice(-8)`.
const RECENT_CHECKS: usize = 8;

/// `a || b` over numbers: the first that is not 0 or NaN.
fn first_nonzero(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    a.filter(|v| *v != 0.0 && !v.is_nan()).or(b.filter(|v| *v != 0.0 && !v.is_nan()))
}

/// The header change of `rememberCompactTelemetry(session, policy, { stage: 'pre_send_check', .. })`
/// for the send about to go out: `input` is the session header with the transcript and the tools of
/// that request. `None` when the session has no worker policy that compacts (Node records nothing
/// then). `reactive`: a context-overflow retry is pending, which floors the pressure at the trigger
/// (`compactionTelemetryPressureTokens`).
pub fn pre_send_check(input: &StatusInput<'_>, now: f64, reactive: bool) -> Option<HeaderPatch> {
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
    let handoff_timeout = positive_int(get(cfg, "timeoutMs")).or_else(|| env_positive_int("MIXDOG_AGENT_COMPACT_TIMEOUT_MS")).unwrap_or(HANDOFF_TIMEOUT_MAX_MS);
    let last_api = positive_int(get(session, "lastContextTokens")).map_or_else(|| or_null(prev.get("lastApiRequestTokens")), num);
    let last_duration = prev.get("lastDurationMs").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null);

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
        ("lastAfterTokens", num(pressure)),
        ("lastPressureTokens", num(pressure)),
        ("currentEstimatedTokens", num(pressure)),
        ("lastApiRequestTokens", last_api),
        ("lastStage", json!("pre_send_check")),
        ("lastChanged", json!(false)),
        ("lastTrigger", or_null(prev.get("lastTrigger"))),
        ("lastFreshContext", json!(false)),
        // A terminal success of the pre-send stage clears a carried error.
        ("lastFreshContextError", Value::Null),
        ("lastHandoffSource", or_null(prev.get("lastHandoffSource"))),
        ("lastError", Value::Null),
        ("lastDurationMs", last_duration),
        ("compactCount", num(number_or_zero(prev.get("compactCount")))),
        ("singleShotConsumed", json!(prev.get("singleShotConsumed") == Some(&Value::Bool(true)))),
    ];

    // `recentCompactChecks`: the decision beside the live baseline, for a missed-trigger postmortem.
    let mut recent = prev.get("recentChecks").and_then(Value::as_array).cloned().unwrap_or_default();
    let baseline_at = number_or_zero(get(session, "contextPressureBaselineUpdatedAt"));
    let baseline_at = if baseline_at != 0.0 { num(baseline_at) } else { Value::Null };
    let baseline = positive_int(get(session, "contextPressureBaselineTokens")).map_or(Value::Null, num);
    let check_trigger = or_none(first_nonzero(Some(trigger), Some(boundary)).unwrap_or(0.0));
    recent.push(json!({
        "at": num(now),
        "stage": "pre_send_check",
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
