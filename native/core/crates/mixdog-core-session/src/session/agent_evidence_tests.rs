//! [`SessionAgentEvidence`] against `fixtures/agent-evidence/golden.json`
//! (`record-agent-evidence.mjs`): the home threads real Node stored, migrated and read here, give
//! Node's `homeThreadEvidence` verdicts; the recorded schedule and webhook rows give Node's
//! `mixyOwnsRoutines` answer (a failing listing an error).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::agents::AgentEvidence;
use mixdog_services::bots::RoutineKind;
use mixdog_services::bots::RoutineRecords;
use mixdog_services::bots::RoutineState;
use mixdog_services::scheduler::store::Ts;
use mixdog_services::webhooks::RunStamp;
use serde_json::Value;

use super::SessionAgentEvidence;
use crate::session::SessionDirectory;
use crate::session::search_backfill::tests::migrated;
use crate::session::testing::Rig;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/agent-evidence/golden.json")).expect("golden.json")
}

/// One recorded routine case: its schedule and webhook rows, or a listing that fails.
struct Routines {
    schedules: Value,
    webhooks: Value,
}

fn states(rows: &Value) -> Result<Vec<RoutineState>, String> {
    if rows == "fail" {
        return Err("relation does not exist".into());
    }
    Ok(rows
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| RoutineState {
            name: row["name"].as_str().expect("name").to_owned(),
            // A stored row without an owner holds an empty one.
            owner_agent_id: row["ownerAgentId"].as_str().unwrap_or_default().to_owned(),
            enabled: true,
            consecutive_failures: 0,
            last_failed_at: None,
            result_delivery: None,
        })
        .collect())
}

#[async_trait]
impl RoutineRecords for Routines {
    async fn state(&self, _: RoutineKind, _: &str) -> Result<Option<RoutineState>, String> {
        unreachable!("the evidence lists")
    }
    async fn list(&self, kind: RoutineKind) -> Result<Vec<RoutineState>, String> {
        states(match kind {
            RoutineKind::Schedule => &self.schedules,
            RoutineKind::Webhook => &self.webhooks,
        })
    }
    async fn record_skip(&self, _: RoutineKind, _: &str, _: Ts) -> Result<(), String> {
        unreachable!("the evidence writes nothing")
    }
    async fn record_delivery(&self, _: RoutineKind, _: &str, _: &str, _: Option<Value>) -> Result<(), String> {
        unreachable!("the evidence writes nothing")
    }
    async fn record_webhook_run(&self, _: &str, _: RunStamp, _: Ts) -> Result<(), String> {
        unreachable!("the evidence writes nothing")
    }
}

fn no_routines() -> Arc<Routines> {
    Arc::new(Routines { schedules: Value::Array(Vec::new()), webhooks: Value::Array(Vec::new()) })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_home_thread_shows_the_greeting_and_the_users_words_as_node_reads_them() {
    let golden = golden();
    let (_dir, threads, _lanes) = migrated(&golden).await;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps_on(threads)));
    let evidence = SessionAgentEvidence::new(directory, no_routines());
    for case in golden["home"].as_array().expect("home") {
        let agent = case["agentId"].as_str().expect("agentId");
        assert_eq!(Value::Bool(evidence.home_greeted(agent).await), case["greeted"], "{agent:?} greeted");
        assert_eq!(Value::Bool(evidence.home_chatted(agent).await), case["chatted"], "{agent:?} chatted");
    }
}

#[tokio::test]
async fn mixy_owns_a_routine_exactly_when_node_says_so() {
    let golden = golden();
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    for case in golden["routines"].as_array().expect("routines") {
        let name = case["name"].as_str().expect("name");
        // Without a cluster Node holds no routine; the Rust state store then holds none either.
        if case["cluster"] == false {
            assert!(case["schedules"].as_array().is_some_and(Vec::is_empty) && case["webhooks"].as_array().is_some_and(Vec::is_empty), "{name}");
        }
        let routines = Arc::new(Routines { schedules: case["schedules"].clone(), webhooks: case["webhooks"].clone() });
        let evidence = SessionAgentEvidence::new(directory.clone(), routines);
        match evidence.mixy_owns_routines().await {
            Ok(owns) => assert_eq!(Value::Bool(owns), case["owns"], "{name}"),
            Err(_) => assert_eq!(case["error"], true, "{name}"),
        }
    }
}
