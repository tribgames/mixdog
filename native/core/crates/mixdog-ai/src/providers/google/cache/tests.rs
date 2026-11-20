//! Conformance of the explicit-cache port against `golden.json`, recorded from
//! Node's `GeminiProvider._ensureGeminiCache` (`record_goldens.mjs`).

use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::Value;

use super::layer::Ask;
use super::layer::CacheRuntime;
use super::layer::ExplicitCache;
use super::policy::CacheRequest;
use super::policy::Tuning;
use super::registry::Registry;
use mixdog_core_api::domain::provider::ProviderState;

fn system(case: u64) -> String {
    format!("{}case-{case}", "You are the Lead. ".repeat(1000))
}

fn parts(g: &Value) -> (Vec<Value>, Option<Value>, Vec<Value>) {
    (g["tools"].as_array().unwrap().clone(), Some(g["toolConfig"].clone()), g["contents"].as_array().unwrap().clone())
}

/// Runs only the backoff waits: the attempt and total limits never fire, so each failure the transport reports is the
/// attempt's own, and the retry ladder runs to its end.
struct LadderRuntime;

impl CacheRuntime for LadderRuntime {
    fn now_ms(&self) -> u64 {
        0
    }
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        tokio::spawn(task);
    }
    fn spawn_after(&self, _delay_ms: u64, _task: BoxFuture<'static, ()>) {}
    fn deadline(&self, ms: u64) -> BoxFuture<'static, ()> {
        if ms >= 120_000 { Box::pin(futures::future::pending()) } else { Box::pin(futures::future::ready(())) }
    }
}

#[test]
fn provider_state_round_trip_keeps_every_node_key() {
    let node = serde_json::json!({
        "gemini": {
            "cacheName": "cachedContents/a", "cacheCreatedAt": 1, "cacheCreatedAtIter": 2,
            "cacheExpiresAt": 3, "cacheModel": "gemini-2.5-pro", "cacheTokenSize": 4,
            "cachePrefixContentCount": 5, "cachePrefixHash": "h", "cacheCredentialFingerprint": "f"
        },
        "openaiContinuation": {"previousResponseId": "resp_1", "baseLen": 7},
        "xaiResponses": {"previousResponseId": "resp_x"},
        "providerAccountId": "acct-1"
    });
    let state: ProviderState = serde_json::from_value(node.clone()).unwrap();
    assert_eq!(state.rest.len(), 3);
    assert_eq!(serde_json::to_value(&state).unwrap(), node);
    let rest_only: ProviderState = serde_json::from_value(serde_json::json!({"providerAccountId": "a"})).unwrap();
    assert!(rest_only.gemini.is_none());
    assert_eq!(serde_json::to_value(&rest_only).unwrap(), serde_json::json!({"providerAccountId": "a"}));
}

/// The create's request is bounded by Node's total timer (`sites.geminiCacheCreate`: `armed` 180 s, the fetch rejected
/// with `Gemini cachedContents.create total timed out after 180000ms`); the timeouts are retried and, once the ladder is
/// spent, the create resolves no cache and logs the line Node's catch writes to stderr.
#[tokio::test(start_paused = true)]
async fn a_create_the_transport_times_out_is_retried_then_resolves_no_cache() {
    use crate::transport::site_probe::TimingOut;
    use crate::transport::site_probe::assert_transport;
    use crate::transport::site_probe::capture_logs;

    let (logged, _guard) = capture_logs();
    let g = serde_json::json!({
        "apiKey": "key",
        "model": "gemini-2.5-pro",
        "tools": [{ "functionDeclarations": [{ "name": "lookup", "description": "Looks a thing up.", "parameters": { "type": "object", "properties": {} } }] }],
        "toolConfig": { "functionCallingConfig": { "mode": "AUTO" } },
        "contents": [{ "role": "user", "parts": [{ "text": "Hello." }] }],
    });
    let (tools, tool_config, contents) = parts(&g);
    let system = system(1);
    let transport = TimingOut::new();
    let cache = ExplicitCache::new(
        g["apiKey"].as_str().unwrap(),
        "https://generativelanguage.googleapis.com",
        transport.clone(),
        Arc::new(LadderRuntime),
        Arc::new(Registry::default()),
        Tuning::default(),
    );
    let ask = Ask {
        model: g["model"].as_str().unwrap(),
        request: CacheRequest { system_instruction: &system, tools: &tools, tool_config: tool_config.as_ref(), contents: &contents },
        state: None,
        iteration: 1,
        fork: false,
    };
    let answer = cache.ensure(ask).await;
    assert_eq!(answer.cache_name, None);
    assert!(transport.seen().len() > 1, "a timeout is retried");
    assert_transport("geminiCacheCreate", &transport);
    let want: Vec<String> = crate::transport::site_probe::logged("geminiCacheCreate").iter().map(|l| (*l).to_owned()).collect();
    assert_eq!(logged(), want);
}
