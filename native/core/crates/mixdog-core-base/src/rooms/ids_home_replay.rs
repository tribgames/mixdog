//! Node's recording `fixtures/agent-home-cases/golden.json` (`record-agent-home-cases.mjs`, test file
//! `session/agent-home.test.mjs` at b6f10295a), cases 0 and 1: the home key of an agent and the session id
//! pattern, read when the test runs and decoded with [`Exact`]; every recorded input goes through the
//! functions every surface derives the key with, and the whole recorded value is compared.

use std::path::Path;

use mixdog_js::JsRegex;
use mixdog_testkit::Exact;
use serde_json::{Value, json};

use super::{MIXY_AGENT_ID, SESSION_ID_PATTERN, agent_home_session_id, agent_id_of_home_session};

fn golden() -> Exact {
    Exact::load(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/agent-home-cases/golden.json"))
}

fn observed<'a>(golden: &'a Exact, index: usize, name: &str) -> &'a Exact {
    let case = &golden.get("cases").as_array()[index];
    assert_eq!(case.get("case").as_str(), name, "case {index}");
    case.get("observed")
}

/// `agentHomeSessionId(id)`: `''` for an id that is no agent's.
fn home(agent_id: &str) -> String {
    agent_home_session_id(agent_id).unwrap_or_default()
}

/// `agentIdOfHomeSession(id)`: `''` for a session that is no home thread.
fn agent_of(session_id: &str) -> String {
    agent_id_of_home_session(session_id).unwrap_or_default()
}

/// A recorded agent id: Node's `null` is no id, which the Rust key reads as the empty one.
fn agent_id(value: &Exact) -> &str {
    match value {
        Exact::Null => "",
        other => other.as_str(),
    }
}

#[test]
fn the_home_key_is_a_fixed_reversible_session_id_per_agent() {
    let golden = golden();
    let name = "the home key is a fixed, reversible session id per agent";
    let want = observed(&golden, 0, name);
    let pattern = JsRegex::new_static(SESSION_ID_PATTERN.0, SESSION_ID_PATTERN.1);
    let agents: Vec<Value> = want
        .get("agents")
        .as_array()
        .iter()
        .map(|agent| {
            let id = agent.get("agentId").as_str();
            let session = home(id);
            json!({
                "agentId": id,
                "sessionId": session,
                "again": home(id),
                "matchesPattern": pattern.is_match(&session),
                "agentIdOfHomeSession": agent_of(&session),
                "isHome": agent_id_of_home_session(&session).is_some(),
            })
        })
        .collect();
    let distinct: serde_json::Map<String, Value> =
        want.get("distinct").to_plain().unwrap().as_object().unwrap().keys().map(|id| (id.clone(), json!(home(id)))).collect();
    let got = json!({
        "mixyAgentId": MIXY_AGENT_ID,
        "sessionIdPattern": SESSION_ID_PATTERN.0,
        "sessionIdPatternFlags": SESSION_ID_PATTERN.1,
        "agents": agents,
        "distinct": distinct,
        "lead": home(MIXY_AGENT_ID),
    });
    assert!(Exact::plain(&got) == *want, "{name}: {got}");
}

#[test]
fn non_agent_ids_and_ordinary_sessions_are_not_home_threads() {
    let golden = golden();
    let name = "non-agent ids and ordinary sessions are not home threads";
    let want = observed(&golden, 1, name);
    let agent_ids: Vec<Value> = want
        .get("agentIds")
        .as_array()
        .iter()
        .map(|entry| json!({ "agentId": entry.get("agentId").to_plain().unwrap(), "sessionId": home(agent_id(entry.get("agentId"))) }))
        .collect();
    let session_ids: Vec<Value> = want
        .get("sessionIds")
        .as_array()
        .iter()
        .map(|entry| {
            let id = entry.get("sessionId").as_str();
            json!({ "sessionId": id, "isHome": agent_id_of_home_session(id).is_some(), "agentId": agent_of(id) })
        })
        .collect();
    let got = json!({ "agentIds": agent_ids, "sessionIds": session_ids });
    assert!(Exact::plain(&got) == *want, "{name}: {got}");
}
