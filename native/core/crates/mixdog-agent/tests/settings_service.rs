//! The `config/*` compaction methods against Node's recorded results.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::compact::settings::Doc;
use mixdog_agent::compact::settings::adopt_session_compaction;
use mixdog_agent::compact::settings::agent_terminal_reap_ms;
use mixdog_agent::compact::settings::compaction_config_keys;
use mixdog_agent::compact::settings_service::AgentChange;
use mixdog_agent::compact::settings_service::AgentConfigStore;
use mixdog_agent::compact::settings_service::CompactionHost;
use mixdog_agent::compact::settings_service::CompactionSettingsService;
use mixdog_core_api::CallContext;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;

struct Store(Mutex<Doc>);

#[async_trait]
impl AgentConfigStore for Store {
    fn agent(&self) -> Doc {
        self.0.lock().unwrap().clone()
    }

    async fn update(&self, change: AgentChange) -> Result<(), CoreError> {
        // The config actor takes turns: a queued edit runs after the others queued before it.
        tokio::task::yield_now().await;
        let mut doc = self.0.lock().unwrap();
        let mut next = doc.clone();
        change(&mut next)?;
        *doc = next;
        Ok(())
    }
}

struct Host {
    provider: Option<String>,
    session: Mutex<Option<Doc>>,
    invalidated: Mutex<u64>,
    last_thread: Mutex<Option<ThreadId>>,
    /// Every `refresh_lead_cache_opts` call: its thread and the agent config it was given.
    refreshes: Mutex<Vec<(Option<ThreadId>, Doc)>>,
}

impl Host {
    fn new(provider: Option<String>, session: Option<Doc>) -> Self {
        Self {
            provider,
            session: Mutex::new(session),
            invalidated: Mutex::new(0),
            last_thread: Mutex::new(None),
            refreshes: Mutex::new(Vec::new()),
        }
    }
}

impl CompactionHost for Host {
    fn route_provider(&self, _thread: Option<&ThreadId>) -> Option<String> {
        self.provider.clone()
    }

    fn adopt_session_compaction(&self, thread: Option<&ThreadId>, saved: &Doc) {
        if thread.is_some()
            && let Some(session) = self.session.lock().unwrap().as_mut()
        {
            adopt_session_compaction(session, saved);
        }
    }

    fn invalidate_context_status(&self, thread: Option<&ThreadId>) {
        *self.invalidated.lock().unwrap() += 1;
        *self.last_thread.lock().unwrap() = thread.cloned();
    }

    fn refresh_lead_cache_opts(&self, thread: Option<&ThreadId>, agent: &Doc) {
        self.refreshes.lock().unwrap().push((thread.cloned(), agent.clone()));
    }
}

fn request(method: &str, params: Value) -> CoreRequest {
    CoreRequest {
        method: Method(Box::leak(method.to_owned().into_boxed_str())),
        params,
        op: None,
        ctx: CallContext::internal("settings-test"),
    }
}

#[allow(clippy::disallowed_methods, reason = "test setup: reads the recorded golden fixture")]
fn golden() -> Value {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/agent/compact/golden/settings.json"))
        .unwrap();
    serde_json::from_str(&text).unwrap()
}

#[test]
fn the_config_owned_session_keys_equal_nodes() {
    let golden = golden();
    let mut node: Vec<&str> = golden["configKeys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
    let mut rust = compaction_config_keys();
    node.sort_unstable();
    node.dedup();
    rust.sort_unstable();
    rust.dedup();
    assert_eq!(rust, node);
}

#[tokio::test]
async fn every_recorded_call_equals_nodes_result_and_state() {
    let golden = golden();
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        // `configText` keeps the order the keys were written in; a parsed JS object lists
        // integer-like keys first, so `config` alone could not carry it.
        let config: Doc = match case["configText"].as_str() {
            Some(text) => serde_json::from_str(text).unwrap(),
            None => case["config"].as_object().unwrap().clone(),
        };
        let store = Arc::new(Store(Mutex::new(config)));
        let host = Arc::new(Host::new(case["provider"].as_str().map(str::to_owned), case["session"].as_object().cloned()));
        let mut refreshed = 0;
        // A session case runs on a thread; the others run without one.
        let thread = (!case["session"].is_null()).then(|| ThreadId::from("t1"));
        let service = CompactionSettingsService::new(store.clone(), host.clone());
        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("{name}[{index}] {}", step["method"]);
            let method = format!("config/{}", step["method"].as_str().unwrap());
            let mut params = serde_json::Map::new();
            if let Some(input) = step.get("input") {
                params.insert("input".into(), input.clone());
            }
            if let Some(thread) = &thread {
                params.insert("threadId".into(), Value::String(thread.to_string()));
            }
            let reply = service.call(request(&method, Value::Object(params))).await;
            match (step.get("error"), reply) {
                (Some(expected), Err(CoreError::DomainError { domain, code, message, detail })) => {
                    assert_eq!((&*domain, code), ("config", None), "{at}");
                    assert_eq!(message.as_deref(), expected.as_str(), "{at}");
                    assert_eq!(detail, None, "{at}");
                }
                (None, Ok(Reply::Value(value))) => assert_eq!(value, step["result"], "{at} result"),
                (error, other) => panic!("{at}: node error {error:?}, rust {other:?}"),
            }
            assert_eq!(Value::Object(store.agent()), step["config"], "{at} config");
            let session = host.session.lock().unwrap().clone().map_or(Value::Null, Value::Object);
            assert_eq!(session, step["session"], "{at} session");
            assert_eq!(*host.invalidated.lock().unwrap(), step["invalidated"].as_u64().unwrap(), "{at} invalidated");
            if step["method"] == "setCompactionSettings" && step.get("error").is_none() {
                assert_eq!(*host.last_thread.lock().unwrap(), thread, "{at} thread");
            }
            // Node refreshes the Lead cache options once per saved auto-clear change, with the
            // config it saved and never when the change was refused.
            let refreshes = host.refreshes.lock().unwrap();
            assert_eq!(refreshes.len() as u64, step["refreshes"].as_u64().unwrap(), "{at} refreshes");
            for (refresh_thread, agent) in &refreshes[refreshed..] {
                assert_eq!(refresh_thread, &thread, "{at} refresh thread");
                assert_eq!(Value::Object(agent.clone()), step["config"], "{at} refresh config");
            }
            refreshed = refreshes.len();
        }
    }
}

#[test]
fn agent_terminal_reap_equals_nodes() {
    let golden = golden();
    for row in golden["reap"].as_array().unwrap() {
        let auto_clear = Some(&row["autoClear"]).filter(|v| !v.is_null());
        let provider = row["provider"].as_str().unwrap_or_default();
        assert_eq!(agent_terminal_reap_ms(auto_clear, provider), row["ms"].as_f64().unwrap(), "{row}");
    }
}

async fn set(service: &CompactionSettingsService, method: &str, input: Value) {
    service.call(request(method, serde_json::json!({ "input": input }))).await.unwrap();
}

#[tokio::test]
async fn concurrent_compaction_edits_of_different_fields_both_survive() {
    let store = Arc::new(Store(Mutex::new(Doc::new())));
    let service = CompactionSettingsService::new(store.clone(), Arc::new(Host::new(None, None)));
    tokio::join!(
        set(&service, "config/setCompactionSettings", serde_json::json!({ "auto": false })),
        set(&service, "config/setCompactionSettings", serde_json::json!({ "summaryMode": "self" })),
    );
    let compaction = store.agent()["compaction"].clone();
    assert_eq!(compaction["auto"], Value::Bool(false));
    assert_eq!(compaction["summaryMode"], "self");
}

#[tokio::test]
async fn concurrent_auto_clear_edits_of_different_providers_both_survive() {
    let store = Arc::new(Store(Mutex::new(Doc::new())));
    let service = CompactionSettingsService::new(store.clone(), Arc::new(Host::new(None, None)));
    tokio::join!(
        set(&service, "config/setAutoClear", serde_json::json!({ "provider": "groq", "duration": "45m" })),
        set(&service, "config/setAutoClear", serde_json::json!({ "provider": "xai", "duration": "90m" })),
        set(&service, "config/setAutoClear", serde_json::json!({ "enabled": false })),
        set(&service, "config/setCompactionSettings", serde_json::json!({ "auto": false })),
    );
    let agent = store.agent();
    assert_eq!(agent["autoClear"]["providerIdleMs"], serde_json::json!({ "groq": 2_700_000, "xai": 5_400_000 }));
    assert_eq!(agent["autoClear"]["enabled"], Value::Bool(false));
    assert_eq!(agent["compaction"]["auto"], Value::Bool(false));
}
