//! `session action=fork compact=true` (`fixtures/session-compact-cases`): the copy's conversation compacted for the heir
//! as `compactConversationForHeir` does (`HostManualCompaction::compact_for_heir`: the source's whole transcript, its system
//! block first, through the run host's compactor of the route with the conversation threshold at the floor), the
//! provider answering the one summary request; the compacted conversation is compared whole with what Node stored in the copy.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::boundary::CompactSettings;
use mixdog_agent::compact::summary_run::{SummaryFailure, SummaryResponse, SummarySender};
use mixdog_agent::env::{CompactRequest, CompactTrigger};
use mixdog_core_session::session::StoredRows;
use mixdog_store::schema::record::Header;
use serde_json::{Value, json};

use super::compaction_node_harness::{World, session_compactor};
use super::message_row::row_of;
use super::summary_routes::{MaintainerRoute, SessionRoute, SummaryHost};

/// The provider: it answers every summary request with the recorded summary, and counts them.
struct Provider {
    summary: String,
    sent: Arc<AtomicUsize>,
}
#[async_trait]
impl SummarySender for Provider {
    async fn send(&self, _: &str, _: &str, _: &mixdog_agent::compact::summary_run::SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
        self.sent.fetch_add(1, Ordering::SeqCst);
        Ok(SummaryResponse { text: self.summary.clone(), tool_call: false, usage: None })
    }
}

struct Host(Arc<Provider>);
#[async_trait]
impl SummaryHost for Host {
    fn session(&self) -> SessionRoute {
        SessionRoute { provider: "anthropic".into(), model: "fake-model".into(), context_window: Some(100_000) }
    }
    fn maintainer_route(&self) -> Option<MaintainerRoute> {
        None
    }
    async fn provider_ready(&self, _: &str, _: bool) -> Result<bool, SummaryFailure> {
        Ok(true)
    }
    fn whole_window(&self, _: &str, _: &str) -> u64 {
        128_000
    }
    fn calibration(&self, _: &str, _: &str) -> f64 {
        1.0
    }
    fn sender(&self, _: &str) -> Arc<dyn SummarySender> {
        self.0.clone()
    }
    async fn saved_catalog(&self, _: &str) -> Option<Vec<Value>> {
        None
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_with_compact_stores_the_conversation_node_compacted() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/session-compact-cases/golden.json")).expect("golden json");
    let case = golden["cases"].as_array().expect("cases").iter().find(|c| c["case"] == "fork with compact true compacts the copy with the real compaction").expect("the case")["observed"].clone();
    let source = case["source"]["messages"].as_array().expect("source messages");
    let system = source[0]["content"].as_str().expect("system block");
    let rows: Vec<Value> = source[1..].to_vec();
    let sent = Arc::new(AtomicUsize::new(0));
    let provider = Arc::new(Provider { summary: case["summary"].as_str().expect("summary").to_owned(), sent: sent.clone() });
    let mut header = Header::new();
    header.insert("promptBase".into(), json!(system));
    header.insert("provider".into(), json!("anthropic"));
    header.insert("model".into(), json!("fake-model"));
    header.insert("compaction".into(), json!({ "conversationThresholdTokens": 1 }));
    let messages = super::factory::session_messages(&header, &rows).expect("messages");
    let stored = Arc::new(StoredRows::new());
    for (message, row) in messages[messages.len() - rows.len()..].iter().zip(&rows) {
        stored.record(message, row.clone());
    }
    let settings = CompactSettings { context_window: Some(100_000), token_calibration: 1.0, ..CompactSettings::default() };
    let data = tempfile_dir();
    let world = World::unsaved("anthropic", Arc::new(Host(provider)), None);
    let compactor = session_compactor(world, "sess_fork_compact_src", &header, settings, stored, Path::new(&data)).await;
    compactor.prepare(&messages).await;
    let request = CompactRequest { messages: &messages, budget_tokens: case["budgetTokens"].as_u64().expect("budget"), trigger: CompactTrigger::Auto, require_reduction: false, reference_latest_attachments: false, active_turn: false, latest_user_prefix: "" };
    let output = compactor.compact(request).await.expect("the compaction");
    let carried: Vec<Value> = output.messages.iter().map(row_of).collect();
    assert_eq!(sent.load(Ordering::SeqCst), case["summaryRequests"].as_u64().expect("requests") as usize);
    // The compactor sees the system block first and only the conversation after it travels (the heir keeps its own block,
    // Node's first stored message). The carry, not the compaction, stamps the inheritance boundary on the last carried row:
    // that row's recorded meta is the boundary of this fork, and every other row is compared whole.
    assert_eq!(carried[0], json!({ "role": "system", "content": system }));
    let wanted = case["heir"]["messages"].as_array().expect("heir messages")[1..].to_vec();
    let (last_wanted, head_wanted) = wanted.split_last().expect("carried rows");
    let (last_got, head_got) = carried[1..].split_last().expect("carried rows");
    assert_eq!(head_got, head_wanted);
    assert_eq!((&last_got["role"], &last_got["content"]), (&last_wanted["role"], &last_wanted["content"]));
    assert_eq!(last_got.get("meta"), None);
    let boundary = &last_wanted["meta"]["sessionInheritances"][0];
    assert_eq!((boundary["sourceSessionId"].clone(), boundary["provider"].clone(), boundary["modelId"].clone()), (json!("sess_fork_compact_src"), json!("anthropic"), json!("fake-model")));}

fn tempfile_dir() -> String {
    let dir = std::env::temp_dir().join(format!("fork-compact-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("data dir");
    dir.to_string_lossy().into_owned()
}