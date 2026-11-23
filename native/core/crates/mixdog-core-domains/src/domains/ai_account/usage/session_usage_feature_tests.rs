//! `thread/getSessionUsage`: the ids a session sent under, which threads answer null, and when a thread's conversation is read.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixture I/O")]

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use mixdog_ai::accounts::AccountStore;
use mixdog_ai::oauth::CredentialIo;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::{Method, ThreadId};
use mixdog_core_api::{CoreRequest, DomainService, Reply};
use mixdog_core_ports::ports::threads::{Section, ThreadState};
use mixdog_ledger::ledger::UsageLedger;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::refresh::{Pricer, UsageRefresher};
use mixdog_ledger::repair::{PriceRequest, Priced};
use mixdog_ledger::writer::UsageWriter;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use serde_json::{Map, Value, json};

use super::session_usage::SessionUsageService;
use super::session_usage::{account_scoped_session_id, other_session_ids};

struct NoPrices;

impl Pricer for NoPrices {
    fn revision(&self) -> String {
        String::new()
    }
    fn price(&self, _: &PriceRequest) -> mixdog_ledger::Result<Priced> {
        Ok(Priced { cost_usd: None, rates: None })
    }
}

#[derive(Default)]
struct Records {
    unseated: Mutex<HashSet<String>>,
    gone: HashSet<String>,
    message_reads: AtomicUsize,
    /// Header members of threads that carry more than the model.
    extra: std::collections::HashMap<String, Value>,
}

#[async_trait::async_trait]
impl ThreadState for Records {
    async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
        if self.gone.contains(thread.as_str()) {
            return Err(PortError::Failed { capability: "threads".into(), message: "no such thread".into() });
        }
        let mut header = Header::new();
        if !self.unseated.lock().unwrap().contains(thread.as_str()) {
            header.insert("model".into(), json!("harness-model"));
        }
        if let Some(Value::Object(extra)) = self.extra.get(thread.as_str()) {
            header.extend(extra.clone());
        }
        Ok(header)
    }
    async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        unreachable!("the usage read writes no header")
    }
    async fn patch_header_at(
        &self,
        thread: &ThreadId,
        at: &mixdog_core_ports::ports::threads::RunFence,
        expect: Map<String, Value>,
        set: Map<String, Value>,
        unset: Vec<String>,
    ) -> Result<mixdog_core_ports::ports::threads::FencedPatch, PortError> {
        mixdog_core_ports::ports::threads::patch_at_rest(self, thread, at, expect, set, unset).await
    }
    async fn patch_header_if(
        &self,
        _: &ThreadId,
        _: Map<String, Value>,
        _: Map<String, Value>,
        _: Vec<String>,
    ) -> Result<Option<Map<String, Value>>, PortError> {
        unreachable!("the usage read writes no header")
    }
    async fn store_header(&self, thread: &ThreadId, write: mixdog_core_ports::ports::threads::HeaderWrite) -> mixdog_core_ports::ports::threads::HeaderStored {
        mixdog_core_ports::ports::threads::HeaderStored::of_patch(self.patch_header(thread, write.set, write.unset).await)
    }
    fn log_identity(&self, _: &ThreadId) -> Option<String> {
        None
    }
    /// This fake holds nothing but the header it answers.
    async fn held_fields(
        &self,
        thread: &ThreadId,
        keys: &'static [&'static str],
    ) -> Result<serde_json::Map<String, serde_json::Value>, mixdog_tools::orch::util::PortError> {
        Ok(mixdog_core_ports::ports::threads::held_of(&self.header(thread).await?, keys))
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        unreachable!("the usage read publishes no section")
    }
}

#[async_trait::async_trait]
impl mixdog_core_ports::ports::memory_source::ThreadMessages for Records {
    async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
        self.message_reads.fetch_add(1, Ordering::SeqCst);
        Ok(Vec::new())
    }
}

async fn service(dir: &tempfile::TempDir, threads: Arc<Records>) -> Arc<SessionUsageService> {
    let path = dir.path().join("ledger.sqlite");
    let tokens = mixdog_rt::testing::tokens();
    let writer = UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
    writer.sums_built().await.unwrap();
    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let ledger = UsageLedger { writer, reader, refresher: UsageRefresher::new(Arc::new(NoPrices), tokens.cpu_bulk) };
    let accounts = AccountStore::new(dir.path().join("accounts"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    SessionUsageService::new(Arc::new(Arc::new(ledger)), accounts, threads.clone(), threads)
}

async fn usage_of(service: &SessionUsageService, thread: &str, options: Option<Value>) -> Value {
    let mut params = json!({ "threadId": thread });
    if let Some(options) = options {
        params["options"] = options;
    }
    let request = CoreRequest { method: Method("thread/getSessionUsage"), params, op: None, ctx: CallContext::internal("session-usage-test") };
    let Ok(Reply::Value(got)) = service.call(request).await else { panic!("{thread}: a value reply") };
    got
}

#[test]
fn an_account_sends_a_session_under_the_sha256_of_its_provider_account_and_session() {
    assert_eq!(
        account_scoped_session_id("anthropic-oauth", "7d1f3c52-0a4e-4b8e-9c61-2f5a6b3d8e10", "sess_a"),
        "account-da4249513ad617d74ac15d7d02ae9d535c5d753418285bd6c6867fe3f2e4e507"
    );
}

#[test]
fn the_other_sessions_named_are_distinct_non_empty_and_at_most_sixty_four() {
    let named = json!({ "sessionIds": ["b", "", "own", "b", "c", 7] });
    assert_eq!(other_session_ids(Some(&named), "own"), ["b", "c"]);
    assert!(other_session_ids(None, "own").is_empty());
    let many = json!({ "sessionIds": (0..100).map(|n| format!("s{n}")).collect::<Vec<_>>() });
    let ids = other_session_ids(Some(&many), "own");
    assert_eq!((ids.len(), ids[0].as_str(), ids[63].as_str()), (64, "s0", "s63"));
}

#[tokio::test]
async fn a_thread_without_a_session_answers_null_until_a_route_gives_it_one() {
    let dir = tempfile::tempdir().unwrap();
    let records =
        Arc::new(Records { unseated: Mutex::new(HashSet::from(["$control".to_owned()])), gone: HashSet::from(["sess_gone".to_owned()]), ..Records::default() });
    let service = service(&dir, records.clone()).await;
    assert!(usage_of(&service, "$control", None).await.is_null(), "before a route has created the session");
    records.unseated.lock().unwrap().clear();
    assert_eq!(usage_of(&service, "$control", None).await["sessionId"], "$control", "once it has");
    assert_eq!(usage_of(&service, "sess_gone", None).await["sessionId"], "sess_gone", "a thread the directory forgot keeps its ledger totals");
}

#[tokio::test]
async fn a_seated_thread_is_answered_without_reading_its_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let records = Arc::new(Records { unseated: Mutex::new(HashSet::from(["$unseated".to_owned()])), ..Records::default() });
    let service = service(&dir, records.clone()).await;
    for _ in 0..3 {
        assert_eq!(usage_of(&service, "sess_seated", None).await["sessionId"], "sess_seated");
    }
    assert_eq!(records.message_reads.load(Ordering::SeqCst), 0);
    assert!(usage_of(&service, "$unseated", None).await.is_null());
    assert_eq!(records.message_reads.load(Ordering::SeqCst), 1, "a header without a model is told by its rows");
}

/// An ACP agent's session is counted by the context the agent reports, as the session's own readout is, and by no
/// number when the agent reported nothing: the ledger's zero of a turn that carried no usage is no count.
#[tokio::test]
async fn an_agent_sessions_row_figure_is_the_context_the_agent_reports_and_none_when_it_reports_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let extra = [
        ("agent_reported", json!({ "provider": "acp-antigravity", "lastContextTokens": 9606 })),
        ("agent_silent", json!({ "provider": "acp-antigravity" })),
        ("loop_session", json!({ "provider": "anthropic-oauth" })),
    ]
    .into_iter()
    .map(|(id, header)| (id.to_owned(), header))
    .collect();
    let service = service(&dir, Arc::new(Records { extra, ..Records::default() })).await;
    let asked = usage_of(&service, "lead", Some(json!({ "sessionIds": ["agent_reported", "agent_silent", "loop_session"] }))).await;
    let sessions = &asked["sessions"];
    assert_eq!(sessions["agent_reported"]["tokens"].as_f64(), Some(9606.0));
    assert!(sessions["agent_silent"].get("tokens").is_none(), "{}", sessions["agent_silent"]);
    assert_eq!(sessions["loop_session"]["tokens"].as_f64(), Some(0.0));
}

#[tokio::test]
async fn the_sessions_and_agents_asked_for_are_answered_beside_the_callers_own() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(&dir, Arc::new(Records::default())).await;
    let plain = usage_of(&service, "sess_a", None).await;
    assert!(plain.get("sessions").is_none() && plain.get("agents").is_none());
    let asked = usage_of(&service, "sess_a", Some(json!({ "sessionIds": ["sess_b", "sess_a"], "agents": true }))).await;
    assert_eq!(asked["sessions"].as_object().unwrap().keys().collect::<Vec<_>>(), ["sess_b"], "the caller's own id is not listed among the others");
    assert!(asked["agents"].is_object());
}
