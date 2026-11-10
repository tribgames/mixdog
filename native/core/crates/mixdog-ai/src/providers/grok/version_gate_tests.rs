//! `send`'s version gate (`grok-oauth.mjs:451-465`), inside the adapter's one attempt: a 426 whose body states a minimum
//! above the version in use is sent once more at the learned version; a second refusal, a minimum already met, another
//! status, and a version the environment pins surface at once.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::WireRequest;

use super::GrokRewriter;
use super::listing::SeedEffortRule;
use crate::client_versions::Net;
use crate::client_versions::versions_in;
use crate::providers::connect::rewrite::RewriteCodec;
use crate::providers::connect::rewrite::StaticCredential;
use crate::providers::connect::rewrite::run_attempt;
use crate::providers::listing_row::testing::Replay;

/// The `x-grok-client-version` of every request the attempt sent, answering each with the next refusal.
async fn sent_after(refusals: &[(u16, &str)], env: &[(&str, &str)]) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let env = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect::<HashMap<_, _>>();
    let versions = versions_in(dir.path(), &Arc::new(Net::default()), env, &Arc::new(AtomicU64::new(1_800_000_000_000)));
    let script = Mutex::new(refusals.iter().map(|(status, message)| (*status, serde_json::json!({ "error": { "message": message } }).to_string().into_bytes())).collect::<VecDeque<_>>());
    let http = Replay::new(move |_: &WireRequest| script.lock().unwrap().pop_front().expect("a request the script answers"));
    let rewriter = GrokRewriter { client_version: versions.grok_live(), user_id: Arc::new(|| None), sdk_headers: Vec::new(), effort_rule: Arc::new(SeedEffortRule) };
    let codec = RewriteCodec::new(super::codec(&versions.grok()), rewriter);
    let credential = StaticCredential(Some(("authorization".to_owned(), "Bearer fake-credential-not-a-secret".to_owned())));
    let request = ModelRequest { model: "grok-4".into(), messages: Vec::new(), tools: Vec::new(), options: RequestOptions::default() };
    let gate = super::version_gate(Arc::clone(&versions));
    assert!(run_attempt(&codec, &http, &credential, &request, Some(&gate)).await.is_err(), "every answer is a refusal");
    let requests = http.requests.lock().unwrap();
    requests.iter().map(|r| r.headers.iter().find(|(name, _)| name == "x-grok-client-version").unwrap().1.clone()).collect()
}

#[tokio::test]
async fn a_426_stating_a_higher_minimum_is_sent_once_more_at_that_version() {
    let both = [(426, "426: minimum version 1.0.95 required"), (426, "minimum version 1.0.95")];
    // The resent refusal is the attempt's result: no third request.
    assert_eq!(sent_after(&both, &[]).await, ["1.0.70", "1.0.95"]);
    assert_eq!(sent_after(&[(426, "minimum version 1.0.60")], &[]).await, ["1.0.70"]);
    assert_eq!(sent_after(&[(400, "minimum version 1.0.95")], &[]).await, ["1.0.70"]);
    assert_eq!(sent_after(&[(426, "minimum version 1.0.95")], &[("MIXDOG_GROK_CLIENT_VERSION", "1.0.50")]).await, ["1.0.50"]);
}
