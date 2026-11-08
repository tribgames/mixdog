//! `thread/getSessionUsage` against Node's real `getSessionUsage` over the ledger file Node wrote
//! (`fixtures/session-usage`, recorded by `record-session-usage.mjs`).
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixture I/O")]

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_ai::accounts::AccountStore;
use mixdog_ai::oauth::CredentialIo;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use mixdog_ledger::ledger::UsageLedger;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::refresh::Pricer;
use mixdog_ledger::refresh::UsageRefresher;
use mixdog_ledger::repair::PriceRequest;
use mixdog_ledger::repair::Priced;
use mixdog_ledger::writer::UsageWriter;
use serde_json::Value;
use serde_json::json;

use super::SessionUsageService;
use super::account_scoped_session_id;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/session-usage");

/// Reads never price anything: the refresh belongs to the statistics.
struct NoPrices;

impl Pricer for NoPrices {
    fn revision(&self) -> String {
        String::new()
    }

    fn price(&self, _: &PriceRequest) -> mixdog_ledger::Result<Priced> {
        Ok(Priced { cost_usd: None, rates: None })
    }
}

fn golden() -> Value {
    serde_json::from_slice(&std::fs::read(Path::new(FIXTURES).join("golden.json")).unwrap()).unwrap()
}

/// The thread records: every thread has its session (a model on its header) except the ones named in `unseated`; a thread
/// in `gone` is unknown to the directory.
#[derive(Default)]
struct Records {
    unseated: Mutex<HashSet<String>>,
    gone: HashSet<String>,
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
        Ok(header)
    }

    async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        unreachable!("the usage read writes no header")
    }

    async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        unreachable!("the usage read writes no header")
    }

    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        unreachable!("the usage read publishes no section")
    }
}

/// Conversation rows: none, every thread's session here is told by its header.
#[async_trait::async_trait]
impl mixdog_core_ports::ports::memory_source::ThreadMessages for Records {
    async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
        Ok(Vec::new())
    }
}

/// The service over a copy of the ledger Node wrote and the account pools of the golden.
async fn service_over(dir: &tempfile::TempDir, golden: &Value, threads: Arc<Records>) -> Arc<SessionUsageService> {
    let path = dir.path().join("ledger.sqlite");
    std::fs::copy(Path::new(FIXTURES).join("ledger.sqlite"), &path).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let writer = UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
    writer.sums_built().await.unwrap();
    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let ledger = UsageLedger { writer, reader, refresher: UsageRefresher::new(Arc::new(NoPrices), tokens.cpu_bulk) };

    let accounts_dir = dir.path().join("accounts");
    std::fs::create_dir_all(&accounts_dir).unwrap();
    let pools: serde_json::Map<String, Value> = golden["accounts"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(provider, rows)| (provider.clone(), json!({ "accounts": rows })))
        .collect();
    std::fs::write(accounts_dir.join("provider-accounts.json"), json!({ "version": 1, "providers": pools }).to_string()).unwrap();
    let accounts = AccountStore::new(accounts_dir, CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    SessionUsageService::new(Arc::new(Arc::new(ledger)), accounts, threads.clone(), threads)
}

async fn usage_of(service: &SessionUsageService, thread: &str) -> Value {
    let request = CoreRequest {
        method: Method("thread/getSessionUsage"),
        params: json!({ "threadId": thread }),
        op: None,
        ctx: CallContext::internal("session-usage-test"),
    };
    let Ok(Reply::Value(got)) = service.call(request).await else { panic!("{thread}: a value reply") };
    got
}

/// The desktop's control session as Node answered it (`fixtures/context-status-route`): `null` while the thread has no
/// session, its zero totals once a model route has created it; a thread the directory has forgotten still reads the ledger.
#[tokio::test]
async fn a_thread_without_a_session_answers_null_as_nodes_does() {
    let recorded: Value = serde_json::from_slice(&std::fs::read(Path::new(FIXTURES).join("../context-status-route/golden.json")).unwrap()).unwrap();
    let usage: Vec<&Value> = recorded["steps"].as_array().unwrap().iter().filter(|s| s["session"] == "control" && s["action"] == "getSessionUsage").collect();
    assert!(usage[0]["value"].is_null() && usage[1]["value"].is_null() && usage[2]["value"]["sessionId"] == "$control", "the recording spans the session's creation");

    let dir = tempfile::tempdir().unwrap();
    let records = Arc::new(Records { unseated: Mutex::new(HashSet::from(["$control".to_owned()])), gone: HashSet::from(["sess_gone".to_owned()]) });
    let service = service_over(&dir, &golden(), records.clone()).await;
    assert_eq!(usage_of(&service, "$control").await, usage[0]["value"], "before a route has created the session");
    records.unseated.lock().unwrap().clear();
    assert_eq!(usage_of(&service, "$control").await, usage[2]["value"], "once it has");
    assert_eq!(usage_of(&service, "sess_gone").await["sessionId"], "sess_gone", "a thread the directory forgot keeps its ledger totals");
}

#[tokio::test]
async fn session_usage_equals_what_nodes_get_session_usage_answered() {
    let golden = golden();
    let dir = tempfile::tempdir().unwrap();
    let service = service_over(&dir, &golden, Arc::new(Records::default())).await;

    for (session, scoped) in golden["accountScopedIds"].as_object().unwrap() {
        assert_eq!(&account_scoped_session_id("anthropic-oauth", "7d1f3c52-0a4e-4b8e-9c61-2f5a6b3d8e10", session), scoped.as_str().unwrap());
    }
    for case in golden["cases"].as_array().unwrap() {
        let mut params = json!({});
        if let Some(session) = case["session"].as_str() {
            params["threadId"] = json!(session);
        }
        if !case["options"].is_null() {
            params["options"] = case["options"].clone();
        }
        let request = CoreRequest {
            method: Method("thread/getSessionUsage"),
            params,
            op: None,
            ctx: CallContext::internal("session-usage-test"),
        };
        let Ok(Reply::Value(got)) = service.call(request).await else { panic!("{}: a value reply", case["name"]) };
        assert_eq!(got, case["result"], "{}", case["name"]);
    }
}

