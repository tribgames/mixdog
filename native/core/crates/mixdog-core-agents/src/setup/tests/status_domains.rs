//! The config-backed `status` domains: which getters each reads and how the answer is shaped.

use std::sync::Mutex;

use serde_json::Value;
use serde_json::json;

use super::*;

/// The getters of the domain table, answering from a map and logging every call.
struct Table {
    answers: Value,
    calls: Mutex<Vec<(String, Value)>>,
}

impl Table {
    fn of(answers: Value) -> Arc<Self> {
        Arc::new(Self { answers, calls: Mutex::default() })
    }
    fn called(&self) -> Vec<String> {
        self.calls.lock().unwrap().iter().map(|(method, _)| method.clone()).collect()
    }
}

#[async_trait]
impl DomainCalls for Table {
    async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        self.calls.lock().unwrap().push((method.to_owned(), params));
        Ok(self.answers[method].clone())
    }
}

/// A human's dispatcher with `build` registering the readers under test.
async fn read(table: &Arc<Table>, domain: &str, build: impl FnOnce(SetupService, Arc<Table>, Config) -> SetupService) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    *world.caller.lock().unwrap() = "human".into();
    let (service, config, _) = settings_service(dir.path(), json!({ "agent": {}, "desktop": { "zoom": 1 } }), &world, false).await;
    let service = build(service, table.clone(), config);
    settings_call_on(&service, "sess_1", &json!({ "action": "status", "domain": domain })).await.unwrap()
}

fn config_reader(service: SetupService, table: Arc<Table>, _: Config) -> SetupService {
    service.with_status(Arc::new(ConfigStatus::new(table)))
}

#[tokio::test]
async fn simple_domains_spread_their_getter_and_autoclear_asks_for_the_calling_thread() {
    let table = Table::of(json!({
        "config/getAutoClear": { "enabled": true, "idleMinutes": 30 },
        "config/getSystemShell": { "command": "pwsh" },
        "config/getWorktreeSettings": null,
    }));
    let auto = read(&table, "autoclear", config_reader).await;
    assert_eq!(auto, json!({ "domain": "autoclear", "enabled": true, "idleMinutes": 30 }));
    assert_eq!(table.calls.lock().unwrap()[0], ("config/getAutoClear".to_owned(), json!({ "threadId": "sess_1" })));
    assert_eq!(read(&table, "shell", config_reader).await, json!({ "domain": "shell", "command": "pwsh" }));
    // A getter that answers nothing spreads nothing.
    assert_eq!(read(&table, "worktree", config_reader).await, json!({ "domain": "worktree" }));
}

#[tokio::test]
async fn the_tool_module_domains_show_their_own_part_and_memory_adds_the_recap_or_null() {
    let tools = json!({ "memory": { "enabled": true, "installed": true }, "localProvider": { "enabled": false, "installed": false }, "webSearch": { "enabled": true } });
    let table = Table::of(json!({ "config/getToolModuleSettings": tools, "config/getRecapSettings": { "enabled": true, "everyMinutes": 15 } }));
    assert_eq!(read(&table, "local-provider", config_reader).await, json!({ "domain": "local-provider", "enabled": false, "installed": false }));
    assert_eq!(
        read(&table, "memory", config_reader).await,
        json!({ "domain": "memory", "enabled": true, "installed": true, "recap": { "enabled": true, "everyMinutes": 15 } })
    );
    let none = Table::of(json!({ "config/getToolModuleSettings": tools }));
    assert_eq!(read(&none, "memory", config_reader).await["recap"], Value::Null, "no recap settings is null");
    assert_eq!(none.called(), ["config/getToolModuleSettings", "config/getRecapSettings"]);
}

#[tokio::test]
async fn compaction_joins_the_session_titles_and_names_the_cache_warming_switch() {
    let table = Table::of(json!({
        "config/getCompactionSettings": { "autoCompact": true },
        "config/getSessionTitleSettings": { "aiSessionTitles": false },
        "config/getCacheWarmingSettings": { "enabled": true, "everyMinutes": 4 },
    }));
    let shown = read(&table, "compaction", config_reader).await;
    assert_eq!(shown, json!({ "domain": "compaction", "autoCompact": true, "aiSessionTitles": false, "promptCacheWarming": true }));
    let bare = Table::of(json!({ "config/getCompactionSettings": {}, "config/getSessionTitleSettings": {}, "config/getCacheWarmingSettings": {} }));
    assert_eq!(read(&bare, "compaction", config_reader).await, json!({ "domain": "compaction" }), "no switch is reported when none is stored");
}

#[tokio::test]
async fn the_profile_domain_fills_defaults_and_lists_the_picker_ids() {
    let table = Table::of(json!({ "config/getProfile": {
        "title": "", "languages": [{ "id": "en", "label": "English" }, "ko"], "experienceLevels": [{ "id": "expert" }],
    } }));
    let shown = read(&table, "profile", config_reader).await;
    assert_eq!(
        shown,
        json!({ "domain": "profile", "title": "", "language": "system", "experienceLevel": "", "languages": ["en", "ko"], "experienceLevels": ["expert"] }),
        "a picker row is shown as its id"
    );
    let set = Table::of(json!({ "config/getProfile": { "title": "Dr", "language": "ko", "experienceLevel": "expert" } }));
    let shown = read(&set, "profile", config_reader).await;
    assert_eq!((shown["title"].clone(), shown["language"].clone(), shown["experienceLevel"].clone()), (json!("Dr"), json!("ko"), json!("expert")));
    assert_eq!(shown["languages"], json!([]));
}

// ---- workflow, features, summary and model ------------------------------------------------------

struct Facts {
    route: Value,
    onboarding: Value,
    workflows: Value,
}

#[async_trait]
impl WorkflowFacts for Facts {
    fn web_search_route(&self) -> Result<Value, PortError> {
        Ok(self.route.clone())
    }
    async fn onboarding(&self) -> Result<Value, PortError> {
        Ok(self.onboarding.clone())
    }
    async fn workflows(&self) -> Result<Value, PortError> {
        Ok(self.workflows.clone())
    }
}

fn facts(route: Value, onboarding: Value, workflows: Value) -> Arc<Facts> {
    Arc::new(Facts { route, onboarding, workflows })
}

#[tokio::test]
async fn web_search_status_shows_the_route_and_is_on_unless_switched_off() {
    let on = Table::of(json!({ "config/getToolModuleSettings": { "webSearch": { "enabled": true } } }));
    let route = json!({ "provider": "openai", "model": "gpt-x" });
    let build = |route: Value| {
        move |service: SetupService, table: Arc<Table>, _: Config| {
            service.with_status(Arc::new(WorkflowStatus::new(facts(route, Value::Null, Value::Null), table)))
        }
    };
    assert_eq!(read(&on, "websearch", build(route.clone())).await, json!({ "domain": "websearch", "route": route, "enabled": true }));
    assert_eq!(read(&on, "websearch", build(Value::Null)).await["route"], Value::Null);
    let off = Table::of(json!({ "config/getToolModuleSettings": { "webSearch": { "enabled": false } } }));
    assert_eq!(read(&off, "websearch", build(Value::Null)).await["enabled"], false);
    // No stored switch is on.
    let unset = Table::of(json!({ "config/getToolModuleSettings": {} }));
    assert_eq!(read(&unset, "websearch", build(Value::Null)).await["enabled"], true);
}

#[tokio::test]
async fn onboarding_and_workflow_status_pass_the_owners_answer_and_default_to_empty() {
    let table = Table::of(json!({}));
    let with = |onboarding: Value, workflows: Value| {
        move |service: SetupService, table: Arc<Table>, _: Config| {
            service.with_status(Arc::new(WorkflowStatus::new(facts(Value::Null, onboarding, workflows), table)))
        }
    };
    let shown = read(&table, "onboarding", with(json!({ "done": false, "step": "provider" }), Value::Null)).await;
    assert_eq!(shown, json!({ "domain": "onboarding", "done": false, "step": "provider" }));
    assert_eq!(read(&table, "onboarding", with(Value::Null, Value::Null)).await, json!({ "domain": "onboarding" }));
    let rows = json!([{ "id": "default", "active": true }]);
    assert_eq!(read(&table, "workflow", with(Value::Null, rows.clone())).await, json!({ "domain": "workflow", "workflows": rows }));
    assert_eq!(read(&table, "workflow", with(Value::Null, Value::Null)).await["workflows"], json!([]));
}

struct Active(&'static [&'static str]);

impl FeatureActivity for Active {
    fn active(&self, id: &str) -> bool {
        self.0.contains(&id)
    }
}

fn features_of(table: &Arc<Table>, config: Config, active: &'static [&'static str]) -> Arc<FeatureStatus> {
    Arc::new(FeatureStatus::new(table.clone(), Settings::new(config, Arc::new(NoEffects), Arc::new(|_| None)), Arc::new(Active(active))))
}

fn feature_table() -> Arc<Table> {
    Table::of(json!({
        "config/getToolModuleSettings": {
            "memory": { "enabled": true, "installed": true, "secret": "x" },
            "autoEffort": { "enabled": true, "installed": true, "supported": true, "ready": false, "installing": true, "note": "n" },
            "instructionFiles": "agents",
        },
        "voice/getVoiceStatus": { "enabled": true, "installed": false, "busy": true, "components": { "whisper": false } },
    }))
}

#[tokio::test]
async fn features_status_keeps_the_switches_the_bridges_the_heartbeat_reactions_and_voice() {
    let table = feature_table();
    let shown = read(&table, "features", |service, table, config| service.with_status(features_of(&table, config, &["browser", "terminal"]))).await;
    assert_eq!(shown["memory"], json!({ "enabled": true, "installed": true }), "only the switches show");
    assert_eq!(shown["autoEffort"], json!({ "enabled": true, "installed": true, "supported": true, "ready": false, "installing": true }));
    assert_eq!(shown["instructionFiles"], "agents", "a scalar setting passes through");
    assert_eq!(
        (shown["browser"].clone(), shown["computer"].clone(), shown["terminal"].clone()),
        (json!({ "active": true }), json!({ "active": false }), json!({ "active": true }))
    );
    assert_eq!(shown["heartbeat"], json!({ "enabled": false, "intervalMinutes": 60 }));
    assert_eq!(shown["reactions"], json!({ "enabled": true }), "reactions are on until switched off");
    assert_eq!(shown["voice"], json!({ "enabled": true, "installed": false, "components": { "whisper": false }, "installing": true }));
}

fn live() -> Arc<Live> {
    Arc::new(Live {
        route: json!({ "provider": "openai", "model": "gpt-x", "effort": "high", "fast": true, "effortAuto": false, "effortOptions": ["low", "high"] }),
        positions: json!({ "sessions": [{ "id": "s1" }] }),
    })
}

struct Live {
    route: Value,
    positions: Value,
}

#[async_trait]
impl LiveRoute for Live {
    fn route(&self, _: &ThreadId) -> Value {
        self.route.clone()
    }
    fn lead_fallbacks(&self) -> Value {
        json!([{ "provider": "anthropic", "model": "claude-x" }])
    }
    async fn positions(&self, _: &ThreadId, _: bool) -> Result<Value, PortError> {
        Ok(self.positions.clone())
    }
}

#[tokio::test]
async fn model_status_shows_the_live_route_its_fallbacks_effort_choices_and_chain_positions() {
    let table = Table::of(json!({}));
    let shown = read(&table, "model", |service, _, _| service.with_status(Arc::new(ModelStatus::new(live())))).await;
    assert_eq!(shown["route"]["model"], "gpt-x");
    assert_eq!((shown["route"]["fast"].clone(), shown["route"]["fastCapable"].clone()), (json!(true), json!(false)));
    assert_eq!(shown["route"]["effortAuto"], false, "explicit effortAuto: false is preserved");
    assert_eq!(shown["route"]["fallbacks"], json!([{ "provider": "anthropic", "model": "claude-x" }]));
    assert_eq!(shown["route"]["modelParameters"], json!({}));
    assert_eq!(shown["route"]["contextPercent"], Value::Null);
    assert_eq!(shown["effortOptions"], json!(["low", "high"]));
    assert_eq!(shown["sessions"], json!([{ "id": "s1" }]), "the chain positions join the answer");

    let missing_auto = Arc::new(Live { route: json!({ "provider": "openai", "model": "gpt-x" }), positions: json!({}) });
    let shown_missing = read(&table, "model", |service, _, _| service.with_status(Arc::new(ModelStatus::new(missing_auto)))).await;
    assert!(shown_missing["route"].get("effortAuto").is_none(), "missing effortAuto is not fabricated");
}

#[tokio::test]
async fn the_summary_gathers_route_workflow_style_profile_features_and_onboarding() {
    let table = Table::of(json!({
        "config/getOutputStyle": { "configured": "concise" },
        "config/getProfile": { "title": "Dr", "language": "ko", "experienceLevel": "", "languages": [{ "id": "ko" }] },
        "config/getToolModuleSettings": { "memory": { "enabled": true } },
        "voice/getVoiceStatus": { "enabled": false },
    }));
    let workflows = json!([{ "id": "a", "active": false }, { "id": "b", "active": true }, { "id": "c", "active": true }]);
    let shown = read(&table, "summary", |service, table, config| {
        let features = features_of(&table, config, &[]);
        service.with_status(Arc::new(SummaryStatus::new(table, facts(Value::Null, json!({ "done": true }), workflows), features, live())))
    })
    .await;
    assert_eq!(shown["route"]["model"], "gpt-x");
    assert!(shown["route"].get("fallbacks").is_none(), "the summary shows no fallback chain");
    assert_eq!(shown["workflow"]["id"], "b", "the first active workflow");
    assert_eq!(shown["outputStyle"], "concise");
    assert_eq!(shown["profile"], json!({ "title": "Dr", "language": "ko", "experienceLevel": "" }), "only the three profile fields");
    assert_eq!(shown["features"]["memory"], json!({ "enabled": true }));
    assert_eq!(shown["onboarding"], json!({ "done": true }));
    let keys: Vec<&str> = shown.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["domain", "route", "workflow", "outputStyle", "profile", "features", "onboarding"]);

    let empty = Table::of(json!({ "config/getOutputStyle": {}, "config/getProfile": {}, "config/getToolModuleSettings": {}, "voice/getVoiceStatus": {} }));
    let shown = read(&empty, "summary", |service, table, config| {
        let features = features_of(&table, config, &[]);
        service.with_status(Arc::new(SummaryStatus::new(table, facts(Value::Null, Value::Null, json!([])), features, live())))
    })
    .await;
    assert_eq!((shown["workflow"].clone(), shown["outputStyle"].clone(), shown["onboarding"].clone()), (Value::Null, Value::Null, Value::Null));
}
