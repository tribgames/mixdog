//! Node's recording `fixtures/quiet-progress-cases/golden.json` (`record-quiet-progress-cases.mjs`), read when the test
//! runs and decoded with [`Exact`]. Case 4: the pool rows' turn progress (`withTurnProgress` over `isTurnInFlight`): the
//! recorded rows go through the listing's last step ([`AgentPool`]'s `with_progress`, which `list` lays over every row)
//! with the recorded runtime entries, and the whole recorded value is compared. Cases 0-3: the core's half of one chain.
//! Each recorded input goes to the core's quiet state ([`quiet_progress`](super::super::quiet_progress)), the published
//! `spinner.quiet` (`turn_quiet_state`) and the pool row of a sent request; the whole of it is `src/tui/quiet-progress-core.json`,
//! which `src/tui/quiet-progress-replay.test.mjs` hands to the client's `buildSpinnerMeta` and compares each case whole.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_agent::agent_tool::watchdog::{AgentKind, stall_warn_ms};
use mixdog_testkit::Exact;
use serde_json::{Value, json};

use super::super::quiet_progress::{
    MODEL_THINKING_STAGE, QUIET_PROGRESS_CUE_MS, awaiting_model_response, display_progress_stage, last_progress_at, quiet_progress, quiet_wait_kind,
    turn_quiet_state,
};
use super::{AgentPool, PoolLive, PoolStore, Row, RuntimeEntry};

fn golden() -> Exact {
    Exact::load(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/quiet-progress-cases/golden.json"))
}

/// Node's `runtimeState.get(id)` entry as the daemon's: the liveness record, and the turn's controller (any
/// `controller` that is not aborted) as `controller_live`.
fn runtime_entry(entry: &Value) -> RuntimeEntry {
    let mut liveness = entry.as_object().cloned().unwrap_or_default();
    let controller = liveness.shift_remove("controller");
    RuntimeEntry { liveness, controller_live: controller.is_some_and(|c| c.is_object() && c.get("signal").and_then(|s| s.get("aborted")) != Some(&Value::Bool(true))) }
}

/// The recorder's lookup (`record-quiet-progress-cases.mjs:66`): the recorded entry for `run`, `{ stage: 'idle' }`
/// for any other session; the stall warn point from the watchdog, with no environment override.
struct Live {
    entry: Value,
}

impl PoolLive for Live {
    fn now(&self) -> f64 {
        0.0
    }
    fn running(&self) -> HashSet<String> {
        HashSet::new()
    }
    fn awaiting_shell(&self) -> HashSet<String> {
        HashSet::new()
    }
    fn live_session(&self, _: &str) -> Option<Value> {
        None
    }
    fn runtime_entry(&self, session_id: &str) -> Option<RuntimeEntry> {
        Some(runtime_entry(&if session_id == "run" { self.entry.clone() } else { json!({ "stage": "idle" }) }))
    }
    fn ledger_tokens(&self, _: &[(String, Vec<String>)]) -> HashMap<String, String> {
        HashMap::new()
    }
    fn stall_warn_ms(&self, agent: Option<&str>) -> f64 {
        stall_warn_ms(AgentKind { name: agent, hidden: false, stall_cap_idle_seconds: None }, &|_| None) as f64
    }
}

struct NoStore;

#[async_trait::async_trait]
impl PoolStore for NoStore {
    async fn agent_index(&self) -> Option<Value> {
        None
    }
    async fn lead_index(&self) -> Option<Value> {
        None
    }
    async fn headers(&self, ids: &[String]) -> Vec<Option<Row>> {
        vec![None; ids.len()]
    }
}

fn core_file() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../src/tui/quiet-progress-core.json")
}

/// The recorded case `index`, checked by name: its observed value.
fn observed<'a>(golden: &'a Exact, index: usize, name: &str) -> &'a Exact {
    let case = &golden.get("cases").as_array()[index];
    assert_eq!(case.get("case").as_str(), name, "case {index}");
    case.get("observed")
}

fn plain(value: &Exact) -> Value {
    value.to_plain().unwrap()
}

/// `quietProgress(input)` of a recorded `{ progressAt, stage, tool?, now }`.
fn quiet_of(input: &Value) -> Option<Value> {
    quiet_progress(input["progressAt"].as_f64().unwrap(), input["stage"].as_str(), input["tool"].as_str(), input["now"].as_f64().unwrap())
}

/// What the core gives for the inputs of cases 0-3.
fn core_values() -> Value {
    let golden = golden();
    let case0 = observed(&golden, 0, "the quiet cue is lenient: a turn reads quiet only after the cue window without counted progress");
    let quiet0: Vec<Value> = case0.get("quietProgress").as_array().iter().map(|call| quiet_of(&plain(call.get("input"))).unwrap_or(Value::Null)).collect();
    let kinds: Vec<Value> = case0.get("quietWaitKind").as_array().iter().map(|kind| json!(quiet_wait_kind(Some(kind.get("stage").as_str())))).collect();

    // Case 1: the state a turn quiet since `progressAt` publishes at `now`: its liveness as the watch reads it.
    let case1 = observed(&golden, 1, "the quiet state is frozen for a silence and escalates only at the watchdog warn point");
    let input = plain(case1.get("quietInput"));
    let liveness = json!({ "stage": input["stage"], "lastProgressAt": input["progressAt"], "currentTool": input["tool"] });
    let published = turn_quiet_state(liveness.as_object(), input["now"].as_f64().unwrap(), plain(case1.get("warnMs")).as_f64().unwrap());

    let case2 = observed(&golden, 2, "a sent request waiting for its headers is the model-thinking stage until transport arrives");
    let stages: Vec<Value> = case2
        .get("stages")
        .as_array()
        .iter()
        .map(|stage| {
            let input = plain(stage.get("input"));
            json!({ "awaiting": awaiting_model_response(input.as_object()), "displayStage": display_progress_stage(input.as_object()) })
        })
        .collect();
    let live = Arc::new(Live { entry: plain(case2.get("sentEntry")) });
    let pool = AgentPool::new(Arc::new(NoStore), live);
    let sent_row = pool.with_progress(plain(case2.get("sentRow")).as_object().unwrap().clone(), &HashSet::new());

    let case3 = observed(&golden, 3, "progress is counted from the same stamps as the stall watchdog");
    let stamps = plain(case3.get("stamps"));
    json!({
        "0": { "cueWindowMs": QUIET_PROGRESS_CUE_MS, "quietProgress": quiet0, "quietWaitKind": kinds },
        "1": { "published": published },
        "2": { "modelThinkingStage": MODEL_THINKING_STAGE, "stages": stages, "waitKindOfThinking": quiet_wait_kind(Some(MODEL_THINKING_STAGE)), "poolRowFromSentEntry": sent_row },
        "3": { "lastProgressAt": last_progress_at(stamps.as_object()), "nullEntry": last_progress_at(None) },
    })
}

/// The core's values equal the file the client test reads. `MIXDOG_WRITE_QUIET_PROGRESS_CORE=1` writes them there instead.
#[test]
fn the_core_gives_the_client_the_quiet_states_the_recording_was_made_from() {
    let got = core_values();
    let path = core_file();
    if std::env::var_os("MIXDOG_WRITE_QUIET_PROGRESS_CORE").is_some() {
        std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&got).unwrap())).unwrap();
        return;
    }
    let want: Value = serde_json::from_str(&mixdog_testkit::read_string(&path)).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(got, want, "the core's quiet states differ from {}", path.display());
}

#[test]
fn running_pool_rows_carry_their_turn_progress_stage_and_warn_point() {
    let golden = golden();
    let name = "running pool rows carry their turn progress, stage and warn point; settled rows pass through";
    let case = &golden.get("cases").as_array()[4];
    assert_eq!(case.get("case").as_str(), name);
    let want = case.get("observed");
    let entry = want.get("entry").to_plain().unwrap();
    let rows = want.get("rows").to_plain().unwrap();
    let live = Arc::new(Live { entry: entry.clone() });
    let pool = AgentPool::new(Arc::new(NoStore), live.clone());
    let decorated: Vec<Value> =
        rows.as_array().unwrap().iter().map(|row| Value::Object(pool.with_progress(row.as_object().unwrap().clone(), &HashSet::new()))).collect();
    // Node's `decorated[1] === rows[1]`: a settled row comes back as it went in.
    let settled = decorated[1] == rows[1];
    let got = json!({
        "entry": entry,
        "rows": rows,
        "decorated": decorated,
        "settledRowIsTheSameObject": settled,
        "workerWarnSeconds": live.stall_warn_ms(Some("worker")) / 1000.0,
    });
    assert!(Exact::plain(&got) == *want, "{name}: {got}");
}
