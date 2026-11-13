//! `session action=fork compact=true` (`fixtures/session-compact-cases`): the heir of a `thread/fork` with `compact`, replayed
//! through the real fork of a session directory (the carry stamps the inheritance boundary, stores the heir's rows and names its
//! source), the compaction of the carry done as `HostManualCompaction::compact_for_heir` does it (the source's whole transcript,
//! its system block first, through the run host's compactor of the route with the conversation threshold at the floor), the
//! provider answering the one summary request; the heir's stored conversation is compared whole with what Node stored in the copy.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use mixdog_agent::boundary::CompactSettings;
use mixdog_agent::compact::summary_run::{SummaryFailure, SummaryResponse, SummarySender};
use mixdog_agent::env::{CompactRequest, CompactTrigger};
use mixdog_agent::message::AgentMessage;
use mixdog_core_api::call::{CallContext, CoreRequest};
use mixdog_core_api::ids::{Method, OpId, ThreadId};
use mixdog_core_api::{CoreError, Reply, ThreadDirectory, ThreadHandle};
use mixdog_core_session::session::testing::{Rig, TestCompaction, lock};
use mixdog_core_session::session::turn_ops::{Books, ManualCompaction, OffloadCopies};
use mixdog_core_session::session::{SessionDirectory, StoredRows};
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
        SessionRoute { provider: "anthropic".into(), model: "fake-model".into(), context_window: Some(100_000), summary_model: None }
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

/// The rig's compaction engine, with the host's own `compact_for_heir` (`HostManualCompaction::compact_for_heir`): the source's
/// whole model context through the run host's compactor of its route, the conversation threshold at the floor when the pass
/// summarizes, the provider answering the one summary request.
struct HeirCompaction {
    rig: Arc<TestCompaction>,
    directory: OnceLock<Arc<SessionDirectory>>,
    provider: Arc<Provider>,
    data: std::path::PathBuf,
}

#[async_trait]
impl ManualCompaction for HeirCompaction {
    async fn compact(&self, thread: &ThreadId, trigger: &str, require_reduction: bool, cancel: &mixdog_agent::cancel::Cancel) -> Result<Option<Value>, CoreError> {
        self.rig.compact(thread, trigger, require_reduction, cancel).await
    }
    async fn compact_for_heir(&self, source: &ThreadId, budget_tokens: u64, summarize: bool) -> Result<Option<Vec<Value>>, CoreError> {
        let directory = self.directory.get().expect("the directory is bound");
        let mut header = directory.stored_header(source).await.expect("the source's record");
        let context = directory.model_context(source).read().await?;
        let rows: Vec<Value> = context.iter().map(|(_, row)| row.clone()).collect();
        let messages = super::factory::session_messages(&header, &rows).expect("messages");
        if summarize {
            let mut compaction = header.get("compaction").and_then(Value::as_object).cloned().unwrap_or_default();
            compaction.insert("conversationThresholdTokens".into(), json!(1));
            header.insert("compaction".into(), Value::Object(compaction));
        }
        let stored = Arc::new(StoredRows::new());
        for (message, row) in messages[messages.len() - rows.len()..].iter().zip(&rows) {
            stored.record(message, row.clone());
        }
        let settings = CompactSettings { context_window: Some(100_000), token_calibration: 1.0, ..CompactSettings::default() };
        let world = World::unsaved("anthropic", Arc::new(Host(self.provider.clone())), None);
        let compactor = session_compactor(world, source.as_str(), &header, settings, stored, &self.data).await;
        compactor.prepare(&messages).await;
        let request = CompactRequest { messages: &messages, budget_tokens, trigger: CompactTrigger::Auto, require_reduction: false, reference_latest_attachments: false, active_turn: false, latest_user_prefix: "" };
        let output = compactor.compact(request).await.map_err(|error| mixdog_core_base::support::failed("compaction", format!("{error:?}")))?;
        Ok(Some(output.messages.iter().map(row_of).collect()))
    }
    async fn post_compact(&self, thread: &ThreadId, trigger: &str) {
        self.rig.post_compact(thread, trigger).await;
    }
    async fn offload_candidates(&self, thread: &ThreadId) -> Vec<std::path::PathBuf> {
        self.rig.offload_candidates(thread).await
    }
    async fn prune_offloads(&self, thread: &ThreadId, candidates: Vec<std::path::PathBuf>, transcripts: String, copies: OffloadCopies) {
        self.rig.prune_offloads(thread, candidates, transcripts, copies).await;
    }
    async fn rearm(&self, thread: &ThreadId) {
        self.rig.rearm(thread).await;
    }
    fn recover_workers(&self, thread: &ThreadId) {
        self.rig.recover_workers(thread);
    }
    fn invalidate_context_status(&self, thread: &ThreadId) {
        self.rig.invalidate_context_status(thread);
    }
    fn books(&self, thread: &ThreadId, header: &Header) -> Option<Books> {
        self.rig.books(thread, header)
    }
    async fn prepare_books(&self, thread: &ThreadId, provider: &str, messages: &[AgentMessage]) {
        self.rig.prepare_books(thread, provider, messages).await;
    }
    fn synced_compaction(&self, header: &Header, install: bool) -> Option<Value> {
        self.rig.synced_compaction(header, install)
    }
    fn route_config(&self, header: &Header) -> mixdog_app_protocol::v2::thread::ThreadRoute {
        self.rig.route_config(header)
    }
    fn settings_changes(&self, thread: &ThreadId) -> Option<mixdog_core_session::session::turn_ops::SettingsFeed> {
        self.rig.settings_changes(thread)
    }
}

async fn call(directory: &SessionDirectory, thread: Option<&ThreadId>, method: &'static str, params: Value) -> Value {
    let ctx = CallContext::internal("replay");
    let op = params.get("opId").and_then(Value::as_str).map(OpId::from);
    let request = CoreRequest { method: Method(method), params, op, ctx: ctx.clone() };
    let reply = match thread {
        Some(id) => directory.open_handle(id, &ctx).await.expect("opens").request(request).await.expect(method),
        None => directory.request(request).await.expect(method),
    };
    match reply {
        Reply::Value(value) => value,
        Reply::Subscribe(started) => started.result,
    }
}

/// `session action=fork compact=true` (`fixtures/session-compact-cases`) through the protocol a client uses: a `thread/fork` with
/// `compact` over a real session directory whose source holds Node's conversation, the compaction of the heir's carry done by the
/// run host's compactor against the provider answering the one summary request. What is compared is the heir's stored
/// conversation, row by row and whole, with the inheritance boundary the carry stamps on its last row. The heir's own id (which
/// the boundary names as `sessionId`) is the one field the recording cannot hold the same: Node's names it by clock and a random.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_with_compact_gives_the_heir_the_conversation_node_compacted() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/session-compact-cases/golden.json")).expect("golden json");
    let case = golden["cases"].as_array().expect("cases").iter().find(|c| c["case"] == "fork with compact true compacts the copy with the real compaction").expect("the case")["observed"].clone();
    let source = case["source"]["messages"].as_array().expect("source messages");
    let system = source[0]["content"].as_str().expect("system block");
    let rows: Vec<Value> = source[1..].to_vec();
    let sent = Arc::new(AtomicUsize::new(0));
    let provider = Arc::new(Provider { summary: case["summary"].as_str().expect("summary").to_owned(), sent: sent.clone() });
    let data = tempfile::tempdir().expect("data dir");
    let rig = Rig::new();
    rig.clock.0.store(case["heir"]["messages"][3]["meta"]["sessionInheritances"][0]["at"].as_u64().expect("the recorded clock"), Ordering::SeqCst);
    // The heir's route policy: the conversation measures well inside the window, the compaction budget is the recorded one.
    *lock(&rig.inherit.basis) = Some((100_000, 10, false));
    *lock(&rig.inherit.budget) = Some(case["budgetTokens"].as_u64().expect("budget"));
    let mut deps = rig.deps_parts(rig.store.clone());
    let compaction = Arc::new(HeirCompaction { rig: rig.compaction.clone(), directory: OnceLock::new(), provider, data: data.path().to_path_buf() });
    deps.compaction = compaction.clone();
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
    compaction.directory.set(directory.clone()).ok().expect("bound once");
    let source_id = ThreadId::from("sess_fork_compact_src");
    let mut header = Header::new();
    header.insert("promptBase".into(), json!(system));
    header.insert("provider".into(), json!("anthropic"));
    header.insert("model".into(), json!("fake-model"));
    header.insert("title".into(), case["source"]["title"].clone());
    directory.create_with_id(source_id.clone(), header, json!({})).await.expect("the source");
    call(&directory, Some(&source_id), "thread/inheritedRows/append", json!({ "threadId": source_id.as_str(), "messages": rows })).await;

    let forked = call(&directory, None, "thread/fork", json!({ "threadId": source_id.as_str(), "opId": "op-fork", "compact": true })).await;
    let heir = ThreadId::from(forked["thread"]["id"].as_str().expect("the heir"));
    assert_ne!(heir, source_id, "the fork is a session of its own");
    assert_eq!(sent.load(Ordering::SeqCst), case["summaryRequests"].as_u64().expect("requests") as usize, "one summary request");
    let carried = call(&directory, Some(&heir), "thread/messages/read", json!({ "threadId": heir.as_str() })).await["messages"].clone();
    let mut got: Vec<Value> = carried.as_array().expect("messages").clone();
    // The heir keeps its own system block: the first stored message, which the conversation read leaves to the header.
    if got.first().is_some_and(|first| first["role"] != json!("system")) {
        let held = call(&directory, Some(&heir), "thread/header/read", json!({ "threadId": heir.as_str() })).await;
        got.insert(0, json!({ "role": "system", "content": held["header"]["promptBase"] }));
    }
    // The boundary names the heir by its id: Node's is minted from the clock and a random, so it is the one field compared as
    // "the heir's own id" rather than as text.
    let mut want = case["heir"]["messages"].as_array().expect("heir messages").clone();
    let last = want.len() - 1;
    let boundary = &mut want[last]["meta"]["sessionInheritances"][0];
    assert!(boundary["sessionId"].as_str().is_some_and(|id| id.starts_with("sess_")), "Node's boundary names the heir");
    boundary["sessionId"] = json!(heir.as_str());
    assert_eq!(got, want);
}
