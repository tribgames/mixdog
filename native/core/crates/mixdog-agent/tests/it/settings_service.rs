//! The `config/*` compaction methods against Node's recorded results.

#![allow(clippy::disallowed_methods, reason = "test-only: reads recorded fixtures synchronously")]

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

/// Saving compaction settings from a conversation stores them, drops the stale context status of that thread, and a
/// conversation-owned key is among those the config owns.
#[tokio::test]
async fn saving_compaction_settings_from_a_thread_stores_them_and_invalidates_its_context_status() {
    let store = Arc::new(Store(Mutex::new(Doc::new())));
    let host = Arc::new(Host::new(None, None));
    let service = CompactionSettingsService::new(store.clone(), host.clone());
    let params = serde_json::json!({ "threadId": "t1", "input": { "auto": false } });
    service.call(request("config/setCompactionSettings", params)).await.unwrap();
    assert_eq!(store.agent()["compaction"]["auto"], Value::Bool(false));
    assert_eq!((*host.invalidated.lock().unwrap(), host.last_thread.lock().unwrap().clone()), (1, Some(ThreadId::from("t1"))));
    let keys = compaction_config_keys();
    for key in ["auto", "summaryMode", "tailTurns", "bufferTokens"] {
        assert!(keys.contains(&key), "{key}");
    }
}

/// The auto-clear window of a conversation with no route is global; with a provider it is that provider's. Every saved
/// change refreshes the Lead's cache options once with what was saved, and a request the global window cannot take
/// (`unlimited` with no route) is refused with the usage line and saves nothing.
#[tokio::test]
async fn setting_the_auto_clear_window_saves_it_globally_or_per_provider_and_refreshes_the_lead_once() {
    let store = Arc::new(Store(Mutex::new(Doc::new())));
    let host = Arc::new(Host::new(None, None));
    let service = CompactionSettingsService::new(store.clone(), host.clone());
    let refused = service.call(request("config/setAutoClear", serde_json::json!({ "input": { "duration": "unlimited" } }))).await;
    assert!(
        matches!(&refused, Err(CoreError::DomainError { message: Some(text), .. }) if &**text == "usage: /autoclear [on|off|status|<minutes|1h|90m>|unlimited]"),
        "{refused:?}"
    );
    assert!(store.agent().is_empty() && host.refreshes.lock().unwrap().is_empty());

    let reply = service.call(request("config/setAutoClear", serde_json::json!({ "input": { "duration": "10m" } }))).await.unwrap();
    let Reply::Value(view) = reply else { panic!("a value") };
    assert_eq!((view["enabled"].clone(), view["idleMs"].clone(), view["label"].clone()), (Value::Bool(true), serde_json::json!(600_000), serde_json::json!("10m")));
    assert_eq!(store.agent()["autoClear"]["idleMs"], serde_json::json!(600_000));
    set(&service, "config/setAutoClear", serde_json::json!({ "provider": "mistral", "duration": "3600s" })).await;
    assert_eq!(store.agent()["autoClear"]["providerIdleMs"], serde_json::json!({ "mistral": 3_600_000 }));
    assert_eq!(store.agent()["autoClear"]["idleMs"], serde_json::json!(600_000), "the global window is not touched by a provider's");
    assert_eq!(host.refreshes.lock().unwrap().len(), 2);
}

/// How long a finished agent's session is kept before it is released: the provider's own default (30 minutes for
/// the pay-per-use OpenAI API, 2 hours for Groq, a day for DeepSeek, an hour otherwise), matched without regard to
/// case, unless the config sets that provider's window, or a default of its own.
#[test]
fn a_finished_agents_session_is_kept_for_its_providers_window() {
    let none = |provider: &str| agent_terminal_reap_ms(None, provider);
    assert_eq!(
        [none("openai-oauth"), none("openai"), none("OpenAI"), none("groq"), none("deepseek"), none("unknown"), none("")],
        [3_600_000.0, 1_800_000.0, 1_800_000.0, 7_200_000.0, 86_400_000.0, 3_600_000.0, 3_600_000.0]
    );
    let config = serde_json::json!({ "providerIdleMs": { "groq": 600_000 } });
    assert_eq!(agent_terminal_reap_ms(Some(&config), "groq"), 600_000.0);
    assert_eq!(agent_terminal_reap_ms(Some(&config), "deepseek"), 86_400_000.0);
    let own_default = serde_json::json!({ "providerIdleMs": { "default": 120_000 } });
    assert_eq!(agent_terminal_reap_ms(Some(&own_default), "unknown"), 120_000.0);
    assert_eq!(agent_terminal_reap_ms(Some(&serde_json::json!("x")), "groq"), 7_200_000.0, "a config that is not an object is ignored");
}


