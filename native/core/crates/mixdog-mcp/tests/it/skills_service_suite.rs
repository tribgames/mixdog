//! The skill methods of the runtime API over a data folder in a temp dir: what creating, saving, removing and listing skills answers
//! and leaves on disk, which names move with a rename, and the words of each refusal. Plugin and bundled skills are read-only.
//! (Node `session-runtime/skills-api.mjs`, whose answers these keep.)
#![allow(clippy::disallowed_methods, reason = "test fixtures lay out skill folders")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_mcp::extension_service::ExtensionConfig;
use mixdog_mcp::extension_service::ExtensionHost;
use mixdog_mcp::scopes::ExtensionScopes;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skill_catalog::SkillSettings;
use mixdog_mcp::skill_catalog::SkillSettingsSource;
use mixdog_mcp::skills::SkillGate;
use mixdog_mcp::skills::SkillRoot;
use mixdog_mcp::skills::SkillSource;
use mixdog_mcp::skills_service::ProjectWorkspaces;
use mixdog_mcp::skills_service::SkillsService;
use mixdog_mcp::skills_watch::SkillsWatch;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

struct Config {
    agent: Mutex<Map<String, Value>>,
}

#[async_trait]
impl ExtensionConfig for Config {
    fn agent(&self) -> Map<String, Value> {
        self.agent.lock().unwrap().clone()
    }

    async fn save_agent(&self, _: &Map<String, Value>, _: &Map<String, Value>) -> Result<(), String> {
        Ok(())
    }

    fn set_disabled_skills(&self, names: &[String]) {
        self.agent.lock().unwrap().insert("skills".to_owned(), json!({"disabled": names}));
    }
}

struct Host {
    log: Mutex<Vec<String>>,
    cwd: PathBuf,
}

#[async_trait]
impl ExtensionHost for Host {
    async fn reconcile_plugins_and_announce(&self) {}

    async fn announce(&self, kind: &str) {
        self.log.lock().unwrap().push(format!("announce:{kind}"));
    }

    async fn announce_without_invalidating(&self, kind: &str) {
        self.log.lock().unwrap().push(format!("announce:{kind}:keep"));
    }

    async fn tool_names(&self) -> Result<Vec<String>, String> {
        Ok(vec!["read".to_owned()])
    }

    async fn reconnect_mcp_and_announce(&self, _: Option<&str>, _: bool, _: &[String]) -> Value {
        Value::Null
    }

    async fn reconnect_all_mcp_and_announce(&self) -> Value {
        Value::Null
    }

    async fn schedule_mcp_toggle(&self, _: &str, _: bool) -> Value {
        Value::Null
    }

    async fn publish_mcp_changes(&self, _: &[(String, bool)]) {}

    async fn announce_mcp_changes(&self, _: &[(String, bool)]) {}

    async fn connect_configured_mcp(&self, _: &str, _: bool) -> Value {
        Value::Null
    }

    fn invalidate_skills(&self) {
        self.log.lock().unwrap().push("invalidateSkills".to_owned());
    }

    async fn flush_skills_save(&self) {
        self.log.lock().unwrap().push("flushSkills".to_owned());
    }

    async fn current_cwd(&self, _: Option<&str>) -> Result<PathBuf, String> {
        Ok(self.cwd.clone())
    }

    async fn plugin_mcp_summary(&self, _: Option<&str>) -> Result<Value, String> {
        Ok(Value::Object(Map::new()))
    }

    async fn skills_status(&self, _: Option<&str>) -> Value {
        Value::Null
    }
}

struct Settings(SkillSettings);

impl SkillSettingsSource for Settings {
    fn current(&self) -> SkillSettings {
        self.0.clone()
    }
}

struct Projects;

#[async_trait]
impl ProjectWorkspaces for Projects {
    async fn workspace_cwd(&self, project_path: &str) -> Result<PathBuf, String> {
        if project_path == "unknown" { Err("Project is not available.".to_owned()) } else { Ok(PathBuf::from("/resolved")) }
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    data: PathBuf,
    cwd: PathBuf,
    service: SkillsService,
    config: Arc<Config>,
    host: Arc<Host>,
}

fn fixture(existing: &[(&str, &str)]) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    for (name, text) in existing {
        let folder = data.join("skills").join(name);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("SKILL.md"), text).unwrap();
    }
    let config = Arc::new(Config { agent: Mutex::default() });
    let host = Arc::new(Host { log: Mutex::default(), cwd: cwd.clone() });
    let settings: Arc<dyn SkillSettingsSource> =
        Arc::new(Settings(SkillSettings { gate: SkillGate { disabled: Default::default(), active_features: Default::default() }, scopes: ExtensionScopes::from_config(&Value::Null) }));
    let tokens = mixdog_rt::testing::tokens();
    let root = SkillRoot { dir: data.join("skills"), source: SkillSource::Global, plugin: None };
    let catalog = SkillCatalog::new(data.clone(), tokens.maintenance_io.clone(), Arc::new(move |_| vec![root.clone()]), Arc::clone(&settings), &SkillsWatch::new());
    let service = SkillsService::new(catalog, settings, config.clone(), host.clone(), Arc::new(Projects), tokens.maintenance_io, tokens.durability_io, data.clone());
    Fixture { _dir: dir, data, cwd, service, config, host }
}

async fn call(service: &SkillsService, method: &'static str, params: Value) -> Result<Value, String> {
    match service.call(CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") }).await {
        Ok(Reply::Value(value)) => Ok(value),
        Ok(_) => panic!("not a value"),
        Err(CoreError::DomainError { message: Some(message), .. }) => Err(message.to_string()),
        Err(other) => panic!("{other:?}"),
    }
}

fn names(status: &Value) -> Vec<String> {
    status["skills"].as_array().unwrap().iter().map(|row| row["name"].as_str().unwrap().to_owned()).collect()
}

const DEMO: &str = "---\nname: demo\ndescription: Does a thing.\n---\n\nStep one.\n";

#[tokio::test(flavor = "multi_thread")]
async fn a_skill_added_is_written_listed_as_the_users_own_and_announced() {
    let f = fixture(&[]);
    let added = call(&f.service, "skills/addSkill", json!({"input": {"name": "demo", "description": "Does a thing.", "instructions": "Step one."}})).await.unwrap();
    assert_eq!(added["skill"]["name"], "demo");
    let file = f.data.join("skills").join("demo").join("SKILL.md");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "---\nname: demo\ndescription: Does a thing.\n---\n\nStep one.\n");
    assert_eq!(names(&added["status"]), ["demo"]);
    let row = &added["status"]["skills"][0];
    assert_eq!((row["editable"].clone(), row["source"].clone(), row["owner"].clone(), row["enabled"].clone()), (json!(true), json!("global"), json!({"kind": "user"}), json!(true)));
    assert_eq!(added["status"]["cwd"], f.cwd.to_string_lossy().as_ref());
    assert_eq!(added["status"]["tools"], json!([{"name": "read"}]));
    assert_eq!(*f.host.log.lock().unwrap(), ["announce:skills"]);

    let again = call(&f.service, "skills/addSkill", json!({"input": {"name": "demo", "description": "Other."}})).await;
    assert_eq!(again.unwrap_err(), "skill already exists: demo");
    let content = call(&f.service, "skills/skillContent", json!({"name": "  demo "})).await.unwrap();
    assert_eq!((content["content"].as_str(), content["name"].as_str(), content["source"].as_str()), (Some("Step one."), Some("demo"), Some("global")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_skill_without_instructions_gets_the_placeholder_text() {
    let f = fixture(&[]);
    call(&f.service, "skills/addSkill", json!({"input": {"name": "bare", "description": "Bare."}})).await.unwrap();
    let text = std::fs::read_to_string(f.data.join("skills").join("bare").join("SKILL.md")).unwrap();
    assert!(text.ends_with("\n\n# Instructions\n\nDescribe how to use this skill.\n"), "{text:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lookup_with_no_name_or_an_unknown_name_is_refused_in_words() {
    let f = fixture(&[("demo", DEMO)]);
    assert_eq!(call(&f.service, "skills/skillContent", json!({"name": "  "})).await.unwrap_err(), "skill name is required");
    assert_eq!(call(&f.service, "skills/skillContent", json!({"name": " nope "})).await.unwrap_err(), "skill not found: nope");
    assert_eq!(call(&f.service, "skills/removeSkill", json!({"input": {"name": "nope"}})).await.unwrap_err(), "skill not found: nope");
    assert_eq!(call(&f.service, "skills/saveSkill", json!({"input": {"originalName": "nope", "name": "nope", "description": "d"}})).await.unwrap_err(), "skill not found: nope");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rename_moves_the_folder_and_the_switched_off_state_to_the_new_name_and_a_taken_name_is_refused() {
    let f = fixture(&[("demo", DEMO), ("other", "---\nname: other\ndescription: Another.\n---\n\nBody\n")]);
    call(&f.service, "skills/setDisabledSkills", json!({"names": ["demo"]})).await.unwrap();

    let taken = call(&f.service, "skills/saveSkill", json!({"input": {"originalName": "demo", "name": "other", "description": "Does a thing.", "instructions": "Step one."}})).await;
    assert_eq!(taken.unwrap_err(), "skill already exists: other");
    assert!(f.data.join("skills").join("demo").is_dir());

    let saved = call(&f.service, "skills/saveSkill", json!({"input": {"originalName": "demo", "name": "renamed", "description": "Does a thing.", "instructions": "Step one."}})).await.unwrap();
    assert_eq!((saved["skill"]["originalName"].as_str(), saved["skill"]["name"].as_str()), (Some("demo"), Some("renamed")));
    assert!(!f.data.join("skills").join("demo").exists());
    let text = std::fs::read_to_string(f.data.join("skills").join("renamed").join("SKILL.md")).unwrap();
    assert!(text.starts_with("---\nname: renamed\n"), "{text:?}");
    assert_eq!(call(&f.service, "skills/getDisabledSkills", json!({})).await.unwrap(), json!({"disabled": ["renamed"]}));
    assert!(f.host.log.lock().unwrap().contains(&"announce:skills:keep".to_owned()));
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_a_skill_deletes_its_folder_and_its_switched_off_entry() {
    let f = fixture(&[("demo", DEMO)]);
    call(&f.service, "skills/setDisabledSkills", json!({"names": ["demo", "kept"]})).await.unwrap();
    let removed = call(&f.service, "skills/removeSkill", json!({"input": {"name": "demo"}})).await.unwrap();
    assert_eq!(removed["skill"], json!({"name": "demo"}));
    assert!(!f.data.join("skills").join("demo").exists());
    assert_eq!(names(&removed["status"]), Vec::<String>::new());
    assert_eq!(f.config.agent()["skills"]["disabled"], json!(["kept"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_switched_off_list_is_trimmed_unique_and_sorted() {
    let f = fixture(&[]);
    let set = call(&f.service, "skills/setDisabledSkills", json!({"names": ["b", " a ", "b", "", "c"]})).await.unwrap();
    assert_eq!(set, json!({"disabled": ["a", "b", "c"]}));
    assert_eq!(call(&f.service, "skills/getDisabledSkills", json!({})).await.unwrap(), set);
    assert_eq!(*f.host.log.lock().unwrap(), ["flushSkills", "invalidateSkills", "announce:skills:keep"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_status_is_of_the_folder_asked_for_and_a_bad_ask_is_refused_in_words() {
    let f = fixture(&[("demo", DEMO)]);
    let ask = |options: Value| call(&f.service, "skills/skillsStatus", json!({"options": options}));
    assert_eq!(ask(Value::Null).await.unwrap()["cwd"], f.cwd.to_string_lossy().as_ref());
    let here = f.data.to_string_lossy().into_owned();
    assert_eq!(ask(json!({"cwd": here})).await.unwrap()["cwd"], here.as_str());
    assert_eq!(ask(json!({"cwd": "relative/dir"})).await.unwrap_err(), "skillsStatus cwd must be an absolute path.");
    let missing = Path::new(&here).join("no-such-folder");
    assert_eq!(ask(json!({"cwd": missing})).await.unwrap_err(), "skillsStatus cwd is not a directory.");
    assert_eq!(ask(json!({"projectPath": "/p"})).await.unwrap()["cwd"], "/resolved");
    assert_eq!(ask(json!({"projectPath": "unknown"})).await.unwrap_err(), "Project is not available.");
    assert_eq!(ask(json!({"projectPath": 3})).await.unwrap_err(), "projectPath must be a string.");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_method_the_service_does_not_serve_is_unavailable() {
    let f = fixture(&[]);
    let request = CoreRequest { method: Method("skills/unheard"), params: json!({}), op: None, ctx: CallContext::internal("test") };
    assert!(matches!(f.service.call(request).await, Err(CoreError::CapabilityUnavailable { .. })));
}