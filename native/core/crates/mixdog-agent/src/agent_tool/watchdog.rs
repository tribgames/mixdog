//! The progress watchdog's policy and its verdict texts (Node `agent-runtime/
//! agent-progress-watchdog.mjs`, with the thresholds of `stall-policy.mjs`). It applies to
//! unattended runs only (agent jobs, routines, schedules, goals); an attended run has a person
//! who can stop it, and SPEC §4.9 keeps content timers off it.
//!
//! The deadlines are Node's: [`resolve_policy`] is `resolveAgentWatchdogPolicy` over the same
//! environment keys. The verdict itself is [`super::progress::stale_report`]
//! (`evaluateAgentWatchdogAbort`); the sweep that acts on it lives with the run host.

use mixdog_js::js_trim_start;

use super::progress::WatchdogPolicy;

/// `STALL_TICK_MS`: the margin the watchdog's windows keep above the provider's own.
pub const STALL_TICK_MS: i64 = 15_000;

/// `WATCHDOG_STOP_ERROR`: the failure the owner reads for a stalled turn that still handed back
/// partial output.
pub const WATCHDOG_STOP_ERROR: &str = "stalled: the progress watchdog stopped the turn";

/// The worker row's failure reason for a turn the watchdog stopped (`WATCHDOG_STALL_FAILURE`).
pub const WATCHDOG_STALL_FAILURE: &str = "stalled";

/// `KEEPALIVE_MAX_IDLE_MULTIPLIER` lives with the verdict; the defaults below are Node's.
const DEFAULT_STALL_ABORT_S: i64 = 600;
const DEFAULT_STALL_WARN_S: i64 = 300;
const DEFAULT_FIRST_RESPONSE_MS: i64 = 120_000;
const DEFAULT_FIRST_VISIBLE_MS: i64 = 600_000;
/// `DEFAULT_STALE_TIMEOUT_MS`: 30 minutes, `MIXDOG_AGENT_STALE_TIMEOUT_MS`.
pub const DEFAULT_STALE_MS: i64 = 30 * 60_000;

/// Reads one environment variable.
pub type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

/// What the run's agent and routing add to the environment's thresholds
/// (`resolveAgentWatchdogPolicy`'s `overrides`). `None` takes the default.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Overrides {
    pub idle_timeout_ms: Option<i64>,
    /// `firstTransportTimeoutMs ?? firstResponseTimeoutMs`.
    pub first_transport_timeout_ms: Option<i64>,
    /// `firstSemanticTimeoutMs ?? firstVisibleTimeoutMs`.
    pub first_semantic_timeout_ms: Option<i64>,
    pub provider_first_byte_timeout_ms: Option<i64>,
    pub provider_first_output_timeout_ms: Option<i64>,
}

/// The run's agent, as the stall thresholds read it.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct AgentKind<'a> {
    pub name: Option<&'a str>,
    /// `getHiddenAgent(agent)` is set: an internal role.
    pub hidden: bool,
    /// The hidden agent's own `stallCap.idleSeconds`.
    pub stall_cap_idle_seconds: Option<i64>,
}

/// `parseInt(raw, 10)`.
fn parse_int(raw: &str) -> Option<i64> {
    let text = js_trim_start(raw);
    let (sign, rest) = match text.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, text.strip_prefix('+').unwrap_or(text)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse::<i64>().ok().map(|n| n * sign)
}

fn present(env: Env<'_>, name: &str) -> Option<String> {
    env(name).filter(|raw| !raw.is_empty())
}

/// `envThresholdSeconds`: `STALL_TIMEOUT_S`, when a positive integer.
fn threshold_seconds(env: Env<'_>) -> Option<i64> {
    parse_int(&present(env, "STALL_TIMEOUT_S")?).filter(|n| *n > 0)
}

/// `resolveTimeoutMs`: the first named variable that is a positive number, clamped.
fn timeout_ms(env: Env<'_>, names: &[&str], fallback: i64, min: i64, max: i64) -> i64 {
    for name in names {
        if let Some(raw) = present(env, name) {
            let n = mixdog_js::string_to_number(&raw);
            if n.is_finite() && n > 0.0 {
                return n.max(min as f64).min(max as f64) as i64;
            }
        }
    }
    fallback.max(min).min(max)
}

/// `envTimeoutMs`: a present variable that is a non-negative number, else the fallback.
fn env_timeout_ms(env: Env<'_>, name: &str, fallback: i64) -> i64 {
    let Some(raw) = present(env, name) else { return fallback };
    let n = mixdog_js::string_to_number(&raw).floor();
    if n.is_finite() && n >= 0.0 { n as i64 } else { fallback }
}

/// `resolveExplicitMs`.
fn explicit(value: Option<i64>, fallback: i64) -> i64 {
    value.filter(|v| *v >= 0).unwrap_or(fallback)
}

/// `aboveProviderBudget`: one deadline floored a tick above the provider's own budget.
fn above_provider_budget(requested: i64, provider_budget: i64) -> i64 {
    if requested <= 0 || provider_budget <= 0 {
        return requested;
    }
    requested.max(provider_budget + STALL_TICK_MS)
}

/// `WORKFLOW_AGENT_STALL_ABORT_S`.
fn role_abort_seconds(agent: Option<&str>) -> Option<i64> {
    match agent? {
        "worker" | "reviewer" | "maintainer" => Some(300),
        "heavy-worker" => Some(420),
        _ => None,
    }
}

/// `resolveAgentStallThresholds(agent, env).warn`, in milliseconds (the status row's `stallWarnMs`). An
/// agent stall notifies only at its abort deadline, so warn is abort: `STALL_TIMEOUT_S` when set, else
/// the hidden agent's own `stallCap.idleSeconds`, else the role's workflow budget, else the base 600.
pub fn stall_warn_ms(agent: AgentKind<'_>, env: Env<'_>) -> i64 {
    let configured = agent.stall_cap_idle_seconds.filter(|seconds| *seconds > 0).or_else(|| role_abort_seconds(agent.name)).unwrap_or(DEFAULT_STALL_ABORT_S);
    threshold_seconds(env).unwrap_or(configured) * 1000
}

/// `resolveAgentWatchdogPolicy(agent, overrides)`.
pub fn resolve_policy(agent: AgentKind<'_>, overrides: Overrides, env: Env<'_>) -> WatchdogPolicy {
    // The module-level stall thresholds.
    let base_abort_s = threshold_seconds(env).unwrap_or(DEFAULT_STALL_ABORT_S);
    let warn_s = if base_abort_s > DEFAULT_STALL_WARN_S { DEFAULT_STALL_WARN_S } else { base_abort_s / 2 };
    let max_before_warn = (warn_s * 1000 - STALL_TICK_MS).max(1000);
    let provider_first_byte = timeout_ms(env, &["MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS"], 60_000, 30_000, max_before_warn);
    let semantic_max = (base_abort_s * 1000 - STALL_TICK_MS).max(10_000);
    let semantic_idle = timeout_ms(
        env,
        &["MIXDOG_PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS", "MIXDOG_PROVIDER_SSE_IDLE_TIMEOUT_MS"],
        300_000,
        10_000,
        semantic_max,
    );
    let ws_semantic_idle = timeout_ms(
        env,
        &["MIXDOG_PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS", "MIXDOG_PROVIDER_WS_OUTPUT_IDLE_TIMEOUT_MS"],
        300_000,
        10_000,
        semantic_max,
    );
    // The provider's recovery window must always fire before the watchdog's terminal abort.
    let recovery_floor = semantic_idle.max(ws_semantic_idle) + STALL_TICK_MS;

    let first_transport = above_provider_budget(
        explicit(overrides.first_transport_timeout_ms, env_timeout_ms(env, "MIXDOG_AGENT_FIRST_RESPONSE_TIMEOUT_MS", DEFAULT_FIRST_RESPONSE_MS)),
        explicit(overrides.provider_first_byte_timeout_ms, provider_first_byte),
    );
    let first_semantic = above_provider_budget(
        explicit(overrides.first_semantic_timeout_ms, env_timeout_ms(env, "MIXDOG_AGENT_FIRST_VISIBLE_TIMEOUT_MS", DEFAULT_FIRST_VISIBLE_MS)),
        explicit(overrides.provider_first_output_timeout_ms, 0),
    );

    let idle_stale = if let Some(idle) = overrides.idle_timeout_ms.filter(|v| *v >= 0) {
        idle
    } else {
        // `resolveAgentStallThresholds(agent).abort`.
        let cap = agent.stall_cap_idle_seconds.filter(|s| *s > 0);
        let configured = cap.or_else(|| role_abort_seconds(agent.name)).unwrap_or(base_abort_s);
        let abort_s = threshold_seconds(env).unwrap_or(configured);
        if agent.hidden {
            (abort_s * 1000).max(recovery_floor)
        } else {
            // A backstop only: it may not exceed the stall abort, with 30 minutes as the ceiling.
            let stale = env_timeout_ms(env, "MIXDOG_AGENT_STALE_TIMEOUT_MS", DEFAULT_STALE_MS);
            let backstop = (abort_s * 1000).max(0);
            let idle = if backstop > 0 { stale.min(backstop) } else { stale };
            idle.max(recovery_floor)
        }
    };
    WatchdogPolicy { first_transport_ms: first_transport, first_semantic_ms: first_semantic, idle_stale_ms: idle_stale }
}

/// `isAgentProgressWatchdogAbortError`: the abort reason the watchdog's verdict carries.
pub fn is_watchdog_abort(message: &str) -> bool {
    let Some(rest) = message.strip_prefix("agent ") else { return false };
    ["first transport stale", "first semantic response stale", "first response stale", "task stale"]
        .iter()
        .find_map(|head| rest.strip_prefix(head))
        .is_some_and(|tail| js_trim_start(tail).starts_with('('))
}

/// `watchdogStoppedHandoff`: the owner reads the stop and its reason before the partial text, so
/// it never mistakes that text for a finished result or a user cancel. `stopped` / `stopping` are
/// the background shell jobs the stop ended / is still ending.
pub fn stopped_handoff(message: &str, partial: &str, stopped: &[String], stopping: &[String]) -> String {
    let note = stopped_jobs_note(stopped, stopping).map(|note| format!("\n{note}")).unwrap_or_default();
    format!("[Agent stopped by the progress watchdog: {message}. The output below is partial.]{note}\n\n{partial}")
}

/// `stoppedShellJobsNote`: which background shell jobs the stop ended and which it is still
/// ending; `None` when it stopped none.
pub fn stopped_jobs_note(stopped: &[String], stopping: &[String]) -> Option<String> {
    let mut notes = Vec::new();
    if !stopped.is_empty() {
        notes.push(format!("[Stopped its background shell jobs: {}.]", stopped.join(", ")));
    }
    if !stopping.is_empty() {
        notes.push(format!("[Still stopping its background shell jobs: {}.]", stopping.join(", ")));
    }
    (!notes.is_empty()).then(|| notes.join(" "))
}

/// `resolveAgentStallThresholds(..).warn` against Node's run (`fixtures/stall-thresholds/golden.json`).
#[cfg(test)]
#[path = "watchdog_stall_tests.rs"]
mod stall_tests;

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    /// What real Node answered (`benchmarks/rust-core/recorders/record-agent-watchdog.mjs`).
    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../../fixtures/agent-watchdog/golden.json")).unwrap()
    }

    fn overrides_of(recorded: &Value) -> Overrides {
        let ms = |key: &str| recorded.get(key).and_then(Value::as_i64);
        Overrides {
            idle_timeout_ms: ms("idleTimeoutMs"),
            first_transport_timeout_ms: ms("firstResponseTimeoutMs"),
            first_semantic_timeout_ms: ms("firstSemanticTimeoutMs"),
            provider_first_byte_timeout_ms: ms("providerFirstByteTimeoutMs"),
            provider_first_output_timeout_ms: ms("providerFirstOutputTimeoutMs"),
        }
    }

    #[test]
    fn the_policy_is_what_node_resolved_under_each_environment() {
        let golden = golden();
        let mut checked = 0;
        for environment in golden["policies"].as_array().unwrap() {
            let vars = environment["env"].as_object().unwrap().clone();
            let read = move |name: &str| vars.get(name).and_then(Value::as_str).map(str::to_owned);
            for case in environment["cases"].as_array().unwrap() {
                let kind = AgentKind {
                    name: case["agent"].as_str(),
                    hidden: case["hidden"].as_bool().unwrap(),
                    stall_cap_idle_seconds: case["stallCapIdleSeconds"].as_i64(),
                };
                let policy = resolve_policy(kind, overrides_of(&case["overrides"]), &read);
                let want = &case["policy"];
                assert_eq!(
                    (policy.first_transport_ms, policy.first_semantic_ms, policy.idle_stale_ms),
                    (want["firstTransportMs"].as_i64().unwrap(), want["firstSemanticMs"].as_i64().unwrap(), want["idleStaleMs"].as_i64().unwrap()),
                    "{} {} {}",
                    environment["env"],
                    case["agent"],
                    case["overrides"]
                );
                checked += 1;
            }
        }
        assert!(checked > 0);
    }

    #[test]
    fn only_the_abort_texts_node_calls_a_stall_are_one() {
        for case in golden()["abortTexts"].as_array().unwrap() {
            let message = case["message"].as_str().unwrap();
            assert_eq!(is_watchdog_abort(message), case["stall"].as_bool().unwrap(), "{message:?}");
        }
    }

    #[test]
    fn the_handoff_is_the_text_node_built() {
        let golden = golden();
        let names = |list: Option<&Value>| -> Vec<String> {
            list.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()
        };
        for case in golden["handoffs"].as_array().unwrap() {
            let jobs = case.get("shellJobs");
            let text = stopped_handoff(
                case["message"].as_str().unwrap(),
                case["partial"].as_str().unwrap(),
                &names(jobs.and_then(|j| j.get("stopped"))),
                &names(jobs.and_then(|j| j.get("stopping"))),
            );
            assert_eq!(text, case["text"].as_str().unwrap());
        }
    }
}