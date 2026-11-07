//! `thread/getSessionUsage` against Node's real `getSessionUsage` over the ledger file Node wrote
//! (`fixtures/session-usage`, recorded by `record-session-usage.mjs`).
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixture I/O")]

use std::path::Path;
use std::sync::Arc;

use mixdog_ai::accounts::AccountStore;
use mixdog_ai::oauth::CredentialIo;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
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

#[tokio::test]
async fn session_usage_equals_what_nodes_get_session_usage_answered() {
    let golden = golden();
    let dir = tempfile::tempdir().unwrap();
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
    let service = SessionUsageService::new(Arc::new(Arc::new(ledger)), accounts);

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

