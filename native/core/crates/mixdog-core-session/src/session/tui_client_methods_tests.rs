//! The terminal client's methods (`tui_client_methods.rs`): the hint rules replay `setProgressHint` of Node's notice surface
//! (`src/tui/session/notice-surface.mjs`), whose outputs were recorded by running its body on the inputs below; the snapshot and the
//! service run over recording stand-ins of the reads and of the thread's sections.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_agents::setup::DomainCalls;
use mixdog_core_api::CoreError;
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
use serde_json::Value;
use serde_json::json;

use super::tui_client_methods::*;

/// The arguments of `setProgressHint` and the `progressHint` Node's body set for them: `null` is a cleared hint.
fn recorded_hints() -> Vec<(Value, Value)> {
    vec![
        (json!({ "text": "  Downloading  " }), json!({ "text": "Downloading", "tone": "info" })),
        (json!({ "text": "x", "tone": "warn", "percent": 41.5 }), json!({ "text": "x", "tone": "warn", "percent": 42 })),
        (json!({ "text": "x", "percent": -3 }), json!({ "text": "x", "tone": "info", "percent": 0 })),
        (json!({ "text": "x", "percent": 250 }), json!({ "text": "x", "tone": "info", "percent": 100 })),
        (json!({ "text": "x", "percent": "7.4" }), json!({ "text": "x", "tone": "info", "percent": 7 })),
        (json!({ "text": "x", "percent": null }), json!({ "text": "x", "tone": "info", "percent": 0 })),
        (json!({ "text": "", "percent": 5 }), Value::Null),
        (json!({ "text": "   ", "percent": 5 }), Value::Null),
        (json!({ "percent": 5 }), Value::Null),
        (json!({ "text": "x", "tone": null, "percent": 1 }), json!({ "text": "x", "tone": null, "percent": 1 })),
        (json!({ "text": "x", "percent": 0.5 }), json!({ "text": "x", "tone": "info", "percent": 1 })),
        (json!({ "text": "x", "percent": "abc" }), json!({ "text": "x", "tone": "info" })),
    ]
}

#[test]
fn the_progress_hint_is_what_nodes_notice_surface_sets() {
    for (args, expected) in recorded_hints() {
        let hint = progress_hint(&args).expect("a text");
        assert_eq!(hint.unwrap_or(Value::Null), expected, "{args}");
    }
}

#[test]
fn a_hint_text_that_is_a_list_is_refused() {
    assert!(matches!(progress_hint(&json!({ "text": ["x"] })), Err(CoreError::InvalidParams { .. })));
}

#[test]
fn the_remembered_prompt_is_the_trimmed_text_and_nothing_when_empty() {
    let kept = |params: Value| remembered_prompt(&params).expect("a text");
    assert_eq!(kept(json!({ "text": "  fix the build \n" })), Some("fix the build".to_owned()));
    assert_eq!(kept(json!({ "text": "\u{a0}\u{feff} " })), None);
    assert_eq!(kept(json!({ "text": "" })), None);
    assert_eq!(kept(json!({ "text": null })), None);
    assert_eq!(kept(json!({})), None);
    assert_eq!(kept(json!({ "text": 0 })), None);
    assert_eq!(kept(json!({ "text": 12 })), Some("12".to_owned()));
}

/// Every read answers its own method and params, except the ones in `failing` (an error) and `empty` (`null`).
#[derive(Default)]
struct Reads {
    calls: Mutex<Vec<&'static str>>,
    failing: Vec<&'static str>,
    empty: Vec<&'static str>,
}

#[async_trait]
impl DomainCalls for Reads {
    async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        self.calls.lock().unwrap().push(method);
        if self.failing.contains(&method) {
            return Err(CoreError::InvalidParams { path: "params".into(), expected: "a failing read".into() });
        }
        if self.empty.contains(&method) {
            return Ok(Value::Null);
        }
        Ok(json!({ "method": method, "params": params }))
    }
}

/// The snapshot's reads over `domains`, with `route` the stored web-search route (none is a failing read).
fn settings_reads(domains: &Arc<Reads>, route: Option<Value>) -> SettingsReads {
    SettingsReads::new(domains.clone(), move || route.clone().ok_or_else(|| CoreError::InvalidParams { path: "route".into(), expected: "a route".into() }))
}

#[tokio::test]
async fn the_snapshot_holds_every_row_of_the_settings_picker() {
    let reads = settings_reads(&Arc::new(Reads::default()), Some(json!({ "provider": "default" })));
    let snapshot = settings_snapshot(&reads, &json!({ "threadId": "t1" })).await;
    let mut got: Vec<&str> = snapshot.as_object().unwrap().keys().map(String::as_str).collect();
    got.sort_unstable();
    let mut expected = vec![
        "autoClear", "channelWorker", "channels", "compaction", "mcp", "outputStyle", "plugins", "profile", "recap", "sessionTitles", "skills",
        "systemShell", "toolModules", "updateSettings", "voice", "webSearchRoute",
    ];
    expected.sort_unstable();
    assert_eq!(got, expected);
    assert_eq!(snapshot["webSearchRoute"], json!({ "provider": "default" }));
    assert_eq!(snapshot["voice"], json!({ "enabled": false }), "the status read answers no `enabled`: off");
    assert_eq!(snapshot["systemShell"]["method"], "config/getSystemShell");
    assert_eq!(snapshot["systemShell"]["params"], json!({ "threadId": "t1" }));
    assert_eq!(snapshot["channels"]["params"], json!({ "options": { "includeStatus": false }, "threadId": "t1" }));
}

#[tokio::test]
async fn a_light_snapshot_leaves_out_the_status_of_mcp_plugins_and_skills() {
    for params in [json!({ "options": { "heavy": false } }), json!({ "options": { "heavy": null } }), json!({ "options": { "heavy": 0 } })] {
        let domains = Arc::new(Reads::default());
        let snapshot = settings_snapshot(&settings_reads(&domains, None), &params).await;
        for key in ["mcp", "plugins", "skills"] {
            assert!(snapshot.get(key).is_none(), "{params}: {key}");
        }
        assert!(!domains.calls.lock().unwrap().contains(&"mcp/mcpStatus"));
    }
    for params in [json!({}), json!({ "options": null }), json!({ "options": {} })] {
        let snapshot = settings_snapshot(&settings_reads(&Arc::new(Reads::default()), None), &params).await;
        assert!(snapshot.get("mcp").is_some(), "{params}: heavy is on unless stated");
    }
}

#[tokio::test]
async fn a_failing_read_is_null_in_its_place_and_the_others_stand() {
    let domains = Arc::new(Reads { failing: vec!["config/getRecapSettings", "skills/skillsStatus"], ..Reads::default() });
    let snapshot = settings_snapshot(&settings_reads(&domains, None), &json!({})).await;
    assert_eq!(snapshot["recap"], Value::Null);
    assert_eq!(snapshot["skills"], Value::Null);
    assert_eq!(snapshot["webSearchRoute"], Value::Null, "no route is null too");
    assert_eq!(snapshot["profile"]["method"], "config/getProfile");
}

#[tokio::test]
async fn the_output_style_falls_back_to_the_list_when_there_is_none() {
    let domains = Arc::new(Reads { empty: vec!["config/getOutputStyle"], ..Reads::default() });
    let snapshot = settings_snapshot(&settings_reads(&domains, None), &json!({})).await;
    assert_eq!(snapshot["outputStyle"]["method"], "config/listOutputStyles");
    let domains = Arc::new(Reads::default());
    let snapshot = settings_snapshot(&settings_reads(&domains, None), &json!({})).await;
    assert_eq!(snapshot["outputStyle"]["method"], "config/getOutputStyle");
    assert!(!domains.calls.lock().unwrap().contains(&"config/listOutputStyles"), "the list is read only when the style is empty");
}

#[derive(Default)]
struct Sections(Mutex<Vec<(String, Option<Value>)>>);

#[async_trait]
impl ThreadState for Sections {
    async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
        Err(PortError::NotFound { target: thread.as_str().to_owned(), message: "no header".into() })
    }

    async fn patch_header(&self, thread: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        Err(PortError::NotFound { target: thread.as_str().to_owned(), message: "no header".into() })
    }

    async fn patch_header_if(&self, thread: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        Err(PortError::NotFound { target: thread.as_str().to_owned(), message: "no header".into() })
    }

    async fn publish(&self, thread: &ThreadId, section: Section) -> Result<(), PortError> {
        if thread.as_str() == "gone" {
            return Err(PortError::NotFound { target: "gone".into(), message: "no thread".into() });
        }
        let Section::ProgressHint(hint) = section else { panic!("only the progress hint is published") };
        self.0.lock().unwrap().push((thread.as_str().to_owned(), hint));
        Ok(())
    }
}

fn request(method: &'static str, params: Value) -> CoreRequest {
    CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("tui-client-methods-tests") }
}

fn service() -> (Arc<TuiClientService>, Arc<Sections>) {
    let sections = Arc::new(Sections::default());
    (TuiClientService::new(settings_reads(&Arc::new(Reads::default()), None), sections.clone()), sections)
}

async fn value(service: &TuiClientService, method: &'static str, params: Value) -> Result<Value, CoreError> {
    match service.call(request(method, params)).await? {
        Reply::Value(value) => Ok(value),
        Reply::Subscribe(_) => panic!("no subscription"),
    }
}

#[tokio::test]
async fn a_hint_is_published_on_the_thread_that_asked_and_an_empty_one_clears_it() {
    let (service, sections) = service();
    assert_eq!(value(&service, SET_PROGRESS_HINT, json!({ "threadId": "t1", "text": "Installing voice", "percent": 12.4 })).await.unwrap(), Value::Null);
    assert_eq!(value(&service, SET_PROGRESS_HINT, json!({ "threadId": "t1", "text": "" })).await.unwrap(), Value::Null);
    let published = sections.0.lock().unwrap().clone();
    assert_eq!(
        published,
        vec![
            ("t1".to_owned(), Some(json!({ "text": "Installing voice", "tone": "info", "percent": 12 }))),
            ("t1".to_owned(), None),
        ]
    );
}

#[tokio::test]
async fn a_hint_needs_a_thread_that_exists() {
    let (service, sections) = service();
    assert!(matches!(value(&service, SET_PROGRESS_HINT, json!({ "text": "x" })).await, Err(CoreError::InvalidParams { .. })));
    assert!(matches!(value(&service, SET_PROGRESS_HINT, json!({ "threadId": "gone", "text": "x" })).await, Err(CoreError::ThreadNotFound { .. })));
    assert!(sections.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn paging_the_transcript_restores_nothing_because_the_core_keeps_the_whole_log() {
    let (service, _) = service();
    for method in [RESTORE_OLDER_TRANSCRIPT, RESTORE_NEWER_TRANSCRIPT] {
        assert_eq!(value(&service, method, json!({ "threadId": "t1" })).await.unwrap(), Value::Bool(false));
        assert!(matches!(value(&service, method, json!({})).await, Err(CoreError::InvalidParams { .. })));
    }
}

#[tokio::test]
async fn the_service_answers_the_snapshot_and_refuses_a_method_it_does_not_serve() {
    let (service, _) = service();
    let snapshot = value(&service, GET_SETTINGS_SNAPSHOT, json!({ "options": { "heavy": false } })).await.unwrap();
    assert!(snapshot.get("profile").is_some());
    assert!(matches!(value(&service, REMEMBER_PROMPT_HISTORY, json!({ "text": "x" })).await, Err(CoreError::InvalidParams { .. })));
    assert_eq!(service.methods(), [GET_SETTINGS_SNAPSHOT, SET_PROGRESS_HINT, RESTORE_OLDER_TRANSCRIPT, RESTORE_NEWER_TRANSCRIPT]);
}

#[tokio::test]
async fn the_voice_member_is_the_switch_of_the_voice_runtime_or_null() {
    struct Voice(Value);
    #[async_trait]
    impl DomainCalls for Voice {
        async fn call(&self, method: &'static str, _params: Value) -> Result<Value, CoreError> {
            if method == "voice/getVoiceStatus" { Ok(self.0.clone()) } else { Ok(Value::Null) }
        }
    }
    let read = |status: Value| async move { settings_snapshot(&SettingsReads::new(Arc::new(Voice(status)), || Ok(Value::Null)), &json!({})).await["voice"].clone() };
    assert_eq!(read(json!({ "enabled": true, "busy": false })).await, json!({ "enabled": true }));
    assert_eq!(read(json!({ "enabled": false })).await, json!({ "enabled": false }));
    assert_eq!(read(Value::Null).await, Value::Null);
}
